#!/usr/bin/env node
/*
 * w8rez — dependency-free static server with local conversion endpoints.
 *
 * Endpoints:
 *   GET  /                                 static app files
 *   GET  /api/health                       liveness probe (no side effects)
 *   GET  /api/status                       { ghostscript, ffmpeg } availability
 *   POST /api/eps-to-png?dpi=150           body: EPS   → image/png   (ghostscript)
 *   POST /api/pdf-to-png?page=1&dpi=150    body: PDF   → image/png   (ghostscript)
 *   POST /api/video-to-mp4                 body: video → video/mp4   (ffmpeg)
 *   POST /api/frames-to-mp4?fps=10         body: concatenated PNGs → video/mp4
 *
 * Security posture (see docs/SECURITY.md for the full rationale):
 *   - binds to the loopback interface by default; remote exposure is opt-in
 *   - Host header allowlist (DNS-rebinding protection)
 *   - strict security headers, CSP without inline scripts
 *   - static handler: extension allowlist, no dotfiles, containment checks,
 *     streamed from disk
 *   - conversion endpoints: request bodies are streamed into a private
 *     work directory, sniffed by magic bytes, executed through spawn() with
 *     argument arrays (no shell), under a concurrency limit, with output
 *     size caps and hard timeouts
 *   - child processes are killed when the client disconnects or the server
 *     shuts down; the work directory is removed on exit
 *
 * Configuration is read from environment variables (see docs/CONFIGURATION.md).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const pkg = require('./package.json');

/* ------------------------------------------------------------------ *
 *  Configuration
 * ------------------------------------------------------------------ */

function intEnv(name, fallback, min, max) {
  const raw = parseInt(process.env[name], 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

const ROOT = __dirname;
const HOST = process.env.W8REZ_HOST || '127.0.0.1';
const PORT = intEnv('PORT', intEnv('W8REZ_PORT', 8080, 0, 65535), 0, 65535); // 0 = ephemeral (tests)
const MAX_UPLOAD = intEnv('W8REZ_MAX_UPLOAD_MB', 30, 1, 512) * 1024 * 1024;
const MAX_OUTPUT = intEnv('W8REZ_MAX_OUTPUT_MB', 256, 1, 2048) * 1024 * 1024;
const MAX_CONCURRENT = intEnv('W8REZ_MAX_CONCURRENT', 2, 1, 16);
const MAX_QUEUE = intEnv('W8REZ_MAX_QUEUE', 8, 0, 64);
const GS_TIMEOUT_MS = intEnv('W8REZ_GS_TIMEOUT_S', 60, 5, 600) * 1000;
const FFMPEG_TIMEOUT_MS = intEnv('W8REZ_FFMPEG_TIMEOUT_S', 180, 5, 1800) * 1000;
const BODY_TIMEOUT_MS = intEnv('W8REZ_BODY_TIMEOUT_S', 120, 5, 1800) * 1000;
const LOG_REQUESTS = process.env.W8REZ_LOG === '1';
const TOOLS_DISABLED = new Set(
  String(process.env.W8REZ_DISABLE_TOOLS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

/**
 * Hosts accepted in the Host header. Anything else is rejected: a request
 * that reached us through a DNS-rebinding domain or a foreign vhost cannot
 * be trusted to come from this machine's user.
 */
const ALLOWED_HOSTS = new Set(
  ['localhost', '127.0.0.1', '[::1]', os.hostname().toLowerCase()]
    .concat(String(process.env.W8REZ_ALLOWED_HOSTS || '').split(','))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; " +
  "connect-src 'self'; worker-src 'self' blob:; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/* ------------------------------------------------------------------ *
 *  Work directory (private, removed on exit)
 * ------------------------------------------------------------------ */

let workDir;
try {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w8rez-'));
} catch (err) {
  console.error('w8rez: cannot create the work directory in the system temp dir:', err.message);
  process.exit(1);
}

function tempPath() {
  return path.join(workDir, 't-' + crypto.randomBytes(8).toString('hex'));
}

function unlinkQuiet(file) {
  if (!file) return;
  fs.unlink(file, () => {});
}

/* ------------------------------------------------------------------ *
 *  Responses and headers
 * ------------------------------------------------------------------ */

function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-Robots-Tag', 'noindex');
}

function sendJson(res, status, obj) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
    'Cache-Control': 'no-store',
  });
  res.end(message);
}

/**
 * Rejects a request whose body has NOT been read. The socket is marked
 * `Connection: close` and destroyed once the response is flushed: leaving an
 * unread body on a keep-alive connection would corrupt the next request
 * parsed from it.
 */
function rejectJson(req, res, status, obj) {
  res.setHeader('Connection', 'close');
  sendJson(res, status, obj);
  res.on('finish', () => req.destroy());
}

/* ------------------------------------------------------------------ *
 *  External tools (ghostscript / ffmpeg)
 * ------------------------------------------------------------------ */

/** Child processes that are currently running (killed on shutdown). */
const activeChildren = new Set();

const toolCache = new Map();

/** gs and ffmpeg disagree on how to print their version. */
const TOOL_VERSION_ARGS = { gs: ['--version'], ffmpeg: ['-version'] };

/**
 * Detects a tool once and caches the result. spawnSync with an argument
 * array — no shell is involved, so version strings can never be injected.
 */
function detectTool(bin) {
  if (toolCache.has(bin)) return toolCache.get(bin);
  let info = null;
  try {
    const probe = spawnSync(bin, TOOL_VERSION_ARGS[bin] || ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const first = String(probe.stdout || '').split('\n', 1)[0].trim();
    if (probe.status === 0 && first) info = { version: first };
  } catch (_) {
    info = null;
  }
  toolCache.set(bin, info);
  return info;
}

function toolsEnabled(bin) {
  return !TOOLS_DISABLED.has(bin) && !TOOLS_DISABLED.has('all');
}

/**
 * Runs an external tool against files (never against pipes: input and output
 * are both paths inside the private work directory).
 *
 * @returns {Promise<{ok:boolean, stderrTail:string, timedOut:boolean}>}
 */
function runTool(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let stderrTail = '';
    let timedOut = false;

    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    activeChildren.add(child);

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      clearTimeout(timer);
      resolve({ ok: ok, stderrTail: stderrTail, timedOut: timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    // A dying pipe or an aborted client must never take the server down.
    child.on('error', () => finish(false));
    child.stderr.on('error', () => {});
    child.on('close', (code) => finish(code === 0));
  });
}

/* ------------------------------------------------------------------ *
 *  Request body → private temp file (streamed, size-capped)
 * ------------------------------------------------------------------ */

/**
 * Streams the request body into the work directory.
 * Rejects with {status, message} and cleans up on any failure; nothing is
 * ever buffered fully in memory.
 */
function readBodyToFile(req, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const outPath = tempPath();
    let out;
    try {
      out = fs.openSync(outPath, 'w', 0o600);
    } catch (err) {
      reject({ status: 500, message: 'cannot create a temporary file' });
      return;
    }

    let size = 0;
    let done = false;
    const timer = setTimeout(onTimeout, timeoutMs);

    const fail = (status, message) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fs.closeSync(out);
      unlinkQuiet(outPath);
      req.unpipe && req.unpipe();
      reject({ status: status, message: message });
    };

    const succeed = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fs.closeSync(out);
      resolve({ path: outPath, size: size });
    };

    function onTimeout() {
      fail(408, 'upload timed out');
      req.destroy();
    }

    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(413, 'upload exceeds the ' + Math.round(maxBytes / (1024 * 1024)) + ' MB limit');
        req.destroy();
        return;
      }
      try {
        fs.writeSync(out, chunk);
      } catch (err) {
        fail(500, 'cannot buffer the upload');
        req.destroy();
      }
    });
    req.on('end', () => (done ? undefined : succeed()));
    req.on('error', () => fail(400, 'upload aborted'));
  });
}

/* ------------------------------------------------------------------ *
 *  Magic-byte sniffing
 *
 *  Request bodies are only handed to external tools after their content has
 *  been recognised. gs and ffmpeg are large C codebases with a history of
 *  memory-corruption bugs in demuxers/interpreters; refusing unknown input
 *  shrinks their exposure to the formats this feature actually supports.
 * ------------------------------------------------------------------ */

function sniffFormat(head, size) {
  // DOS EPS binary header
  if (head[0] === 0xc5 && head[1] === 0xd0 && head[2] === 0xd3 && head[3] === 0xc6) return 'eps';
  const headStr = head.toString('latin1');
  if (headStr.startsWith('%!PS') || headStr.slice(0, 1024).includes('%!PS-Adobe')) return 'eps';
  if (headStr.slice(0, 1024).includes('%PDF-')) return 'pdf';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (size > 8 && head.toString('latin1', 4, 8) === 'ftyp') return 'video';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video'; // webm/mkv
  if (headStr.startsWith('RIFF')) return 'video'; // avi/wav
  if (headStr.startsWith('OggS')) return 'video';
  if (headStr.startsWith('FLV')) return 'video';
  if (headStr.startsWith('GIF8')) return 'video';
  if (head[0] === 0x30 && head[1] === 0x26 && head[2] === 0xb2 && head[3] === 0x75) return 'video'; // asf/wmv
  if (head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && (head[3] === 0xba || head[3] === 0xb3)) return 'video'; // mpeg-ps
  if (head[0] === 0x47) return 'video'; // mpeg-ts
  return null;
}

/* ------------------------------------------------------------------ *
 *  Concurrency control
 * ------------------------------------------------------------------ */

let runningJobs = 0;
const jobQueue = [];

function acquireSlot() {
  return new Promise((resolve, reject) => {
    if (runningJobs < MAX_CONCURRENT) {
      runningJobs++;
      resolve();
      return;
    }
    if (jobQueue.length >= MAX_QUEUE) {
      reject({ status: 503, message: 'server busy: too many concurrent conversions' });
      return;
    }
    jobQueue.push(resolve);
  });
}

function releaseSlot() {
  const next = jobQueue.shift();
  if (next) {
    next(); // the slot passes directly to the queued job
  } else {
    runningJobs--;
  }
}

/* ------------------------------------------------------------------ *
 *  Conversion orchestration
 * ------------------------------------------------------------------ */

/**
 * Streams a file from disk to the response. Resolves to true when the
 * response was handled (fully or with an error response), false when the
 * file vanished or was unusable. The caller must only delete the file AFTER
 * this resolves — the read stream opens the path lazily.
 */
function streamFile(res, filePath, mime) {
  return new Promise((resolve) => {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      resolve(false);
      return;
    }
    if (!stat.isFile() || stat.size === 0) {
      resolve(false);
      return;
    }
    if (stat.size > MAX_OUTPUT) {
      sendJson(res, 413, { error: 'conversion output exceeds the ' + Math.round(MAX_OUTPUT / (1024 * 1024)) + ' MB limit' });
      resolve(true);
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(filePath);
    const done = once(() => resolve(true));
    stream.on('error', () => {
      res.destroy();
      done();
    });
    res.on('close', () => {
      stream.destroy();
      done();
    });
    stream.pipe(res);
    stream.on('end', done);
  });
}

/** Calls fn at most once. */
function once(fn) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

/**
 * Shared implementation of every conversion endpoint.
 * `spec.accept`  formats accepted for sniffing (from sniffFormat)
 * `spec.build`   (inputPath, query) → { bin, args, timeoutMs, outMime }
 */
async function handleConvert(req, res, query, spec) {
  const bin = spec.accept.includes('eps') || spec.accept.includes('pdf') ? 'gs' : 'ffmpeg';
  if (!toolsEnabled(bin)) {
    rejectJson(req, res, 501, {
      error: 'this endpoint is disabled on this server (W8REZ_DISABLE_TOOLS).',
    });
    return;
  }
  if (!detectTool(bin)) {
    rejectJson(req, res, 501, { error: bin + ' is not installed on this machine.' });
    return;
  }
  try {
    await acquireSlot();
  } catch (err) {
    rejectJson(req, res, err.status || 503, { error: err.message });
    return;
  }

  let inputPath = null;
  let outputPath = tempPath();
  let aborted = false;
  res.on('close', () => {
    aborted = true;
  });

  try {
    let body;
    try {
      body = await readBodyToFile(req, MAX_UPLOAD, BODY_TIMEOUT_MS);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }
    inputPath = body.path;
    if (aborted) return;

    // Content sniffing: only recognised formats reach the tool.
    const head = Buffer.alloc(1024);
    const fh = fs.openSync(inputPath, 'r');
    let read = 0;
    try {
      read = fs.readSync(fh, head, 0, 1024, 0);
    } finally {
      fs.closeSync(fh);
    }
    const format = sniffFormat(head, body.size);
    if (!format || !spec.accept.includes(format)) {
      sendJson(res, 415, {
        error: 'unsupported content: expected ' + spec.accept.join(' or ') +
          ' (detected: ' + (format || 'unknown') + ')',
      });
      return;
    }

    const job = spec.build(inputPath, query, outputPath);
    const result = await runTool(job.bin, job.args, job.timeoutMs);
    if (aborted) return;

    if (!result.ok) {
      const reason = result.timedOut
        ? 'timeout: ' + job.bin + ' exceeded ' + Math.round(job.timeoutMs / 1000) + ' s'
        : job.bin + ' failed: ' + (result.stderrTail.trim().split('\n').slice(-2).join(' ') || 'unknown error');
      sendJson(res, 422, { error: reason });
      return;
    }

    if (!(await streamFile(res, outputPath, job.outMime))) {
      sendJson(res, 422, { error: job.bin + ' produced no output' });
    }
  } finally {
    releaseSlot();
    unlinkQuiet(inputPath);
    unlinkQuiet(outputPath);
  }
}

/* ------------------------------------------------------------------ *
 *  API routing
 * ------------------------------------------------------------------ */

function clampIntParam(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function gsArgsFor(kind, query, inputPath, outputPath) {
  const dpi = clampIntParam(query.get('dpi'), 150, 36, 300);
  const args = [
    '-q', '-dSAFER', '-dNOPAUSE', '-dBATCH',
    '-sDEVICE=pngalpha',
    '-r' + dpi,
    '-sOutputFile=' + outputPath,
    '-dMaxBitmap=64000000',
  ];
  if (kind === 'eps') {
    args.push('-dEPSCrop');
  } else {
    const page = clampIntParam(query.get('page'), 1, 1, 5000);
    args.push('-dFirstPage=' + page, '-dLastPage=' + page);
  }
  args.push(inputPath);
  return args;
}

/** Health and status are read-only; conversion endpoints take POST bodies. */
const GET_ENDPOINTS = new Set(['/api/health', '/api/status']);

function handleApi(req, res, url) {
  const method = req.method;
  const path = url.pathname;

  // Unsupported verbs fail before any request body is read.
  if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (path === '/api/health' && (method === 'GET' || method === 'HEAD')) {
    sendJson(res, 200, { status: 'ok', version: pkg.version });
    return;
  }

  if (path === '/api/status' && (method === 'GET' || method === 'HEAD')) {
    const gs = toolsEnabled('gs') ? detectTool('gs') : null;
    const ff = toolsEnabled('ffmpeg') ? detectTool('ffmpeg') : null;
    sendJson(res, 200, {
      ghostscript: { available: !!gs, version: gs ? gs.version : null },
      ffmpeg: { available: !!ff, version: ff ? ff.version : null },
      limits: {
        maxUploadMb: Math.round(MAX_UPLOAD / (1024 * 1024)),
        maxConcurrent: MAX_CONCURRENT,
      },
      version: pkg.version,
    });
    return;
  }

  const routes = {
    '/api/eps-to-png': {
      accept: ['eps'],
      build: (input, query, out) => ({
        bin: 'gs',
        args: gsArgsFor('eps', query, input, out),
        timeoutMs: GS_TIMEOUT_MS,
        outMime: 'image/png',
      }),
    },
    '/api/pdf-to-png': {
      accept: ['pdf'],
      build: (input, query, out) => ({
        bin: 'gs',
        args: gsArgsFor('pdf', query, input, out),
        timeoutMs: GS_TIMEOUT_MS,
        outMime: 'image/png',
      }),
    },
    '/api/video-to-mp4': {
      accept: ['video'],
      build: (input, _query, out) => ({
        bin: 'ffmpeg',
        args: [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-i', input,
          '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart', '-an',
          '-max_muxing_queue_size', '1024',
          '-fs', String(MAX_OUTPUT),
          '-f', 'mp4', out,
        ],
        timeoutMs: FFMPEG_TIMEOUT_MS,
        outMime: 'video/mp4',
      }),
    },
    '/api/frames-to-mp4': {
      accept: ['png'],
      build: (input, query, out) => ({
        bin: 'ffmpeg',
        args: [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-framerate', String(clampIntParam(query.get('fps'), 10, 1, 60)),
          '-f', 'image2pipe',
          '-i', input,
          '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart', '-an',
          '-max_muxing_queue_size', '1024',
          '-fs', String(MAX_OUTPUT),
          '-f', 'mp4', out,
        ],
        timeoutMs: FFMPEG_TIMEOUT_MS,
        outMime: 'video/mp4',
      }),
    },
  };

  const route = routes[path];
  if (!route) {
    rejectJson(req, res, 404, { error: 'unknown endpoint' });
    return;
  }
  if (method !== 'POST') {
    res.setHeader('Allow', 'POST');
    rejectJson(req, res, 405, { error: 'method not allowed: conversions take a POST body' });
    return;
  }

  handleConvert(req, res, url.searchParams, route).catch((err) => {
    sendJson(res, 500, { error: 'internal error' });
    if (LOG_REQUESTS) console.error('[w8rez] handler error:', err && err.message);
  });
}

/* ------------------------------------------------------------------ *
 *  Static files
 * ------------------------------------------------------------------ */

/** Only these top-level directories are served. Everything else is 404. */
const ALLOWED_TOP_DIRS = new Set(['js', 'css', 'vendor', 'samples', 'assets', 'icons']);

/** Only these root-level files are served; the package source stays private. */
const ROOT_FILES = new Set(['index.html', 'favicon.ico', 'robots.txt']);

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serves a static file with defence in depth:
 *   - GET/HEAD only
 *   - dotfile segments are invisible (.git, .env, .gitignore …)
 *   - only allowlisted top-level directories and root files are reachable
 *   - only allowlisted extensions are served
 *   - the resolved path must stay inside the package root
 *   - files are streamed, never buffered
 */
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, 'method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    sendText(res, 400, 'bad request');
    return;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    sendText(res, 404, 'not found');
    return;
  }

  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) {
    sendText(res, 404, 'not found');
    return;
  }

  let rel;
  if (segments.length === 0) {
    rel = 'index.html';
  } else if (segments.length === 1 && ROOT_FILES.has(segments[0])) {
    rel = segments[0];
  } else if (ALLOWED_TOP_DIRS.has(segments[0])) {
    rel = segments.join('/');
  } else {
    sendText(res, 404, 'not found');
    return;
  }

  const ext = path.extname(rel).toLowerCase();
  if (!STATIC_MIME[ext]) {
    sendText(res, 404, 'not found');
    return;
  }

  const filePath = path.resolve(ROOT, rel);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    sendText(res, 404, 'not found');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendText(res, 404, 'not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': STATIC_MIME[ext],
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => res.destroy());
    res.on('error', () => stream.destroy());
  });
}

/* ------------------------------------------------------------------ *
 *  Host header validation (DNS-rebinding protection)
 * ------------------------------------------------------------------ */

function hostAllowed(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return false;
  const bracketed = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  const name = bracketed ? '[' + bracketed[1] + ']' : raw.split(':')[0];
  return ALLOWED_HOSTS.has(name);
}

/* ------------------------------------------------------------------ *
 *  Server
 * ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  // A client that aborts mid-transfer must never take the server down.
  res.on('error', () => {});
  req.on('error', () => {});

  if (LOG_REQUESTS) {
    res.on('finish', () => {
      console.log('[w8rez] ' + req.method + ' ' + (req.url || '-') + ' → ' + res.statusCode + ' (' + (Date.now() - startedAt) + ' ms)');
    });
  }

  applySecurityHeaders(res);

  if (!hostAllowed(req.headers.host)) {
    rejectJson(req, res, 421, { error: 'untrusted Host header' });
    return;
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    sendText(res, 400, 'bad request');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
  } else {
    serveStatic(req, res, url);
  }
});

// Malformed HTTP at the socket level: answer 400 and drop, never crash.
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.requestTimeout = 300000;
server.headersTimeout = 60000;
server.keepAliveTimeout = 5000;

/* ------------------------------------------------------------------ *
 *  Lifecycle
 * ------------------------------------------------------------------ */

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nw8rez: received ' + signal + ' — shutting down…');
  for (const child of activeChildren) {
    try {
      child.kill('SIGKILL');
    } catch (_) { /* already gone */ }
  }
  server.close(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) { /* best effort */ }
    process.exit(0);
  });
  // Force-exit if close() hangs on keep-alive sockets.
  setTimeout(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) { /* best effort */ }
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (_) { /* best effort */ }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('  w8rez: port ' + PORT + ' is already in use.');
    console.error('');
    console.error('  Options:');
    console.error('    • run on another port:   PORT=8081 node server.js');
    console.error('    • or stop the process that owns the port, e.g.:  fuser -k ' + PORT + '/tcp');
    console.error('');
    process.exit(1);
  }
  console.error('  w8rez: server error:', err.message);
  process.exit(1);
});

const BANNER = [
  '█   █   ███   █████  █████  █████',
  '█   █  █   █  █   █  █          █',
  '█ █ █   ███   ████   ████     █  ',
  '██ ██  █   █  █  █   █       █   ',
  '█   █   ███   █   █  █████  █████',
].join('\n');

server.listen(PORT, HOST, () => {
  const gs = detectTool('gs');
  const ff = detectTool('ffmpeg');
  const boundPort = server.address().port;
  console.log('');
  console.log(BANNER);
  console.log('');
  console.log('  w8rez v' + pkg.version + '  →  http://' + (HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST) + ':' + boundPort);
  console.log('  ghostscript: ' + (gs ? 'available (' + gs.version + ') — EPS and PDF conversion enabled'
    : 'not installed — EPS falls back to embedded previews'));
  console.log('  ffmpeg:      ' + (ff ? 'available (' + ff.version + ') — video transcoding enabled'
    : 'not installed — only browser-native video formats'));
  if (TOOLS_DISABLED.size) {
    console.log('  disabled tools: ' + Array.from(TOOLS_DISABLED).join(', '));
  }
  if (!LOOPBACK.has(HOST)) {
    console.log('');
    console.log('  ⚠ LISTENING ON A NON-LOOPBACK INTERFACE (' + HOST + ').');
    console.log('    The conversion endpoints accept file uploads from anyone who can');
    console.log('    reach this port. Do not expose w8rez to untrusted networks.');
  }
  console.log('');
});

/*
 * w8rez — server integration tests (plain Node, zero dependencies).
 * Run: node tests/server.test.js   (or: npm run test:server)
 *
 * Boots real server instances on ephemeral ports and exercises the security
 * controls and the conversion endpoints. Conversion tests are skipped (not
 * failed) when ghostscript/ffmpeg are not installed on the machine.
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name + (detail ? '\n    ' + detail : ''));
    process.exitCode = 1;
  }
}

/* helpers ------------------------------------------------------------ */

function startServer(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: '0', W8REZ_LOG: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not boot:\n' + output)), 8000);
    child.stdout.on('data', () => {
      const m = output.match(/http:\/\/[^\s]+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('server exited early (' + code + '):\n' + output));
    });
  });
  return { child, ready, output: () => output };
}

function stopServer(instance) {
  return new Promise((resolve) => {
    instance.child.on('exit', resolve);
    instance.child.kill('SIGTERM');
    setTimeout(() => {
      instance.child.kill('SIGKILL');
      resolve();
    }, 2000);
  });
}

/** GET/POST via fetch; returns {status, headers, buffer}. */
async function req(base, pathname, options) {
  const res = await fetch(base + pathname, options);
  return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
}

/** Raw HTTP/1.1 request (send arbitrary headers, e.g. Host). */
function raw(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: pathname, headers, method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

/** Builds a valid PNG buffer (RGBA, filter 0). */
function makePng(width, height, rgb) {
  function crc32(buf) {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (1 + width * 4) + 1 + x * 4;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; raw[o + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const EPS_SAMPLE = Buffer.from(
  '%!PS-Adobe-3.0 EPSF-3.0\n' +
    '%%BoundingBox: 0 0 40 40\n' +
    '1 0 0 setrgbcolor 0 0 moveto 40 40 lineto 40 0 lineto 0 40 lineto fill\n' +
    'showpage\n',
  'latin1'
);

/* main ---------------------------------------------------------------- */

async function main() {
  console.log('w8rez — server tests\n');
  const main_ = startServer({});
  let base;
  try {
    base = await main_.ready;
  } catch (e) {
    console.error('  ✗ boot: ' + e.message);
    process.exit(1);
  }
  const port = Number(new URL(base).port);
  console.log('  server: ' + base + '\n');

  /* ── health & status ── */
  {
    const health = await req(base, '/api/health');
    const body = JSON.parse(health.buffer.toString());
    ok('health: 200 + status ok + version', health.status === 200 && body.status === 'ok' && !!body.version);

    const status = await req(base, '/api/status');
    const s = JSON.parse(status.buffer.toString());
    ok(
      'status: tool report shape',
      status.status === 200 &&
        typeof s.ghostscript === 'object' &&
        typeof s.ffmpeg === 'object' &&
        typeof s.ghostscript.available === 'boolean'
    );
  }

  /* ── security headers ── */
  {
    const res = await req(base, '/api/health');
    ok(
      'security headers on API responses',
      res.headers.get('x-content-type-options') === 'nosniff' &&
        res.headers.get('x-frame-options') === 'DENY' &&
        res.headers.get('referrer-policy') === 'no-referrer'
    );
  }

  /* ── static serving rules ── */
  {
    const index = await req(base, '/');
    ok('index served', index.status === 200 && index.buffer.toString().includes('<html lang="en">'));
    ok(
      'index served with CSP',
      typeof index.headers.get('content-security-policy') === 'string'
    );
    const engine = await req(base, '/js/ascii.js');
    ok('js/ served', engine.status === 200);
    const css = await req(base, '/css/style.css');
    ok('css/ served', css.status === 200);
    const vendor = await req(base, '/vendor/pdfjs/pdf.min.mjs');
    ok('vendor/ served', vendor.status === 200);
    const sample = await req(base, '/samples/demo.png');
    ok('samples/ served', sample.status === 200);

    ok('dotfiles blocked', (await req(base, '/.gitignore')).status === 404);
    ok('.git blocked', (await req(base, '/.git/config')).status === 404);
    ok('encoded traversal blocked', (await req(base, '/%2e%2e%2fpackage.json')).status === 404);
    ok('dot-dot path blocked', (await req(base, '/../../etc/passwd')).status === 404);
    ok('null byte blocked', (await req(base, '/%00')).status === 404);
    ok('package source not served', (await req(base, '/server.js')).status === 404);
    ok('tests/ not served', (await req(base, '/tests/engine.test.js')).status === 404);
    ok('docs/ not served', (await req(base, '/docs/README.md')).status === 404);
    ok('unknown static path 404 (no echo)', (await req(base, '/no/such/file.png')).status === 404);
    ok('extension not in allowlist 404', (await req(base, '/js/ascii.mjs.bak')).status === 404);

    const postIndex = await fetch(base + '/', { method: 'POST' });
    ok('POST to static file: 405', postIndex.status === 405);
  }

  /* ── API method / routing discipline ── */
  {
    ok('unknown endpoint: 404', (await req(base, '/api/nope')).status === 404);
    const getConvert = await req(base, '/api/video-to-mp4');
    ok('GET on conversion endpoint: 405', getConvert.status === 405);
    ok('Allow: POST advertised', getConvert.headers.get('allow') === 'POST');
    const del = await fetch(base + '/api/health', { method: 'DELETE' });
    ok('DELETE: 405', del.status === 405);
  }

  /* ── Host header validation (raw request; fetch normalises Host) ── */
  {
    const evil = await raw(port, '/api/health', { Host: 'evil.example.com' });
    ok('foreign Host header: 421', evil.status === 421);
    const okHost = await raw(port, '/api/health', { Host: 'localhost:' + port });
    ok('localhost Host accepted', okHost.status === 200);
    const noPortHost = await raw(port, '/api/health', { Host: '127.0.0.1' });
    ok('Host without port accepted', noPortHost.status === 200);
  }

  /* ── upload validation ── */
  {
    const bad = await req(base, '/api/frames-to-mp4', {
      method: 'POST',
      body: 'this is definitely not a PNG stream',
    });
    ok('non-PNG upload: 415', bad.status === 415);
    ok('415 body explains the expectation', /png/i.test(bad.buffer.toString()));

    const wrongRoute = await req(base, '/api/pdf-to-png', { method: 'POST', body: EPS_SAMPLE });
    ok('EPS posted to the PDF endpoint: 415', wrongRoute.status === 415);

    const healthAfter = await req(base, '/api/health');
    ok('server healthy after rejected uploads', healthAfter.status === 200);
  }

  /* ── conversions (skipped when the tool is missing) ── */
  const status = JSON.parse((await req(base, '/api/status')).buffer.toString());

  if (status.ghostscript.available) {
    const r = await req(base, '/api/eps-to-png?dpi=72', { method: 'POST', body: EPS_SAMPLE });
    ok('eps→png converts', r.status === 200 && r.headers.get('content-type') === 'image/png');
    ok('png magic in response', r.buffer[0] === 0x89 && r.buffer[1] === 0x50);

    const bad = await req(base, '/api/eps-to-png', {
      method: 'POST',
      body: Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n this_is_not_valid_postscript %%'),
    });
    ok('failing PostScript: 422', bad.status === 422);
  } else {
    console.log('  – ghostscript not installed: conversion tests skipped');
  }

  if (status.ffmpeg.available) {
    const frames = Buffer.concat([
      makePng(64, 64, [255, 0, 0]),
      makePng(64, 64, [0, 255, 0]),
      makePng(64, 64, [0, 0, 255]),
      makePng(64, 64, [255, 255, 0]),
    ]);
    const r = await req(base, '/api/frames-to-mp4?fps=10', { method: 'POST', body: frames });
    ok('frames→mp4 converts', r.status === 200 && r.headers.get('content-type') === 'video/mp4');
    ok('mp4 starts with an ftyp box', r.buffer.toString('latin1', 4, 8) === 'ftyp');

    const badFps = await req(base, '/api/frames-to-mp4?fps=99999', { method: 'POST', body: frames });
    ok('fps is clamped, not trusted (still converts)', badFps.status === 200);
  } else {
    console.log('  – ffmpeg not installed: conversion tests skipped');
  }

  await stopServer(main_);

  /* ── instance with tools disabled ── */
  {
    const inst = startServer({ W8REZ_DISABLE_TOOLS: 'all' });
    const disabledBase = await inst.ready;
    const r = await req(disabledBase, '/api/eps-to-png', { method: 'POST', body: EPS_SAMPLE });
    ok('W8REZ_DISABLE_TOOLS=all → 501', r.status === 501);
    const st = JSON.parse((await req(disabledBase, '/api/status')).buffer.toString());
    ok('status reports tools unavailable when disabled', st.ghostscript.available === false);
    await stopServer(inst);
  }

  /* ── instance with a 1 MB upload cap ── */
  {
    const inst = startServer({ W8REZ_MAX_UPLOAD_MB: '1' });
    const strictBase = await inst.ready;
    let status413 = null;
    let threw = false;
    try {
      const r = await fetch(strictBase + '/api/frames-to-mp4', {
        method: 'POST',
        body: Buffer.alloc(2 * 1024 * 1024, 0x41),
      });
      status413 = r.status;
    } catch (_) {
      threw = true; // the socket may be cut while the oversized body is draining
    }
    ok('oversized upload rejected (413)', threw || status413 === 413, 'status=' + status413);
    await stopServer(inst);
  }

  /* ── summary ── */
  console.log('\n' + passed + ' tests OK' + (failed ? ', ' + failed + ' FAILED' : ''));
  if (failed) {
    console.error('  ── there are failures ──');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});

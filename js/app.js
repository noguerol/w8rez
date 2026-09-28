/*
 * w8rez — UI glue: file → canvas → engine → preview / exports.
 *
 * Plain ES module (it imports pdf.js); no framework, no build step. Works
 * from a static server (recommended: `node server.js`, which also enables
 * the EPS/PDF/video helpers) or straight from the filesystem with a reduced
 * feature set.
 *
 * Hardening notes:
 *   - every grid is serialised through Renderer.buildHtmlFragment, the single
 *     implementation shared with the exports (glyph text is always escaped);
 *   - frame sampling is capped and every seek has a timeout, so a stalled
 *     media decoder can never freeze the UI thread's state machine;
 *   - transcodes cannot recurse forever and object URLs are revoked.
 */
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

(function () {
  'use strict';

  const Ascii = window.W8rez.Ascii;
  const Renderer = window.W8rez.Renderer;
  // Optional new-design shell (js/ui.js). Every call is guarded, so the app
  // still works with the previous markup when the module is missing.
  const UI = window.W8rez.UI;

  pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* Safety limits for the browser side. */
  const LIMITS = {
    MAX_TEXTS: 8, // text overlay inputs
    MAX_FRAMES: 600, // animation frames held in memory
    SEEK_TIMEOUT_MS: 10000, // per-frame seek deadline
    MAX_TRANSCODE_DEPTH: 2, // video → mp4 → mp4 attempts
    MAX_MP4_UPLOAD_MB: 200, // stop before the server's own limit
    RENDER_DEBOUNCE_MS: 120,
    PDF_PAGE_DEBOUNCE_MS: 250,
  };

  /* ------------------------------------------------------------------ *
   *  State
   * ------------------------------------------------------------------ */
  const state = {
    img: null, // { el: Image|Canvas, w, h, name }
    grid: null,
    cols: 100,
    charAspect: 0.5, // re-measured from the active font
    bgColor: '#000000',
    debounce: null,
    raster: null, // cached ImageData for the current still image
    pdf: null, // open pdf.js document
    pdfFileName: null,
    video: null, // { el, url, fileName, duration }
    videoFrames: null, // grids per frame
    videoMeta: null, // { start, end, fps, speed, totalFrames, animDur }
    videoTimer: null,
    videoIdx: 0,
    textSeed: 1, // seed for the deterministic random text layout
    zoom: 1, // preview zoom multiplier (driven by js/ui.js)
  };

  /* ------------------------------------------------------------------ *
   *  Elements
   * ------------------------------------------------------------------ */
  const els = {
    drop: $('#drop'),
    fileInput: $('#file-input'),
    fileName: $('#file-name'),
    imgInfo: $('#img-info'),
    fileCard: $('#file-card'),

    palette: $('#palette'),
    customPalette: $('#custom-palette'),
    customPaletteWrap: $('#custom-palette-wrap'),
    width: $('#width'),
    widthVal: $('#width-val'),
    dynamic: $('#dynamic'),
    invert: $('#invert'),
    mode: $('#mode'),
    theme: $('#theme'),
    fontFamily: $('#font-family'),
    fontSize: $('#font-size'),
    fsVal: $('#fs-val'),
    bgColor: $('#bg-color'),
    autoAspect: $('#auto-aspect'),
    pdfPage: $('#pdf-page'),
    pdfPageWrap: $('#pdf-page-wrap'),
    pdfPageLabel: $('#pdf-page-label'),
    videoGroup: $('#video-group'),
    vidSource: $('#vid-source'),
    vidStart: $('#vid-start'),
    vidEnd: $('#vid-end'),
    vidFill: $('#vid-fill'),
    vidFrom: $('#vid-from'),
    vidTo: $('#vid-to'),
    vidClip: $('#vid-clip'),
    vidAnim: $('#vid-anim'),
    vidCount: $('#vid-count'),
    vidFps: $('#vid-fps'),
    vidSpeed: $('#vid-speed'),
    btnVidGenerate: $('#btn-vid-generate'),
    btnVidPlay: $('#btn-vid-play'),
    btnVidWebm: $('#btn-vid-webm'),
    btnVidMp4: $('#btn-vid-mp4'),
    btnVidHtml: $('#btn-vid-html'),
    frameInfo: $('#frame-info'),
    textToggle: $('#text-toggle'),
    textControls: $('#text-controls'),
    textRandom: $('#text-random'),
    textCount: $('#text-count'),
    textCountVal: $('#text-count-val'),
    textInputs: $('#text-inputs'),
    textUse: $('#text-use'),
    textRepeat: $('#text-repeat'),

    tabs: $$('.tab'),
    preview: $('#preview'),
    originalView: $('#original-view'),
    codeOut: $('#code-out'),
    txtOut: $('#txt-out'),
    meta: $('#meta'),
    status: $('#status'),

    btnTxt: $('#btn-txt'),
    btnPng: $('#btn-png'),
    btnHtml: $('#btn-html'),
    btnCopy: $('#btn-copy'),
  };

  const STATUS_ERROR = '#ff7b72';

  /** Writes the Generate button label without destroying its icon. */
  function setGenerateLabel(text) {
    const label = document.getElementById('btn-vid-generate-label');
    if (label) label.textContent = text;
    else els.btnVidGenerate.textContent = text;
  }

  /** Sets the status line; resets the error colour. */
  function setStatus(message) {
    els.status.textContent = message;
    els.status.style.color = '';
  }

  /** Shows an error; the status line doubles as the message area. */
  function fail(message) {
    els.status.textContent = '✗ ' + message;
    els.status.style.color = STATUS_ERROR;
  }

  /* ------------------------------------------------------------------ *
   *  File decoding (bitmap + SVG + PDF + EPS + video)
   * ------------------------------------------------------------------ */

  const SVG_RE = /^image\/svg|\.svg($|\?)|<svg[\s>]/i;

  function loadFile(file) {
    els.pdfPageWrap.style.display = 'none'; // shown again for PDFs
    const name = file.name || '';
    if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
      loadPdf(file);
      return;
    }
    if (/\.eps$/i.test(name) || /postscript|application\/eps/i.test(file.type)) {
      loadEps(file);
      return;
    }
    if (VIDEO_EXT.test(name) || /^video\//.test(file.type)) {
      loadVideo(file, 0);
      return;
    }
    const isSvg = SVG_RE.test(file.type) || SVG_RE.test(file.name);
    const reader = new FileReader();
    reader.onerror = () => fail('The file could not be read.');
    if (isSvg) {
      reader.onload = (e) => decodeSvg(String(e.target.result), file.name);
      reader.readAsText(file);
      return;
    }
    reader.onload = (e) => decodeRaster(e.target.result, file.name);
    reader.readAsDataURL(file);
  }

  function decodeRaster(dataUrl, name) {
    const img = new Image();
    img.onload = () => setImage(img, name);
    img.onerror = () => fail('The image could not be decoded (unsupported format?).');
    img.src = dataUrl;
  }

  /**
   * SVG: rasterised by drawing it onto a canvas via a data URL. When the SVG
   * lacks a size, its viewBox (or 512×512) is used. The markup arrives as
   * text: fetching a data: URL is blocked by our own CSP (connect-src 'self'),
   * and the source text is what we need anyway.
   */
  function decodeSvg(svgText, name) {
    try {
      let { width, height } = svgDims(svgText);
      if (!width || !height) {
        const vb = (svgText.match(/viewBox\s*=\s*["']([^"']+)["']/) || [])[1];
        if (vb) {
          const p = vb.trim().split(/\s+/).map(Number);
          width = p[2] - p[0];
          height = p[3] - p[1];
        }
      }
      width = width || 512;
      height = height || 512;

      // Normalise with an explicit size (avoids rasterisation failures)
      const norm = svgText.replace(/<svg([^>]*?)>/, (m, attrs) => {
        const a = attrs
          .replace(/\swidth\s*=\s*["'][^"']*["']/i, '')
          .replace(/\sheight\s*=\s*["'][^"']*["']/i, '')
          .replace(/\sviewBox\s*=\s*["'][^"']*["']/i, '');
        return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"${a}>`;
      });

      const img = new Image();
      img.onload = () => setImage(img, name);
      img.onerror = () => fail('SVG could not be rasterised: check that it is valid and free of external references.');
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(norm);
    } catch (e) {
      fail('The SVG could not be read.');
    }
  }

  function svgDims(text) {
    const w = text.match(/\swidth\s*=\s*["']([^"']+)["']/i);
    const h = text.match(/\sheight\s*=\s*["']([^"']+)["']/i);
    return { width: w ? parseFloat(w[1]) : 0, height: h ? parseFloat(h[1]) : 0 };
  }

  function setImage(el, name) {
    // Leaving video mode (if we were in it) releases its resources.
    leaveVideoMode();
    const w = el.naturalWidth || el.width;
    const h = el.naturalHeight || el.height;
    state.img = { el, w, h, name };
    state.raster = null; // invalidate the pixel cache
    showFileCard(name, `${w} × ${h} px`);
    syncOriginalAvailable();
    setStatus('Image loaded ✓');
    render();
  }

  /**
   * Rasterises the current still image once and caches the pixel data, so
   * moving a slider does not re-decode the whole picture on every tick.
   */
  function getRaster() {
    const img = state.img;
    if (!img) return null;
    if (state.raster && state.raster.el === img.el) return state.raster;
    const canvas = document.createElement('canvas');
    canvas.width = img.w;
    canvas.height = img.h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img.el, 0, 0, img.w, img.h);
    const data = ctx.getImageData(0, 0, img.w, img.h).data;
    state.raster = { el: img.el, w: img.w, h: img.h, data };
    return state.raster;
  }

  /* ------------------------------------------------------------------ *
   *  PDF (pdf.js → canvas → engine)
   * ------------------------------------------------------------------ */

  function loadPdf(file) {
    setStatus('Opening PDF…');
    file
      .arrayBuffer()
      .then((buf) => pdfjsLib.getDocument({ data: buf }).promise)
      .then((pdf) => {
        state.pdf = pdf;
        state.pdfFileName = file.name;
        els.pdfPage.max = pdf.numPages;
        els.pdfPage.value = 1;
        els.pdfPageLabel.textContent = '1 / ' + pdf.numPages;
        els.pdfPageWrap.style.display = '';
        renderPdfPage(1);
      })
      .catch((e) => fail('The PDF could not be opened: ' + e.message));
  }

  /** Renders page n of the PDF to a canvas (~1600 px wide). */
  function renderPdfPage(n) {
    if (!state.pdf) return;
    setStatus('Rendering page ' + n + '…');
    state.pdf
      .getPage(n)
      .then((page) => {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.max(1, 1600 / base.width);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        return page
          .render({ canvasContext: ctx, viewport: vp })
          .promise.then(() => setImage(canvas, pageLabel(state.pdfFileName, n)));
      })
      .catch((e) => fail('The page could not be rendered: ' + e.message));
  }

  function pageLabel(name, page) {
    const base = name ? name.replace(/\.pdf$/i, '') : 'page';
    return page ? base + ' (p.' + page + ')' : name;
  }

  /* ------------------------------------------------------------------ *
   *  EPS (ghostscript via server → embedded JPEG preview fallback)
   * ------------------------------------------------------------------ */

  function loadEps(file) {
    setStatus('Converting EPS…');
    const bufP = file.arrayBuffer();

    const tryServer = () =>
      fetch('/api/eps-to-png?dpi=150', { method: 'POST', body: file })
        .then((r) => {
          if (!r.ok) {
            // the server answers with JSON describing the reason
            // (501 without gs, 422 when gs failed, 415 for non-EPS content…)
            return r
              .json()
              .catch(() => null)
              .then((j) => {
                throw new Error(j && j.error ? j.error : 'gs: HTTP ' + r.status);
              });
          }
          return r.blob();
        })
        .then(
          (blob) =>
            new Promise((resolve, reject) => {
              const url = URL.createObjectURL(blob);
              const img = new Image();
              img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
              };
              img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('gs produced an invalid PNG'));
              };
              img.src = url;
            })
        );

    tryServer()
      .then((img) => setImage(img, file.name))
      .catch((err) => {
        const reason = err && err.message ? err.message : 'network error';
        bufP.then((buf) => {
          const jpeg = window.W8rez.Eps.extractJpegPreview(buf);
          if (!jpeg) {
            fail(
              'EPS could not be converted (' +
                reason +
                ') and it has no embedded preview. ' +
                'For vector-only EPS files, install ghostscript and serve through `node server.js`.'
            );
            return;
          }
          setStatus('gs: ' + reason + ' — using the embedded preview…');
          const url = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            setImage(img, file.name + ' (preview)');
          };
          img.onerror = () => fail('The embedded JPEG preview could not be decoded.');
          img.src = url;
        });
      });
  }

  /* ------------------------------------------------------------------ *
   *  Video (frame sampling → animation / webm / mp4)
   * ------------------------------------------------------------------ */

  const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v|avi|mkv|flv|wmv|mpg|mpeg|ts|mts)$/i;

  function fmtTime(t) {
    if (!isFinite(t)) return '0:00.0';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  function leaveVideoMode() {
    stopVideoAnim();
    if (state.video && state.video.url) {
      try {
        URL.revokeObjectURL(state.video.url);
      } catch (_) { /* already revoked */ }
    }
    state.video = null;
    state.videoFrames = null;
    state.videoMeta = null;
    if (els.videoGroup) els.videoGroup.style.display = 'none';
  }

  function loadVideo(file, depth) {
    // leaves any previous video (revokes its object URL) before loading
    leaveVideoMode();
    state.img = null; // leave image mode
    state.raster = null;
    state.pdf = null;
    syncOriginalAvailable();
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;

    video.addEventListener(
      'loadedmetadata',
      () => {
        state.video = { el: video, url, fileName: file.name, duration: video.duration };
        state.videoFrames = null;
        state.videoMeta = null;
        state.videoIdx = 0;
        els.videoGroup.style.display = '';
        showFileCard(
          file.name,
          video.videoWidth + ' × ' + video.videoHeight + ' px · ' + fmtTime(video.duration)
        );
        syncOriginalAvailable();
        if (UI && UI.openAccordion) UI.openAccordion('acc-video');
        syncSummaries();
        setStatus('Video loaded ✓');
        els.vidSource.src = url;
        els.vidStart.max = video.duration;
        els.vidStart.value = 0;
        els.vidEnd.max = video.duration;
        els.vidEnd.value = video.duration;
        els.btnVidGenerate.disabled = false;
        setGenerateLabel('Generate frames');
        setVideoGenerating(false);
        els.btnVidWebm.style.display = 'none';
        els.btnVidMp4.style.display = 'none';
        els.btnVidHtml.style.display = 'none';
        updateRangeUI();
        // first frame as the static preview
        sampleFrame(0)
          .then(({ data, w, h }) => {
            const grid = Ascii.toGrid(data, w, h, imageOpts());
            const stamped = els.textToggle.checked ? Ascii.stampText(grid, textOptions()) : grid;
            state.videoFrames = [stamped];
            state.videoMeta = null;
            drawFrame(state.videoFrames[0], 0);
            els.txtOut.value = Ascii.gridToText(grid);
            setStatus('Video loaded ✓ — press “Generate frames”');
          })
          .catch(() => fail('The first frame could not be sampled.'));
      },
      { once: true }
    );

    video.addEventListener(
      'error',
      () => {
        URL.revokeObjectURL(url);
        if (depth >= LIMITS.MAX_TRANSCODE_DEPTH) {
          fail('The video format is not supported by this browser and transcoding did not help.');
          return;
        }
        setStatus('Format not supported by the browser — trying ffmpeg…');
        transcodeVideo(file, depth);
      },
      { once: true }
    );

    video.load();
  }

  /** Transcodes a non-playable video (avi, mkv…) with ffmpeg on the server. */
  function transcodeVideo(file, depth) {
    fetch('/api/video-to-mp4', { method: 'POST', body: file })
      .then((r) => {
        if (!r.ok) {
          return r
            .json()
            .catch(() => null)
            .then((j) => {
              throw new Error(j && j.error ? j.error : 'ffmpeg: HTTP ' + r.status);
            });
        }
        return r.blob();
      })
      .then((blob) => {
        if (blob.size === 0) throw new Error('ffmpeg returned no data');
        const name = file.name.replace(/\.[^.]+$/, '') + '.mp4';
        loadVideo(new File([blob], name, { type: 'video/mp4' }), depth + 1);
      })
      .catch((e) =>
        fail(
          'Unsupported video (' +
            e.message +
            '). Convert it to mp4/webm, or install ffmpeg on the server.'
        )
      );
  }

  /**
   * Seeks to instant t and resolves with the frame's pixels. The seek has a
   * hard deadline: a media decoder that never fires `seeked` must not leave
   * the generation loop hanging forever.
   */
  function sampleFrame(t) {
    return new Promise((resolve, reject) => {
      const v = state.video && state.video.el;
      if (!v) {
        reject(new Error('the video was closed'));
        return;
      }
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        v.removeEventListener('seeked', onSeeked);
      };
      const onSeeked = () => {
        cleanup();
        try {
          const canvas = document.createElement('canvas');
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(v, 0, 0);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          resolve({ data, w: canvas.width, h: canvas.height });
        } catch (e) {
          reject(e);
        }
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('seek timed out'));
      }, LIMITS.SEEK_TIMEOUT_MS);
      v.addEventListener('seeked', onSeeked);
      const target = Math.max(0, Math.min(t, (v.duration || 0) - 0.05));
      if (v.readyState >= 2) {
        v.currentTime = target;
      } else {
        v.addEventListener(
          'loadeddata',
          () => {
            v.currentTime = target;
          },
          { once: true }
        );
      }
    });
  }

  /**
   * Generation state: the generate button shows a spinner plus progress while
   * play/range/fps/speed controls are locked.
   */
  function setVideoGenerating(on, total, done) {
    els.btnVidGenerate.disabled = on;
    els.btnVidGenerate.classList.toggle('busy', !!on);
    const spinner = els.btnVidGenerate.querySelector('.spinner');
    if (spinner) spinner.hidden = !on;
    setGenerateLabel(
      on ? 'Generating…' + (total ? ' ' + (done || 0) + '/' + total : '') : 'Generate frames'
    );
    const hasFrames = !!(state.videoFrames && state.videoFrames.length >= 2);
    els.btnVidPlay.disabled = on || !hasFrames;
    els.btnVidPlay.title = els.btnVidPlay.disabled
      ? 'Generate the frames first'
      : 'Play the animation in the preview';
    [els.vidStart, els.vidEnd, els.vidFps, els.vidSpeed].forEach((el) => {
      el.disabled = on;
    });
    if (!on) stopVideoAnim();
  }

  /** Generates every frame of the selected range according to fps and speed. */
  async function generateFrames() {
    if (!state.video) return;
    const start = parseFloat(els.vidStart.value);
    const end = parseFloat(els.vidEnd.value);
    const fps = parseInt(els.vidFps.value, 10);
    const speed = parseFloat(els.vidSpeed.value);
    const animDur = (end - start) / speed;
    let totalFrames = Math.max(1, Math.round(animDur * fps));
    let clamped = false;
    if (totalFrames > LIMITS.MAX_FRAMES) {
      totalFrames = LIMITS.MAX_FRAMES;
      clamped = true;
    }
    const frames = [];
    setVideoGenerating(true, totalFrames);
    setStatus('Generating ' + totalFrames + ' frames…' + (clamped ? ' (capped at ' + LIMITS.MAX_FRAMES + ')' : ''));
    for (let i = 0; i < totalFrames; i++) {
      const t = start + (i / totalFrames) * (end - start);
      try {
        const { data, w, h } = await sampleFrame(t);
        const grid = Ascii.toGrid(data, w, h, imageOpts());
        frames.push(els.textToggle.checked ? Ascii.stampText(grid, textOptions()) : grid);
      } catch (e) {
        fail('Error sampling frame ' + (i + 1) + ': ' + e.message);
        break;
      }
      if (i % 5 === 0) {
        setStatus('Frames ' + (i + 1) + '/' + totalFrames + '…');
        setVideoGenerating(true, totalFrames, i + 1);
        // let the browser breathe between frames
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    state.videoFrames = frames;
    state.videoMeta = { start, end, fps, speed, totalFrames: frames.length, animDur };
    setVideoGenerating(false);
    els.vidCount.textContent = frames.length;
    els.vidAnim.textContent = fmtTime(animDur);
    if (frames.length >= 2) {
      setStatus(frames.length + ' frames generated ✓' + (clamped ? ' (clipped to the ' + LIMITS.MAX_FRAMES + '-frame limit)' : ''));
    } else if (frames.length === 1) {
      setStatus('Only 1 frame was generated — widen the range or lower the speed.');
    }
    els.btnVidWebm.style.display = '';
    els.btnVidMp4.style.display = '';
    els.btnVidHtml.style.display = '';
    syncSummaries();
    if (frames.length) drawFrame(frames[0], 0);
  }

  function drawFrame(grid, i) {
    renderPreviewHtml(grid);
    els.frameInfo.textContent =
      'frame ' + (i + 1) + ' / ' + (state.videoFrames ? state.videoFrames.length : '—');
    updateBadge(grid);
  }

  function playVideoPreview() {
    if (!state.videoFrames || state.videoFrames.length < 2) {
      fail('Generate the frames first.');
      return;
    }
    stopVideoAnim();
    state.videoIdx = 0;
    drawFrame(state.videoFrames[0], 0);
    const fps = parseInt(els.vidFps.value, 10);
    const speed = parseFloat(els.vidSpeed.value);
    const interval = 1000 / (fps * speed);
    els.btnVidPlay.textContent = '⏸ Stop';
    setStatus('Playing…');
    state.videoTimer = setInterval(() => {
      state.videoIdx++;
      if (state.videoIdx >= state.videoFrames.length) {
        stopVideoAnim();
        setStatus('Playback finished');
        return;
      }
      drawFrame(state.videoFrames[state.videoIdx], state.videoIdx);
    }, interval);
  }

  function stopVideoAnim() {
    if (state.videoTimer) {
      clearInterval(state.videoTimer);
      state.videoTimer = null;
    }
    if (els.btnVidPlay) els.btnVidPlay.textContent = '▶ Play';
  }

  /** Records the animation to .webm with MediaRecorder (real time, client). */
  function recordWebm() {
    if (!state.videoFrames || state.videoFrames.length < 2) {
      fail('Generate the frames first.');
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
      fail('MediaRecorder is not available in this browser.');
      return;
    }
    const fps = parseInt(els.vidFps.value, 10);
    const speed = parseFloat(els.vidSpeed.value);
    const frames = state.videoFrames;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const drawOpts = canvasDrawOpts();
    try {
      Renderer.drawGridToCanvas(canvas, ctx, frames[0], drawOpts);
    } catch (e) {
      fail(e.message);
      return;
    }
    const stream = canvas.captureStream(fps);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      download(baseName(state.video.fileName) + '.webm', blob, 'video/webm');
      setStatus('WebM video saved ✓');
    };
    rec.start();
    let idx = 0;
    const interval = 1000 / (fps * speed);
    setStatus(
      'Recording video… (' + Math.round(state.videoMeta ? state.videoMeta.animDur : 0) + ' s)'
    );
    const timer = setInterval(() => {
      idx++;
      if (idx >= frames.length) {
        clearInterval(timer);
        setStatus('Finalising video…');
        rec.stop();
        return;
      }
      Renderer.drawGridToCanvas(canvas, ctx, frames[idx], drawOpts);
    }, interval);
  }

  /**
   * Exports the animation to H.264 MP4 offline: every frame is drawn to a
   * PNG, the frames are uploaded as one stream and ffmpeg assembles them at
   * the exact framerate (no real-time limit).
   */
  async function recordMp4() {
    if (!state.videoFrames || state.videoFrames.length < 2) {
      fail('Generate the frames first.');
      return;
    }
    const fps = parseInt(els.vidFps.value, 10);
    const frames = state.videoFrames;
    const drawOpts = canvasDrawOpts();
    const tmp = document.createElement('canvas');
    const tctx = tmp.getContext('2d');
    const out = document.createElement('canvas');
    const octx = out.getContext('2d');
    els.btnVidMp4.disabled = true;
    const parts = [];
    let totalBytes = 0;
    try {
      for (let i = 0; i < frames.length; i++) {
        Renderer.drawGridToCanvas(tmp, tctx, frames[i], drawOpts);
        // H.264 (yuv420p) requires even dimensions
        const w = tmp.width - (tmp.width % 2);
        const h = tmp.height - (tmp.height % 2);
        if (out.width !== w) out.width = w;
        if (out.height !== h) out.height = h;
        octx.drawImage(tmp, 0, 0, w, h);
        const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
        totalBytes += blob.size;
        if (totalBytes > LIMITS.MAX_MP4_UPLOAD_MB * 1024 * 1024) {
          throw new Error(
            'the frame set is larger than ' + LIMITS.MAX_MP4_UPLOAD_MB + ' MB — reduce the range, the width or the framerate'
          );
        }
        parts.push(blob);
        if (i % 10 === 0) setStatus('PNG ' + (i + 1) + '/' + frames.length + '…');
        await new Promise((r) => setTimeout(r, 0));
      }
    } catch (e) {
      els.btnVidMp4.disabled = false;
      fail('mp4 export failed: ' + e.message);
      return;
    }
    els.btnVidMp4.disabled = false;
    const body = new Blob(parts, { type: 'image/png' });
    setStatus('Uploading ' + Math.round(body.size / 1024) + ' KB to ffmpeg…');
    try {
      const res = await fetch('/api/frames-to-mp4?fps=' + fps, { method: 'POST', body });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j && j.error ? j.error : 'ffmpeg: HTTP ' + res.status);
      }
      const blob = await res.blob();
      download(baseName(state.video.fileName) + '.mp4', blob, 'video/mp4');
      setStatus('MP4 video saved ✓');
    } catch (e) {
      fail('mp4 failed: ' + e.message);
    }
  }

  /** Exports the animation as a self-contained HTML document. */
  function exportAnimHtml() {
    if (!state.videoFrames || !state.videoFrames.length) return;
    const frames = state.videoFrames.map((g) => gridToHtml(g));
    const meta = state.videoMeta || {};
    const html = Renderer.buildAnimHtml({
      title: state.video.fileName,
      frames,
      fps: parseInt(els.vidFps.value, 10),
      speed: parseFloat(els.vidSpeed.value),
      mode: els.mode.value,
      fontFamily: els.fontFamily.value,
      fontSize: parseInt(els.fontSize.value, 10),
      theme: els.theme.value,
      bgColor: state.bgColor,
      meta: {
        source: state.video.fileName,
        start: meta.start,
        end: meta.end,
        totalFrames: frames.length,
      },
    });
    download(baseName(state.video.fileName) + '-anim.html', html, 'text/html;charset=utf-8');
    setStatus('HTML animation saved ✓');
  }

  /* ------------------------------------------------------------------ *
   *  Conversion
   * ------------------------------------------------------------------ */

  /** Conversion options from the current controls. */
  function imageOpts() {
    return {
      cols: state.cols,
      palette: customPalette(),
      dynamicRange: els.dynamic.checked,
      invert: els.invert.checked,
      // auto: the real measured ratio of the active font; off: classic
      // terminal ratio 0.5
      charAspect: els.autoAspect.checked ? state.charAspect : 0.5,
      bgColor: state.bgColor,
    };
  }

  function render() {
    // video mode: redraw the current frame with the live colour mode
    if (state.video && state.videoFrames && state.videoFrames.length) {
      const idx = Math.min(state.videoIdx, state.videoFrames.length - 1);
      const g = state.videoFrames[idx];
      renderPreviewHtml(g);
      els.txtOut.value = Ascii.gridToText(g);
      updateBadge(g);
      return;
    }
    if (!state.img) return;
    const raster = getRaster();
    if (!raster) return;

    const opts = imageOpts();
    let grid;
    try {
      grid = Ascii.toGrid(raster.data, raster.w, raster.h, opts);
    } catch (e) {
      fail(e.message);
      return;
    }

    // text overlay (works with any palette)
    if (els.textToggle.checked) {
      grid = Ascii.stampText(grid, textOptions());
    }
    state.grid = grid;

    if (grid.paletteFallback) {
      setStatus('The custom palette is unusable — using the default palette.');
    }
    renderPreview();
    renderCode();
    renderMeta();
    updateBadge();
  }

  /** Reads the text controls and builds the stampText options. */
  function textOptions() {
    const count = Math.max(1, Math.min(parseInt(els.textCount.value, 10) || 1, LIMITS.MAX_TEXTS));
    const texts = [];
    for (let i = 1; i <= count; i++) {
      const el = document.getElementById('text-' + i);
      if (el) texts.push(el.value);
    }
    return {
      texts,
      mode: els.textUse.value,
      repeat: parseInt(els.textRepeat.value, 10) || 1,
      random: els.textRandom.checked,
      // the seed stays fixed for a whole generation so every frame of a video
      // keeps the text in the same place; it is renewed when the checkbox is
      // toggled
      seed: state.textSeed,
    };
  }

  /** Serialises a grid with the shared builder (same code as the exports). */
  function gridToHtml(grid) {
    return Renderer.buildHtmlFragment(grid, {
      mode: els.mode.value,
      invert: els.invert.checked,
      preFg: els.theme.value === 'light' ? Renderer.THEMES.light.preFg : Renderer.THEMES.dark.preFg,
    });
  }

  /** Paints a grid into the preview <pre> and applies theme styles. */
  function renderPreviewHtml(grid) {
    els.preview.innerHTML = gridToHtml(grid);
    applyPreviewStyles();
  }

  /** Applies theme and background colour to the preview frame (live). */
  function applyPreviewStyles() {
    const light = els.theme.value === 'light';
    const wrap = document.querySelector('.ascii-wrap');
    if (wrap) {
      wrap.style.background = state.bgColor;
      wrap.style.borderColor = light ? '#d0d7de' : '';
    }
    // the zoom multiplier is applied on top of the base size from #font-size
    const baseSize = parseInt(els.fontSize.value, 10) || 16;
    const zoom = state.zoom > 0 ? state.zoom : 1;
    els.preview.style.fontFamily = els.fontFamily.value;
    els.preview.style.fontSize = baseSize * zoom + 'px';
    els.preview.style.lineHeight = baseSize * zoom + 'px';
    els.preview.style.color = light ? Renderer.THEMES.light.preFg : Renderer.THEMES.dark.preFg;
  }

  function renderPreview() {
    renderPreviewHtml(state.grid);
  }

  function renderCode() {
    const img = state.img || {};
    els.codeOut.value = Renderer.renderHtml({
      title: img.name || 'image',
      grid: state.grid,
      mode: els.mode.value,
      fontFamily: els.fontFamily.value,
      fontSize: parseInt(els.fontSize.value, 10),
      theme: els.theme.value,
      invert: els.invert.checked,
      bgColor: state.bgColor,
      meta: {
        source: img.name,
        w: img.w,
        h: img.h,
        dynamicRange: els.dynamic.checked,
      },
    });
    els.txtOut.value = Renderer.renderTxt(state.grid);
  }

  function renderMeta() {
    const g = state.grid;
    els.meta.textContent =
      g.cols + '×' + g.rows + ' · palette ' + customPalette().length +
      ' · luminance ' + (g.min | 0) + '–' + (g.max | 0) +
      ' · glyph aspect ' + state.charAspect.toFixed(3);
  }

  /* ------------------------------------------------------------------ *
   *  Control utilities
   * ------------------------------------------------------------------ */

  function customPalette() {
    const sel = els.palette.value;
    if (sel === 'custom') return els.customPalette.value;
    return Ascii.PALETTES[sel] ? Ascii.PALETTES[sel].chars : Ascii.DEFAULT_PALETTE;
  }

  function syncPaletteInput() {
    const isCustom = els.palette.value === 'custom';
    els.customPalette.disabled = !isCustom;
    if (els.customPaletteWrap) {
      els.customPaletteWrap.hidden = !isCustom;
      els.customPaletteWrap.style.display = isCustom ? '' : 'none';
    }
  }

  /** Re-measures the active font's aspect ratio (called on font changes). */
  function remeasureAspect() {
    const measured = Renderer.measureCharAspect(els.fontFamily.value);
    if (measured) state.charAspect = measured;
  }

  function scheduleRender() {
    clearTimeout(state.debounce);
    state.debounce = setTimeout(render, LIMITS.RENDER_DEBOUNCE_MS);
  }

  /* ------------------------------------------------------------------ *
   *  Exports / downloads
   * ------------------------------------------------------------------ */

  function baseName(name) {
    let n = String(name || 'ascii').replace(/\s*\(p\.\d+\)\s*$/i, '');
    n = n.replace(/\.[^.]+$/, '');
    return n || 'ascii';
  }

  function download(filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /** Converts a data URL to a Blob (for the PNG download). */
  function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(',');
    const mime = (head.match(/data:(.*?)[;,]/) || [])[1] || 'application/octet-stream';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function copyText(text) {
    navigator.clipboard
      .writeText(text)
      .then(() => setStatus('Copied to the clipboard ✓'))
      .catch(() => setStatus('The text could not be copied (permission denied).'));
  }

  /** Shared drawing options for the PNG/WebM/MP4 raster path. */
  function canvasDrawOpts() {
    return {
      mode: els.mode.value,
      fontFamily: els.fontFamily.value,
      fontSize: parseInt(els.fontSize.value, 10),
      theme: els.theme.value,
      invert: els.invert.checked,
      bgColor: state.bgColor,
    };
  }

  /* ------------------------------------------------------------------ *
   *  UI bridge (js/ui.js) — optional, additive, always guarded
   * ------------------------------------------------------------------ */

  /** Updates the file card (name + metadata) in the control panel. */
  function showFileCard(name, info) {
    els.fileName.textContent = name;
    els.imgInfo.textContent = info;
    if (els.fileCard) els.fileCard.hidden = false;
    if (UI && UI.setFileCard) UI.setFileCard(name, info);
  }

  /** Hides the file card and restores the empty placeholder text. */
  function hideFileCard() {
    els.fileName.textContent = '—';
    els.imgInfo.textContent = '';
    if (els.fileCard) els.fileCard.hidden = true;
    if (UI && UI.setFileCard) UI.setFileCard('', '');
  }

  /** Tells the shell whether "View original" has a source to show. */
  function syncOriginalAvailable() {
    if (UI && UI.setOriginalAvailable) UI.setOriginalAvailable(!!(state.img || state.video));
  }

  /** Preview badge: grid size when there is a grid, else the file name. */
  function updateBadge(grid) {
    if (!UI || !UI.setBadge) return;
    const g = grid || state.grid;
    if (g) UI.setBadge({ cols: g.cols, rows: g.rows });
    else if (state.video && state.video.fileName) UI.setBadge({ name: state.video.fileName });
    else if (state.img && state.img.name) UI.setBadge({ name: state.img.name });
    else UI.setBadge('No file');
  }

  /** Accordion summaries (text / video / render). */
  function syncSummaries() {
    if (!UI || !UI.setSummaries) return;
    UI.setSummaries({
      text: {
        enabled: !!(els.textToggle && els.textToggle.checked),
        count: els.textCount ? els.textCount.value : 1,
      },
      video: {
        clip: !!(state.video && state.video.fileName),
        frames: state.videoFrames ? state.videoFrames.length : 0,
      },
      render: { mode: els.mode.value, size: els.fontSize.value },
    });
  }

  /** Copies the current source (image/canvas or video frame) to #original-view. */
  function drawOriginalView() {
    const canvas = els.originalView;
    if (!canvas) return;
    const src = state.img ? state.img.el : state.video ? state.video.el : null;
    if (!src) return;
    const w = state.img ? state.img.w : state.video.el.videoWidth || src.width;
    const h = state.img ? state.img.h : state.video.el.videoHeight || src.height;
    if (!w || !h) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    try {
      ctx.drawImage(src, 0, 0, w, h);
    } catch (_) {
      // the browser may refuse a frame that is not ready yet
    }
  }

  /** Releases the loaded file and returns to the empty state. */
  function clearFile() {
    stopVideoAnim();
    leaveVideoMode();
    if (state.pdf && typeof state.pdf.destroy === 'function') {
      try {
        state.pdf.destroy();
      } catch (_) {
        // already closed
      }
    }
    state.img = null;
    state.grid = null;
    state.raster = null;
    state.pdf = null;
    state.pdfFileName = null;
    state.videoFrames = null;
    state.videoMeta = null;
    state.videoIdx = 0;

    els.preview.innerHTML = '';
    els.codeOut.value = '';
    els.txtOut.value = '';
    els.meta.textContent = '';
    els.frameInfo.textContent = '';
    if (els.videoGroup) els.videoGroup.style.display = 'none';
    if (els.pdfPageWrap) els.pdfPageWrap.style.display = 'none';
    if (els.vidSource) {
      try {
        els.vidSource.pause();
        els.vidSource.removeAttribute('src');
        els.vidSource.load();
      } catch (_) {
        // nothing to release
      }
    }
    if (els.fileInput) els.fileInput.value = '';

    hideFileCard();
    syncOriginalAvailable();
    updateBadge();
    syncSummaries();
    setStatus('Ready');
  }

  /* ------------------------------------------------------------------ *
   *  Events
   * ------------------------------------------------------------------ */

  // upload: click, keyboard and drag & drop
  els.drop.addEventListener('click', () => els.fileInput.click());
  els.drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  });
  els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
  els.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    els.drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  els.fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  });

  // controls → re-render
  els.palette.addEventListener('change', syncPaletteInput);
  els.palette.addEventListener('change', scheduleRender);
  els.customPalette.addEventListener('input', scheduleRender);
  els.width.addEventListener('input', () => {
    state.cols = parseInt(els.width.value, 10);
    els.widthVal.textContent = state.cols;
    scheduleRender();
  });
  els.dynamic.addEventListener('change', scheduleRender);
  els.autoAspect.addEventListener('change', scheduleRender);
  els.invert.addEventListener('change', scheduleRender);
  els.mode.addEventListener('change', () => {
    syncSummaries();
    scheduleRender();
  });
  els.theme.addEventListener('change', scheduleRender);
  // keep the header theme toggle in sync with the Render select
  els.theme.addEventListener('change', () => {
    if (UI && UI.syncThemeToggle) UI.syncThemeToggle();
  });
  els.fontFamily.addEventListener('change', () => {
    remeasureAspect(); // the aspect ratio depends on the active font
    scheduleRender();
  });
  els.fontSize.addEventListener('input', () => {
    els.fsVal.textContent = els.fontSize.value;
    syncSummaries();
    scheduleRender();
  });
  els.bgColor.addEventListener('input', () => {
    state.bgColor = els.bgColor.value;
    scheduleRender();
  });

  // new-design shell events (dispatched by js/ui.js; every handler is safe
  // even when that module is absent)
  document.addEventListener('w8rez:clearfile', clearFile);
  document.addEventListener('w8rez:zoom', (e) => {
    const z = e && e.detail ? parseFloat(e.detail.zoom) : 1;
    state.zoom = isFinite(z) && z > 0 ? z : 1;
    applyPreviewStyles();
  });
  document.addEventListener('w8rez:vieworiginal', (e) => {
    if (e && e.detail && e.detail.on) drawOriginalView();
  });

  // video: dual range, fps, speed, generation and playback
  function updateRangeUI() {
    if (!state.video) return;
    const s = parseFloat(els.vidStart.value);
    const e = parseFloat(els.vidEnd.value);
    const max = state.video.duration || 0;
    els.vidFrom.textContent = fmtTime(s);
    els.vidTo.textContent = fmtTime(e);
    els.vidFill.style.left = (s / max) * 100 + '%';
    els.vidFill.style.right = ((max - e) / max) * 100 + '%';
    els.vidClip.textContent = fmtTime(e - s);
    const fps = parseInt(els.vidFps.value, 10);
    const speed = parseFloat(els.vidSpeed.value);
    els.vidAnim.textContent = fmtTime((e - s) / speed);
    // Estimated frame count; the real one is written after generation.
    els.vidCount.textContent = String(frameEstimate(s, e, fps, speed));
  }

  /** Frames a clip would produce: animation duration × framerate, capped. */
  function frameEstimate(start, end, fps, speed) {
    const animDur = Math.max(0, end - start) / (speed || 1);
    return Math.min(LIMITS.MAX_FRAMES, Math.max(1, Math.round(animDur * fps)));
  }
  els.vidStart.addEventListener('input', () => {
    if (!state.video) return;
    if (parseFloat(els.vidStart.value) >= parseFloat(els.vidEnd.value) - 0.05) {
      els.vidStart.value = Math.max(0, parseFloat(els.vidEnd.value) - 0.05);
    }
    updateRangeUI();
  });
  els.vidEnd.addEventListener('input', () => {
    if (!state.video) return;
    if (parseFloat(els.vidEnd.value) <= parseFloat(els.vidStart.value) + 0.05) {
      els.vidEnd.value = Math.min(state.video.duration, parseFloat(els.vidStart.value) + 0.05);
    }
    updateRangeUI();
  });
  els.vidFps.addEventListener('change', updateRangeUI);
  els.vidSpeed.addEventListener('change', updateRangeUI);
  els.btnVidGenerate.addEventListener('click', generateFrames);
  els.btnVidPlay.addEventListener('click', () => {
    if (state.videoTimer) stopVideoAnim();
    else playVideoPreview();
  });
  els.btnVidWebm.addEventListener('click', recordWebm);
  els.btnVidMp4.addEventListener('click', recordMp4);
  els.btnVidHtml.addEventListener('click', exportAnimHtml);

  // text overlay
  els.textToggle.addEventListener('change', () => {
    els.textControls.style.display = els.textToggle.checked ? '' : 'none';
    if (els.textToggle.checked && UI && UI.openAccordion) UI.openAccordion('acc-text');
    syncSummaries();
    render();
  });
  els.textCount.addEventListener('input', () => {
    const n = Math.max(1, Math.min(parseInt(els.textCount.value, 10) || 1, LIMITS.MAX_TEXTS));
    els.textCountVal.textContent = n;
    for (let i = 1; i <= LIMITS.MAX_TEXTS; i++) {
      const f = document.getElementById('text-field-' + i);
      if (f) f.style.display = i <= n ? '' : 'none';
    }
    syncSummaries();
    render();
  });
  els.textUse.addEventListener('change', render);
  els.textRepeat.addEventListener('input', render);
  els.textRandom.addEventListener('change', () => {
    if (els.textRandom.checked) state.textSeed = (Math.random() * 2147483647) | 0;
    render();
  });
  els.textInputs.addEventListener('input', scheduleRender);

  // PDF page selector
  els.pdfPage.addEventListener('input', () => {
    if (!state.pdf) return;
    const n = parseInt(els.pdfPage.value, 10);
    els.pdfPageLabel.textContent = n + ' / ' + state.pdf.numPages;
    clearTimeout(state.debounce);
    state.debounce = setTimeout(() => renderPdfPage(n), LIMITS.PDF_PAGE_DEBOUNCE_MS);
  });

  // tabs
  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      els.tabs.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-pressed', String(t === tab));
      });
      tab.classList.add('active');
      tab.setAttribute('aria-pressed', 'true');
      $$('.tab-panel').forEach((p) => {
        p.style.display = p.id === tab.dataset.target ? 'block' : 'none';
      });
    });
  });

  // exports
  els.btnTxt.addEventListener('click', () => {
    if (!state.grid) return;
    download(baseName(state.img && state.img.name) + '.txt', els.txtOut.value, 'text/plain;charset=utf-8');
  });
  els.btnHtml.addEventListener('click', () => {
    if (!state.grid) return;
    download(baseName(state.img && state.img.name) + '.html', els.codeOut.value, 'text/html;charset=utf-8');
  });
  els.btnPng.addEventListener('click', () => {
    if (!state.grid) return;
    let dataUrl;
    try {
      dataUrl = Renderer.renderPng({
        grid: state.grid,
        ...canvasDrawOpts(),
      });
    } catch (e) {
      fail(e.message);
      return;
    }
    if (!dataUrl) {
      fail('PNG export is not available in this context.');
      return;
    }
    download(baseName(state.img && state.img.name) + '.png', dataUrlToBlob(dataUrl), 'image/png');
    setStatus('PNG saved ✓');
  });
  els.btnCopy.addEventListener('click', () => {
    if (!state.grid) return;
    const active = $('.tab.active');
    const target = active ? active.dataset.target : 'tab-txt';
    copyText(target === 'tab-code' ? els.codeOut.value : els.txtOut.value);
  });

  /* ------------------------------------------------------------------ *
   *  Init
   * ------------------------------------------------------------------ */

  // palettes
  for (const key of Object.keys(Ascii.PALETTES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = Ascii.PALETTES[key].label;
    els.palette.appendChild(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = 'Custom…';
  els.palette.appendChild(customOpt);
  syncPaletteInput();

  // text inputs (up to MAX_TEXTS)
  for (let i = 1; i <= LIMITS.MAX_TEXTS; i++) {
    const label = document.createElement('label');
    label.className = 'field';
    label.id = 'text-field-' + i;
    const span = document.createElement('span');
    span.textContent = 'String ' + i;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'text-' + i;
    input.spellcheck = false;
    input.placeholder = 'text ' + i;
    input.maxLength = 512;
    label.append(span, input);
    els.textInputs.appendChild(label);
    if (i > 1) label.style.display = 'none';
  }

  // measure the real glyph ratio of the active font (web) — fallback: 0.5
  remeasureAspect();

  // new-design shell (js/ui.js): accordions, steppers, segmented controls,
  // tabs, theme toggle, zoom and the "view original" switch. Optional: the
  // app must keep working when the module is missing or throws.
  if (UI) {
    try {
      UI.init(document);
    } catch (e) {
      // ignored on purpose: the previous markup still works
    }
  }
  if (UI && UI.getZoom) {
    const z = parseFloat(UI.getZoom());
    if (isFinite(z) && z > 0) state.zoom = z;
  }
  syncSummaries();
  updateBadge();
})();

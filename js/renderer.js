/*
 * w8rez — output renderers: .txt, self-contained .html, .png and animation.
 *
 * The delicate part is the web aspect ratio: a monospace glyph is roughly
 * 0.55–0.62em wide by 1em tall. We measure the real advance width of the font
 * in the browser (technique from jpetitcolas/ascii-art-converter) and use that
 * ratio to choose how many rows the grid needs, so the ASCII image keeps the
 * proportions of the original.
 *
 * Attribution: see docs/THIRD_PARTY_NOTICES.md and the LICENSE file.
 *
 * UMD: browser (window.W8rez.Renderer) and Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./ascii.js'));
  } else {
    root.W8rez = root.W8rez || {};
    root.W8rez.Renderer = factory(root.W8rez.Ascii);
  }
})(typeof self !== 'undefined' ? self : this, function (Ascii) {
  'use strict';

  const MODES = {
    mono: { label: 'Monochrome' },
    fg: { label: 'Colour — glyphs' },
    bg: { label: 'Colour — background' },
    both: { label: 'Colour — background + glyphs' },
  };

  const THEMES = {
    dark: {
      label: 'Dark',
      pageBg: '#0d1117',
      pageFg: '#e6edf3',
      panelBg: '#161b22',
      border: '#30363d',
      accent: '#58a6ff',
      preBg: '#010409',
      preFg: '#c9d1d9',
    },
    light: {
      label: 'Light',
      pageBg: '#f6f8fa',
      pageFg: '#24292f',
      panelBg: '#ffffff',
      border: '#d0d7de',
      accent: '#0969da',
      preBg: '#ffffff',
      preFg: '#1f2328',
    },
  };

  const DEFAULT_FONT = 'Consolas, Menlo, monospace';
  /** Browsers fail past ~32k px per side; 16384 keeps us well inside limits. */
  const MAX_CANVAS_DIM = 16384;

  /* ------------------------------------------------------------------ *
   *  Input sanitisation
   *
   *  Font stacks and colours reach the generated documents as raw CSS, so
   *  they are validated against an allowlist instead of being interpolated.
   * ------------------------------------------------------------------ */

  const SAFE_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  // A font stack may contain family names, generic keywords, quotes, commas,
  // spaces and a little punctuation. Anything that could close a declaration
  // (`;`), open a block (`{`/`}`), load a URL or smuggle markup is rejected.
  const SAFE_FONT_RE = /^[A-Za-z0-9 ,.'"()+_-]{1,128}$/;

  /** Returns a safe `#hex` colour, or `fallback` when the value is not one. */
  function safeColor(value, fallback) {
    const s = String(value == null ? '' : value).trim();
    return SAFE_COLOR_RE.test(s) ? s : fallback;
  }

  /** Returns a trusted CSS font stack, or `fallback` when it cannot be. */
  function safeFontStack(value, fallback) {
    const s = String(value == null ? '' : value).trim();
    if (SAFE_FONT_RE.test(s) && !/url\s*\(/i.test(s)) return s;
    return fallback;
  }

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function defaultStamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  function paletteName(chars) {
    for (const key of Object.keys(Ascii.PALETTES)) {
      if (Ascii.PALETTES[key].chars === chars) return Ascii.PALETTES[key].label;
    }
    return 'custom';
  }

  /* ------------------------------------------------------------------ *
   *  Font measurement (browser only)
   * ------------------------------------------------------------------ */

  /**
   * Measures the advance width of a monospace font and returns the glyph
   * width/height ratio (charW / fontSize), used to keep the grid proportional.
   *
   * @param {string} fontFamily CSS font stack
   * @returns {number|null} the ratio (≈0.55–0.62), or null without a DOM
   */
  function measureCharAspect(fontFamily) {
    if (typeof document === 'undefined') return null;
    const font = safeFontStack(fontFamily, DEFAULT_FONT);
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;' +
      'font-family:' + font + ';font-size:64px;line-height:64px;white-space:pre;';
    probe.textContent = 'MMMMMMMMMM';
    document.body.appendChild(probe);
    let ratio = null;
    try {
      const width = probe.getBoundingClientRect().width;
      if (isFinite(width) && width > 0) ratio = width / 10 / 64;
    } finally {
      probe.remove();
    }
    return ratio;
  }

  /* ------------------------------------------------------------------ *
   *  .txt output
   * ------------------------------------------------------------------ */

  /** Plain text for an already computed grid. */
  function renderTxt(grid) {
    return Ascii.gridToText(grid);
  }

  /* ------------------------------------------------------------------ *
   *  Shared HTML fragment builder
   * ------------------------------------------------------------------ */

  /**
   * Serialises a grid into the inner HTML of a `<pre>`. The live preview and
   * the exported documents share this one implementation, so what you see is
   * exactly what you download.
   *
   * Output size is reduced by run-length grouping: consecutive cells that
   * would carry the same inline style are emitted inside a single `<span>`.
   * The rendered result is identical, but a 300×200 grid typically drops from
   * ~60,000 elements to a few hundred — the difference between a responsive UI
   * and a frozen tab.
   *
   * @param {Object} grid
   * @param {Object} [opts]
   * @param {'mono'|'fg'|'bg'|'both'} [opts.mode]
   * @param {boolean} [opts.invert] negative colours
   * @param {string}  [opts.preFg]   theme colour for stamped glyphs
   * @returns {string} HTML for the inside of a `<pre>`
   */
  function buildHtmlFragment(grid, opts) {
    if (!grid || !Array.isArray(grid.cells)) return '';
    opts = opts || {};
    const mode = MODES[opts.mode] ? opts.mode : 'mono';
    const invert = !!opts.invert;
    const preFg = safeColor(opts.preFg, THEMES.dark.preFg);
    const stamped = grid.stamped;
    const cols = grid.cols;
    const cells = grid.cells;

    const rgbOf = (cell) => {
      const r = invert ? 255 - (cell.r | 0) : cell.r | 0;
      const g = invert ? 255 - (cell.g | 0) : cell.g | 0;
      const b = invert ? 255 - (cell.b | 0) : cell.b | 0;
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    };
    // Contrast colour for 'both': dark glyphs on light blocks, light glyphs
    // on dark blocks.
    const glyphColor = (cell) => {
      const l = invert ? 255 - cell.lum : cell.lum;
      return l > 128 ? '#111111' : '#f0f0f0';
    };

    let out = '';
    let openStyle = null;
    let buffer = '';

    const flush = () => {
      if (openStyle === null) return;
      out += '<span style="' + openStyle + '">' + buffer + '</span>';
      openStyle = null;
      buffer = '';
    };
    const emit = (style, html) => {
      if (style !== openStyle) {
        flush();
        openStyle = style;
      }
      buffer += html;
    };

    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < cols; x++) {
        const idx = y * cols + x;
        const cell = cells[idx];
        const isStamped = stamped ? !!stamped[idx] : false;

        if (mode === 'mono') {
          flush();
          out += Ascii.escapeHtml(cell.char);
        } else {
          const rgb = rgbOf(cell);
          if (mode === 'fg') {
            emit('color:' + rgb, Ascii.escapeHtml(cell.char));
          } else if (mode === 'bg') {
            if (isStamped) emit('background:' + rgb + ';color:' + preFg, Ascii.escapeHtml(cell.char));
            else emit('background:' + rgb, '&nbsp;');
          } else {
            const style = 'background:' + rgb + ';color:' + (isStamped ? preFg : glyphColor(cell));
            emit(style, Ascii.escapeHtml(cell.char));
          }
        }
      }
      // A newline breaks the inline run: flush BEFORE emitting it, otherwise
      // the pending span would be closed after the row break and the rows
      // would end up reordered.
      flush();
      out += '\n';
    }
    flush();
    return out;
  }

  /* ------------------------------------------------------------------ *
   *  Document scaffolding
   * ------------------------------------------------------------------ */

  /** CSS shared by the exported documents. Values are pre-sanitised. */
  function pageCss(o) {
    const t = o.theme;
    return [
      ':root {',
      '  --bg: ' + t.pageBg + ';',
      '  --fg: ' + t.pageFg + ';',
      '  --panel: ' + t.panelBg + ';',
      '  --border: ' + t.border + ';',
      '  --accent: ' + t.accent + ';',
      '  --pre-bg: ' + o.bgColor + ';',
      '  --pre-fg: ' + t.preFg + ';',
      '}',
      '* { box-sizing: border-box; }',
      'body { margin: 0; padding: 2.5rem 1.5rem 4rem; background: var(--bg); color: var(--fg);',
      '  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }',
      'main { max-width: 1200px; margin: 0 auto; }',
      'header { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap;',
      '  padding-bottom: 1rem; margin-bottom: 1.5rem; border-bottom: 1px solid var(--border); }',
      'h1 { font-size: 1.1rem; margin: 0; letter-spacing: .04em; }',
      '.meta-table { font-size: .78rem; opacity: .85; }',
      '.meta-table th { text-align: left; font-weight: 600; padding-right: .6rem; color: var(--accent); }',
      '.meta-table td { padding-right: 1.2rem; }',
      '.ascii-wrap { background: var(--pre-bg); border: 1px solid var(--border); border-radius: 10px;',
      '  padding: 1.2rem; overflow: auto; }',
      'pre#ascii { margin: 0; font-family: ' + o.family + '; font-size: ' + o.fontSize + 'px;',
      '  line-height: ' + o.lineHeight + 'px; color: ' + (o.mode === 'mono' ? 'var(--pre-fg)' : 'inherit') + ';',
      '  white-space: pre; width: max-content; min-width: 100%; }',
      'pre#ascii span { white-space: pre; }',
      'footer { margin-top: 1.5rem; font-size: .75rem; opacity: .6; text-align: center; }',
    ].join('\n');
  }

  /**
   * Wraps a body/head into a full HTML document.
   * `csp` lets each document declare its own Content-Security-Policy: static
   * exports allow no scripts at all, animations allow only their own inline
   * script.
   */
  function documentShell(o) {
    const csp = o.csp || "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
    return [
      '<!DOCTYPE html>',
      '<html lang="' + Ascii.escapeHtml(o.lang || 'en') + '">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta http-equiv="Content-Security-Policy" content="' + Ascii.escapeHtml(csp) + '">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="generator" content="w8rez">',
      '<title>' + Ascii.escapeHtml(o.title) + '</title>',
      o.head,
      '</head>',
      '<body>',
      o.body,
      '</body>',
      '</html>',
    ].join('\n');
  }

  /* ------------------------------------------------------------------ *
   *  .html output (self-contained document)
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} opts
   * @param {Object} opts.grid           result of Ascii.toGrid
   * @param {string} [opts.title]        source name
   * @param {'mono'|'fg'|'bg'|'both'} [opts.mode]
   * @param {string} [opts.fontFamily]   CSS font stack
   * @param {number} [opts.fontSize]     px for the <pre> (default 16)
   * @param {string} [opts.theme]        'dark' | 'light'
   * @param {string} [opts.bgColor]      canvas background
   * @param {boolean} [opts.invert]
   * @param {Object} [opts.meta]         extra header rows (source, w, h, …)
   * @param {string} [opts.generatedAt]  injectable timestamp (testability)
   * @returns {string} a complete HTML document
   */
  function renderHtml(opts) {
    opts = opts || {};
    const mode = MODES[opts.mode] ? opts.mode : 'mono';
    const family = safeFontStack(opts.fontFamily, DEFAULT_FONT);
    const fontSize = clampInt(opts.fontSize, 4, 96, 16);
    const theme = THEMES[opts.theme] || THEMES.dark;
    const bgColor = safeColor(opts.bgColor, theme.preBg);
    const grid = opts.grid;
    if (!grid || !Array.isArray(grid.cells)) {
      throw new TypeError('renderHtml: opts.grid is required');
    }

    const lineHeight = Math.round(fontSize); // identical to the measuring line-box
    const meta = opts.meta || {};
    const stamp = opts.generatedAt || defaultStamp();

    const rows = [
      ['Source', meta.source || opts.title || ''],
      ['Dimensions', (meta.w || '?') + '×' + (meta.h || '?') + ' px → ' + grid.cols + '×' + grid.rows + ' chars'],
      ['Palette', paletteName(grid.palette) + ' (' + grid.palette.length + ')'],
      ['Mode', MODES[mode].label],
      ['Dynamic range', meta.dynamicRange ? 'yes' : 'no'],
      ['Generated', stamp],
    ]
      .filter((row) => row[1] !== '' && row[1] != null)
      .map((row) => '<tr><th>' + Ascii.escapeHtml(row[0]) + '</th><td>' + Ascii.escapeHtml(row[1]) + '</td></tr>')
      .join('\n      ');

    const body = buildHtmlFragment(grid, { mode: mode, invert: opts.invert, preFg: theme.preFg });

    return documentShell({
      title: 'ASCII — ' + (opts.title || 'w8rez'),
      head: [
        '<style>',
        pageCss({ theme: theme, family: family, fontSize: fontSize, lineHeight: lineHeight, mode: mode, bgColor: bgColor }),
        '</style>',
      ].join('\n'),
      body: [
        '<main>',
        '  <header>',
        '    <h1>ASCII — ' + Ascii.escapeHtml(opts.title || 'image') + '</h1>',
        '    <table class="meta-table">',
        '      ' + rows,
        '    </table>',
        '  </header>',
        '  <div class="ascii-wrap">',
        '    <pre id="ascii">' + body + '</pre>',
        '  </div>',
        '  <footer>generated with <b>w8rez</b> — font ' + Ascii.escapeHtml(family) + '</footer>',
        '</main>',
      ].join('\n'),
    });
  }

  /* ------------------------------------------------------------------ *
   *  .png output (rasterise the ASCII grid)
   * ------------------------------------------------------------------ */

  /**
   * Draws an ASCII grid onto a canvas (used for PNG export and for video).
   * Sizes the canvas to the grid and honours mode, font, theme and inversion.
   * Browser only; returns null in Node.
   *
   * @returns {{cellW:number,cellH:number}|null}
   * @throws {RangeError} when the resulting canvas would exceed MAX_CANVAS_DIM
   */
  function drawGridToCanvas(canvas, ctx, grid, opts) {
    if (typeof document === 'undefined') return null;
    if (!canvas || !ctx || !grid || !Array.isArray(grid.cells)) return null;
    opts = opts || {};

    const theme = THEMES[opts.theme] || THEMES.dark;
    const family = safeFontStack(opts.fontFamily, DEFAULT_FONT);
    const fontSize = clampInt(opts.fontSize, 4, 96, 16);
    const mode = MODES[opts.mode] ? opts.mode : 'mono';
    const invert = !!opts.invert;

    const font = fontSize + 'px ' + family;
    ctx.font = font;
    const cellW = Math.ceil(ctx.measureText('M').width);
    const cellH = fontSize; // same line-box as the HTML output
    const width = grid.cols * cellW;
    const height = grid.rows * cellH;
    if (width < 1 || height < 1 || width > MAX_CANVAS_DIM || height > MAX_CANVAS_DIM) {
      throw new RangeError(
        'drawGridToCanvas: canvas ' + width + '×' + height + ' exceeds the ' + MAX_CANVAS_DIM + 'px limit — reduce the width'
      );
    }
    canvas.width = width;
    canvas.height = height;
    // Resizing a canvas resets its context state, so set the font again.
    ctx.font = font;
    ctx.textBaseline = 'top';

    ctx.fillStyle = safeColor(opts.bgColor, theme.preBg);
    ctx.fillRect(0, 0, width, height);

    const stamped = grid.stamped;
    const rgbOf = (cell) => {
      const r = invert ? 255 - (cell.r | 0) : cell.r | 0;
      const g = invert ? 255 - (cell.g | 0) : cell.g | 0;
      const b = invert ? 255 - (cell.b | 0) : cell.b | 0;
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    };
    const glyphColor = (cell) => {
      const l = invert ? 255 - cell.lum : cell.lum;
      return l > 128 ? '#111111' : '#f0f0f0';
    };

    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.cols; x++) {
        const idx = y * grid.cols + x;
        const cell = grid.cells[idx];
        const isStamped = stamped ? !!stamped[idx] : false;
        const px = x * cellW;
        const py = y * cellH;
        const rgb = rgbOf(cell);

        if (mode === 'bg' || mode === 'both') {
          ctx.fillStyle = rgb;
          ctx.fillRect(px, py, cellW, cellH);
        }
        if (mode === 'mono') {
          ctx.fillStyle = theme.preFg;
          ctx.fillText(cell.char, px, py);
        } else if (mode === 'fg') {
          ctx.fillStyle = rgb;
          ctx.fillText(cell.char, px, py);
        } else if (mode === 'both') {
          ctx.fillStyle = isStamped ? theme.preFg : glyphColor(cell);
          ctx.fillText(cell.char, px, py);
        } else if (isStamped) {
          // 'bg' mode: draw the stamped glyph over its colour block
          ctx.fillStyle = theme.preFg;
          ctx.fillText(cell.char, px, py);
        }
      }
    }

    return { cellW: cellW, cellH: cellH };
  }

  /**
   * Rasterises an ASCII grid to a PNG data URL (canvas → data URL).
   * @returns {string|null} 'image/png' data URL, or null without a DOM
   */
  function renderPng(opts) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    drawGridToCanvas(canvas, ctx, (opts && opts.grid) || null, opts || {});
    return canvas.toDataURL('image/png');
  }

  /* ------------------------------------------------------------------ *
   *  Self-contained animated HTML (ASCII video)
   * ------------------------------------------------------------------ */

  /**
   * Builds a self-contained HTML document that plays the animation.
   *
   * Frames are embedded as JSON escaped through `Ascii.escapeForScript`, so a
   * frame containing `</script>` can never break out of the script element.
   *
   * @param {Object} opts
   * @param {string[]} opts.frames  HTML produced by buildHtmlFragment
   * @param {number} [opts.fps]     playback framerate
   * @param {number} [opts.speed]   playback rate multiplier
   * @param {string} [opts.title]
   * @param {string} [opts.mode]
   * @param {string} [opts.fontFamily]
   * @param {number} [opts.fontSize]
   * @param {string} [opts.theme]
   * @param {string} [opts.bgColor]
   * @param {Object} [opts.meta]
   * @param {string} [opts.generatedAt] injectable timestamp (testability)
   * @returns {string} a complete HTML document
   */
  function buildAnimHtml(opts) {
    opts = opts || {};
    const theme = THEMES[opts.theme] || THEMES.dark;
    const family = safeFontStack(opts.fontFamily, DEFAULT_FONT);
    const fontSize = clampInt(opts.fontSize, 4, 96, 14);
    const mode = MODES[opts.mode] ? opts.mode : 'mono';
    const frames = Array.isArray(opts.frames) ? opts.frames : [];
    const fps = clampInt(opts.fps, 1, 60, 10);
    const speed = clampNumber(opts.speed, 0.05, 16, 1);
    const meta = opts.meta || {};
    const stamp = opts.generatedAt || defaultStamp();
    const bgColor = safeColor(opts.bgColor, theme.preBg);

    const head = [
      '<style>',
      ':root { --bg: ' + theme.pageBg + '; --fg: ' + theme.pageFg + '; --panel: ' + theme.panelBg +
        '; --border: ' + theme.border + '; --accent: ' + theme.accent + '; --pre-bg: ' + bgColor +
        '; --pre-fg: ' + theme.preFg + '; }',
      '* { box-sizing: border-box; }',
      'body { margin: 0; padding: 2rem 1rem 3rem; background: var(--bg); color: var(--fg);',
      '  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }',
      '.wrap { max-width: 1100px; margin: 0 auto; }',
      'h1 { font-size: 1rem; letter-spacing: .05em; margin: 0 0 .4rem; }',
      '.meta { font-size: .75rem; opacity: .65; margin-bottom: 1rem; }',
      '.controls { display: flex; align-items: center; gap: .8rem; flex-wrap: wrap; margin-bottom: 1rem; }',
      'button, select { background: var(--panel); color: var(--fg); border: 1px solid var(--border);',
      '  border-radius: 7px; padding: .45rem .9rem; font-size: .85rem; cursor: pointer; }',
      'button:hover { border-color: var(--accent); }',
      '.frame { font-family: monospace; font-size: .75rem; opacity: .7; }',
      '.pre-wrap { background: var(--pre-bg); border: 1px solid var(--border); border-radius: 10px;',
      '  padding: 1rem; overflow: auto; max-height: 80vh; }',
      'pre#anim { margin: 0; font-family: ' + family + '; font-size: ' + fontSize + 'px;',
      '  line-height: ' + fontSize + 'px; color: var(--pre-fg); white-space: pre;',
      '  width: max-content; min-width: 100%; }',
      '</style>',
    ].join('\n');

    const body = [
      '<div class="wrap">',
      '  <h1>ASCII animation — ' + Ascii.escapeHtml(opts.title || 'w8rez') + '</h1>',
      '  <p class="meta">' + Ascii.escapeHtml(meta.source || '') + ' · ' + frames.length +
        ' frames · ' + fps + ' fps · ' + Ascii.escapeHtml(String(speed)) + '× · ' +
        Ascii.escapeHtml(MODES[mode].label) + ' · ' + Ascii.escapeHtml(stamp) +
        ' · generated with w8rez</p>',
      '  <div class="controls">',
      '    <button id="play" type="button">⏸ Pause</button>',
      '    <span class="frame" id="counter" role="status" aria-live="polite">1 / ' + frames.length + '</span>',
      '    <label for="speed">speed</label>',
      '    <select id="speed">',
      '      <option value="0.25">0.25×</option>',
      '      <option value="0.5">0.5×</option>',
      '      <option value="1" selected>1×</option>',
      '      <option value="2">2×</option>',
      '      <option value="4">4×</option>',
      '    </select>',
      '    <button id="restart" type="button">↺ Restart</button>',
      '  </div>',
      '  <div class="pre-wrap"><pre id="anim"></pre></div>',
      '</div>',
      playerScript(frames, fps),
    ].join('\n');

    return documentShell({
      title: 'ASCII animation — ' + (opts.title || 'w8rez'),
      head: head,
      body: body,
      csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    });
  }

  /**
   * The inline player script. `frames` is serialised with escapeForScript so
   * the payload can never terminate the script block; frames are assigned with
   * innerHTML because they are markup produced by buildHtmlFragment (the glyph
   * text inside is already escaped) and never by user input directly.
   */
  function playerScript(frames, fps) {
    const lines = [
      '<script>',
      '(function () {',
      '  "use strict";',
      '  var FRAMES = ' + Ascii.escapeForScript(frames) + ';',
      '  var FPS = ' + fps + ';',
      '  var idx = 0;',
      '  var timer = null;',
      "  var pre = document.getElementById('anim');",
      "  var counter = document.getElementById('counter');",
      "  var speedSel = document.getElementById('speed');",
      "  var playBtn = document.getElementById('play');",
      '  function draw() {',
      '    pre.innerHTML = FRAMES[idx];',
      "    counter.textContent = (idx + 1) + ' / ' + FRAMES.length;",
      '  }',
      '  function interval() {',
      '    var rate = parseFloat(speedSel.value) || 1;',
      '    return 1000 / (FPS * rate);',
      '  }',
      '  function stop() {',
      '    if (timer) { clearInterval(timer); timer = null; }',
      "    playBtn.textContent = '\u25B6 Play';",
      '  }',
      '  function play() {',
      '    stop();',
      "    playBtn.textContent = '\u23F8 Pause';",
      '    draw();',
      '    timer = setInterval(function () {',
      '      idx = (idx + 1) % FRAMES.length;',
      '      draw();',
      '    }, interval());',
      '  }',
      '  playBtn.addEventListener("click", function () { if (timer) { stop(); } else { play(); } });',
      '  speedSel.addEventListener("change", function () { if (timer) { play(); } });',
      '  document.getElementById("restart").addEventListener("click", function () { idx = 0; play(); });',
      '  if (FRAMES.length) { play(); }',
      '})();',
      '</script>',
    ];
    return lines.join('\n');
  }

  return {
    MODES,
    THEMES,
    DEFAULT_FONT,
    MAX_CANVAS_DIM,
    safeColor,
    safeFontStack,
    measureCharAspect,
    renderTxt,
    buildHtmlFragment,
    renderHtml,
    renderPng,
    drawGridToCanvas,
    buildAnimHtml,
  };
});

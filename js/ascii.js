/*
 * w8rez — image → ASCII conversion engine.
 *
 * Pipeline (reimplemented from AsciiMap, MIT, © 2019 Jonas Gunz):
 *   1. block averaging      (each output cell averages a block of the source)
 *   2. perceptual luminance   √(0.299R² + 0.587G² + 0.114B²)
 *   3. optional dynamic range (stretch min..max → 0..255)
 *   4. glyph mapping          (dark → bright)
 *
 * Attribution: see docs/THIRD_PARTY_NOTICES.md and the LICENSE file.
 *
 * UMD: works in the browser (window.W8rez.Ascii) and in Node (require).
 * This module is DOM-free: it takes RGBA pixels and returns a cell grid, so it
 * is unit-testable in Node without a browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.W8rez = root.W8rez || {};
    root.W8rez.Ascii = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Constants
   * ------------------------------------------------------------------ */

  /** Palettes are ordered from darkest to brightest glyph. */
  const PALETTES = {
    map: {
      label: 'AsciiMap',
      chars: '  .,-~"*:;<!/?%&=$#',
    },
    classic: {
      label: 'Classic (70)',
      chars: '$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/|()1{}[]?-_+~<>i!lI;:,"^`\'. ',
    },
    blocks: {
      label: 'Blocks',
      chars: ' ░▒▓█',
    },
    ramp: {
      label: 'Ramp (10)',
      chars: ' .:-=+*#%@',
    },
    binary: {
      label: 'Binary',
      chars: ' #',
    },
    dots: {
      label: 'Dots',
      chars: ' ·•',
    },
  };

  const DEFAULT_PALETTE_KEY = 'map';
  const DEFAULT_PALETTE = PALETTES.map.chars;

  /**
   * Hard safety limits. They stop a malformed or hostile input from
   * allocating unbounded memory (a cell is a small object, so ~1.2M cells is
   * already a ~100 MB worst case). The UI never reaches these values.
   */
  const LIMITS = {
    MAX_COLS: 1000,
    MAX_ROWS: 4000,
    MAX_CELLS: 1200000,
    MAX_IMAGE_DIM: 16384,
    MIN_PALETTE_GLYPHS: 1,
    MAX_PALETTE_GLYPHS: 512,
    MAX_TEXT_LINES: 8,
    MAX_TEXT_LINE_LENGTH: 512,
    MAX_TEXT_REPETITIONS: 64,
  };

  /* ------------------------------------------------------------------ *
   *  Small utilities
   * ------------------------------------------------------------------ */

  /**
   * Parses '#rgb' / '#rrggbb' (leading '#' optional).
   * @returns {number[]} [r, g, b]; black on invalid input, so a bad value can
   *   never poison a whole frame with NaN.
   */
  function parseHex(hex) {
    let s = String(hex == null ? '' : hex).trim().replace(/^#/, '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return [0, 0, 0];
    const n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /** Escapes text for safe interpolation into HTML text and attributes. */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Escapes a value for embedding inside a `<script>` element via JSON.
   * `JSON.stringify` does not escape `<`, so a value containing `</script>`
   * could otherwise break out of the script block.
   */
  function escapeForScript(value) {
    return JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  /**
   * Splits a palette into glyphs by Unicode code point, so a surrogate pair
   * counts as one glyph instead of two.
   */
  function toGlyphs(chars) {
    if (Array.isArray(chars)) {
      return chars.filter((c) => typeof c === 'string' && c.length > 0).slice(0, LIMITS.MAX_PALETTE_GLYPHS);
    }
    const out = [];
    for (const ch of String(chars == null ? '' : chars)) out.push(ch);
    return out.slice(0, LIMITS.MAX_PALETTE_GLYPHS);
  }

  /**
   * Validates a palette and returns its glyphs.
   * @returns {string[]|null} glyphs, or null when unusable
   */
  function normalizePalette(chars) {
    const glyphs = toGlyphs(chars);
    return glyphs.length >= LIMITS.MIN_PALETTE_GLYPHS ? glyphs : null;
  }

  /* ------------------------------------------------------------------ *
   *  Luminance
   * ------------------------------------------------------------------ */

  /**
   * Perceptual luminance of an RGB colour (each channel 0..255).
   * √(0.299R² + 0.587G² + 0.114B²) — AsciiMap's formula, which tracks human
   * perception better than a plain channel average.
   */
  function luminance(r, g, b) {
    return Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b); // 0..255
  }

  /* ------------------------------------------------------------------ *
   *  Block averaging
   * ------------------------------------------------------------------ */

  /**
   * Reduces an RGBA buffer to a `cols × rows` cell grid. Each cell averages
   * its block; alpha is composited over `bgColor` but also reported, so a
   * renderer can tell an empty cell from an opaque one.
   *
   * Cost is O(source pixels): every source pixel belongs to exactly one
   * block, so there is no repeated scanning left to optimise away.
   *
   * @param {Uint8ClampedArray|Uint8Array|Array} data RGBA pixel data
   * @param {number} w    source width in px
   * @param {number} h    source height in px
   * @param {number} cols output grid width in characters
   * @param {number} rows output grid height in characters
   * @param {string} [bgColor] '#rrggbb' used to composite transparency
   * @returns {Array<{r:number,g:number,b:number,lum:number,alpha:number}>}
   */
  function sample(data, w, h, cols, rows, bgColor) {
    if (!data || typeof data.length !== 'number') {
      throw new TypeError('sample(data, w, h, cols, rows): data must be an RGBA array');
    }
    const W = Math.floor(w);
    const H = Math.floor(h);
    if (!(w > 0) || !(h > 0)) {
      throw new RangeError('sample: source dimensions must be positive');
    }
    if (W > LIMITS.MAX_IMAGE_DIM || H > LIMITS.MAX_IMAGE_DIM) {
      throw new RangeError('sample: source dimensions exceed the ' + LIMITS.MAX_IMAGE_DIM + 'px limit');
    }
    if (W * H * 4 > data.length) {
      throw new RangeError(
        'sample: source size ' + w + '×' + h + ' does not match the buffer (' + data.length + ' bytes)'
      );
    }

    const c = Math.max(1, Math.min(Math.floor(cols) || 1, LIMITS.MAX_COLS));
    const R = Math.max(1, Math.min(Math.floor(rows) || 1, LIMITS.MAX_ROWS));
    if (c * R > LIMITS.MAX_CELLS) {
      throw new RangeError('sample: grid ' + c + '×' + R + ' exceeds the ' + LIMITS.MAX_CELLS + ' cell limit');
    }

    const bg = parseHex(bgColor || '#000000');
    const sx = W / c;
    const sy = H / R;
    const cells = new Array(c * R);

    for (let cy = 0; cy < R; cy++) {
      const y0 = Math.floor(cy * sy);
      const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * sy));
      for (let cx = 0; cx < c; cx++) {
        const x0 = Math.floor(cx * sx);
        const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * sx));

        let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
        for (let py = y0; py < y1; py++) {
          let i = (py * W + x0) * 4;
          for (let px = x0; px < x1; px++, i += 4) {
            const a = data[i + 3] / 255;
            sr += data[i] * a;
            sg += data[i + 1] * a;
            sb += data[i + 2] * a;
            sa += a;
            n++;
          }
        }

        let rr, gg, bb, alpha;
        if (n > 0) {
          rr = sr / n;
          gg = sg / n;
          bb = sb / n;
          alpha = sa / n;
          // composite over the background so transparency is not lost
          rr += bg[0] * (1 - alpha);
          gg += bg[1] * (1 - alpha);
          bb += bg[2] * (1 - alpha);
        } else {
          rr = bg[0];
          gg = bg[1];
          bb = bg[2];
          alpha = 0;
        }

        cells[cy * c + cx] = { r: rr, g: gg, b: bb, lum: luminance(rr, gg, bb), alpha: alpha };
      }
    }
    return cells;
  }

  /* ------------------------------------------------------------------ *
   *  Aspect ratio
   * ------------------------------------------------------------------ */

  /**
   * Number of character rows needed for a `cols`-wide grid to preserve the
   * aspect ratio of a w×h image.
   *
   * A glyph is `charAspect` wide per 1 unit of height: in a terminal a glyph
   * is ~2× taller than wide (charAspect ≈ 0.5); on the web the real font
   * advance is measured (see renderer.js) → ≈ 0.55–0.62.
   */
  function computeRows(w, h, cols, charAspect) {
    const aspect = Number.isFinite(charAspect) && charAspect > 0 ? charAspect : 0.5;
    return Math.max(1, Math.round(cols * (h / w) * aspect));
  }

  /* ------------------------------------------------------------------ *
   *  Glyph mapping
   * ------------------------------------------------------------------ */

  /**
   * Normalises luminance 0..255 to 0..1. With dynamicRange, [min,max] is
   * stretched to the full range (AsciiMap's `-d` flag).
   */
  function normalizeLum(lum, min, max, dynamicRange) {
    if (dynamicRange && max > min) return (lum - min) / (max - min);
    return lum / 255;
  }

  /**
   * Maps a normalised luminance to a palette glyph (dark → bright).
   * @param {number} lum01 luminance in 0..1
   * @param {string|string[]} palette ordered glyphs (dark → bright)
   * @param {boolean} [invert]
   */
  function charFor(lum01, palette, invert) {
    const glyphs = Array.isArray(palette) ? palette : toGlyphs(palette);
    if (!glyphs.length) return ' ';
    const p = invert ? 1 - lum01 : lum01;
    const idx = Math.max(0, Math.min(glyphs.length - 1, Math.round(p * (glyphs.length - 1))));
    return glyphs[idx];
  }

  /* ------------------------------------------------------------------ *
   *  Full pipeline
   * ------------------------------------------------------------------ */

  /**
   * Converts an RGBA buffer into a character grid.
   *
   * @param {Uint8ClampedArray|Uint8Array|Array} data RGBA pixels
   * @param {number} w source width
   * @param {number} h source height
   * @param {Object} [opts]
   * @param {number}  [opts.cols=80]      grid width in characters
   * @param {number}  [opts.rows]         computed from charAspect when omitted
   * @param {number}  [opts.charAspect]   glyph width/height ratio (default 0.5)
   * @param {string}  [opts.palette]      glyphs ordered dark → bright
   * @param {boolean} [opts.dynamicRange] stretch contrast (default false)
   * @param {boolean} [opts.invert]       invert luminance
   * @param {string}  [opts.bgColor]      compositing colour for transparency
   * @returns {{cols:number,rows:number,cells:Array,min:number,max:number,palette:string}}
   */
  function toGrid(data, w, h, opts) {
    opts = opts || {};
    const cols = Math.max(1, Math.min(Math.round(opts.cols || 80), LIMITS.MAX_COLS));
    const rows = Math.max(
      1,
      Math.min(Math.round(opts.rows) || computeRows(w, h, cols, opts.charAspect), LIMITS.MAX_ROWS)
    );

    // An empty/garbage palette falls back to the default instead of throwing:
    // a UI text input can legitimately be empty mid-edit, and rendering must
    // stay resilient. Callers can detect it through `paletteFallback`.
    const requested = opts.palette === undefined ? DEFAULT_PALETTE : opts.palette;
    const requestedGlyphs = normalizePalette(requested);
    const glyphs = requestedGlyphs || toGlyphs(DEFAULT_PALETTE);

    const cells = sample(data, w, h, cols, rows, opts.bgColor);

    let min = Infinity;
    let max = -Infinity;
    for (const cell of cells) {
      if (cell.lum < min) min = cell.lum;
      if (cell.lum > max) max = cell.lum;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 0;
    }

    for (const cell of cells) {
      cell.char = charFor(normalizeLum(cell.lum, min, max, opts.dynamicRange), glyphs, opts.invert);
    }

    return {
      cols,
      rows,
      cells,
      min: min,
      max: max,
      palette: glyphs.join(''),
      // true when the requested palette was unusable and the default was used
      paletteFallback: requestedGlyphs === null,
    };
  }

  /* ------------------------------------------------------------------ *
   *  Text overlay
   * ------------------------------------------------------------------ */

  /**
   * Deterministic PRNG (mulberry32): same seed → same sequence. Used by the
   * random placement mode so every frame of a video keeps the text in exactly
   * the same place.
   */
  function mulberry32(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Stamps text lines onto a grid. Works with any palette: the background art
   * uses the selected palette and the text is overlaid on top. Returns a NEW
   * grid — the input is never mutated.
   *
   * @param {Object} grid result of toGrid
   * @param {Object} [opts]
   * @param {string[]} [opts.texts]  up to 8 lines
   * @param {'once'|'repeat'} [opts.mode] 'once' = centred, 'repeat' = spread out
   * @param {number} [opts.repeat]  number of copies in 'repeat' mode
   * @param {boolean} [opts.random] deterministic pseudo-random placement
   * @param {number} [opts.seed]    seed for the random layout
   * @returns {Object} cloned grid; stamped cells have `cell.stamped` reported
   *   through `grid.stamped` (array of booleans, one per cell)
   */
  function stampText(grid, opts) {
    if (!grid || !Array.isArray(grid.cells) || grid.cells.length !== grid.cols * grid.rows) {
      throw new TypeError('stampText: invalid grid');
    }
    const lines = ((opts && opts.texts) || [])
      .slice(0, LIMITS.MAX_TEXT_LINES)
      .map((t) => String(t == null ? '' : t).replace(/[\r\n]/g, '').slice(0, LIMITS.MAX_TEXT_LINE_LENGTH))
      .filter((t) => t.length > 0);
    if (!lines.length) return grid;

    const cols = grid.cols;
    const rows = grid.rows;
    const cells = grid.cells.map((cell) => Object.assign({}, cell));
    const stamped = new Array(cells.length).fill(false);

    const repetitions = () => {
      const n = parseInt(opts && opts.repeat, 10);
      return Math.max(1, Math.min(Number.isFinite(n) ? n : 1, LIMITS.MAX_TEXT_REPETITIONS));
    };

    // Stamp one line at (y, xStart); anything outside the grid is clipped.
    const stampLine = (line, y, xStart) => {
      if (y < 0 || y >= rows) return;
      const start = Math.max(0, Math.min(cols - 1, xStart));
      for (let x = 0; x < line.length; x++) {
        const ch = line[x];
        if (ch === ' ' || ch === '\t') continue; // spaces let the underlying art show
        const cx = start + x;
        if (cx < 0 || cx >= cols) continue;
        const idx = y * cols + cx;
        cells[idx].char = ch;
        stamped[idx] = true;
      }
    };

    const clone = () => ({
      cols: cols,
      rows: rows,
      cells: cells,
      min: grid.min,
      max: grid.max,
      palette: grid.palette,
      stamped: stamped,
    });

    if (opts && opts.random) {
      const rng = mulberry32(opts.seed || 1);
      const copies = opts.mode === 'repeat' ? repetitions() : 1;
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        for (let k = 0; k < copies; k++) {
          const y = Math.floor(rng() * rows);
          const xStart = Math.floor(rng() * Math.max(1, cols - line.length + 1));
          stampLine(line, y, xStart);
        }
      }
      return clone();
    }

    const yPositions = [];
    if (!opts || !opts.mode || opts.mode === 'once') {
      yPositions.push(Math.max(0, Math.floor((rows - lines.length) / 2)));
    } else {
      const n = repetitions();
      const step = rows / (n + 1);
      for (let i = 1; i <= n; i++) yPositions.push(Math.max(0, Math.floor(step * i)));
    }

    for (const y0 of yPositions) {
      for (let li = 0; li < lines.length; li++) {
        stampLine(lines[li], y0 + li, Math.floor((cols - lines[li].length) / 2));
      }
    }

    return clone();
  }

  /** Serialises a grid to plain text (rows joined with \n). */
  function gridToText(grid) {
    if (!grid || !Array.isArray(grid.cells)) return '';
    const lines = new Array(grid.rows);
    for (let y = 0; y < grid.rows; y++) {
      let line = '';
      for (let x = 0; x < grid.cols; x++) line += grid.cells[y * grid.cols + x].char;
      lines[y] = line;
    }
    return lines.join('\n');
  }

  return {
    PALETTES,
    DEFAULT_PALETTE_KEY,
    DEFAULT_PALETTE,
    LIMITS,
    parseHex,
    escapeHtml,
    escapeForScript,
    toGlyphs,
    normalizePalette,
    luminance,
    sample,
    computeRows,
    normalizeLum,
    charFor,
    toGrid,
    stampText,
    gridToText,
  };
});

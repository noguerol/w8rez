/*
 * w8rez — engine test suite (plain Node, zero dependencies).
 * Run: node tests/engine.test.js   (or: npm run test:engine)
 *
 * Covers the conversion engine (js/ascii.js), the renderers (js/renderer.js)
 * and the EPS helper (js/eps.js). The server has its own suite:
 * tests/server.test.js.
 */
'use strict';

const assert = require('assert');
const Ascii = require('../js/ascii.js');
const Renderer = require('../js/renderer.js');
const Eps = require('../js/eps.js');

let passed = 0;
let failed = 0;

function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name + '\n    ' + e.message);
    process.exitCode = 1;
  }
}

function throws(fn, Expected) {
  try {
    fn();
  } catch (e) {
    if (!Expected || e instanceof Expected) return true;
    throw e;
  }
  return false;
}

/* helpers ------------------------------------------------------------ */

/** Solid RGBA image. */
function solid(w, h, r, g, b, a = 255) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return data;
}

const STAMP_GRID = Ascii.toGrid(solid(20, 10, 128, 128, 128), 20, 10, {
  cols: 20,
  rows: 10,
  palette: '#',
});

const stampedPositions = (grid) =>
  grid.stamped.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);

console.log('w8rez — engine tests\n');

/* ── luminance ─────────────────────────────────────────────────────── */

ok('luminance: white ≈ 255', () => {
  assert.ok(Math.abs(Ascii.luminance(255, 255, 255) - 255) < 0.1);
});
ok('luminance: black = 0', () => {
  assert.strictEqual(Ascii.luminance(0, 0, 0), 0);
});
ok('luminance: mid grey ≈ 127.5', () => {
  const l = Ascii.luminance(128, 128, 128);
  assert.ok(Math.abs(l - 127.5) < 1, 'got ' + l);
});
ok('luminance: pure red ≈ 139 (weights green highest)', () => {
  const l = Ascii.luminance(255, 0, 0);
  assert.ok(Math.abs(l - 139.4) < 1, 'got ' + l);
});

/* ── small utilities ───────────────────────────────────────────────── */

ok('parseHex: #rgb shorthand expands', () => {
  assert.deepStrictEqual(Ascii.parseHex('#f00'), [255, 0, 0]);
});
ok('parseHex: invalid input falls back to black (never NaN)', () => {
  assert.deepStrictEqual(Ascii.parseHex('not-a-color'), [0, 0, 0]);
  assert.deepStrictEqual(Ascii.parseHex(undefined), [0, 0, 0]);
});
ok('escapeHtml escapes & < > " \'', () => {
  assert.strictEqual(
    Ascii.escapeHtml('<a href="x" class=\'y\'> & '),
    '&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt; &amp; '
  );
});
ok('escapeForScript neutralises </script> breakouts', () => {
  const out = Ascii.escapeForScript('</script><img src=x onerror=alert(1)>');
  assert.ok(!out.includes('</script>'), 'raw </script> survived: ' + out);
  assert.ok(out.startsWith('"\\u003c'));
});
ok('toGlyphs counts Unicode code points, not UTF-16 units', () => {
  assert.strictEqual(Ascii.toGlyphs(' a𐐀b ').length, 5);
});
ok('normalizePalette: 1 glyph is valid, empty is null', () => {
  assert.deepStrictEqual(Ascii.normalizePalette('#'), ['#']);
  assert.deepStrictEqual(Ascii.normalizePalette(' '), [' ']); // spaces are valid glyphs
  assert.strictEqual(Ascii.normalizePalette(''), null);
});

/* ── aspect ratio ──────────────────────────────────────────────────── */

ok('computeRows: 400×300 @ 100 cols, aspect 0.5 → 38', () => {
  assert.strictEqual(Ascii.computeRows(400, 300, 100, 0.5), 38);
});
ok('computeRows: square @ aspect 0.5 → cols/2', () => {
  assert.strictEqual(Ascii.computeRows(100, 100, 80, 0.5), 40);
});
ok('computeRows: invalid aspect falls back to 0.5', () => {
  assert.strictEqual(Ascii.computeRows(100, 100, 80, NaN), 40);
  assert.strictEqual(Ascii.computeRows(100, 100, 80, -1), 40);
});

/* ── toGrid ────────────────────────────────────────────────────────── */

ok('white image → brightest glyph', () => {
  const grid = Ascii.toGrid(solid(10, 10, 255, 255, 255), 10, 10, { cols: 5, palette: ' .:#' });
  assert.strictEqual(grid.cells[0].char, '#');
});
ok('black image → darkest glyph', () => {
  const grid = Ascii.toGrid(solid(10, 10, 0, 0, 0), 10, 10, { cols: 5, palette: ' .:#' });
  assert.strictEqual(grid.cells[0].char, ' ');
});
ok('inverted black image → bright glyph', () => {
  const grid = Ascii.toGrid(solid(10, 10, 0, 0, 0), 10, 10, { cols: 5, palette: ' .:#', invert: true });
  assert.strictEqual(grid.cells[0].char, '#');
});
ok('red image: channel kept, luminance > 0', () => {
  const grid = Ascii.toGrid(solid(8, 8, 255, 0, 0), 8, 8, { cols: 4 });
  const c = grid.cells[0];
  assert.ok(c.r > 250 && c.g === 0 && c.b === 0);
  assert.ok(c.lum > 100);
});
ok('dynamic range stretches faint grey to full contrast', () => {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = x < 8 ? 10 : 20;
      const i = (y * 16 + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const g1 = Ascii.toGrid(data, 16, 16, { cols: 8, palette: ' .:#', dynamicRange: false });
  const g2 = Ascii.toGrid(data, 16, 16, { cols: 8, palette: ' .:#', dynamicRange: true });
  assert.strictEqual(g1.cells[0].char, g1.cells[4].char, 'without stretch both tones map to one glyph');
  assert.notStrictEqual(g2.cells[0].char, g2.cells[4].char, 'stretched tones must differ');
});
ok('transparency composites over the background colour', () => {
  const grid = Ascii.toGrid(solid(10, 10, 255, 255, 255, 0), 10, 10, { cols: 5, bgColor: '#000000' });
  assert.strictEqual(grid.cells[0].r, 0);
});
ok('grid dimensions are exactly cols×rows', () => {
  const grid = Ascii.toGrid(solid(40, 30, 128, 128, 128), 40, 30, { cols: 20, rows: 10 });
  assert.strictEqual(grid.cells.length, 200);
});
ok('empty custom palette falls back to the default (UI resilience)', () => {
  const grid = Ascii.toGrid(solid(8, 8, 200, 200, 200), 8, 8, { cols: 4, palette: '' });
  assert.strictEqual(grid.paletteFallback, true);
  assert.ok(grid.cells.every((c) => typeof c.char === 'string' && c.char.length === 1));
});
ok('usable custom palette does not trigger the fallback flag', () => {
  const grid = Ascii.toGrid(solid(8, 8, 200, 200, 200), 8, 8, { cols: 4, palette: '+*' });
  assert.strictEqual(grid.paletteFallback, false);
  assert.strictEqual(grid.palette, '+*');
});
ok('oversized cols request is clamped, not rejected', () => {
  const grid = Ascii.toGrid(solid(16, 16, 128, 128, 128), 16, 16, { cols: 100000, rows: 1 });
  assert.strictEqual(grid.cols, Ascii.LIMITS.MAX_COLS);
});
ok('buffer smaller than w×h×4 is rejected', () => {
  assert.throws(() => Ascii.toGrid(new Uint8ClampedArray(10), 10, 10, { cols: 2 }), RangeError);
});
ok('non-positive dimensions are rejected', () => {
  assert.throws(() => Ascii.toGrid(solid(4, 4, 1, 1, 1), 0, 4, { cols: 2 }), RangeError);
  assert.throws(() => Ascii.toGrid(solid(4, 4, 1, 1, 1), 4, -1, { cols: 2 }), RangeError);
});
ok('grid beyond the cell limit is rejected', () => {
  const cols = Ascii.LIMITS.MAX_COLS;
  const rows = Math.floor(Ascii.LIMITS.MAX_CELLS / cols) + 1;
  assert.throws(
    () => Ascii.toGrid(solid(64, 64, 1, 1, 1), 64, 64, { cols, rows }),
    RangeError
  );
});

/* ── text output ───────────────────────────────────────────────────── */

ok('gridToText: correct line count and width', () => {
  const grid = Ascii.toGrid(solid(40, 30, 255, 255, 255), 40, 30, { cols: 20, rows: 10, palette: '#' });
  const lines = Ascii.gridToText(grid).split('\n');
  assert.strictEqual(lines.length, 10);
  assert.ok(lines.every((l) => l.length === 20));
});
ok('renderTxt matches gridToText', () => {
  const grid = Ascii.toGrid(solid(40, 30, 0, 0, 0), 40, 30, { cols: 20, rows: 10, palette: '#' });
  assert.strictEqual(Renderer.renderTxt(grid), Ascii.gridToText(grid));
});

/* ── HTML output ───────────────────────────────────────────────────── */

ok('renderHtml: self-contained document with <pre> and line-height', () => {
  const grid = Ascii.toGrid(solid(40, 30, 0, 0, 0), 40, 30, { cols: 20, rows: 10, palette: '#' });
  const html = Renderer.renderHtml({ title: 'test.png', grid, mode: 'mono', fontFamily: 'Consolas, monospace', fontSize: 16, theme: 'dark' });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<pre id="ascii">'));
  assert.ok(html.includes('line-height: 16px'));
  assert.ok(html.includes('20×10 chars'));
  assert.ok(html.includes('test.png'));
});
ok('renderHtml: no script tags in the static export (CSP defence in depth)', () => {
  const grid = Ascii.toGrid(solid(10, 10, 0, 0, 0), 10, 10, { cols: 4, rows: 4 });
  const html = Renderer.renderHtml({ title: 'x', grid, theme: 'dark' });
  assert.ok(!/<script/i.test(html), 'static export must not contain scripts');
  assert.ok(html.includes('Content-Security-Policy'), 'CSP meta missing');
});
ok('renderHtml: bg mode uses &nbsp; and rgb backgrounds', () => {
  const grid = Ascii.toGrid(solid(10, 10, 255, 0, 0), 10, 10, { cols: 4, rows: 4 });
  const html = Renderer.renderHtml({ title: 'x', grid, mode: 'bg', fontFamily: 'monospace', fontSize: 16, theme: 'dark' });
  assert.ok(html.includes('background:rgb(255,0,0)'));
  assert.ok(html.includes('&nbsp;'));
});
ok('renderHtml: dangerous palette glyphs are escaped', () => {
  const data = new Uint8ClampedArray(12 * 12 * 4);
  for (let i = 0; i < 12 * 12; i++) {
    const v = Math.round((i / (12 * 12 - 1)) * 255);
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  const grid = Ascii.toGrid(data, 12, 12, { cols: 12, rows: 12, palette: '<&>' });
  const html = Renderer.renderHtml({ title: 'x', grid, mode: 'mono', fontFamily: 'monospace', fontSize: 16, theme: 'dark' });
  assert.ok(html.includes('&lt;'), 'missing &lt;');
  assert.ok(html.includes('&amp;'), 'missing &amp;');
  assert.ok(html.includes('&gt;'), 'missing &gt;');
});
ok('renderHtml: hostile font stacks are replaced by the default', () => {
  const grid = Ascii.toGrid(solid(10, 10, 0, 0, 0), 10, 10, { cols: 4, rows: 4 });
  const html = Renderer.renderHtml({
    title: 'x', grid, mode: 'mono', theme: 'dark',
    fontFamily: 'x;} body{background:red} pre{',
  });
  assert.ok(!html.includes('body{background:red'), 'CSS injection survived');
  assert.ok(html.includes('Consolas, Menlo, monospace'), 'fallback font not applied');
});
ok('renderHtml: hostile bg colours fall back to the theme', () => {
  const grid = Ascii.toGrid(solid(10, 10, 128, 128, 128), 10, 10, { cols: 4, rows: 4 });
  const html = Renderer.renderHtml({ title: 'x', grid, theme: 'dark', bgColor: 'red" onload="x' });
  assert.ok(html.includes('--pre-bg: #010409'), 'theme background expected');
});
ok('renderHtml: user background colour is honoured when safe', () => {
  const grid = Ascii.toGrid(solid(10, 10, 128, 128, 128), 10, 10, { cols: 4, rows: 4 });
  const html = Renderer.renderHtml({ title: 'x', grid, theme: 'dark', bgColor: '#ff0000' });
  assert.ok(html.includes('--pre-bg: #ff0000'));
});
ok('renderHtml: title is escaped', () => {
  const grid = Ascii.toGrid(solid(10, 10, 0, 0, 0), 10, 10, { cols: 4, rows: 4 });
  const html = Renderer.renderHtml({ title: '<img src=x onerror=alert(1)>', grid, theme: 'dark' });
  assert.ok(!html.includes('<img src=x'), 'title was interpolated raw');
  assert.ok(html.includes('&lt;img'), 'title was not escaped');
});
ok('renderHtml: generatedAt makes output deterministic (reproducible builds)', () => {
  const grid = Ascii.toGrid(solid(10, 10, 0, 0, 0), 10, 10, { cols: 4, rows: 4 });
  const a = Renderer.renderHtml({ title: 'x', grid, theme: 'dark', generatedAt: '2020-01-01 00:00:00' });
  const b = Renderer.renderHtml({ title: 'x', grid, theme: 'dark', generatedAt: '2020-01-01 00:00:00' });
  assert.strictEqual(a, b);
});
ok('renderHtml: mode "both" uses contrast colours', () => {
  const grid = Ascii.toGrid(solid(10, 10, 255, 0, 0), 10, 10, { cols: 4, rows: 4 });
  const html = Renderer.renderHtml({ title: 'x', grid, mode: 'both', fontFamily: 'monospace', fontSize: 16, theme: 'dark' });
  assert.ok(html.includes('background:rgb(255,0,0);color:#111111'), 'dark glyph expected on bright red');
});
ok('renderHtml: mode "both" uses light glyphs on dark blocks', () => {
  const grid = Ascii.toGrid(solid(10, 10, 20, 20, 20), 10, 10, { cols: 4, rows: 4 });
  const html = Renderer.renderHtml({ title: 'x', grid, mode: 'both', fontFamily: 'monospace', fontSize: 16, theme: 'dark' });
  assert.ok(html.includes('color:#f0f0f0'));
});
ok('renderHtml: invert flips displayed colours (fg mode)', () => {
  const grid = Ascii.toGrid(solid(10, 10, 255, 0, 0), 10, 10, { cols: 4, rows: 4 });
  const html = Renderer.renderHtml({ title: 'x', grid, mode: 'fg', fontFamily: 'monospace', fontSize: 16, theme: 'dark', invert: true });
  assert.ok(html.includes('color:rgb(0,255,255)'), 'red → cyan when inverted');
});
ok('renderHtml: invert flips the background (bg mode)', () => {
  const grid = Ascii.toGrid(solid(10, 10, 255, 0, 0), 10, 10, { cols: 4, rows: 4 });
  const html = Renderer.renderHtml({ title: 'x', grid, mode: 'bg', fontFamily: 'monospace', fontSize: 16, theme: 'dark', invert: true });
  assert.ok(html.includes('background:rgb(0,255,255)'));
});
ok('renderHtml: light theme uses its own colours', () => {
  const grid = Ascii.toGrid(solid(10, 10, 0, 0, 0), 10, 10, { cols: 4, rows: 4 });
  const html = Renderer.renderHtml({ title: 'x', grid, theme: 'light' });
  assert.ok(html.includes('--pre-bg: #ffffff'));
});

/* ── HTML fragment builder (run-length grouping) ───────────────────── */

ok('buildHtmlFragment: flat background collapses into one span per row', () => {
  const grid = Ascii.toGrid(solid(16, 16, 255, 0, 0), 16, 16, { cols: 40, rows: 8 });
  const html = Renderer.buildHtmlFragment(grid, { mode: 'bg' });
  const spans = html.match(/<span/g) || [];
  // grouping runs per row: 8 rows → 8 spans instead of 320 per-cell elements
  assert.strictEqual(spans.length, 8);
});
ok('buildHtmlFragment: text content equals the naive per-cell build', () => {
  const grid = Ascii.toGrid(solid(30, 12, 160, 32, 240), 30, 12, { cols: 30, rows: 12 });
  for (const mode of ['mono', 'fg', 'bg', 'both']) {
    const html = Renderer.buildHtmlFragment(grid, { mode });
    const text = html
      .replace(/<span[^>]*>/g, '')
      .replace(/<\/span>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    const expected = grid.cells
      .map((c, i) => {
        // in bg mode a plain cell paints a colour block rendered as &nbsp;
        const ch = mode === 'bg' ? ' ' : c.char;
        return (i + 1) % grid.cols === 0 ? ch + '\n' : ch;
      })
      .join('');
    assert.strictEqual(text, expected, 'mode ' + mode + ' diverges from the naive build');
  }
});
ok('buildHtmlFragment: stamped glyphs survive grouping', () => {
  const stamped = Ascii.stampText(STAMP_GRID, { texts: ['HI'], mode: 'once' });
  const html = Renderer.buildHtmlFragment(stamped, { mode: 'bg', preFg: '#ffffff' });
  assert.ok(html.includes('>HI<'), 'stamped text missing: ' + html.slice(0, 200));
});

/* ── animation HTML ────────────────────────────────────────────────── */

ok('buildAnimHtml: embeds escaped frames and controls', () => {
  const html = Renderer.buildAnimHtml({
    title: 'clip.mp4',
    frames: ['row1\nrow2', 'row3\nrow4'],
    fps: 10,
    speed: 2,
    mode: 'mono',
    fontFamily: 'Consolas, monospace',
    fontSize: 14,
    theme: 'dark',
    meta: { source: 'clip.mp4' },
    generatedAt: '2020-01-01 00:00:00',
  });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('var FRAMES = '));
  assert.ok(html.includes('<pre id="anim">'));
  assert.ok(html.includes('2 frames'));
  assert.ok(html.includes('id="speed"'));
  assert.ok(html.includes('w8rez'));
});
ok('buildAnimHtml: a frame containing </script> cannot break out', () => {
  const html = Renderer.buildAnimHtml({
    title: 'x',
    frames: ['</script><img src=x onerror=alert(1)>'],
    theme: 'dark',
  });
  const scriptStart = html.indexOf('var FRAMES = ');
  const scriptEnd = html.indexOf('</script>', scriptStart);
  const payload = html.slice(scriptStart, scriptEnd);
  assert.ok(!payload.includes('</script>'), 'payload escaped its container');
  assert.ok(payload.includes('\\u003c'), 'payload was not escaped');
});
ok('buildAnimHtml: deterministic with generatedAt', () => {
  const opts = {
    title: 'x', frames: ['a'], fps: 12, speed: 1, theme: 'dark',
    generatedAt: '2020-01-01 00:00:00',
  };
  assert.strictEqual(Renderer.buildAnimHtml(opts), Renderer.buildAnimHtml(opts));
});

/* ── Node (no DOM) behaviour ───────────────────────────────────────── */

ok('measureCharAspect returns null without a DOM', () => {
  assert.strictEqual(Renderer.measureCharAspect('monospace'), null);
});
ok('renderPng returns null without a canvas', () => {
  assert.strictEqual(Renderer.renderPng({}), null);
});
ok('drawGridToCanvas returns null without a DOM', () => {
  assert.strictEqual(Renderer.drawGridToCanvas(null, null, {}, {}), null);
});

/* ── sanitisation helpers ──────────────────────────────────────────── */

ok('safeColor accepts hex only', () => {
  assert.strictEqual(Renderer.safeColor('#FF0000', 'FB'), '#FF0000');
  assert.strictEqual(Renderer.safeColor('#f00', 'FB'), '#f00');
  assert.strictEqual(Renderer.safeColor('red', 'FB'), 'FB');
  assert.strictEqual(Renderer.safeColor('#ff0000; }', 'FB'), 'FB');
});
ok('safeFontStack blocks declarations, blocks and URLs', () => {
  assert.strictEqual(Renderer.safeFontStack('Consolas, Menlo, monospace', 'FB'), 'Consolas, Menlo, monospace');
  assert.strictEqual(Renderer.safeFontStack('a; b', 'FB'), 'FB');
  assert.strictEqual(Renderer.safeFontStack('a } b', 'FB'), 'FB');
  assert.strictEqual(Renderer.safeFontStack('url(x)', 'FB'), 'FB');
  assert.strictEqual(Renderer.safeFontStack('<script>', 'FB'), 'FB');
});

/* ── stampText ─────────────────────────────────────────────────────── */

ok('stampText: once, centred, glyphs stamped', () => {
  const s = Ascii.stampText(STAMP_GRID, { texts: ['HOLA'], mode: 'once' });
  const row = Array.from({ length: 20 }, (_, x) => s.cells[4 * 20 + x].char).join('');
  assert.ok(row.includes('HOLA'), 'centre row: [' + row + ']');
  assert.ok(s.stamped[4 * 20 + 8] === true, 'H cell not stamped');
});
ok('stampText: repeat spreads copies vertically', () => {
  const s = Ascii.stampText(STAMP_GRID, { texts: ['X'], mode: 'repeat', repeat: 2 });
  const hits = [];
  for (let y = 0; y < 10; y++) if (s.stamped[y * 20 + 9]) hits.push(y);
  assert.deepStrictEqual(hits, [3, 6]);
});
ok('stampText: no texts returns the same grid', () => {
  assert.strictEqual(Ascii.stampText(STAMP_GRID, { texts: [] }), STAMP_GRID);
  assert.strictEqual(Ascii.stampText(STAMP_GRID, { texts: [''] }), STAMP_GRID);
  assert.strictEqual(Ascii.stampText(STAMP_GRID, null), STAMP_GRID);
});
ok('stampText: whitespace-only text stamps nothing but returns a new grid', () => {
  const s = Ascii.stampText(STAMP_GRID, { texts: ['  '] });
  assert.notStrictEqual(s, STAMP_GRID);
  assert.ok(s.stamped.every((v) => !v));
});
ok('stampText: the original grid is never mutated', () => {
  const before = STAMP_GRID.cells.map((c) => c.char).join('');
  Ascii.stampText(STAMP_GRID, { texts: ['ZZZ'], mode: 'once' });
  assert.strictEqual(STAMP_GRID.cells.map((c) => c.char).join(''), before);
});
ok('stampText: text spaces do not erase the underlying art', () => {
  const s = Ascii.stampText(STAMP_GRID, { texts: ['A B'], mode: 'once' });
  assert.ok(!s.stamped[4 * 20 + 9], 'space should not be stamped');
  assert.ok(s.stamped[4 * 20 + 8] && s.stamped[4 * 20 + 10], 'letters should be stamped');
});
ok('stampText: oversized text is clipped safely', () => {
  const s = Ascii.stampText(STAMP_GRID, { texts: ['ABCDEFGHIJKLMNOPQRSTUVWXYZ'], mode: 'once' });
  assert.strictEqual(s.cells.length, STAMP_GRID.cells.length);
});
ok('stampText: inputs are capped (max lines, max length)', () => {
  const many = Array.from({ length: 20 }, (_, i) => 'L' + i);
  const s = Ascii.stampText(STAMP_GRID, { texts: many });
  assert.ok(s.stamped.filter(Boolean).length <= Ascii.LIMITS.MAX_TEXT_LINES * 2);
});
ok('stampText: invalid grid is rejected', () => {
  assert.throws(() => Ascii.stampText({ cols: 2, rows: 2, cells: [] }), TypeError);
});

/* ── random (deterministic) placement ─────────────────────────────── */

ok('random placement: same seed → same positions', () => {
  const opts = { texts: ['ABC', 'DE'], mode: 'once', random: true, seed: 42 };
  assert.deepStrictEqual(
    stampedPositions(Ascii.stampText(STAMP_GRID, opts)),
    stampedPositions(Ascii.stampText(STAMP_GRID, opts))
  );
});
ok('random placement: different seed → different positions', () => {
  const a = Ascii.stampText(STAMP_GRID, { texts: ['ABC'], random: true, seed: 1 });
  const b = Ascii.stampText(STAMP_GRID, { texts: ['ABC'], random: true, seed: 2 });
  assert.notStrictEqual(stampedPositions(a).join(','), stampedPositions(b).join(','));
});
ok('random placement: stays inside the grid', () => {
  const s = Ascii.stampText(STAMP_GRID, { texts: ['ABC'], random: true, seed: 7 });
  assert.strictEqual(s.stamped.filter(Boolean).length, 3);
  stampedPositions(s).forEach((i) => {
    assert.ok(i >= 0 && i < STAMP_GRID.cols * STAMP_GRID.rows, 'index out of range');
  });
});
ok('random placement: repeat mode places N copies per line', () => {
  const s = Ascii.stampText(STAMP_GRID, { texts: ['X'], mode: 'repeat', repeat: 3, random: true, seed: 5 });
  assert.strictEqual(s.stamped.filter(Boolean).length, 3);
});

/* ── EPS helper ────────────────────────────────────────────────────── */

// Minimal valid 1×1 JPEG (starts with SOI, ends with EOI)
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64'
);

ok('eps: extracts the embedded JPEG preview', () => {
  const eps = Buffer.concat([
    Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\n', 'latin1'),
    JPEG_1X1,
    Buffer.from('\n%%EndPreview\n%PS content here\nshowpage\n%%EOF\n', 'latin1'),
  ]);
  const jpeg = Eps.extractJpegPreview(eps);
  assert.ok(jpeg, 'no preview found');
  assert.strictEqual(jpeg.length, JPEG_1X1.length);
  assert.ok(jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9);
});
ok('eps: keeps the largest stream when several exist', () => {
  const big = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(500, 0xaa), Buffer.from([0xff, 0xd9])]);
  const jpeg = Eps.extractJpegPreview(Buffer.concat([big, JPEG_1X1]));
  assert.strictEqual(jpeg.length, big.length);
});
ok('eps: returns null when there is no preview', () => {
  const eps = Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n10 10 moveto 90 90 lineto stroke\nshowpage\n%%EOF\n', 'latin1');
  assert.strictEqual(Eps.extractJpegPreview(eps), null);
});
ok('eps: looksLikeEps sniffs the DSC header', () => {
  const okEps = Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n%%EOF\n', 'latin1');
  assert.strictEqual(Eps.looksLikeEps(okEps), true);
  assert.strictEqual(Eps.looksLikeEps(Buffer.from('<svg></svg>')), false);
  assert.strictEqual(Eps.looksLikeEps(Buffer.alloc(0)), false);
});

/* ── summary ───────────────────────────────────────────────────────── */

console.log('\n' + passed + ' tests OK' + (failed ? ', ' + failed + ' FAILED' : ''));
if (failed) {
  console.error('  ── there are failures ──');
  process.exit(1);
}

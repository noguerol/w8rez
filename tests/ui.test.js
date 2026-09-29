/*
 * w8rez — UI helper test suite (plain Node, zero dependencies).
 * Run: node tests/ui.test.js   (or: npm run test:ui)
 *
 * Covers the pure helpers exported by js/ui.js: the stepper/range clamping,
 * the zoom stops, the accordion summaries and the preview badge. The DOM part
 * of the module (`init`) is intentionally untested here — it needs a browser
 * and is covered by tests/e2e.browser.js. Requiring the module in Node must
 * work without a DOM, which is asserted below.
 *
 * The interface theme helpers (`applyTheme`, `nextTheme`, `themeDefaults`,
 * `syncColorReadout`) are exercised here too. Note that `applyTheme` only
 * touches the interface: the artwork <select id="theme"> of the Render &
 * output group belongs to js/app.js and is never read or written by ui.js.
 */
'use strict';

const assert = require('assert');
const UI = require('../js/ui.js');

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

/* helpers ------------------------------------------------------------ */

const RANGE = { min: 20, max: 300, step: 5 };

/** The set of values `zoomStep` is allowed to return. */
function isZoomLevel(value) {
  return UI.zoomLevels.indexOf(value) !== -1;
}

/* ── clampStep ─────────────────────────────────────────────────────── */

ok('clampStep: increments by the step', () => {
  assert.strictEqual(UI.clampStep(100, RANGE, 1), 105);
  assert.strictEqual(UI.clampStep(60, RANGE, 1), 65);
});

ok('clampStep: decrements by the step', () => {
  assert.strictEqual(UI.clampStep(105, RANGE, -1), 100);
  assert.strictEqual(UI.clampStep(100, { min: 1, max: 8, step: 1 }, -1), 8);
});

ok('clampStep: never goes above max', () => {
  assert.strictEqual(UI.clampStep(298, RANGE, 1), 300);
  assert.strictEqual(UI.clampStep(300, RANGE, 1), 300);
  assert.strictEqual(UI.clampStep(999, RANGE, 1), 300);
});

ok('clampStep: never goes below min', () => {
  assert.strictEqual(UI.clampStep(22, RANGE, -1), 20);
  assert.strictEqual(UI.clampStep(20, RANGE, -1), 20);
  assert.strictEqual(UI.clampStep(1, { min: 1, max: 8, step: 1 }, -1), 1);
});

ok('clampStep: works with float steps and no binary noise', () => {
  assert.strictEqual(UI.clampStep(0.2, { min: 0, max: 1, step: 0.1 }, 1), 0.3);
  assert.strictEqual(UI.clampStep(0.3, { min: 0, max: 1, step: 0.1 }, -1), 0.2);
  assert.strictEqual(UI.clampStep(0.25, { min: 0, max: 1, step: 0.25 }, 1), 0.5);
});

ok('clampStep: honours a step larger than one', () => {
  assert.strictEqual(UI.clampStep(100, { min: 20, max: 300, step: 25 }, 1), 125);
  assert.strictEqual(UI.clampStep(125, { min: 20, max: 300, step: 25 }, -1), 100);
  assert.strictEqual(UI.clampStep(290, { min: 20, max: 300, step: 25 }, 1), 300);
});

ok('clampStep: tolerates missing min/max/options', () => {
  assert.strictEqual(UI.clampStep(5, {}, 1), 6);
  assert.strictEqual(UI.clampStep(5, undefined, -1), 4);
  assert.strictEqual(UI.clampStep(5, { step: 2 }, 1), 7);
});

ok('clampStep: non-numeric input falls back to a sane value', () => {
  const fromMin = UI.clampStep('abc', { min: 1, max: 8, step: 1 }, 1);
  assert.strictEqual(fromMin, 2);
  const noMin = UI.clampStep(NaN, { step: 1 }, 1);
  assert.strictEqual(noMin, 1);
  const zero = UI.clampStep(null, { min: 0, max: 10, step: 1 }, 1);
  assert.strictEqual(zero, 1);
});

ok('clampStep: dir 0 leaves the value alone', () => {
  assert.strictEqual(UI.clampStep(5, { min: 1, max: 8, step: 1 }, 0), 5);
  assert.strictEqual(UI.clampStep(42, RANGE), 42);
});

ok('clampStep: always returns a number', () => {
  const values = [
    UI.clampStep('100', RANGE, 1),
    UI.clampStep(100, RANGE, -1),
    UI.clampStep('', RANGE, 1),
    UI.clampStep(100, { min: 0, max: 0, step: 1 }, 1),
  ];
  values.forEach((value, i) => {
    assert.strictEqual(typeof value, 'number', 'value #' + i + ' is ' + typeof value);
    assert(!Number.isNaN(value), 'value #' + i + ' is NaN');
    assert(Number.isFinite(value), 'value #' + i + ' is not finite');
  });
});

/* ── zoomLevels / zoomStep ─────────────────────────────────────────── */

ok('zoomLevels: is the documented stop list', () => {
  assert.deepStrictEqual(UI.zoomLevels, [0.75, 1, 1.25, 1.5, 2, 3]);
  assert(Array.isArray(UI.zoomLevels), 'not an array');
});

ok('zoomStep: stays at the lowest stop going down', () => {
  assert.strictEqual(UI.zoomStep(0.75, -1), 0.75);
  assert.strictEqual(UI.zoomStep(0.5, -1), 0.75);
});

ok('zoomStep: stays at the highest stop going up', () => {
  assert.strictEqual(UI.zoomStep(3, 1), 3);
  assert.strictEqual(UI.zoomStep(4, 1), 3);
});

ok('zoomStep: moves one stop from the base level', () => {
  assert.strictEqual(UI.zoomStep(1, 1), 1.25);
  assert.strictEqual(UI.zoomStep(1, -1), 0.75);
});

ok('zoomStep: walks the middle stops in both directions', () => {
  assert.strictEqual(UI.zoomStep(1.25, 1), 1.5);
  assert.strictEqual(UI.zoomStep(1.25, -1), 1);
  assert.strictEqual(UI.zoomStep(1.5, 1), 2);
  assert.strictEqual(UI.zoomStep(1.5, -1), 1.25);
  assert.strictEqual(UI.zoomStep(2, 1), 3);
  assert.strictEqual(UI.zoomStep(2, -1), 1.5);
});

ok('zoomStep: snaps an in-between zoom to the nearest stop', () => {
  assert.strictEqual(UI.zoomStep(1.1, 1), 1.25);
  assert.strictEqual(UI.zoomStep(1.1, -1), 0.75);
  assert.strictEqual(UI.zoomStep(1.4, 1), 2);
  assert.strictEqual(UI.zoomStep(2.9, 1), 3);
});

ok('zoomStep: unknown zoom resolves to a real stop', () => {
  assert.strictEqual(UI.zoomStep(NaN, 1), 1.25);
  assert.strictEqual(UI.zoomStep(NaN, -1), 0.75);
  assert.strictEqual(UI.zoomStep(undefined, 1), 1.25);
  assert.strictEqual(UI.zoomStep(null, 0), 1);
  assert.strictEqual(UI.zoomStep('nonsense', 1), 1.25);
});

ok('zoomStep: always returns a member of zoomLevels', () => {
  const inputs = [0.75, 1, 1.25, 1.5, 2, 3, 1.4, 0.6, 2.2, 9, NaN, undefined, ''];
  const directions = [-1, 0, 1];
  inputs.forEach((zoom) => {
    directions.forEach((dir) => {
      const out = UI.zoomStep(zoom, dir);
      assert(isZoomLevel(out), 'zoomStep(' + zoom + ', ' + dir + ') = ' + out);
    });
  });
});

/* ── summarizeText ─────────────────────────────────────────────────── */

ok('summarizeText: off when the overlay is disabled', () => {
  assert.strictEqual(UI.summarizeText({ enabled: false, count: 3 }), 'off');
  assert.strictEqual(UI.summarizeText({ count: 3 }), 'off');
});

ok('summarizeText: singular for one string', () => {
  assert.strictEqual(UI.summarizeText({ enabled: true, count: 1 }), '1 string');
  assert.strictEqual(UI.summarizeText({ enabled: true }), '1 string');
  assert.strictEqual(UI.summarizeText({ enabled: true, count: 0 }), '1 string');
});

ok('summarizeText: plural for several strings', () => {
  assert.strictEqual(UI.summarizeText({ enabled: true, count: 3 }), '3 strings');
  assert.strictEqual(UI.summarizeText({ enabled: true, count: 8 }), '8 strings');
  assert.strictEqual(UI.summarizeText({ enabled: true, count: '4' }), '4 strings');
});

ok('summarizeText: tolerates a missing argument', () => {
  assert.strictEqual(UI.summarizeText(), 'off');
  assert.strictEqual(UI.summarizeText(null), 'off');
});

/* ── summarizeVideo ────────────────────────────────────────────────── */

ok('summarizeVideo: no clip when no clip is selected', () => {
  assert.strictEqual(UI.summarizeVideo({ clip: false, frames: 30 }), 'no clip');
  assert.strictEqual(UI.summarizeVideo({ frames: 30 }), 'no clip');
});

ok('summarizeVideo: no clip when there are no frames yet', () => {
  assert.strictEqual(UI.summarizeVideo({ clip: true, frames: 0 }), 'no clip');
  assert.strictEqual(UI.summarizeVideo({ clip: true }), 'no clip');
  assert.strictEqual(UI.summarizeVideo({ clip: true, frames: -5 }), 'no clip');
});

ok('summarizeVideo: reports the frame count once generated', () => {
  assert.strictEqual(UI.summarizeVideo({ clip: true, frames: 30 }), '30 frames');
  assert.strictEqual(UI.summarizeVideo({ clip: true, frames: 150 }), '150 frames');
  assert.strictEqual(UI.summarizeVideo({ clip: true, frames: 12.7 }), '12 frames');
});

ok('summarizeVideo: tolerates a missing argument', () => {
  assert.strictEqual(UI.summarizeVideo(), 'no clip');
  assert.strictEqual(UI.summarizeVideo(null), 'no clip');
});

/* ── summarizeRender ───────────────────────────────────────────────── */

ok('summarizeRender: labels the monochrome mode', () => {
  assert.strictEqual(UI.summarizeRender({ mode: 'mono', size: 16 }), 'mono \u00b7 16 px');
  assert.strictEqual(UI.summarizeRender({ mode: 'mono' }), 'mono \u00b7 16 px');
});

ok('summarizeRender: labels the glyph colour mode', () => {
  assert.strictEqual(UI.summarizeRender({ mode: 'fg', size: 16 }), 'glyphs \u00b7 16 px');
});

ok('summarizeRender: labels the background colour mode', () => {
  assert.strictEqual(UI.summarizeRender({ mode: 'bg', size: 16 }), 'background \u00b7 16 px');
});

ok('summarizeRender: labels the combined colour mode', () => {
  assert.strictEqual(UI.summarizeRender({ mode: 'both', size: 16 }), 'background+glyphs \u00b7 16 px');
});

ok('summarizeRender: follows the font size and defaults safely', () => {
  assert.strictEqual(UI.summarizeRender({ mode: 'mono', size: 24 }), 'mono \u00b7 24 px');
  assert.strictEqual(UI.summarizeRender({ mode: 'fg', size: '22' }), 'glyphs \u00b7 22 px');
  assert.strictEqual(UI.summarizeRender({ mode: 'nope', size: 40 }), 'mono \u00b7 40 px');
  assert.strictEqual(UI.summarizeRender(), 'mono \u00b7 16 px');
});

/* ── formatBadge ───────────────────────────────────────────────────── */

ok('formatBadge: prefers the grid dimensions', () => {
  assert.strictEqual(UI.formatBadge({ cols: 100, rows: 50 }), 'ASCII 100 \u00d7 50');
  assert.strictEqual(UI.formatBadge({ cols: 60, rows: 33 }), 'ASCII 60 \u00d7 33');
  assert.strictEqual(UI.formatBadge({ cols: 100, rows: 50, name: 'demo.png' }), 'ASCII 100 \u00d7 50');
});

ok('formatBadge: rounds fractional dimensions', () => {
  assert.strictEqual(UI.formatBadge({ cols: 99.6, rows: 49.4 }), 'ASCII 100 \u00d7 49');
});

ok('formatBadge: falls back to the file name', () => {
  assert.strictEqual(UI.formatBadge({ name: 'demo.png' }), 'demo.png');
  assert.strictEqual(UI.formatBadge({ cols: 0, rows: 0, name: 'clip.mp4' }), 'clip.mp4');
});

ok('formatBadge: "No file" without dimensions or name', () => {
  assert.strictEqual(UI.formatBadge({}), 'No file');
  assert.strictEqual(UI.formatBadge(), 'No file');
  assert.strictEqual(UI.formatBadge({ cols: 100 }), 'No file');
  assert.strictEqual(UI.formatBadge({ name: '   ' }), 'No file');
});

/* ── themeDefaults / nextTheme ─────────────────────────────────────── */

ok('nextTheme: toggles between the two themes', () => {
  assert.strictEqual(UI.nextTheme('dark'), 'light');
  assert.strictEqual(UI.nextTheme('light'), 'dark');
});

ok('nextTheme: unknown input normalises to dark', () => {
  assert.strictEqual(UI.nextTheme(undefined), 'dark');
  assert.strictEqual(UI.nextTheme('weird'), 'dark');
  assert.strictEqual(UI.nextTheme(null), 'dark');
});

ok('themeDefaults: carries the two canvas colours', () => {
  assert.strictEqual(UI.themeDefaults.light, '#ffffff');
  assert.strictEqual(UI.themeDefaults.dark, '#000000');
});

ok('applyTheme: exists and normalises without a DOM', () => {
  assert.strictEqual(typeof UI.applyTheme, 'function');
  assert.strictEqual(UI.applyTheme(), 'dark');
  assert.strictEqual(UI.applyTheme('light'), 'light');
  assert.strictEqual(UI.applyTheme('weird'), 'dark');
});

ok('applyTheme: undefined and unknown input resolve to dark', () => {
  assert.strictEqual(UI.applyTheme(undefined), 'dark');
  assert.strictEqual(UI.applyTheme(null), 'dark');
});

ok('applyTheme: lives off the artwork <select> and never throws without a DOM', () => {
  assert.strictEqual(typeof UI.applyTheme, 'function');
  assert.strictEqual(typeof UI.syncColorReadout, 'function');
  // No DOM in Node: the calls must stay inert instead of throwing.
  assert.strictEqual(UI.applyTheme('light'), 'light');
  assert.strictEqual(UI.applyTheme('nonsense'), 'dark');
  assert.strictEqual(UI.syncColorReadout(), false);
});

ok('syncColorReadout: exists and is inert without a DOM', () => {
  assert.strictEqual(typeof UI.syncColorReadout, 'function');
  assert.strictEqual(UI.syncColorReadout(), false);
});

/* ── module shape (Node, no DOM) ───────────────────────────────────── */

ok('module: loads in Node without touching the DOM', () => {
  assert.strictEqual(typeof globalThis.document, 'undefined', 'a DOM leaked into the test environment');
  assert.strictEqual(typeof UI.init, 'function');
});

ok('module: exposes the pure helpers and the component API', () => {
  ['clampStep', 'zoomStep', 'summarizeText', 'summarizeVideo', 'summarizeRender', 'formatBadge',
    'init', 'openAccordion', 'closeAccordion', 'toggleAccordion', 'syncSegmented', 'setFileCard',
    'setBadge', 'setSummaries', 'getZoom', 'isOriginalView', 'setOriginalAvailable',
    'syncThemeToggle', 'applyTheme', 'syncColorReadout'].forEach((name) => {
    assert.strictEqual(typeof UI[name], 'function', name + ' is not a function');
  });
  assert(Array.isArray(UI.zoomLevels), 'zoomLevels is not an array');
});

ok('module: the DOM API is inert before init() in Node', () => {
  assert.strictEqual(UI.init(), UI, 'init() without a document should return the API');
  assert.strictEqual(UI.getZoom(), 1);
  assert.strictEqual(UI.isOriginalView(), false);
  assert.deepStrictEqual([UI.openAccordion('acc-text'), UI.closeAccordion('acc-text')], [false, false]);
});

/* ── summaryFor: the shape app.js hands to setSummaries ───────────── */

ok('summaryFor: formats the option objects used by the app', () => {
  assert.strictEqual(UI.summaryFor('text', { enabled: false, count: 3 }), 'off');
  assert.strictEqual(UI.summaryFor('text', { enabled: true, count: 3 }), '3 strings');
  assert.strictEqual(UI.summaryFor('video', { clip: false, frames: 0 }), 'no clip');
  assert.strictEqual(UI.summaryFor('video', { clip: true, frames: 95 }), '95 frames');
  assert.strictEqual(UI.summaryFor('render', { mode: 'mono', size: 16 }), 'mono · 16 px');
});

ok('summaryFor: passes ready strings through and ignores nothing', () => {
  assert.strictEqual(UI.summaryFor('text', 'custom'), 'custom');
  assert.strictEqual(UI.summaryFor('video', 'no clip'), 'no clip');
  assert.strictEqual(UI.summaryFor('render', null), null);
  assert.strictEqual(UI.summaryFor('render', undefined), null);
});

ok('setBadge/setSummaries accept both strings and option objects', () => {
  // No document in Node: the calls must stay inert instead of throwing.
  assert.strictEqual(UI.setBadge({ cols: 100, rows: 50 }), false);
  assert.strictEqual(UI.setBadge('No file'), false);
  assert.strictEqual(UI.setSummaries({ text: { enabled: true, count: 2 } }), false);
});

/* ── summary ───────────────────────────────────────────────────────── */

console.log('\n' + passed + ' tests OK' + (failed ? ', ' + failed + ' FAILED' : ''));
if (failed) {
  console.error('  ── there are failures ──');
  process.exit(1);
}

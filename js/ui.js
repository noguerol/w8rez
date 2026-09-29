/*
 * w8rez — reusable UI components (plain DOM, zero dependencies).
 *
 * The control panel is built from a handful of small widgets: collapsible
 * groups (accordions), numeric steppers, segmented controls, the colour swatch
 * readout, the file card, the preview badge, the zoom control, the
 * "view original" toggle and the theme toggle. This module owns their
 * behaviour and exposes it through a small API, so `js/app.js` only has to call
 * `W8rez.UI.init(document)` and listen to the events this module re-broadcasts
 * on the document: `w8rez:zoom`, `w8rez:vieworiginal` and `w8rez:clearfile`.
 *
 * The pure helpers behind those widgets (`clampStep`, `zoomStep`,
 * `summarizeText`, `summarizeVideo`, `summarizeRender`, `formatBadge`) are
 * exported as well and are the ones exercised by `tests/ui.test.js` in Node.
 *
 * UMD: works in the browser (`window.W8rez.UI`) and in Node (`require`). In
 * Node the module never touches the DOM at load time, so requiring it is safe.
 * In the browser it also wires itself up on DOMContentLoaded when the page has
 * not initialised it explicitly — `init()` is idempotent per document, so a
 * later `init()` call from app.js is a no-op.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.W8rez = root.W8rez || {};
    root.W8rez.UI = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Constants
   * ------------------------------------------------------------------ */

  /** U+00B7 MIDDLE DOT — separator used by the accordion summaries. */
  const MIDDLE_DOT = '\u00b7';
  /** U+00D7 MULTIPLICATION SIGN — used by the preview badge ("ASCII 100 × 50"). */
  const MULTIPLICATION_SIGN = '\u00d7';
  /** U+2014 EM DASH — placeholder shown when no file is loaded. */
  const PLACEHOLDER = '\u2014';

  /** Colour-mode values → labels shown in the collapsed "Render" summary. */
  const MODE_LABELS = {
    mono: 'mono',
    fg: 'glyphs',
    bg: 'background',
    both: 'background+glyphs',
  };

  const DEFAULT_MODE = 'mono';
  const DEFAULT_FONT_SIZE = 16;
  const FALLBACK_BADGE = 'No file';

  /** Zoom stops; 1 means "fit the frame". */
  const zoomLevels = [0.75, 1, 1.25, 1.5, 2, 3];
  const BASE_ZOOM = 1;

  /** Fallbacks used when a stepper input lacks min/max/step attributes. */
  const STEPPER_FALLBACK = {
    'text-count': { min: 1, max: 8, step: 1 },
    'text-repeat': { min: 1, max: 30, step: 1 },
  };
  const DEFAULT_STEPPER = { min: 0, max: Infinity, step: 1 };

  /** Values restored by the Reset button, in wiring order. */
  const RESET_CONTROLS = [
    { id: 'width', value: '100', event: 'input' },
    { id: 'palette', value: 'map', event: 'change' },
    { id: 'custom-palette', value: ' .:-=+*#%@', event: 'input' },
    { id: 'dynamic', checked: true, event: 'change' },
    { id: 'auto-aspect', checked: true, event: 'change' },
    { id: 'invert', checked: false, event: 'change' },
    { id: 'text-toggle', checked: false, event: 'change' },
    { id: 'text-random', checked: false, event: 'change' },
    { id: 'text-count', value: '1', event: 'input' },
    { id: 'text-repeat', value: '3', event: 'input' },
    { id: 'text-use', value: 'once', event: 'change' },
    { id: 'mode', value: DEFAULT_MODE, event: 'change' },
    { id: 'theme', value: 'dark', event: 'change' },
    { id: 'bg-color', value: '#000000', event: 'input' },
    { id: 'font-size', value: String(DEFAULT_FONT_SIZE), event: 'input' },
    { id: 'vid-fps', value: '10', event: 'change' },
    { id: 'vid-speed', value: '1', event: 'change' },
    { id: 'vid-start', value: '0', event: 'input' },
    { id: 'vid-end', value: '100', event: 'input' },
  ];

  /* ------------------------------------------------------------------ *
   *  Pure helpers (no DOM — exported and unit-tested in Node)
   * ------------------------------------------------------------------ */

  /** Parse a value into a finite number, or return the fallback. */
  function toNumber(value, fallback) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /** Decimal places implied by a step (0.1 → 1, 25 → 0). */
  function stepPrecision(step) {
    const text = String(Math.abs(toNumber(step, 1)));
    const dot = text.indexOf('.');
    if (dot === -1) return 0;
    return Math.min(10, text.length - dot - 1);
  }

  /** Round away binary floating point noise (0.1 + 0.1 + 0.1). */
  function roundTo(value, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  /**
   * Move a numeric value by `dir` steps and clamp it into [min, max].
   *
   * @param {number|string} value current value (anything non-numeric falls
   *   back to `min`, or 0 when there is no min)
   * @param {{min?: number, max?: number, step?: number}} [options]
   * @param {number} [dir] -1 to decrease, +1 to increase, 0 for no move
   * @returns {number} the clamped value, free of floating point noise
   */
  function clampStep(value, options, dir) {
    const opts = options && typeof options === 'object' ? options : {};
    const min = toNumber(opts.min, -Infinity);
    const max = toNumber(opts.max, Infinity);
    const step = Math.abs(toNumber(opts.step, 1)) || 1;
    const direction = toNumber(dir, 0);

    let base = toNumber(value, NaN);
    if (!Number.isFinite(base)) base = Number.isFinite(min) ? min : 0;

    let next = base + direction * step;
    if (next < min) next = min;
    if (next > max) next = max;
    return roundTo(next, stepPrecision(step));
  }

  /**
   * Next zoom stop towards `dir`, clamped to the ends of `zoomLevels`.
   * A zoom that is not exactly a stop snaps to the nearest one first; an
   * unknown (non-finite) zoom resolves to the base level.
   *
   * @param {number} zoom
   * @param {number} dir
   * @returns {number} a member of `zoomLevels`
   */
  function zoomStep(zoom, dir) {
    const current = toNumber(zoom, NaN);
    let index = zoomLevels.indexOf(current);

    if (index === -1) {
      if (!Number.isFinite(current)) {
        index = zoomLevels.indexOf(BASE_ZOOM);
      } else {
        let best = 0;
        let bestDistance = Infinity;
        for (let i = 0; i < zoomLevels.length; i++) {
          const distance = Math.abs(zoomLevels[i] - current);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
          }
        }
        index = best;
      }
    }

    const direction = toNumber(dir, 0);
    if (direction > 0) index += 1;
    else if (direction < 0) index -= 1;

    if (index < 0) index = 0;
    if (index > zoomLevels.length - 1) index = zoomLevels.length - 1;
    return zoomLevels[index];
  }

  /** "off" / "1 string" / "3 strings" for the Text overlay accordion. */
  function summarizeText(options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (!opts.enabled) return 'off';
    const count = Math.max(1, Math.trunc(toNumber(opts.count, 1)));
    return count + (count === 1 ? ' string' : ' strings');
  }

  /** "no clip" until a clip with at least one frame is selected. */
  function summarizeVideo(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const frames = Math.trunc(toNumber(opts.frames, 0));
    if (!opts.clip || frames < 1) return 'no clip';
    return frames + ' frames';
  }

  /** "mono · 16 px" — colour-mode label plus the font size. */
  function summarizeRender(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const label = MODE_LABELS[opts.mode] || MODE_LABELS[DEFAULT_MODE];
    const size = Math.round(toNumber(opts.size, DEFAULT_FONT_SIZE));
    return label + ' ' + MIDDLE_DOT + ' ' + size + ' px';
  }

  /** "ASCII 100 × 50", the file name, or "No file". */
  function formatBadge(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const cols = Math.round(toNumber(opts.cols, 0));
    const rows = Math.round(toNumber(opts.rows, 0));
    if (cols > 0 && rows > 0) {
      return 'ASCII ' + cols + ' ' + MULTIPLICATION_SIGN + ' ' + rows;
    }
    const name = typeof opts.name === 'string' ? opts.name.trim() : '';
    return name || FALLBACK_BADGE;
  }

  /** Default canvas backgrounds used by the two themes. */
  const themeDefaults = { dark: '#000000', light: '#ffffff' };

  /**
   * The opposite theme: 'light' only comes from 'dark'; any other value
   * (unknown, missing) resolves to 'dark'.
   *
   * @param {string} [current]
   * @returns {'dark'|'light'}
   */
  function nextTheme(current) {
    return current === 'dark' ? 'light' : 'dark';
  }

  /* ------------------------------------------------------------------ *
   *  DOM wiring
   * ------------------------------------------------------------------ */

  /** Document wired by `init()` — stays null in Node and before init. */
  let doc = null;
  /** Documents already wired, so `init()` is idempotent. */
  const wired = typeof WeakSet === 'function' ? new WeakSet() : null;

  /** Live widget state shared with the exported accessors. */
  const state = {
    zoom: BASE_ZOOM,
    original: false,
    originalAvailable: true,
  };

  function byId(id) {
    if (!doc || !id || typeof doc.getElementById !== 'function') return null;
    return doc.getElementById(id);
  }

  function qsa(selector) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    return Array.prototype.slice.call(doc.querySelectorAll(selector));
  }

  function attr(node, name) {
    return node && typeof node.getAttribute === 'function' ? node.getAttribute(name) : null;
  }

  /** Dispatch a plain bubbling event on a node. */
  function fire(node, type) {
    if (!node || typeof node.dispatchEvent !== 'function') return false;
    let event;
    try {
      event = new Event(type, { bubbles: true });
    } catch (err) {
      if (!doc || typeof doc.createEvent !== 'function') return false;
      event = doc.createEvent('Event');
      event.initEvent(type, true, true);
    }
    node.dispatchEvent(event);
    return true;
  }

  /** Dispatch a bubbling CustomEvent carrying `detail` on a node. */
  function fireCustom(node, type, detail) {
    if (!node || typeof node.dispatchEvent !== 'function') return false;
    const data = detail || {};
    let event;
    try {
      event = new CustomEvent(type, { bubbles: true, detail: data });
    } catch (err) {
      if (!doc || typeof doc.createEvent !== 'function') return false;
      event = doc.createEvent('CustomEvent');
      event.initEvent(type, true, true);
      event.detail = data;
    }
    node.dispatchEvent(event);
    return true;
  }

  /* ---- accordions -------------------------------------------------- */

  function isOpen(section) {
    if (!section || typeof section.hasAttribute !== 'function') return false;
    return section.hasAttribute('data-open') && section.getAttribute('data-open') !== 'false';
  }

  function setAccordion(section, open) {
    if (!section || typeof section.setAttribute !== 'function') return false;
    if (open) section.setAttribute('data-open', 'true');
    else section.removeAttribute('data-open');
    const head = typeof section.querySelector === 'function' ? section.querySelector('.acc-head') : null;
    if (head && typeof head.setAttribute === 'function') {
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    return Boolean(open);
  }

  /** Resolve an id (or an element) to the accordion section it belongs to. */
  function accordionSection(idOrElement) {
    let el = idOrElement;
    if (typeof idOrElement === 'string') el = byId(idOrElement);
    if (!el || typeof el.getAttribute !== 'function') return null;
    if (el.classList && el.classList.contains('acc')) return el;
    if (typeof el.closest === 'function') return el.closest('.acc');
    return null;
  }

  function openAccordion(id) {
    const section = accordionSection(id);
    return section ? setAccordion(section, true) : false;
  }

  function closeAccordion(id) {
    const section = accordionSection(id);
    return section ? setAccordion(section, false) : false;
  }

  function toggleAccordion(id) {
    const section = accordionSection(id);
    return section ? setAccordion(section, !isOpen(section)) : false;
  }

  /* ---- steppers ---------------------------------------------------- */

  function syncFieldOutput(outputId, value) {
    const out = byId(outputId);
    if (out) out.textContent = String(value);
    return out;
  }

  function stepperOptions(input, inputId) {
    const fallback = STEPPER_FALLBACK[inputId] || DEFAULT_STEPPER;
    return {
      min: toNumber(attr(input, 'min'), fallback.min),
      max: toNumber(attr(input, 'max'), fallback.max),
      step: toNumber(attr(input, 'step'), fallback.step),
    };
  }

  function stepInput(button) {
    const inputId = attr(button, 'data-stepper');
    const input = byId(inputId);
    if (!input) return null;
    const direction = toNumber(attr(button, 'data-step'), 1) < 0 ? -1 : 1;
    const next = clampStep(input.value, stepperOptions(input, inputId), direction);
    input.value = String(next);
    syncFieldOutput(inputId + '-val', next);
    fire(input, 'input');
    return next;
  }

  /* ---- segmented controls ------------------------------------------ */

  function segButtons(selectId) {
    if (!selectId || typeof selectId !== 'string') return [];
    return qsa('.seg[data-select="' + selectId + '"]');
  }

  /** Re-sync `aria-pressed` from the value of the backing <select>. */
  function syncSegmented(selectId) {
    const select = byId(selectId);
    if (!select) return false;
    const value = select.value;
    segButtons(selectId).forEach((button) => {
      button.setAttribute('aria-pressed', attr(button, 'data-value') === value ? 'true' : 'false');
    });
    return true;
  }

  function selectSegmented(button) {
    const selectId = attr(button, 'data-select');
    const select = byId(selectId);
    if (!select) return false;
    const value = attr(button, 'data-value');
    if (value !== null) select.value = value;
    syncSegmented(selectId);
    fire(select, 'change');
    return true;
  }

  /* ---- file card and badge ----------------------------------------- */

  function setFileCard(name, info) {
    const hasName = typeof name === 'string' ? name.trim().length > 0 : Boolean(name);
    const card = byId('file-card');
    if (card) {
      if (hasName) card.removeAttribute('hidden');
      else card.setAttribute('hidden', '');
    }
    const nameEl = byId('file-name');
    if (nameEl) nameEl.textContent = hasName ? name : PLACEHOLDER;
    const infoEl = byId('img-info');
    if (infoEl) infoEl.textContent = hasName && info !== undefined && info !== null ? String(info) : '';
    return hasName;
  }

  function setBadge(text) {
    const badge = byId('preview-badge-text');
    if (!badge) return false;
    // Accepts either a ready string or the {cols, rows, name} shape used by
    // formatBadge, so callers never have to pre-format the label.
    const value =
      text && typeof text === 'object'
        ? formatBadge(text)
        : text === undefined || text === null || text === ''
          ? FALLBACK_BADGE
          : String(text);
    badge.textContent = value;
    return true;
  }

  /**
   * Summary text for one group. Accepts the option object the summarizers take
   * ({enabled, count} / {clip, frames} / {mode, size}) or a ready string.
   */
  function summaryFor(kind, value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object') return String(value);
    if (kind === 'text') return summarizeText(value);
    if (kind === 'video') return summarizeVideo(value);
    if (kind === 'render') return summarizeRender(value);
    return String(value);
  }

  function setSummaries(values) {
    const map = { text: 'sum-text', video: 'sum-video', render: 'sum-render' };
    const source = values && typeof values === 'object' ? values : {};
    let wrote = false;
    Object.keys(map).forEach((key) => {
      const text = summaryFor(key, source[key]);
      if (text === null) return;
      const el = byId(map[key]);
      if (el) {
        el.textContent = text;
        wrote = true;
      }
    });
    return wrote;
  }

  /* ---- zoom -------------------------------------------------------- */

  function setZoom(next) {
    state.zoom = next;
    fireCustom(doc, 'w8rez:zoom', { zoom: state.zoom });
    return state.zoom;
  }

  function nudgeZoom(direction) {
    state.zoom = zoomStep(state.zoom, direction);
    fireCustom(doc, 'w8rez:zoom', { zoom: state.zoom });
    return state.zoom;
  }

  function fitZoom() {
    state.zoom = BASE_ZOOM;
    fireCustom(doc, 'w8rez:zoom', { zoom: state.zoom });
    return state.zoom;
  }

  function getZoom() {
    return state.zoom;
  }

  /* ---- view original ----------------------------------------------- */

  function applyOriginal(on) {
    state.original = Boolean(on);
    const canvas = byId('original-view');
    if (canvas) {
      if (state.original) canvas.removeAttribute('hidden');
      else canvas.setAttribute('hidden', '');
    }
    const preview = byId('preview');
    if (preview) {
      if (state.original) preview.setAttribute('hidden', '');
      else preview.removeAttribute('hidden');
    }
    const button = byId('btn-view-original');
    if (button) button.setAttribute('aria-pressed', state.original ? 'true' : 'false');
    return state.original;
  }

  function isOriginalView() {
    return state.original;
  }

  function toggleOriginal() {
    const next = !state.original;
    applyOriginal(next);
    fireCustom(doc, 'w8rez:vieworiginal', { on: next });
    return next;
  }

  /** Enable/disable the toggle — the button is unusable without a source. */
  function setOriginalAvailable(available) {
    state.originalAvailable = Boolean(available);
    const button = byId('btn-view-original');
    if (button) button.disabled = !state.originalAvailable;
    if (!state.originalAvailable) applyOriginal(false);
    return state.originalAvailable;
  }

  /* ---- theme toggle (interface only) --------------------------------- */

  /*
   * The interface theme toggled here is INDEPENDENT from the artwork theme
   * chosen by the <select id="theme"> in the Render & output group. That
   * <select> is owned by js/app.js and drives the glyph colour of the preview
   * and of the exports; this module never reads or writes it.
   */

  /** Theme last applied by `applyTheme` (null before the first call). */
  let lastTheme = null;

  /** Look up an element in an explicit document (works before init()). */
  function findIn(targetDoc, id) {
    return targetDoc && typeof targetDoc.getElementById === 'function' ? targetDoc.getElementById(id) : null;
  }

  /**
   * Interface theme currently in effect. Prefers the value last applied by
   * `applyTheme`, then falls back to `data-theme` on the document root and
   * finally to 'dark'. The artwork <select id="theme"> is never consulted.
   */
  function currentTheme() {
    if (lastTheme === 'dark' || lastTheme === 'light') return lastTheme;
    const target = typeof document !== 'undefined' && document ? document : null;
    const attr = target && target.documentElement && typeof target.documentElement.getAttribute === 'function'
      ? target.documentElement.getAttribute('data-theme')
      : null;
    return attr === 'dark' || attr === 'light' ? attr : 'dark';
  }

  /**
   * Apply `theme` to the INTERFACE: `data-theme` on the document root, the
   * toggle label/icon/aria, the stored preference and the `w8rez:theme`
   * event. Unknown values normalise to nextTheme(value) ('dark'). The event
   * is only re-dispatched when the theme actually changes.
   *
   * The interface theme is independent from the artwork theme of the
   * <select id="theme"> in the Render & output group, which belongs to
   * js/app.js; this function never reads or writes that <select>.
   *
   * @param {string} [theme] 'dark' or 'light' (anything else normalises)
   * @returns {'dark'|'light'} the theme that was applied
   */
  function applyTheme(theme) {
    const value = theme === 'dark' || theme === 'light' ? theme : nextTheme(theme);
    const changed = value !== lastTheme;
    const target = typeof document !== 'undefined' && document ? document : null;
    const owner = doc || target;

    if (target && target.documentElement && typeof target.documentElement.setAttribute === 'function') {
      target.documentElement.setAttribute('data-theme', value);
    }

    const label = findIn(owner, 'btn-theme-label');
    if (label) label.textContent = value === 'light' ? 'Light' : 'Dark';

    const button = findIn(owner, 'btn-theme-toggle');
    if (button) {
      button.setAttribute('aria-pressed', value === 'light' ? 'true' : 'false');
      const use = typeof button.querySelector === 'function' ? button.querySelector('use') : null;
      if (use) {
        const href = value === 'light' ? '#i-sun' : '#i-moon';
        use.setAttribute('href', href);
        if (typeof use.hasAttribute === 'function' && use.hasAttribute('xlink:href')) {
          use.setAttribute('xlink:href', href);
        }
      }
    }

    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        localStorage.setItem('w8rez:theme', value);
      }
    } catch (err) {
      /* localStorage may be missing or full: the theme still applies. */
    }

    lastTheme = value;

    if (changed && target && typeof target.dispatchEvent === 'function') {
      fireCustom(target, 'w8rez:theme', { theme: value });
    }

    return value;
  }

  /**
   * Re-apply the INTERFACE theme so the label/icon/aria agree with the current
   * state (no `w8rez:theme` event, since the value does not change). Reads from
   * `lastTheme`/`data-theme` through `currentTheme`, never from the artwork
   * <select id="theme">.
   */
  function syncThemeToggle() {
    return applyTheme(currentTheme());
  }

  function flipTheme() {
    return applyTheme(nextTheme(currentTheme()));
  }

  /** Initial theme: stored preference when valid, else the OS colour scheme. */
  function initialTheme() {
    let stored = null;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) stored = localStorage.getItem('w8rez:theme');
    } catch (err) {
      stored = null;
    }
    if (stored === 'dark' || stored === 'light') return stored;
    try {
      if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    } catch (err) {
      /* matchMedia unavailable. */
    }
    return 'dark';
  }

  /* ---- colour swatch readout --------------------------------------- */

  /** Rewrite `#bg-color-hex` from the current value of `#bg-color`. */
  function syncColorReadout() {
    const input = byId('bg-color');
    const label = byId('bg-color-hex');
    if (input && label) label.textContent = input.value;
    return Boolean(input && label);
  }

  /* ---- reset ------------------------------------------------------- */

  /** Re-sync every proxy that mirrors a control value. */
  function syncProxies() {
    const width = byId('width');
    if (width) syncFieldOutput('width-val', width.value);
    const fontSize = byId('font-size');
    if (fontSize) syncFieldOutput('fs-val', fontSize.value);
    const count = byId('text-count');
    if (count) syncFieldOutput('text-count-val', count.value);
    const repeat = byId('text-repeat');
    if (repeat) syncFieldOutput('text-repeat-val', repeat.value);
    syncSegmented('text-use');
    syncThemeToggle();
    syncColorReadout();
  }

  /** Restore every panel control to its default (the Reset button). */
  function resetControls() {
    RESET_CONTROLS.forEach((control) => {
      const el = byId(control.id);
      if (!el) return;
      if (typeof control.checked === 'boolean') el.checked = control.checked;
      if (typeof control.value === 'string') el.value = control.value;
      fire(el, control.event);
    });
    syncProxies();
    applyTheme('dark');
    syncColorReadout();
    return true;
  }

  /* ---- init -------------------------------------------------------- */

  /**
   * Wire the control panel of `targetDocument` (defaults to `document`).
   * Idempotent: calling it twice for the same document returns the API
   * without adding duplicate listeners.
   */
  function init(targetDocument) {
    const target = targetDocument || (typeof document !== 'undefined' ? document : null);
    if (!target || typeof target.getElementById !== 'function') return API;
    // Already wired: keep the API pointed at this document without adding
    // duplicate listeners (a page may call init() after the auto-init did).
    if (wired && wired.has(target)) {
      doc = target;
      return API;
    }
    if (wired) wired.add(target);

    doc = target;
    state.zoom = BASE_ZOOM;
    state.original = false;

    // (1) accordions — initial state, then click-to-toggle
    qsa('section.acc').forEach((section) => {
      let open = isOpen(section);
      if (section.id === 'acc-conversion') open = true;
      if (section.id === 'acc-text') {
        const toggle = byId('text-toggle');
        if (toggle && toggle.checked) open = true;
      }
      setAccordion(section, open);
    });

    qsa('.acc-head').forEach((head) => {
      head.addEventListener('click', () => {
        const section = accordionSection(head);
        if (section) setAccordion(section, !isOpen(section));
      });
    });

    // (2) numeric steppers
    qsa('.stepper-btn[data-stepper]').forEach((button) => {
      button.addEventListener('click', () => stepInput(button));
    });

    // (3) segmented controls
    const segmentedSelects = [];
    qsa('.seg[data-select]').forEach((button) => {
      const selectId = attr(button, 'data-select');
      if (segmentedSelects.indexOf(selectId) === -1) segmentedSelects.push(selectId);
      button.addEventListener('click', () => selectSegmented(button));
    });
    segmentedSelects.forEach((selectId) => {
      const select = byId(selectId);
      if (select) select.addEventListener('change', () => syncSegmented(selectId));
      syncSegmented(selectId);
    });

    // (4) file card
    const clearButton = byId('file-clear');
    if (clearButton) {
      clearButton.addEventListener('click', () => {
        setFileCard('');
        fireCustom(doc, 'w8rez:clearfile', {});
      });
    }

    // (7) zoom
    const zoomOut = byId('zoom-out');
    if (zoomOut) zoomOut.addEventListener('click', () => nudgeZoom(-1));
    const zoomIn = byId('zoom-in');
    if (zoomIn) zoomIn.addEventListener('click', () => nudgeZoom(1));
    const zoomFit = byId('zoom-fit');
    if (zoomFit) zoomFit.addEventListener('click', () => fitZoom());

    // (8) view original
    const originalButton = byId('btn-view-original');
    if (originalButton) originalButton.addEventListener('click', () => toggleOriginal());

    // (9) theme toggle
    const themeButton = byId('btn-theme-toggle');
    if (themeButton) themeButton.addEventListener('click', () => flipTheme());
    // The artwork <select id="theme"> belongs to js/app.js: no listener here.
    syncThemeToggle();

    // (10) reset
    const resetButton = byId('btn-reset');
    if (resetButton) resetButton.addEventListener('click', () => resetControls());

    // (11) colour swatch readout
    const bgColor = byId('bg-color');
    if (bgColor) bgColor.addEventListener('input', () => syncColorReadout());
    syncColorReadout();

    return API;
  }

  const API = {
    // pure helpers (Node-testable, no DOM)
    clampStep: clampStep,
    zoomLevels: zoomLevels,
    zoomStep: zoomStep,
    summarizeText: summarizeText,
    summarizeVideo: summarizeVideo,
    summarizeRender: summarizeRender,
    summaryFor: summaryFor,
    formatBadge: formatBadge,
    // DOM components (wired by init)
    init: init,
    openAccordion: openAccordion,
    closeAccordion: closeAccordion,
    toggleAccordion: toggleAccordion,
    syncSegmented: syncSegmented,
    setFileCard: setFileCard,
    setBadge: setBadge,
    setSummaries: setSummaries,
    getZoom: getZoom,
    setZoom: setZoom,
    isOriginalView: isOriginalView,
    setOriginalAvailable: setOriginalAvailable,
    syncThemeToggle: syncThemeToggle,
    reset: resetControls,
    // theme + colour readout helpers
    themeDefaults: themeDefaults,
    nextTheme: nextTheme,
    applyTheme: applyTheme,
    syncColorReadout: syncColorReadout,
  };

  // Startup: apply the initial interface theme before anything else is wired,
  // so the label and icon already agree with the stored/OS preference and the
  // panel never flashes the wrong colour scheme.
  if (typeof document !== 'undefined' && document) {
    applyTheme(initialTheme());
  }

  // Browser convenience: wire up automatically unless the page (app.js) does
  // it first. `init()` is idempotent, so an explicit call stays safe.
  if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        init(document);
      });
    } else {
      init(document);
    }
  }

  return API;
});

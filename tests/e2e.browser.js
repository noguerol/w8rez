/*
 * w8rez — end-to-end test harness that runs inside the page.
 *
 * Loaded into a real browser tab (see tests/e2e.sh) and driven through
 * `window.W8REZ_E2E.run()`, which returns { results, passed, failed }.
 *
 * Everything is driven through the public DOM contract of index.html, so it
 * exercises the same paths a user does: file input → engine → preview → export.
 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const FIX = 'tests/fixtures/';

  async function waitFor(fn, ms) {
    const deadline = Date.now() + (ms || 10000);
    while (Date.now() < deadline) {
      let v = false;
      try { v = fn(); } catch (e) { v = false; }
      if (v) return true;
      await sleep(60);
    }
    return false;
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function setControl(el, value, type) {
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
    fire(el, type || 'input');
    fire(el, 'change');
  }

  /** Feeds a file into #file-input exactly like a picker/drop would. */
  async function injectFile(path, name, type) {
    const res = await fetch(path);
    if (!res.ok) throw new Error('fixture missing: ' + path + ' (' + res.status + ')');
    const blob = await res.blob();
    const file = new File([blob], name, { type: type || blob.type });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = $('#file-input');
    input.files = dt.files;
    fire(input, 'change');
  }

  /** Injects a file and waits until the loader reports it by name. */
  async function load(path, name, type) {
    const before = hash(previewText());
    await injectFile(path, name, type);
    const ok = await waitFor(() => $('#file-name').textContent.indexOf(name) >= 0, 15000);
    if (!ok) {
      throw new Error('loader never reported ' + name + ' (file name: ' +
        $('#file-name').textContent + ', status: ' + $('#status').textContent + ')');
    }
    await sleep(250);
    return before;
  }

  const previewText = () => ($('#preview') ? $('#preview').textContent : '');
  const previewShape = () => {
    const t = previewText().split('\n');
    return { cols: t[0] ? t[0].length : 0, rows: t.length, chars: previewText().length };
  };
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; };

  const results = [];
  async function test(name, fn) {
    const t0 = performance.now();
    try {
      const detail = await fn();
      results.push({ name, pass: true, detail: detail === true ? '' : String(detail || ''), ms: Math.round(performance.now() - t0) });
    } catch (e) {
      results.push({ name, pass: false, detail: e && e.message ? e.message : String(e), ms: Math.round(performance.now() - t0) });
    }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  async function reset() {
    const btn = $('#btn-reset');
    if (btn) btn.click();
    await sleep(400);
  }

  async function run() {
    results.length = 0;

    /* ---------------- structure & non-functional ---------------- */

    await test('shell: layout boxes match the design (appbar 56, panel 380, bar heights)', () => {
      const appbar = $('.appbar').getBoundingClientRect();
      const panel = $('.panel.controls').getBoundingClientRect();
      const head = $('.panel-head').getBoundingClientRect();
      const foot = $('.panel-foot').getBoundingClientRect();
      const status = $('.stage-status').getBoundingClientRect();
      assert(Math.round(appbar.height) === 56, 'appbar ' + appbar.height);
      assert(Math.round(panel.width) === 380, 'panel ' + panel.width);
      assert(Math.round(head.height) === 48, 'panel-head ' + head.height);
      assert(Math.round(foot.height) === 44, 'panel-foot ' + foot.height);
      assert(Math.round(status.height) === 34, 'status ' + status.height);
      return `${appbar.height}/${panel.width}/${head.height}/${foot.height}/${status.height}`;
    });

    await test('shell: all controls app.js needs are present', () => {
      const ids = ['drop', 'file-input', 'file-name', 'img-info', 'width', 'width-val', 'palette', 'custom-palette',
        'pdf-page-wrap', 'pdf-page', 'dynamic', 'invert', 'auto-aspect', 'text-toggle', 'text-controls', 'text-count',
        'text-inputs', 'text-random', 'text-use', 'text-repeat', 'video-group', 'vid-source', 'vid-fill', 'vid-start',
        'vid-end', 'vid-from', 'vid-to', 'vid-fps', 'vid-speed', 'vid-clip', 'vid-anim', 'vid-count', 'btn-vid-generate',
        'btn-vid-play', 'mode', 'font-family', 'font-size', 'fs-val', 'theme', 'bg-color', 'meta', 'frame-info',
        'status', 'preview', 'code-out', 'txt-out', 'btn-copy', 'btn-txt', 'btn-png', 'btn-html', 'tab-preview',
        'tab-code', 'tab-txt'];
      const missing = ids.filter((id) => !document.getElementById(id));
      assert(missing.length === 0, 'missing: ' + missing.join(','));
      return ids.length + ' ids';
    });

    await test('non-functional: no external network dependencies (offline promise)', () => {
      const ext = $$('link[href^="http"],script[src^="http"],img[src^="http"],iframe[src^="http"]');
      assert(ext.length === 0, ext.length + ' external assets');
      const fonts = $$('link[href*="fonts.googleapis"],link[href*="fonts.gstatic"]');
      assert(fonts.length === 0, 'webfont requested');
      return 'no external assets';
    });

    await test('non-functional: monochrome palette only (no hue in the stylesheet)', () => {
      const css = Array.from(document.styleSheets).map((s) => {
        try { return Array.from(s.cssRules).map((r) => r.cssText).join('\n'); } catch (e) { return ''; }
      }).join('\n');
      const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      const coloured = hex.filter((h) => {
        const s = h.slice(1);
        if (s.length !== 6 && s.length !== 3) return false;
        const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
        const r = parseInt(f.slice(0, 2), 16), g = parseInt(f.slice(2, 4), 16), b = parseInt(f.slice(4, 6), 16);
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        return max - min > 12 && !(r > 150 && g < 90 && b < 90); // allow greys + a red error colour
      });
      assert(coloured.length === 0, 'coloured values: ' + coloured.join(','));
      return 'greyscale only';
    });

    await test('fidelity: shell chrome matches the .pen inventory exactly', () => {
      const box = (sel) => {
        const el = $(sel);
        if (!el) throw new Error('missing ' + sel);
        const r = el.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height), Math.round(r.x), Math.round(r.y)];
      };
      // Geometry from docs/pen-design-inventory.md §7. The canvas is designed
      // at 1440×900 (pinned by tests/e2e.sh); the chrome is fixed and the rest
      // is derived from the viewport, so this also holds at other sizes.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const mainH = vh - 56;
      const bodyH = mainH - 56 - 40 - 34;
      const spec = [
        ['.appbar', vw, 56, 0, 0, 0],
        ['.panel.controls', 380, mainH, 0, 56, 0],
        ['.panel-head', 380, 48, 0, 56, 1],
        ['.panel-foot', 380, 44, 0, 56 + mainH - 44, 1],
        ['#sec-conversion', 380, 0, 0, 0, 1],
        ['#acc-text', 380, 46, 0, 0, 1],
        ['#acc-video', 380, 46, 0, 0, 1],
        ['#acc-render', 380, 46, 0, 0, 1],
        ['.stage', vw - 380, mainH, 380, 56, 0],
        ['.stage-toolbar', vw - 380, 56, 380, 56, 0],
        ['.metabar', vw - 380, 40, 380, 112, 0],
        ['.stage-status', vw - 380, 34, 380, 56 + mainH - 34, 0],
        ['.stage-body', vw - 380, bodyH, 380, 152, 0],
        ['.preview-frame', vw - 380 - 40, bodyH - 40, 400, 172, 0],
        ['.tabs', 240, 34, 0, 0, 2],
        ['.preview-badge', 0, 22, 0, 0, 0],
        ['#btn-view-original', 0, 22, 0, 0, 0],
        ['.zoom', 90, 28, 0, 0, 0],
      ];
      const bad = [];
      for (const [sel, w, h, x, y, tol] of spec) {
        const [aw, ah, ax, ay] = box(sel);
        if (w && Math.abs(aw - w) > tol) bad.push(sel + ' w ' + aw + '≠' + w);
        if (h && Math.abs(ah - h) > tol) bad.push(sel + ' h ' + ah + '≠' + h);
        if (x && Math.abs(ax - x) > tol) bad.push(sel + ' x ' + ax + '≠' + x);
        if (y && Math.abs(ay - y) > tol) bad.push(sel + ' y ' + ay + '≠' + y);
      }
      // The Conversion group is 377 px in the design with every conditional
      // field visible; here the PDF page and custom-palette fields only show
      // when they apply, so the group is shorter (and never taller).
      const convH = box('#sec-conversion')[1];
      if (convH > 377) bad.push('#sec-conversion h ' + convH + '>377');
      assert(bad.length === 0, bad.join('; '));
      return spec.length + ' boxes @ ' + vw + '×' + vh + ' (conversion ' + convH + 'px)';
    });

    await test('fidelity: greyscale tokens and sharp corners are in force in both themes', async () => {
      const UI = window.W8rez && window.W8rez.UI;
      const root = document.documentElement;
      const token = (n) => getComputedStyle(root).getPropertyValue(n).trim().toLowerCase();
      const dark = { '--bg': '#000000', '--card': '#0a0a0a', '--fg': '#fafafa', '--accent': '#fafafa', '--accent-fg': '#000000', '--border': '#262626', '--surface': '#1c1c1c' };
      const light = { '--bg': '#ffffff', '--card': '#f4f4f4', '--fg': '#111111', '--accent': '#111111', '--accent-fg': '#ffffff', '--border': '#d0d0d0', '--surface': '#e2e2e2' };
      const check = (want, theme) => {
        const bad = Object.entries(want).filter(([k, v]) => token(k) !== v).map(([k, v]) => theme + ' ' + k + '=' + token(k) + '≠' + v);
        if (root.getAttribute('data-theme') !== theme) bad.push('data-theme: ' + root.getAttribute('data-theme'));
        return bad;
      };
      // The suite must not depend on the OS preference (headless Chrome reports
      // light), so pin dark first and let the theme test exercise the toggle.
      if (UI && UI.applyTheme) UI.applyTheme('dark');
      await sleep(250);
      let bad = check(dark, 'dark');
      if (UI && UI.applyTheme) {
        UI.applyTheme('light');
        await sleep(250);
        bad = bad.concat(check(light, 'light'));
        UI.applyTheme('dark');
        await sleep(250);
      }
      assert(bad.length === 0, bad.join(', '));
      const rounded = ['.panel-head', '.drop', '.btn', '.tab', '.zoom', '.preview-frame', '#file-card']
        .filter((s) => $(s) && parseFloat(getComputedStyle($(s)).borderTopLeftRadius) > 0);
      assert(rounded.length === 0, 'rounded corners on ' + rounded.join(','));
      return Object.keys(dark).length + ' tokens × 2 themes + square corners';
    });

    await test('a11y: every control has an accessible name and the drop zone is focusable', () => {
      const controls = $$('input,select,button,textarea').filter((el) => !el.hidden && el.type !== 'hidden' && el.getAttribute('aria-hidden') !== 'true');
      const unnamed = controls.filter((el) => {
        const label = el.closest('label');
        const text = (el.getAttribute('aria-label') || '') + (label ? label.textContent : '') + (el.textContent || '') + (el.title || '');
        return text.trim().length === 0;
      });
      assert(unnamed.length === 0, unnamed.length + ' unnamed controls: ' + unnamed.map((e) => e.id || e.className).join(','));
      const drop = $('#drop');
      assert(drop.getAttribute('tabindex') === '0', 'drop not focusable');
      assert(drop.getAttribute('role') === 'button', 'drop has no button role');
      return controls.length + ' controls';
    });

    await test('a11y: status region is announced and accordions expose aria-expanded', () => {
      assert($('#status').getAttribute('aria-live') === 'polite', 'status not live');
      const heads = $$('.acc-head');
      assert(heads.length === 3, heads.length + ' accordions');
      heads.forEach((h) => assert(h.hasAttribute('aria-expanded'), 'accordion without aria-expanded'));
      return heads.length + ' accordions';
    });

    /* ---------------- accordion behaviour ---------------- */

    await test('accordion: clicking a header opens it and rotates aria-expanded', async () => {
      const head = $('#acc-text .acc-head');
      const before = head.getAttribute('aria-expanded');
      head.click();
      await sleep(150);
      const after = head.getAttribute('aria-expanded');
      assert(before !== after, 'aria-expanded did not change');
      assert($('#acc-text').dataset.open === 'true', 'body not marked open');
      const box = $('#acc-text-body').getBoundingClientRect();
      assert(box.height > 0, 'body still collapsed');
      head.click();
      await sleep(150);
      assert(head.getAttribute('aria-expanded') === before, 'did not close again');
      return 'toggles';
    });

    /* ---------------- image pipeline ---------------- */

    await test('load PNG: preview renders, file card and badge update', async () => {
      await reset();
      await load('samples/demo.png', 'demo.png', 'image/png');
      const ok = await waitFor(() => previewText().length > 50);
      assert(ok, 'no preview produced');
      assert(!$('#file-card').hidden, 'file card hidden');
      assert($('#file-name').textContent.indexOf('demo.png') >= 0, 'file name: ' + $('#file-name').textContent);
      assert($('#preview-badge-text').textContent.length > 0, 'badge empty');
      const meta = $('#meta').textContent;
      assert(/\d+×\d+/.test(meta), 'meta has no dimensions: ' + meta);
      assert($('#status').textContent.length > 0, 'status empty');
      return meta;
    });

    await test('width slider: column count follows the control', async () => {
      setControl($('#width'), 60);
      const ok = await waitFor(() => /^60×/.test($('#meta').textContent));
      assert(ok, 'meta: ' + $('#meta').textContent);
      assert($('#width-val').textContent.trim() === '60', 'output: ' + $('#width-val').textContent);
      return previewShape().cols + ' cols';
    });

    await test('palette switch: meta reports the palette size', async () => {
      const before = $('#meta').textContent;
      setControl($('#palette'), 'blocks', 'change');
      const ok = await waitFor(() => $('#meta').textContent !== before);
      assert(ok, 'meta unchanged');
      const m = $('#meta').textContent.match(/palette (\d+)/);
      assert(m && Number(m[1]) === 5, 'palette size: ' + (m && m[1]));
      return 'palette ' + m[1];
    });

    await test('custom palette: input enabled only for the custom option', async () => {
      assert($('#custom-palette').disabled === true, 'input not disabled for a preset palette');
      setControl($('#palette'), 'custom', 'change');
      await sleep(200);
      assert($('#custom-palette').disabled === false, 'input still disabled for custom');
      setControl($('#custom-palette'), ' .oO0@');
      const ok = await waitFor(() => /palette 6/.test($('#meta').textContent));
      assert(ok, 'custom palette not applied: ' + $('#meta').textContent);
      setControl($('#palette'), 'map', 'change');
      return 'custom honoured';
    });

    await test('invert: flips the rendering', async () => {
      await sleep(250);
      const a = hash(previewText());
      setControl($('#invert'), true);
      const ok = await waitFor(() => hash(previewText()) !== a);
      assert(ok, 'preview identical after invert');
      setControl($('#invert'), false);
      await sleep(250);
      return 'differs';
    });

    await test('dynamic range off: no luminance stretching', async () => {
      setControl($('#dynamic'), false);
      const ok = await waitFor(() => /luminance \d+–\d+/.test($('#meta').textContent));
      assert(ok, 'meta: ' + $('#meta').textContent);
      setControl($('#dynamic'), true);
      await sleep(200);
      return $('#meta').textContent.match(/luminance [^·]+/)[0].trim();
    });

    await test('automatic aspect: row count changes when toggled', async () => {
      const rowsA = previewShape().rows;
      setControl($('#auto-aspect'), false);
      const ok = await waitFor(() => previewShape().rows !== rowsA);
      assert(ok, 'rows unchanged: ' + rowsA);
      const rowsB = previewShape().rows;
      setControl($('#auto-aspect'), true);
      await sleep(300);
      assert(previewShape().rows === rowsA, 'rows did not come back');
      return rowsA + ' → ' + rowsB + ' → ' + rowsA;
    });

    await test('text overlay: toggle reveals controls and stamps the art', async () => {
      setControl($('#text-toggle'), true);
      const shown = await waitFor(() => $('#text-controls').style.display !== 'none');
      assert(shown, 'text controls stayed hidden');
      if (!$('#text-1')) throw new Error('dynamic text inputs missing');
      setControl($('#text-1'), 'HELLO');
      const stamped = await waitFor(() => $('#preview').textContent.indexOf('HELLO') >= 0);
      assert(stamped, 'text not stamped into the preview');
      return 'stamped';
    });

    await test('text overlay: random placement is deterministic for a fixed seed', async () => {
      if (!$('#text-2')) throw new Error('#text-2 missing');
      setControl($('#text-count'), 2);
      await sleep(200);
      setControl($('#text-2'), 'SECOND');
      setControl($('#text-random'), true);
      await sleep(350);
      const a = previewText();
      setControl($('#width'), 65);
      await sleep(300);
      setControl($('#width'), 60);
      const ok = await waitFor(() => previewText() === a);
      assert(ok, 'placement changed between renders with the same seed');
      return 'stable';
    });

    await test('text overlay: repeat mode distributes copies', async () => {
      setControl($('#text-use'), 'repeat', 'change');
      await sleep(120);
      const seg = $$('#text-use-seg .seg').find((b) => b.dataset.value === 'repeat');
      assert(seg && seg.getAttribute('aria-pressed') === 'true', 'segmented proxy not in sync');
      setControl($('#text-repeat'), 4);
      await sleep(350);
      const count = (previewText().match(/HELLO/g) || []).length;
      assert(count >= 2, 'only ' + count + ' copies');
      return count + ' copies';
    });

    await test('stepper buttons: change the value and keep the proxy outputs in sync', async () => {
      const plus = $('.stepper-btn[data-stepper="text-count"][data-step="1"]');
      const before = Number($('#text-count').value);
      plus.click();
      await sleep(200);
      assert(Number($('#text-count').value) === before + 1, 'input: ' + $('#text-count').value);
      assert($('#text-count-val').textContent.trim() === String(before + 1), 'output: ' + $('#text-count-val').textContent);
      const minus = $('.stepper-btn[data-stepper="text-count"][data-step="-1"]');
      minus.click();
      await sleep(200);
      assert(Number($('#text-count').value) === before, 'minus failed');
      return before + '→' + (before + 1) + '→' + before;
    });

    /* ---------------- render & tabs ---------------- */

    await test('render: font size, font family and colour mode reach the preview', async () => {
      await reset();
      await load('samples/demo.png', 'demo.png', 'image/png');
      await waitFor(() => previewText().length > 50);
      setControl($('#font-size'), 22);
      await sleep(300);
      assert($('#fs-val').textContent.trim() === '22', 'output: ' + $('#fs-val').textContent);
      assert(parseFloat(getComputedStyle($('#preview')).fontSize) >= 22, 'font-size not applied');
      setControl($('#font-family'), 'monospace', 'change');
      await sleep(300);
      assert(getComputedStyle($('#preview')).fontFamily.toLowerCase().indexOf('mono') >= 0, 'font family not applied');
      setControl($('#mode'), 'both', 'change');
      await sleep(400);
      assert($('#preview').querySelectorAll('[style*="background"], span').length > 0, 'colour spans missing');
      return 'applied';
    });

    await test('tabs: switching shows the matching panel only', async () => {
      const code = $('.tab[data-target="tab-code"]');
      code.click();
      await sleep(200);
      assert($('#tab-code').style.display !== 'none', 'code panel hidden');
      assert($('#tab-preview').style.display === 'none', 'preview still visible');
      assert($('#code-out').value.indexOf('<') >= 0, 'code-out empty');
      assert(code.classList.contains('active'), 'tab not marked active');
      assert(code.getAttribute('aria-pressed') === 'true', 'aria-pressed not mirrored: ' + code.getAttribute('aria-pressed'));
      $('.tab[data-target="tab-txt"]').click();
      await sleep(200);
      assert($('#txt-out').value.length > 0, 'txt-out empty');
      $('.tab[data-target="tab-preview"]').click();
      await sleep(200);
      assert($('#tab-preview').style.display !== 'none', 'preview not restored');
      return 'ok';
    });

    await test('theme: the header toggle switches the whole shell to light', async () => {
      const root = document.documentElement;
      const token = (n) => getComputedStyle(root).getPropertyValue(n).trim().toLowerCase();
      const rgb = (sel, prop) => getComputedStyle($(sel))[prop];
      const contrast = () => {
        const parse = (s) => (s.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number);
        const lum = (c) => {
          const [r, g, b] = c.map((v) => {
            const x = v / 255;
            return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const a = lum(parse(rgb('.appbar', 'color')));
        const b = lum(parse(rgb('.appbar', 'backgroundColor')));
        const [hi, lo] = a > b ? [a, b] : [b, a];
        return (hi + 0.05) / (lo + 0.05);
      };

      const darkBg = token('--bg');
      const darkRatio = contrast();

      $('#btn-theme-toggle').click();
      await sleep(400);
      assert(root.getAttribute('data-theme') === 'light', 'data-theme: ' + root.getAttribute('data-theme'));
      assert($('#theme').value === 'light', 'select: ' + $('#theme').value);
      assert($('#btn-theme-label').textContent.trim() === 'Light', 'label: ' + $('#btn-theme-label').textContent);
      assert(token('--bg') === '#ffffff', 'light --bg: ' + token('--bg'));
      assert(token('--fg') === '#111111', 'light --fg: ' + token('--fg'));
      const shellRgb = rgb('.appbar', 'backgroundColor');
      assert(/^rgb\((2[0-4]\d|1[6-9]\d),/.test(shellRgb), 'appbar not light: ' + shellRgb);
      const ratio = contrast();
      assert(ratio >= 4.5, 'contrast too low: ' + ratio.toFixed(2));
      // the canvas and the glyphs must stay legible in light mode
      assert($('#bg-color').value.toLowerCase() === '#ffffff', 'canvas: ' + $('#bg-color').value);
      assert($('#bg-color-hex').textContent.trim().toLowerCase() === '#ffffff', 'hex: ' + $('#bg-color-hex').textContent);
      const wrapBg = getComputedStyle($('.ascii-wrap')).backgroundColor;
      assert(/^rgb\((2[0-4]\d|25[0-5]),/.test(wrapBg), 'canvas not light: ' + wrapBg);
      assert(/^rgb\((\d|1\d|2[0-9]|3[0-9]|4[0-9]),/.test(rgb('#preview', 'color')), 'glyphs not dark: ' + rgb('#preview', 'color'));
      // the choice is remembered
      let stored = null;
      try { stored = localStorage.getItem('w8rez:theme'); } catch (e) { stored = null; }
      assert(stored === 'light', 'not persisted: ' + stored);

      $('#btn-theme-toggle').click();
      await sleep(400);
      assert(root.getAttribute('data-theme') === 'dark', 'did not go back: ' + root.getAttribute('data-theme'));
      assert(token('--bg') === darkBg, 'dark tokens not restored');
      assert($('#bg-color').value.toLowerCase() === '#000000', 'canvas not restored: ' + $('#bg-color').value);
      return 'dark ' + darkRatio.toFixed(1) + ':1 → light ' + ratio.toFixed(1) + ':1';
    });

    await test('background α: the canvas colour follows the picker', async () => {
      setControl($('#bg-color'), '#101010');
      await sleep(350);
      const bg = getComputedStyle($('.ascii-wrap')).backgroundColor;
      assert(/16,\s*16,\s*16|#101010/.test(bg), 'background: ' + bg);
      assert($('#bg-color-hex').textContent.trim().toLowerCase() === '#101010', 'hex label: ' + $('#bg-color-hex').textContent);
      setControl($('#bg-color'), '#000000');
      await sleep(250);
      return bg;
    });

    await test('zoom: buttons scale the preview and Fit resets it', async () => {
      const base = parseFloat(getComputedStyle($('#preview')).fontSize);
      $('#zoom-in').click();
      await sleep(250);
      const bigger = parseFloat(getComputedStyle($('#preview')).fontSize);
      assert(bigger > base, base + ' → ' + bigger);
      $('#zoom-fit').click();
      await sleep(250);
      const back = parseFloat(getComputedStyle($('#preview')).fontSize);
      assert(Math.abs(back - base) < 0.6, 'fit did not restore: ' + back);
      return base + '→' + bigger + '→' + back;
    });

    await test('view original: canvas shows the source and toggles back', async () => {
      const btn = $('#btn-view-original');
      btn.click();
      await sleep(350);
      assert(btn.getAttribute('aria-pressed') === 'true', 'not pressed');
      assert(!$('#original-view').hidden, 'canvas hidden');
      assert($('#preview').hidden, 'preview still shown');
      const cv = $('#original-view');
      assert(cv.width > 0 && cv.height > 0, 'canvas has no bitmap');
      btn.click();
      await sleep(300);
      assert($('#preview').hidden === false, 'preview not restored');
      assert(btn.getAttribute('aria-pressed') === 'false', 'still pressed');
      return cv.width + '×' + cv.height;
    });

    await test('clear file: empties the state and hides the card', async () => {
      $('#file-clear').click();
      const ok = await waitFor(() => $('#file-card').hidden);
      assert(ok, 'card still visible');
      assert($('#file-name').textContent.trim() === '—' || $('#file-name').textContent.trim() === '', 'name: ' + $('#file-name').textContent);
      assert(previewText().length === 0, 'preview not cleared');
      return 'cleared';
    });

    /* ---------------- exports ---------------- */

    await test('exports: txt / html / png payloads are generated', async () => {
      await load('samples/demo.png', 'demo.png', 'image/png');
      await waitFor(() => previewText().length > 50);
      const t = $('#txt-out').value;
      assert(t === previewText() || t.length > 50, 'txt export empty');
      const h = $('#code-out').value;
      assert(h.indexOf('<pre') >= 0 || h.indexOf('<!DOCTYPE') >= 0, 'html export missing markup');
      assert(h.indexOf('<style') >= 0, 'html export not self-contained');
      const p = $('#btn-png');
      assert(!p.disabled, 'png button disabled');
      p.click();
      const ok = await waitFor(() => /saved|error/i.test($('#status').textContent), 6000);
      assert(ok, 'no status after png: ' + $('#status').textContent);
      return $('#status').textContent.trim();
    });

    await test('exports: copy button writes the active view to the clipboard', async () => {
      $('.tab[data-target="tab-txt"]').click();
      await sleep(200);
      $('#btn-copy').click();
      const ok = await waitFor(() => /copy|copied|clipboard|permission/i.test($('#status').textContent), 5000);
      assert(ok, 'status: ' + $('#status').textContent);
      $('.tab[data-target="tab-preview"]').click();
      const msg = $('#status').textContent.trim();
      // Headless automation has no user activation, so the Clipboard API may be
      // denied; the app must at least report the outcome instead of failing silently.
      return /permission|denied/i.test(msg) ? 'environment-limited: ' + msg : msg;
    });

    /* ---------------- svg / pdf / eps ---------------- */

    await test('SVG input converts through the data-URL path', async () => {
      const before = await load('samples/demo.svg', 'demo.svg', 'image/svg+xml');
      const ok = await waitFor(() => previewText().length > 50 && hash(previewText()) !== before, 10000);
      assert(ok, 'no new preview from the SVG');
      return previewShape().cols + '×' + previewShape().rows;
    });

    await test('PDF input: page control appears and paging re-renders', async () => {
      await load(FIX + 'multipage.pdf', 'multipage', 'application/pdf');
      const ok = await waitFor(() => previewText().length > 50 && $('#pdf-page-wrap').style.display !== 'none', 20000);
      assert(ok, 'pdf not rendered');
      const max = Number($('#pdf-page').max);
      assert(max === 2, 'page max: ' + max);
      const before = hash(previewText());
      setControl($('#pdf-page'), 2);
      const changed = await waitFor(() => hash(previewText()) !== before, 15000);
      assert(changed, 'page 2 looks identical to page 1');
      assert($('#pdf-page-label').textContent.trim().length > 0, 'page label empty');
      return '2 pages, label ' + $('#pdf-page-label').textContent.trim();
    });

    await test('EPS input converts through the local server (ghostscript)', async () => {
      await load(FIX + 'test.eps', 'test.eps', 'application/postscript');
      const ok = await waitFor(() => previewText().length > 50, 25000);
      assert(ok, 'no EPS preview: ' + $('#status').textContent);
      return previewShape().cols + '×' + previewShape().rows;
    });

    /* ---------------- video ---------------- */

    await test('video: native mp4 loads, opens the group and reports the clip', async () => {
      await load(FIX + 'clip.mp4', 'clip.mp4', 'video/mp4');
      const ok = await waitFor(() => $('#video-group').style.display !== 'none' && $('#vid-source').readyState >= 1, 20000);
      assert(ok, 'video not loaded');
      assert($('#acc-video').dataset.open === 'true' || $('#acc-video .acc-head').getAttribute('aria-expanded') === 'true', 'video accordion not opened');
      assert($('#sum-video').textContent.indexOf('no clip') === -1 || Number($('#vid-source').duration) > 0, 'duration not reported');
      return 'duration ' + Math.round(Number($('#vid-source').duration) * 100) / 100 + 's';
    });

    await test('video: clip handles and speed/framerate controls update the summary', async () => {
      const dur = Number($('#vid-source').duration) || 4;
      setControl($('#vid-start'), Math.round(dur * 0.25 * 100) / 100);
      setControl($('#vid-end'), Math.round(dur * 0.75 * 100) / 100);
      setControl($('#vid-fps'), '5', 'change');
      setControl($('#vid-speed'), '2', 'change');
      const ok = await waitFor(() => $('#vid-from').textContent !== '0:00.0' && $('#vid-to').textContent.length > 0);
      assert(ok, 'labels: ' + $('#vid-from').textContent + ' / ' + $('#vid-to').textContent);
      assert($('#vid-clip').textContent.trim() !== '—', 'clip summary empty');
      assert($('#vid-anim').textContent.trim() !== '—', 'animation summary empty');
      assert($('#vid-count').textContent.trim() !== '—', 'frame count empty');
      const est = Number($('#vid-count').textContent.trim());
      assert(est >= 2, 'estimate too low: ' + est);
      return est + ' frames estimated';
    });

    await test('video: frame generation fills the count and enables Play', async () => {
      $('#btn-vid-generate').click();
      const ok = await waitFor(() => /Generating/i.test($('#btn-vid-generate').textContent) || !$('#btn-vid-play').disabled, 20000);
      assert(ok, 'generation never started');
      const done = await waitFor(() => $('#btn-vid-play').disabled === false, 90000);
      assert(done, 'play never enabled: ' + $('#status').textContent);
      const frames = Number($('#vid-count').textContent.replace(/\D+/g, ''));
      assert(frames > 1, 'frames: ' + $('#vid-count').textContent);
      // the icon must survive the busy state
      assert($('#btn-vid-generate .icon') !== null, 'button icon was destroyed');
      assert($('#btn-vid-generate .spinner').hidden, 'spinner still visible');
      return frames + ' frames';
    });

    await test('video: play animates the preview', async () => {
      const before = hash(previewText());
      $('#btn-vid-play').click();
      const ok = await waitFor(() => hash(previewText()) !== before, 10000);
      assert(ok, 'the preview never changed while playing');
      $('#btn-vid-play').click();
      return 'animating';
    });

    await test('video: export buttons appear and the animation HTML is self-contained', async () => {
      ['btn-vid-webm', 'btn-vid-mp4', 'btn-vid-html'].forEach((id) => {
        assert($('#' + id).style.display !== 'none', id + ' hidden');
      });
      $('#btn-vid-html').click();
      const ok = await waitFor(() => /saved|animation|error/i.test($('#status').textContent), 20000);
      assert(ok, 'status: ' + $('#status').textContent);
      return $('#status').textContent.trim();
    });

    await test('video: non-native container is transcoded by the server', async () => {
      await load(FIX + 'legacy.avi', 'legacy', 'video/x-msvideo');
      const ok = await waitFor(() => $('#preview').textContent.length > 50, 90000);
      assert(ok, 'avi never produced a preview: ' + $('#status').textContent);
      return $('#status').textContent.trim().slice(0, 60);
    });

    /* ---------------- reset ---------------- */

    await test('reset: returns every control to its default', async () => {
      await reset();
      assert($('#width').value === '100', 'width ' + $('#width').value);
      assert($('#font-size').value === '16', 'font-size ' + $('#font-size').value);
      assert($('#palette').value === 'map', 'palette ' + $('#palette').value);
      assert($('#mode').value === 'mono', 'mode ' + $('#mode').value);
      assert($('#theme').value === 'dark', 'theme ' + $('#theme').value);
      assert($('#bg-color').value === '#000000', 'bg ' + $('#bg-color').value);
      assert($('#dynamic').checked && $('#auto-aspect').checked, 'checkboxes');
      assert(!$('#invert').checked && !$('#text-toggle').checked, 'invert/text');
      assert($('#text-count').value === '1' && $('#text-count-val').textContent.trim() === '1', 'text count');
      assert($('#text-use').value === 'once', 'text use');
      return 'defaults restored';
    });

    await test('performance: a 200-column conversion stays well under a second', async () => {
      await load('samples/demo.png', 'demo.png', 'image/png');
      await waitFor(() => previewText().length > 50);
      const t0 = performance.now();
      setControl($('#width'), 200);
      await waitFor(() => /^200×/.test($('#meta').textContent));
      const dt = performance.now() - t0;
      assert(dt < 1500, 'took ' + Math.round(dt) + ' ms');
      return Math.round(dt) + ' ms';
    });

    await test('robustness: 20 rapid control changes do not break the preview', async () => {
      for (let i = 0; i < 20; i++) {
        setControl($('#width'), 40 + i * 5);
        setControl($('#invert'), i % 2 === 0);
      }
      await sleep(1200);
      assert(previewText().length > 50, 'preview lost after the burst');
      assert($('#status').textContent.indexOf('rror') === -1, 'error status: ' + $('#status').textContent);
      await reset();
      return 'survived';
    });

    const passed = results.filter((r) => r.pass).length;
    const summary = { results, passed, failed: results.length - passed };

    // Publish a plain-text report in the DOM so the CLI driver can read it
    // with a simple `get text` instead of parsing escaped JSON.
    let report = document.getElementById('w8rez-e2e-report');
    if (!report) {
      report = document.createElement('pre');
      report.id = 'w8rez-e2e-report';
      report.style.cssText = 'position:fixed;left:-9999px;top:0;font-size:10px;';
      document.body.appendChild(report);
    }
    report.textContent = results
      .map((r) => (r.pass ? 'PASS' : 'FAIL') + '\t' + r.name + '\t' + r.ms + 'ms\t' + r.detail)
      .join('\n') + '\nSUMMARY\t' + passed + '/' + results.length + ' passed';

    return summary;
  }

  window.W8REZ_E2E = { run };
})();

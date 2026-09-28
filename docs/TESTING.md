# Testing w8rez

w8rez has no build step and no npm dependencies, so every suite is a plain
Node script or a shell driver. There are four layers:

| Layer | Command | What it proves |
|---|---|---|
| Unit — engine | `npm run test:engine` | luminance, sampling, dynamic range, inversion, palettes, text overlay determinism, renderers, escaping |
| Unit — UI helpers | `npm run test:ui` | stepper clamping, zoom levels, accordion summaries, badge formatting |
| Integration — server | `npm run test:server` | routing, method/content-type guards, loopback binding, path traversal and dotfile hardening, size caps, concurrency cap, tool gating, `/api/status`, conversions |
| End-to-end — browser | `npm run test:e2e` | the real page in a real Chrome tab: file inputs, every control, exports, accessibility and styling invariants |
| All | `npm test` | engine + server + UI |

## Unit suites

```bash
node tests/engine.test.js    # conversion engine + renderers
node tests/ui.test.js        # pure UI helpers (no DOM needed)
```

Both run in Node without a browser: the engine is a UMD module with no DOM
access, and the UI suite only exercises the pure functions exported by
`js/ui.js` (`clampStep`, `zoomStep`, `summarize*`, `formatBadge`). Anything
that touches the DOM lives in `init()` and is covered by the end-to-end suite
instead — that keeps the fast suites fast and dependency-free.

## Integration suite

```bash
node tests/server.test.js
```

It starts `server.js` on an ephemeral port, drives it with the built-in
`http` client and asserts both the happy paths and the security controls:
loopback-only binding, `Host` validation, `MAX_BODY` enforcement, the
`W8REZ_DISABLE_TOOLS`/`W8REZ_ALLOW_REMOTE` gates, timeout handling and clean
error responses. Tests that need Ghostscript or ffmpeg are skipped with a
clear message when those binaries are missing.

## End-to-end suite

```bash
bash tests/e2e.sh          # optionally: bash tests/e2e.sh 8091
```

`tests/e2e.sh`:

1. generates the binary fixtures into `tests/fixtures/` (git-ignored) using
   ImageMagick and ffmpeg — a 2-page PDF, an EPS, an H.264 MP4 and a legacy
   AVI;
2. boots the local server and waits for `GET /api/status`;
3. opens the app in a real Chrome tab through `agent-browser`;
4. injects `tests/e2e.browser.js` and runs `window.W8REZ_E2E.run()`;
5. prints one line per check with timing, then verifies three real
   downloads (`.txt`, `.png`, `.html`) through the CLI.

The in-page harness drives the same DOM a user does — it does not call
internal functions. Files are injected by building a `DataTransfer` for
`#file-input`, which is exactly what the picker and the drag-and-drop path
deliver, so the routing, decoding and render pipeline is the production one.

### What the browser suite checks

*Structure and non-functional invariants*

- layout metrics of the shell (56 px header, 380 px panel, 48/44 px panel
  head/foot, 34 px status bar);
- every control id that `js/app.js` requires is present;
- **no external network dependency**: no remote stylesheets, scripts, images
  or iframes, and no webfont request (the offline promise);
- **greyscale only**: every colour literal in the stylesheet is achromatic
  (a red error colour is the single allowed exception);
- every control has an accessible name; the drop zone is focusable and
  exposed as a button; the status line is an `aria-live` region; accordion
  headers expose `aria-expanded`;
- performance: a 200-column conversion stays under 1.5 s;
- robustness: 20 rapid control changes in a row still leave a valid preview.

*Features*

- image loading (PNG and SVG data-URL path), file card, badge and metadata;
- width, palette (preset, custom, disabled state), inversion, dynamic range,
  automatic aspect;
- text overlay: toggle, dynamic inputs, deterministic random placement
  (a fixed seed must reproduce the same layout), repeat mode, stepper proxies;
- render controls: font size, font family, colour mode;
- tabs: the active panel is the only visible one and `aria-pressed` follows;
- theme: the header toggle and the Render select stay in sync;
- background α: the canvas colour follows the picker;
- zoom: in/out and Fit back to the base size;
- *View original*: the source bitmap appears and toggles back;
- clear file: state emptied, card hidden;
- exports: `.txt`/`.html` payloads, PNG rasterisation status, clipboard copy;
- PDF: page control appears, page 2 renders differently, label updates;
- EPS: converted through the local server;
- video: native MP4 loads and opens its group, clip handles/framerate/speed
  update the summary, frame generation enables *Play*, playback animates,
  export buttons appear, the animation HTML is produced, and a legacy AVI is
  transcoded by the server;
- reset: every control returns to its default.

### Fixtures

Generated on demand into `tests/fixtures/` (git-ignored):

| File | Producer | Used for |
|---|---|---|
| `test.pdf` (1 page) | ImageMagick | single-page PDF path |
| `multipage.pdf` (2 pages) | ImageMagick | page picker + re-render |
| `test.eps` | ImageMagick | ghostscript path |
| `clip.mp4` (H.264, 4 s) | ffmpeg | native video path |
| `legacy.avi` (MPEG-4) | ffmpeg | server-side transcode |

`dist/samples/demo.png` and `dist/samples/demo.svg` ship with the repo and
are used for the image and SVG checks.

## Manual smoke test

When no browser automation is available, the same coverage can be walked by
hand in about two minutes:

1. `node server.js`, open `http://localhost:8080`.
2. Drop `samples/demo.png` → an ASCII preview appears, the file card shows the
   name and the dimensions, the badge shows `ASCII <cols> × <rows>`.
3. Move *Width*, *Palette*, *Invert*, *Dynamic range* and *Automatic aspect* →
   the preview updates live and the metadata bar follows.
4. Open **Text overlay** → enable it, type two strings, switch to *Repeat*,
   then enable random placement twice → the layout is identical between runs.
5. Drop a video → the Video group opens by itself; drag the clip handles,
   press *Generate frames*, then *Play*.
6. Export `.txt`, `.png` and `.html`; open the HTML file in a new tab → the
   art renders without JavaScript and matches the preview.
7. Toggle *View original*, zoom in/out, press Fit, then *Reset*.
8. Reload with DevTools open on the Network tab → no external requests.

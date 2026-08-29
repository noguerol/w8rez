# Architecture

w8rez is a local-first web application with an optional helper server. It has
no build step and no npm dependencies: the browser loads four plain scripts,
and the server is a single Node file built on `http`.

## Component map

```
                browser
┌──────────────────────────────────────────────┐
│ index.html  css/style.css                    │
│                                              │
│ app.js (ES module, UI glue)                  │
│   ├── ascii.js     UMD engine (DOM-free)     │
│   ├── renderer.js  UMD renderers             │
│   ├── eps.js       UMD EPS helpers           │
│   └── vendor/pdfjs (ES module, vendored)     │
└──────────────┬───────────────────────────────┘
               │ POST uploads (loopback only)
┌──────────────▼───────────────────────────────┐
│ server.js (Node stdlib only)                 │
│   static files · /api/* conversion endpoints │
│   spawn gs / ffmpeg on private temp files    │
└──────────────────────────────────────────────┘
```

## Module conventions

- **UMD for the engine layer.** `ascii.js`, `renderer.js` and `eps.js` attach
  to `window.W8rez.*` in the browser and export via `module.exports` in Node.
  This is what makes the core testable without a browser: the tests require
  the same files the browser loads.
- **ES module for the glue.** `app.js` imports the vendored pdf.js and is the
  only module allowed to touch `document` beyond the renderers' two
  browser-only functions (`measureCharAspect`, `drawGridToCanvas`/`renderPng`).
- **DOM-free core.** Every function in `ascii.js` takes pixel buffers and
  returns plain data. Behaviour differences between browser and Node are
  confined to `renderer.js` and expressed as `null`/throwing return values
  (asserted by tests).

## Data flow (still image)

```
file → FileReader(dataURL) → Image/canvas → ImageData (cached per image)
     → Ascii.toGrid(data, w, h, opts) → grid {cols, rows, cells[], min, max}
     → (optional) Ascii.stampText(grid, textOpts)
     → Renderer.buildHtmlFragment(grid, {mode, invert, preFg})  ── preview
     → Renderer.renderHtml/renderTxt/renderPng                  ── exports
```

The rasterised `ImageData` is cached until a different image is loaded, so
slider input re-runs only the (cheap) engine + serialisation steps.

## Data flow (video)

```
file → <video> (object URL) → loadmetadata
     → generateFrames(): seek(t) per frame [timeout-guarded]
        → ImageData → Ascii.toGrid → (stampText with shared seed)
        → grids capped at MAX_FRAMES
     → preview: drawFrame(i) via buildHtmlFragment
     → exports: buildAnimHtml | MediaRecorder → webm | PNG stream → ffmpeg mp4
```

Frame grids are kept in memory; `app.js` caps them (`LIMITS.MAX_FRAMES = 600`)
and refuses to build an MP4 upload larger than ~200 MB client-side, staying
under the server's own body cap.

## Serialisation: one builder, no drift

`Renderer.buildHtmlFragment` is the single HTML serialiser. The live preview
and every exported document call it, so the preview is exactly the export.
Run-length grouping merges consecutive cells that share an inline style into
one `<span>`; the rendered output is identical to per-cell spans (asserted by
an equivalence test) while DOM size drops by orders of magnitude on flat
areas. Glyph text is always HTML-escaped before grouping, so palette glyphs
and stamped text cannot inject markup.

## Server design

- **Static layer** — extension allowlist, top-level directory allowlist,
  explicit root-file allowlist, dotfile denial, resolved-path containment,
  streamed files, no path echoing in errors.
- **API layer** — bodies streamed to files inside a per-process `mkdtemp`
  work directory; magic-byte sniffing before any external tool runs; `spawn`
  with argument arrays only (no shell, no stdin); per-tool timeouts; output
  size caps (`-fs` for ffmpeg); concurrency semaphore with a bounded queue;
  child processes killed on client abort and on shutdown.
- **Lifecycle** — `SIGINT`/`SIGTERM` close the server, kill children and
  remove the work directory; `EADDRINUSE` produces actionable guidance.

Rationale for each hardening decision: [`SECURITY.md`](SECURITY.md).

## Dependency policy

- **Runtime:** none (Node stdlib only). This is checked by the fact that
  `package.json` has no `dependencies` field at all.
- **Browser library:** pdf.js is vendored, pinned, hash-recorded and verified
  (`vendor/pdfjs/README.md`). It is the only third-party code shipped.
- **Tools (optional):** ghostscript and ffmpeg are detected at runtime; the
  endpoints degrade gracefully (501) and can be disabled explicitly.

## Versioning

`package.json` is the single source of truth; the server reads its version
from there for `/api/health` and `/api/status`. Releases are documented in
[`CHANGELOG.md`](../CHANGELOG.md).

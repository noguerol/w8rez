# w8rez

**Turn images, documents and video into ASCII art — entirely on your machine.**

w8rez is a zero-dependency web tool that converts bitmaps (PNG/JPG/WebP/GIF),
vectors (SVG), documents (PDF, EPS) and video clips into high-quality ASCII
art, ready to publish as text, as a self-contained HTML page, as a PNG, or as
an animated HTML/WebM/MP4 clip. Nothing is uploaded anywhere: everything runs
in your browser, and the optional local helper server never talks to the
network.

```
█   █   ███   █████  █████  █████
█   █  █   █  █   █  █          █
█ █ █   ███   ████   ████     █
██ ██  █   █  █  █   █       █
█   █   ███   █   █  █████  █████
```

## Highlights

- **Any input.** Bitmap images, SVG, multi-page PDFs (page picker), EPS files
  (converted locally with ghostscript, with a fallback to the embedded JPEG
  preview), and video (native formats plus ffmpeg transcoding for the rest).
- **A serious conversion engine.** Perceptual luminance, block averaging with
  real font-aspect correction, dynamic contrast stretch, inversion, and six
  built-in palettes plus custom palettes. The algorithm is a JavaScript
  reimplementation of [AsciiMap](https://github.com/kompetenzbolzen/AsciiMap) (MIT).
- **Text overlay.** Stamp 1–8 text strings onto the art — centred, repeated,
  or pseudo-randomly placed with a deterministic seed (the text stays pinned
  to the same position across every video frame).
- **Four colour modes.** Monochrome, colour glyphs, colour background, or
  both, with automatic glyph contrast in "both" mode and live negative/invert.
- **Four output formats** (plus three for video): plain text, a single-file
  HTML document, a rasterised PNG, and for video a self-contained HTML
  animation, a WebM recording, or a frame-exact MP4.
- **Dark and light interfaces, both monochrome.** A terminal-style shell with
  no colour of its own in either theme — the only colour on screen comes from
  your own image. A fixed control panel (drop zone, conversion groups that
  expand on demand with a live summary of their state) next to a stage with
  view tabs, the export actions, conversion metadata, and a preview with
  *View original* and zoom controls. The header toggle switches the interface
  between dark and light only — it never changes your artwork — and the choice
  is remembered between visits. The theme of the preview glyphs and of the
  exported document is chosen separately through *Artwork theme* in
  *Render & output*. Sharp corners, no rounded chrome, no colour noise.
- **Private by design.** No telemetry, no CDNs, no webfonts, no accounts, no
  uploads. The helper server binds to `127.0.0.1`, and the browser side works
  without it.
- **Zero npm dependencies.** Node's standard library only. pdf.js is vendored
  with recorded SHA-256 provenance.
- **Accessible.** Every control is keyboard reachable with a visible focus
  ring, groups use `aria-expanded`/`aria-controls`, the status line is a live
  region, and native inputs stay in the DOM behind the custom widgets so
  assistive technology sees the real values.

## Quick start

Requirements: Node.js ≥ 18 (no `npm install` needed). Optional: ghostscript
(EPS/PDF fallback) and ffmpeg (exotic video formats).

```bash
node server.js          # → http://localhost:8080
```

Then drop a file onto the page. You can also open `index.html` directly from
disk; everything works except the server-assisted conversions (EPS, PDF
fallback, video transcoding and MP4 export).

Other commands:

```bash
npm test                # engine + server + UI unit suites
npm run test:engine     # conversion engine only
npm run test:server     # HTTP API and security controls only
npm run test:ui         # accordion/stepper/zoom helpers only
npm run test:e2e        # real-browser end-to-end suite (needs agent-browser)
npm run sample          # regenerate samples/demo.png
```

The end-to-end suite boots the server, drives the page in a real Chrome tab
and checks every feature (inputs, engine controls, text overlay, video, tabs,
exports, accessibility and greyscale-only styling). See
[docs/TESTING.md](docs/TESTING.md).

## Outputs

| Format | Source | Notes |
|---|---|---|
| `.txt` | stills & video | plain text, ready for terminals, READMEs and e-mail |
| `.html` | stills | self-contained document: inline styles, correct aspect, theme, CSP meta — no JavaScript |
| `.png` | stills | rasterised with the chosen font/mode/theme |
| anim `.html` | video | all frames embedded + a small player (play/pause, speed) |
| `.webm` | video | recorded in real time via MediaRecorder |
| `.mp4` | video | frame-exact H.264 assembled offline by ffmpeg |

## The conversion pipeline

1. **Decode** — every input is rasterised into a canvas.
2. **Block averaging** — each output cell averages its block of source pixels,
   compositing transparency over the configured background colour.
3. **Perceptual luminance** — `√(0.299R² + 0.587G² + 0.114B²)`, which tracks
   human perception better than a plain channel average.
4. **Dynamic range** (optional) — the `[min,max]` luminance range is stretched
   to full contrast.
5. **Glyph mapping** — `palette[round(l·(n−1))]`, palettes ordered dark → bright.
6. **Aspect correction** — the real advance width of the active monospace font
   is measured in the browser, so the grid keeps the original's proportions.

Details and prior-art comparison: [`docs/ALGORITHM.md`](docs/ALGORITHM.md).

## Configuration (server)

All settings are optional environment variables — see
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for the full reference.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `W8REZ_PORT` | `8080` | listen port (`0` = ephemeral) |
| `W8REZ_HOST` | `127.0.0.1` | bind address (loopback by default) |
| `W8REZ_MAX_UPLOAD_MB` | `30` | request body cap |
| `W8REZ_MAX_OUTPUT_MB` | `256` | conversion output cap (enforced with ffmpeg `-fs`) |
| `W8REZ_MAX_CONCURRENT` | `2` | concurrent conversion jobs |
| `W8REZ_DISABLE_TOOLS` | *(unset)* | `gs`, `ffmpeg` or `all` to disable conversion endpoints |
| `W8REZ_LOG` | off | `1` enables request logging |

## HTTP API

Served by `server.js` on the loopback interface:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | liveness probe |
| `/api/status` | GET | ghostscript/ffmpeg availability and limits |
| `/api/eps-to-png?dpi=N` | POST | EPS bytes → PNG (ghostscript) |
| `/api/pdf-to-png?page=N&dpi=N` | POST | PDF page → PNG (ghostscript) |
| `/api/video-to-mp4` | POST | video bytes → MP4/H.264 (ffmpeg) |
| `/api/frames-to-mp4?fps=N` | POST | concatenated PNG frames → MP4/H.264 (ffmpeg) |

Request bodies are streamed to a private work directory, sniffed by magic
bytes, executed with argument arrays (no shell), capped in size and time, and
cleaned up on completion, abort or shutdown. See
[`docs/SECURITY.md`](docs/SECURITY.md).

## Project layout

```
w8rez/
├── index.html              # UI
├── css/style.css           # styles
├── js/
│   ├── ascii.js            # conversion engine (UMD: browser + Node, DOM-free)
│   ├── renderer.js         # txt / html / png / animation renderers (UMD)
│   ├── eps.js              # embedded JPEG preview extraction (UMD)
│   └── app.js              # UI glue (ES module, imports pdf.js)
├── vendor/pdfjs/           # vendored pdf.js 6.2.108 + provenance record
├── server.js               # static server + hardened conversion API
├── scripts/make-sample.js  # dependency-free PNG sample generator
├── samples/                # demo.png / demo.svg
├── tests/
│   ├── engine.test.js      # engine/renderers/EPS: 70 tests
│   └── server.test.js      # server security & conversions: 40 tests
└── docs/                   # architecture, algorithm, security, configuration
```

## Development notes

- `js/ascii.js`, `js/renderer.js` and `js/eps.js` are UMD modules: they run in
  the browser (`window.W8rez.*`) and in Node (`require`) for the tests. The
  engine never touches the DOM.
- `js/app.js` is an ES module because it imports the vendored pdf.js.
- The HTML fragment builder in `renderer.js` is the single serialiser shared
  by the live preview and every HTML export — the preview is byte-identical
  to what you download. Consecutive cells with the same style are grouped
  into one `<span>`, which keeps large previews responsive.
- Tests are plain Node with zero dependencies; the server suite boots real
  instances on ephemeral ports.

## Security

Threat model, hardening decisions and reporting policy:
[`SECURITY.md`](SECURITY.md) and [`docs/SECURITY.md`](docs/SECURITY.md).
Summary: loopback-only by default, Host allowlist, strict security headers
and CSP, extension allowlists and dotfile denial for static files, magic-byte
sniffing plus size/time/concurrency caps for external tools, private temp
directories with guaranteed cleanup.

## Acknowledgements

- [AsciiMap](https://github.com/kompetenzbolzen/AsciiMap) by Jonas Gunz (MIT) —
  the algorithm behind the engine, reimplemented in JavaScript.
- [pdf.js](https://github.com/mozilla/pdf.js) by Mozilla (Apache-2.0) —
  vendored PDF rendering.
- [jpetitcolas/ascii-art-converter](https://github.com/jpetitcolas/ascii-art-converter) —
  the font-measurement technique.

Full attributions: [`NOTICE.md`](NOTICE.md).

## License

MIT — see [`LICENSE`](LICENSE). Third-party components remain under their own
licences, documented in [`NOTICE.md`](NOTICE.md).

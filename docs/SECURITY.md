# Security

This document explains w8rez's security posture: what the application is for,
what it deliberately does not do, and why each hardening measure exists.
Vulnerability reporting: see [`../SECURITY.md`](../SECURITY.md).

## Threat model

w8rez is a **single-user, local-first tool**. The intended deployment is a
developer's or creator's own machine. We assume:

1. **The browser context is untrusted input territory.** Files dropped into
   the app are arbitrary bytes: hostile SVGs, malformed PDFs, polyglot EPS
   files, mislabelled videos.
2. **The network is untrusted.** The helper server must not be usable by
   other machines, other local users, or web pages open in the same browser.
3. **External tools are a wide attack surface.** ghostscript and ffmpeg are
   large C codebases whose parsers and demuxers regularly surface
   memory-safety CVEs.

Non-goals: multi-tenancy, serving untrusted users, remote exposure.

## Privacy

- No telemetry, no analytics, no external requests. The app loads only local
  assets (the vendored pdf.js included).
- Files are processed in the browser. The only bytes that reach the helper
  server are uploads to the conversion endpoints — and the server binds to
  the loopback interface, so they never leave the machine.
- Exported HTML documents embed the art and metadata only; no beacons, no
  external fonts, no scripts in static exports.

## Browser-side hardening

| Measure | Rationale |
|---|---|
| All glyph/text interpolation goes through `escapeHtml` (including quotes) | palette glyphs and stamped text are user input and end up inside HTML exports |
| Single HTML serialiser (`buildHtmlFragment`) shared by preview and exports | no preview/export drift; one code path to audit |
| Frames embedded in animation HTML via `escapeForScript` (`<` → `\u003c`) | prevents `</script>` breakout from a JSON payload |
| Static HTML exports ship a CSP meta `default-src 'none'; style-src 'unsafe-inline'` and contain no scripts | even a future escaping bug has no execution primitive in exports |
| Font stacks and colours validated against allowlists before CSS interpolation | prevents CSS injection into exported documents |
| Limits on grid size, frames (600), canvas dimensions (16384 px), MP4 upload size | a large input cannot exhaust the tab's memory silently |
| Per-frame seek timeout (10 s) | a stalled decoder cannot wedge the generation loop |
| Transcode recursion cap and object-URL revocation | no runaway loops or leaked blobs |
| Custom palette fallback | an empty palette input degrades instead of throwing mid-edit |

The application page itself is served with
`Content-Security-Policy: default-src 'self'; script-src 'self'; …`, so even
an injection into the DOM could not load external script.

*Accepted trade-off:* `style-src 'unsafe-inline'` is required because the
preview and exports legitimately paint thousands of per-cell inline styles.
The actual XSS control is `script-src 'self'` plus output escaping.

## Server hardening

| Control | Implementation |
|---|---|
| Loopback binding | `W8REZ_HOST` defaults to `127.0.0.1`; non-loopback binds print an explicit warning |
| Host allowlist | requests whose `Host` header is not `localhost`/`127.0.0.1`/`[::1]`/hostname get `421` — blocks DNS-rebinding pages from driving the API |
| Static allowlists | only `js/ css/ vendor/ samples/ assets/ icons/`, only known extensions, only `index.html`/`favicon.ico`/`robots.txt` at the root; dotfile segments always 404; resolved paths must stay inside the package root; errors never echo the requested path |
| No path traversal | `decodeURIComponent` errors and NUL/backslash are rejected; containment check on the resolved path |
| Body streaming | uploads stream into a 0600 temp file inside a private `mkdtemp` directory; size cap (`413`), body timeout (`408`) |
| Content sniffing | `gs`/`ffmpeg` only run on bodies recognised as EPS/PDF/known-video/PNG-stream (`415` otherwise) — shrinks the tools' parser exposure to the formats the product supports |
| No shell | `spawn(bin, args[])` only; version probes use argument arrays; query numbers are clamped before interpolation |
| Resource caps | concurrency semaphore (default 2) with bounded queue (`503`), ffmpeg `-fs` output cap, `-max_muxing_queue_size`, per-tool timeouts, `-nostdin` |
| Cleanup | inputs/outputs unlinked after streaming; children killed on client disconnect (`res.close`) and on `SIGINT`/`SIGTERM`; work directory removed on exit |
| Response discipline | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, COOP/CORP, `Cache-Control: no-store`, CSP; error responses use `Connection: close` when the request body was not consumed, so a keep-alive connection can never be desynchronised |
| Graceful degradation | tools missing or disabled (`W8REZ_DISABLE_TOOLS`) → clear `501` JSON; malformed HTTP → `400` via `clientError` handler; the server never crashes on aborted uploads or dying child pipes |

### Residual risks (accepted, documented)

- **ghostscript/ffmpeg interprete hostile files.** Sniffing narrows the
  surface but does not eliminate parser bugs in the tools themselves. Run
  w8rez as a normal (non-privileged) user; keep the tools patched; use
  `W8REZ_DISABLE_TOOLS` if you do not need those formats.
- **`style-src 'unsafe-inline'`.** Needed for per-cell colouring (above).
- **Non-loopback binds are possible** (`W8REZ_HOST=0.0.0.0`) for container
  use; the startup banner warns loudly. Do not expose w8rez to untrusted
  networks — it has no authentication by design.

## Data handling summary

| Data | Where it goes |
|---|---|
| Images/SVG/PDF/EPS dropped onto the page | decoded in-browser; sent to the loopback server only for EPS/PDF fallback conversion |
| Video files | decoded in-browser; sent to the loopback server only when the browser cannot play them or when exporting MP4 |
| Exported files | written by the browser's download mechanism; nothing is stored server-side |

Temporary conversion files live in the OS temp directory with `0600` perms
inside a `0700` directory and are deleted after each request.

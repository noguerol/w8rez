# Changelog

All notable changes to w8rez are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-08-29

First public release.

### Added

- Conversion of PNG/JPG/WebP/GIF, SVG, multi-page PDF (page picker), EPS and
  video to ASCII art.
- Conversion engine: perceptual luminance, block averaging with font-aspect
  correction, dynamic range, inversion, six palettes plus custom palettes
  (JavaScript reimplementation of the AsciiMap algorithm).
- Text overlay: 1–8 strings, centred/repeated/random (deterministic by seed;
  constant position across video frames), visible in every colour mode.
- Colour modes: monochrome, colour glyphs, colour background, both with
  automatic glyph contrast; live invert (negative).
- Outputs: `.txt`, self-contained `.html` (theme, correct aspect, CSP,
  zero JavaScript), `.png`; for video: self-contained HTML animation, `.webm`
  (MediaRecorder), `.mp4` (H.264 assembled offline by ffmpeg).
- Helper server (`server.js`, Node stdlib only): static serving plus
  `/api/health`, `/api/status`, EPS→PNG, PDF→PNG, video→MP4 and
  frames→MP4 endpoints with streaming bodies, magic-byte sniffing,
  concurrency limits, size/time caps and guaranteed temp-file cleanup.
- Security hardening across browser and server (see `docs/SECURITY.md`):
  loopback binding, Host allowlist, strict headers and CSP, allowlisted
  static serving, no-shell process execution, graceful shutdown.
- Test suites: 70 engine tests + 40 server integration tests (Node, zero
  dependencies).
- Documentation set: architecture, algorithm, security, configuration,
  contributing guide, vendored-dependency provenance and third-party notices
  (AsciiMap MIT, pdf.js Apache-2.0).
- GitHub CI workflow running the test suites on a Node matrix.

### Security

- Vendored pdf.js 6.2.108 verified byte-for-byte against the official npm
  tarball (SHA-256 recorded in `vendor/pdfjs/README.md`).

[1.0.0]: https://github.com/w8rez/w8rez/releases/tag/v1.0.0

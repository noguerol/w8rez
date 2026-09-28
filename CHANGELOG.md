# Changelog

All notable changes to w8rez are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] — 2026-09-29

Interface redesign: the whole shell is now a dark, monochrome (greyscale-only)
terminal-style surface, and the control panel reveals groups on demand.

### Added

- **New shell.** Fixed 56 px header (brand, local-only badge, help popover with
  keyboard shortcuts, dark/light preview toggle), a 380 px control panel with
  its own header, scroll area and status footer, and a stage with view tabs,
  the export actions and a status bar.
- **Control panel rewritten around groups.** The drop zone and *Conversion*
  stay visible; *Text overlay*, *Video clip* and *Render & output* are
  accordions that show a live summary of their state (`off`, `no clip`,
  `mono · 16 px`) while collapsed, and open by themselves when relevant.
- **Reusable UI components** (`js/ui.js`, UMD): accordions, numeric steppers,
  segmented controls, colour swatch readout, file card, preview badge, zoom
  levels and the theme toggle — with pure helpers unit-tested in Node.
- **Preview controls.** *View original* (the source bitmap), zoom out / fit /
  in, and a badge with the current `ASCII cols × rows` size.
- **Reset** button that restores every control to its default in one click.
- **End-to-end test suite** (`tests/e2e.sh` + `tests/e2e.browser.js`) that
  drives a real Chrome tab: structure metrics, every feature, accessibility,
  greyscale-only styling, offline guarantees, performance and robustness.
- **UI unit suite** (`tests/ui.test.js`) and `docs/TESTING.md` describing all
  four test layers and the manual smoke test.

### Changed

- Palette `<select>` now shows the *Custom palette* field only when the custom
  palette is selected, and the field is disabled otherwise.
- Accessibility: visible focus rings, `aria-expanded`/`aria-controls` on
  accordions, `aria-pressed` on tabs and toggles, live-region status line, and
  native inputs kept in the DOM behind every custom widget.
- The status line moved from the header to the stage status bar, next to the
  AsciiMap credit; the header now carries the local-only badge.

### Fixed

- Font size and line height are no longer overwritten by the zoom control:
  zoom multiplies the chosen size instead of replacing it.

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
  concurrency limits, size/time caps, automatic H.264 encoder selection
  (libopenh264 → libx264, override with `W8REZ_H264_ENCODER`) and
  guaranteed temp-file cleanup.
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

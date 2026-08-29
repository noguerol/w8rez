# Third-party notices

This file lists third-party software bundled with or relied upon by w8rez,
together with the applicable licences. Full licence texts live in
[`licenses/`](licenses/).

## AsciiMap (algorithm)

- **Upstream:** https://github.com/kompetenzbolzen/AsciiMap
- **Copyright:** © 2019 Jonas Gunz
- **Licence:** MIT — see [`licenses/AsciiMap-LICENSE.txt`](licenses/AsciiMap-LICENSE.txt)
- **What w8rez uses:** the conversion algorithm — perceptual luminance
  `√(0.299R² + 0.587G² + 0.114B²)`, block averaging with aspect-ratio
  correction, optional dynamic-range stretch and dark→bright palette mapping —
  reimplemented from C in JavaScript (`js/ascii.js`). No upstream source code
  is copied; the algorithm is attributed here and in the file header in
  accordance with the MIT licence.

## pdf.js (bundled build)

- **Upstream:** https://github.com/mozilla/pdf.js
- **Package:** `pdfjs-dist` version **6.2.108** (build `0365cbde0`)
- **Copyright:** © 2024 Mozilla Foundation
- **Licence:** Apache License 2.0 — see [`licenses/pdfjs-LICENSE.txt`](licenses/pdfjs-LICENSE.txt)
- **What w8rez uses:** two files from the official npm tarball, vendored
  unmodified into `vendor/pdfjs/` and verified byte-for-byte against the
  published package (SHA-256 digests in [`vendor/pdfjs/README.md`](vendor/pdfjs/README.md)).
- **Provenance:** https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.2.108.tgz

## Techniques acknowledged

- The real font advance measurement used to keep the ASCII grid proportional
  follows the approach of
  [jpetitcolas/ascii-art-converter](https://github.com/jpetitcolas/ascii-art-converter) (MIT).
- The `&nbsp;` trick for colour-block rendering was popularised by
  [EnotionZ/jscii](https://github.com/EnotionZ/jscii).

If you believe a credit is missing, please open an issue or a pull request.

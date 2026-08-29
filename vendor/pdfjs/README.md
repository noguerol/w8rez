# Vendored: pdf.js 6.2.108

This directory contains an **unmodified** build of Mozilla's pdf.js, used to
render PDF pages in the browser. w8rez vendors it to stay a zero-dependency,
works-offline package.

| Property | Value |
|---|---|
| Upstream project | https://github.com/mozilla/pdf.js |
| Package | `pdfjs-dist@6.2.108` |
| Build id | `0365cbde0` |
| Source tarball | https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.2.108.tgz |
| Licence | Apache-2.0 (see `licenses/pdfjs-LICENSE.txt` at the repository root) |
| Files used | `package/build/pdf.min.mjs`, `package/build/pdf.worker.min.mjs` |

## Integrity (SHA-256)

```
e0be3863c23c8af2305b16548febd58e7f8874a460253317d7771cddbc1c0f6d  pdf.min.mjs
0613f41490dd6aaceed7a93fbbd38c85e6d6aa60474b6588c6e7709cfbe18cb3  pdf.worker.min.mjs
```

Verify after any update:

```bash
sha256sum vendor/pdfjs/pdf.min.mjs vendor/pdfjs/pdf.worker.min.mjs
```

## Update procedure

1. Pick a release from the [pdf.js release notes](https://github.com/mozilla/pdf.js/releases)
   and note the matching `pdfjs-dist` version on npm.
2. Download the official tarball:
   `curl -O https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-<version>.tgz`
3. Extract `package/build/pdf.min.mjs` and `package/build/pdf.worker.min.mjs`
   into this directory (no other files are needed).
4. Recompute and update the SHA-256 digests in this README, the version
   reference in `NOTICE.md`, and the API-version note in `docs/ARCHITECTURE.md`.
5. Run `npm test` and manually check a multi-page PDF against the page slider.

The application imports the library through
`import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs'` and points
`GlobalWorkerOptions.workerSrc` at the vendored worker; keep those paths
stable.

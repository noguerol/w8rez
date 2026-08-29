# Contributing

Thanks for considering a contribution to w8rez! This is a small, deliberately
dependency-free project; the guidelines below keep it that way.

## Ground rules

1. **No npm dependencies, runtime or dev.** The tests run on the Node standard
   library. If you need a library, you probably need to justify adding a
   capability differently.
2. **No build step.** Files are served as-is; keep the browser code
   ES5-compatible where the existing code is, and keep modules UMD unless you
   are touching `app.js` (the only ES module).
3. **Everything in English** — code, comments, docs, commit messages.
4. **Tests accompany behaviour changes.** Bug fixes need a regression test.

## Getting started

```bash
git clone <your fork>
cd w8rez
node server.js        # http://localhost:8080
npm test              # engine + server suites
```

Optional local tools for the full experience: ghostscript (EPS/PDF fallback)
and ffmpeg (exotic video formats, MP4 export).

## Commit and PR style

- Conventional-ish subjects: `fix: …`, `feat: …`, `docs: …`, `chore: …`,
  `test: …`, `security: …`.
- Keep PRs focused; one logical change per PR.
- Describe *why*, not just *what*.
- CI must be green (engine tests + server tests + syntax checks on all
  browser modules).

## Code conventions

- `js/ascii.js` stays DOM-free (it is tested in Node).
- All user-controlled strings pass through `Ascii.escapeHtml` /
  `escapeForScript` / `Renderer.safeFontStack` / `Renderer.safeColor`
  before touching HTML or CSS. New render paths must preserve this.
- Server-side: no shell interpolation, ever. New endpoints must validate
  input (sniffing/clamping), enforce caps, and clean up temp files.
- Update `docs/` and `CHANGELOG.md` when behaviour or configuration changes.

## Reporting bugs

Open an issue with the bug template: steps, expected vs actual, browser/Node
versions, and (if relevant) the input file description. For security issues,
follow [`SECURITY.md`](SECURITY.md) instead.

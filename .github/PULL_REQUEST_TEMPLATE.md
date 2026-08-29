## Summary

<!-- What does this PR do and why? Link related issues. -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] Documentation
- [ ] Security hardening
- [ ] Refactor / internal

## Checklist

- [ ] `npm test` passes locally (engine + server suites)
- [ ] Tests added/updated for the changed behaviour
- [ ] User-controlled strings pass through `escapeHtml` / `escapeForScript` /
      `safeFontStack` / `safeColor` where they reach HTML/CSS
- [ ] No new runtime dependencies; no build step introduced
- [ ] Docs (`README.md`, `docs/*`, `CHANGELOG.md`) updated where needed
- [ ] All user-facing text is in English

# The conversion algorithm

The w8rez engine is a JavaScript reimplementation of the algorithm behind
[AsciiMap](https://github.com/kompetenzbolzen/AsciiMap) by Jonas Gunz (MIT).
No upstream source is copied; the algorithm is credited here, in the module
header and in [`NOTICE.md`](../NOTICE.md).

## Pipeline

```
RGBA buffer
   │  1. block averaging (alpha composited over the background colour)
   ▼
cells {r, g, b, lum, alpha}          ← one per output character
   │  2. perceptual luminance per cell
   ▼
lum ∈ [0, 255]
   │  3. optional dynamic-range stretch
   ▼
lum01 ∈ [0, 1]
   │  4. palette lookup (dark → bright), optional inversion
   ▼
grid of glyphs → text / HTML / PNG / animation
```

### 1. Block averaging

Each output cell `(cx, cy)` averages the source rectangle it covers. The
rectangle is computed from the grid's geometry, so the cost is exactly
O(source pixels): every pixel belongs to one block and is visited once.
Alpha is premultiplied into the averages and then composited over the
configured background colour; the cell's average alpha is kept so renderers
can distinguish empty cells.

### 2. Perceptual luminance

```
lum = √(0.299·R² + 0.587·G² + 0.114·B²)
```

The squared formulation follows human perception more closely than a plain
`(R+G+B)/3` average: greens look brighter and blues darker to the eye.

### 3. Dynamic range

Optional (`-d` in AsciiMap): `[min,max]` over the cells is stretched to
`[0,1]`. Useful for faint or low-contrast inputs; off by default in the UI.

### 4. Glyph mapping

Palettes are ordered dark → bright; `char = palette[round(lum01·(n−1))]`.
Inversion flips `lum01` before the lookup (and flips displayed colours in the
renderers, producing a negative).

Palettes are split by Unicode code point, so a glyph outside the BMP counts
as one glyph. A palette must contain at least one glyph; an unusable custom
palette falls back to the default instead of failing a render (surfaced as
`grid.paletteFallback`).

## Aspect ratio

A monospace glyph is taller than it is wide. `computeRows` converts a
`cols`-wide grid into row counts using a *glyph aspect ratio*:

- terminal convention: `0.5` (glyph ≈ 1:2)
- web: measured live — the real advance width of the active font at
  `font-size 64px`, divided by 64 (Consolas/Menlo ≈ 0.60)

The UI re-measures when the font changes, and the exported HTML pins
`line-height` to the same line-box used while measuring, so exported files
keep the original's proportions.

## Text overlay

`stampText` clones the grid and overwrites stamped cells. Semantics:

- up to 8 lines, each clipped to 512 characters and to the grid bounds;
- spaces in the text do not erase the art underneath;
- modes: **once** (vertically centred block) and **repeat** (N copies spread
  evenly), plus **random placement** driven by `mulberry32(seed)`;
- `grid.stamped` marks stamped cells so renderers can draw them with a
  contrast colour in background modes.

Determinism matters for video: all frames of one generation share the seed,
so randomly placed text stays in exactly the same position in every frame.

## Renderers

- **text** — trivial row serialization.
- **HTML** — `buildHtmlFragment` produces the `<pre>` contents: glyph text
  escaped, style runs merged (run-length grouping), one newline per row. The
  document template adds a strict CSP meta (`default-src 'none'`), theme
  variables and a metadata header. Static exports contain no JavaScript.
- **PNG** — `drawGridToCanvas` rasterises with the chosen font/mode/theme;
  canvas dimensions are validated against a 16384 px limit.
- **Animation** — frames are embedded as JSON escaped via `escapeForScript`
  (`<` → `\u003c`), so a frame can never terminate the `<script>` block; the
  player is a small inline IIFE guarded by its own CSP.

## Prior art considered

| Project | Verdict |
|---|---|
| [kompetenzbolzen/AsciiMap](https://github.com/kompetenzbolzen/AsciiMap) | best-in-class algorithm (adopted); C, terminal/BMP only |
| [EnotionZ/jscii](https://github.com/EnotionZ/jscii) | weak luminance model; `max(r,g,b)`; legacy `<font>` markup |
| [jpetitcolas/ascii-art-converter](https://github.com/jpetitcolas/ascii-art-converter) | good web aspect handling (font measuring adopted) |
| [IonicaBizau/image-to-ascii](https://github.com/IonicaBizau/image-to-ascii) | CLI-only |

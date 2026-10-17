# Compositor — real font rendering

Issue: [#25](https://github.com/AndreyBegma/DemoFlow/issues/25) · before Phase 4 ·
Decisions: [ADR-0005](../adr/0005-renderer-chosen-by-spike.md) (accepted)

Depends on #24

## Summary

The FFmpeg compositor draws text with the Hershey Simplex stroke font: thin,
plotter-like, ASCII only — any other character, Cyrillic included, becomes
`?`. It was the one place the spike found Remotion clearly better, and the
owner accepted it as the debt to pay before Phase 4. This item renders text
from a real, bundled font with anti-aliasing, for Latin and Cyrillic.

## Scope

### In scope

- A bundled font: **Inter** (SIL Open Font License 1.1), Regular and SemiBold,
  subset to Basic Latin, Latin-1 Supplement and Cyrillic, shipped inside
  `@demoflow/renderer` with its licence file.
- Glyph outlines read with `opentype.js` (MIT, pure JavaScript — no native
  module, so it installs the same way on Linux, macOS and Windows).
- An anti-aliased outline rasteriser in `src/ffmpeg/` (non-zero winding,
  coverage-based, 4× vertical subsampling or exact area coverage), kerning
  from the font, and the existing layout (wrapping at `maxWidth`).
- The Hershey font and its table are removed.

### Out of scope

- Right-to-left scripts, CJK, emoji, font fallback chains, user-chosen fonts.

## Decisions

- Pure JavaScript only; no `canvas`/`skia` native binding (install footprint,
  ADR-0001's three operating systems).
- Characters outside the subset still draw as `?`, now in Inter.

## Acceptance criteria

- [ ] `bun run --filter @demoflow/renderer test`, `bun run check`, `bun run build` pass.
- [ ] A caption "Создать клиента — Create customer" renders with every
      character drawn (no `?`), measured by comparing against a render of `?`.
- [ ] Cap heights stay as #24 set them (±1 px).
- [ ] Edge pixels of glyphs have intermediate alpha (anti-aliasing), checked on
      a rendered "H".
- [ ] `npm pack --dry-run` of `@demoflow/renderer` includes the font files and
      `OFL.txt`; the package grows by less than 1 MB.
- [ ] Rendering the engine's `tour.demo.json` run takes no more than 20 % longer
      than before this change on the same machine (stated in the pull request).

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i25-fonts | the font, the rasteriser, the layout change | packages/renderer/src/ffmpeg/**, packages/renderer/test/ffmpeg/**, packages/renderer/fonts/**, packages/renderer/package.json, bun.lock | — | yes | opus |

One slot: the rasteriser and the layout are one change to one module.

## Risks

- **Rasteriser speed** (medium): JavaScript coverage rasterisation per glyph.
  Mitigation: glyphs are rasterised once per size and cached; text is laid out
  once per string already.

## Open questions

- Inter or another OFL sans (e.g. Noto Sans)? Default: Inter.

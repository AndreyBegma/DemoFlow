# Render the page in a rounded window on a background

Issue: [#100](https://github.com/AndreyBegma/DemoFlow/issues/100) · Phase 4 ·
Roadmap: [roadmap.md](../product/roadmap.md) (Phase 4 — style, frame, background) ·
Decisions: [ADR-0005](../adr/0005-renderer-chosen-by-spike.md), [ADR-0010](../adr/0010-source-video-at-viewport-size.md)

Depends on #91

## Summary

Today the page fills the whole output frame. The owner chose a Screen
Studio-like look for Phase 4: the page sits in a window with rounded corners
and a soft shadow, on a gradient or solid background, with the camera's zoom
and pan acting on that window. This item adds the window and the background to
the FFmpeg compositor and the render plan, configurable in
`demoflow.config.json`.

## Scope

### In scope

- **Window**: the page is drawn scaled into a centred window that leaves a
  margin of the output on every side (default 6% of the output height),
  corners rounded (default 12 output px at 1080p, scaled with output height),
  a soft drop shadow beneath. **No browser chrome** — no title bar, no URL bar
  (owner, roadmap).
- **Background**: 6 built-in presets (gradients) plus `color` (solid) or a
  custom two-stop `gradient` (`from`, `to`, `angle`). No image backgrounds
  (owner, roadmap).
- **Camera**: the existing zoom/pan (plan `keys`) now frames the window: at
  zoom 1 the whole window with its margin is visible; zooming in moves towards
  the target as today, so at the 1.6×/1.25× zoom the background may leave the
  frame. The cursor, rings, captions, masks and badges are drawn in the window's
  coordinate space (they move and scale with it), except captions and cards,
  which stay in output space as today.
- **Config** in `RenderConfigSchema` (`packages/core/src/project-config.ts`),
  additive with defaults:
  `render.frame: { enabled: true, marginRatio: 0.06, radius: 12, shadow: true }`,
  `render.background: { preset: 'ocean' } | { color: '#rrggbb' } |
  { gradient: { from, to, angle } }`, default preset `'ocean'`. The JSON Schema
  for project config is regenerated.
- **Off switch**: `render.frame.enabled: false` renders exactly today's
  full-bleed output (existing golden images unchanged under it).
- **Golden images** (#73): new baselines for the framed look — window at zoom 1,
  zoomed on a target, each preset swatch strip — and the existing ones kept for
  `enabled: false`.

### Out of scope

- Cards and transitions (separate issues), export formats, 9:16.

## Decisions

1. **Framed by default**, with an off switch. — orchestrator (owner chose the
   style; the switch keeps today's output reproducible).
2. **Six gradient presets** named `ocean`, `sunset`, `forest`, `dusk`,
   `graphite`, `paper`; the slot proposes the colours in the PR with a swatch
   strip (golden image), and the orchestrator reviews them at merge. —
   orchestrator.
3. **Overlays follow the window, text stays in output space.** — orchestrator.

## Acceptance criteria

- [ ] With default config, a real fixture run renders the page in a rounded,
      shadowed window on the `ocean` gradient; the #73 layout check is adapted
      (page content inside the window rect, background outside) and passes.
- [ ] The camera's zoom keyframes frame the window; on a click the zoom still
      centres the target (plan test).
- [ ] Cursor, rings, masks follow the window when zoomed (golden image of a
      zoomed frame with a mask and the cursor).
- [ ] `render.frame.enabled: false` reproduces the existing golden images
      bit-for-bit within tolerance.
- [ ] `color`, `gradient` and each preset render (golden swatch strip);
      invalid colours and unknown presets are rejected by the schema.
- [ ] The project-config JSON Schema is regenerated.
- [ ] Before/after images in the PR; `bun run check` passes; Woodpecker and all
      three OSes green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i100 | window, background, config | packages/renderer/src/**, packages/renderer/test/**, packages/core/src/project-config.ts, packages/core/test/**, packages/core/schemas/** | #91 | yes | opus |

One slot. `opus`: the coordinate model (overlays in window space, text in
output space) and the camera change are decided here. Depends on #91 only
because it holds the renderer and core files.

## Risks

- **Masks out of place when zoomed** (high — a secret could show). Mitigation:
  the mask golden image and the existing real-run mask coverage test, run with
  the frame on.
- **Smaller page in the frame softens text further** (medium, with a 1× source,
  ADR-0010). Mitigation: the margin is configurable; 6% keeps the page at ~88%
  of the output height.

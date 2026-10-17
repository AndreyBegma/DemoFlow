# Renderer — FFmpeg compositor only: remove Remotion, fix text sizes

Issue: [#24](https://github.com/AndreyBegma/DemoFlow/issues/24) · Phase 1 ·
Decisions: [ADR-0005](../adr/0005-renderer-chosen-by-spike.md) (accepted)

## Summary

The owner chose the FFmpeg compositor (ADR-0005). This item removes the
Remotion renderer and its dependencies from `@demoflow/renderer`, so
`demoflow` installs no Remotion packages and downloads no browser to render,
and it fixes the compositor's one measured defect: captions, the FAILED badge
and the end card are about 1.4× too large because it reads the shared look's
sizes as cap heights while they are CSS font sizes.

## Scope

### In scope

- Delete `packages/renderer/src/remotion/**` and `packages/renderer/test/remotion/**`.
- Drop `remotion`, `@remotion/bundler`, `@remotion/renderer`, `react`,
  `react-dom`, `@types/react`, `@types/react-dom` from
  `packages/renderer/package.json`; regenerate `bun.lock`.
- Delete `packages/renderer/scripts/spike.ts` and the `spike` script — the
  spike is over. The report keeps its reproduce section, with a note that it
  applies to commit `aa7ffe8`.
- In the compositor, read the look's text sizes as font sizes.

### Out of scope

- Real font rendering (#25). Non-ASCII text still draws as `?` after this.

## Decisions

- The `Renderer` interface and `renderer.name` stay; `ffmpeg` is the only name.
- **Text size**: the look's `text` entries become `{ fontPx, weight }` with
  the values the look already agreed on — caption 40, watermark 32, end card
  48. The compositor draws a cap height of `round(fontPx × 0.72)` (the cap
  height of a typical sans-serif, which is what Remotion's `sans-serif` drew
  at those sizes in the spike). Line height becomes `fontPx × 1.25`.

## Acceptance criteria

- [ ] `bun run --filter @demoflow/renderer test`, `bun run check` and
      `bun run build` pass; no file under `packages/renderer` mentions
      `remotion`, and `bun.lock` lists no `remotion` or `@remotion/*` package.
- [ ] `npm pack --dry-run` of `@demoflow/renderer` lists no file under `remotion/`.
- [ ] A compositor test renders the FAILED badge alone and measures the label's
      cap height from the pixels: 23 px ± 1 (32 × 0.72).
- [ ] The same test for a caption: 29 px ± 1 (40 × 0.72); for the end card's
      first line: 35 px ± 1 (48 × 0.72).
- [ ] The engine's `failing.demo.json` run renders to an MP4 whose end card
      text fits within 1600 px wide without wrapping more lines than before.
- [ ] `docs/research/renderer-spike.md` says, under *Reproduce*, that the
      commands apply to commit `aa7ffe8` and that Remotion was removed in #24.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i24-remove | Remotion out of the package, the spike script, the report note | packages/renderer/src/remotion/**, packages/renderer/test/remotion/**, packages/renderer/src/index.ts, packages/renderer/src/renderer.ts, packages/renderer/package.json, packages/renderer/scripts/**, packages/renderer/tsconfig.json, docs/research/renderer-spike.md, bun.lock | — | yes | sonnet |
| i24-text-size | the compositor's text sizes | packages/renderer/src/ffmpeg/**, packages/renderer/test/ffmpeg/** | — | no | sonnet |

The two slots touch disjoint files and may run together; either may merge first.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/renderer/package.json, bun.lock | i24-remove | do not open |
| packages/renderer/src/index.ts | i24-remove | do not open |

## Risks

- **A dependency other than the Remotion renderer used React** (low): checked —
  only `src/remotion/**` imports `react`. If a test fails for it, keep React and
  say so in the pull request.

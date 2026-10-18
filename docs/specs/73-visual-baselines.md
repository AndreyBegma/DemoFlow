# Visual baselines for the compositor and the rendered frame layout

Issue: [#73](https://github.com/AndreyBegma/DemoFlow/issues/73) · before Phase 4 ·
Roadmap: [roadmap.md](../product/roadmap.md) ("Before Phase 4 — visual baselines")

## Summary

Nothing in the test suite looks at what a rendered frame shows. #47 shipped a
video with the page in a quarter of the frame because the tests read only the
WebM header size. Phase 4 changes the look substantially (frame, background,
cards, transitions), so every one of those changes needs a check that the
pixels are what was intended. This item adds two layers: **golden images** for
the compositor on fixed inputs, and **layout assertions** on real runs.

## Scope

### In scope

- **Golden images**: the compositor (`packages/renderer/src/ffmpeg/compose.ts`)
  renders a fixed set of synthetic source frames and states (cursor, click
  rings, caption, mask, zoom, failure card) to PNG. The PNGs are committed under
  `packages/renderer/test/baselines/`. The test compares each one with a
  per-pixel tolerance and a maximum share of differing pixels, and writes a diff
  image next to the failure.
- **`test:update-baselines`** script in `@demoflow/renderer` regenerating the
  PNGs. An intended change commits new baselines in the same pull request, with
  a before/after comparison in the PR body (roadmap).
- **Layout assertions on real runs** (`render.spec.ts` / `build.spec.ts`
  recordings, no new recordings): a mid-run output frame has page content
  (not uniform) in every quadrant, and no region larger than a set share is the
  padding grey (127,125,129 ± 6) — the #47 signature.

### Out of scope

- Golden images of real runs (timing makes them non-deterministic).
- Phase 4 effects themselves.

## Decisions

1. **Golden images only on deterministic inputs**; real runs get structural
   assertions. — orchestrator (owner delegated; roadmap).
2. **Baselines regenerate in the PR that changes the look**, reviewed at merge
   by the orchestrator. — owner (roadmap).
3. **Tolerances are set from data**: run the comparison on all three OSes and
   set the per-pixel tolerance and the differing-pixel share just above the
   largest cross-OS difference observed; the PR reports the numbers. —
   orchestrator.

## Acceptance criteria

- [ ] At least six golden images (cursor, click rings, caption, mask, zoomed
      frame, failure card) committed, compared on all three OSes.
- [ ] A deliberate one-pixel-wide change to the cursor's colour fails the
      golden test with a diff image; reverting it passes (shown in the PR).
- [ ] `bun run --filter @demoflow/renderer test:update-baselines` regenerates
      the PNGs deterministically (running it twice changes nothing).
- [ ] The layout assertion fails on a frame reproducing #47 (a test feeds a
      quarter-page frame) and passes on current real runs.
- [ ] The PR reports cross-OS differences and the chosen tolerances.
- [ ] Tests under Node with Vitest on all three OSes; `bun run check` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i73 | golden images, the update script, layout assertions | packages/renderer/test/**, packages/renderer/package.json | — | yes | sonnet |

One slot. `sonnet`: the method is written here; tolerances come from
measurement, not judgement.

## Risks

- **Cross-OS rendering differences** (medium): font rasterisation is our own
  (spec 25), so differences should be small. Mitigation: Decision 3.

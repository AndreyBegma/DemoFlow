# Engine — restore viewport-sized recording (fix #17's quarter-page video)

Issue: [#47](https://github.com/AndreyBegma/DemoFlow/issues/47) · bug · critical ·
Supersedes: [spec 17](17-source-video-device-pixels.md) Decision 1's premise ·
Decisions: [ADR-0004](../adr/0004-recording-is-separate-from-rendering.md) §1

## Summary

Spec 17 set `recordVideo.size = viewport × DEVICE_SCALE_FACTOR` on the premise
that Playwright would then record device pixels. It does not: Playwright places
the viewport-sized frame in the top-left quarter of the larger canvas and fills
the rest with grey (≈ 127,125,129) — on every frame of every run (8 runs,
decoded and inspected, 2026-10-18) [Confirmed]. Playwright's option only scales
**down** to fit. The renderer reads `source.width / viewport.width = 2`, assumes
device pixels, and aims the camera, cursor and masks at the wrong pixels. #17's
tests read only the WebM header size, so CI stayed green. This item restores a
correct 1× source and adds the content check that would have caught it.

## Scope

### In scope

- `packages/engine/src/execute/recording.ts`: `videoSize = viewport` again,
  with a doc comment saying why (Playwright pads, it does not upscale; see #47).
- The tests that pinned the wrong behaviour, updated to 1×:
  `packages/engine/test/capture/capture.spec.ts` (header size),
  `packages/engine/test/execute/recording.spec.ts`,
  `packages/renderer/test/plan/build.spec.ts` (scale 1, zoom 1.25).
- A **content** assertion on a real recording: a mid-run frame's bottom-right
  quadrant is page content, not uniform grey.
- The WebM header helper from #37 (`packages/engine/test/capture/webm.ts`)
  stays and is reused.

### Out of scope

- A real device-pixel capture (CDP screencast at device pixels or another
  path) — a separate spec; it supersedes spec 17 Decision 1.
- Reverting #37's test-robustness changes (timeline-derived bounds, timeouts,
  the CI quarantine for #40) — they stay.
- #40 and #48 — re-measured after this lands.

## Decisions

1. **Restore 1× now; real 2× later, separately.** A correct 1× video with the
   renderer's 1.25× zoom beats a broken 2× one. — orchestrator (owner delegated).
2. **`deviceScaleFactor: 2` stays on the context** (ADR-0004 §1): the page
   still renders at 2×; only the video frame size changes back. Whether the
   screencast benefits from it is the later spec's question.
3. **Content, not just size, is tested.** Detection: decode one mid-run frame
   (FFmpeg via the engine test's existing system-FFmpeg pattern in
   `clock-drift.spec.ts`, skipped with a warning when FFmpeg is absent, as
   there) and assert the bottom-right quadrant is not uniform grey
   (per-channel spread above a small threshold, or mean not within ±6 of
   127,125,129). — orchestrator.
4. **The renderer is not changed**: its zoom rule already picks 1.25× at
   scale 1 (`plan.ts`). — spec 17, unchanged.

## Acceptance criteria

- [ ] `source.webm` of a `customers.demo.json` run at 1280×720 has header size
      1280×720 (engine test).
- [ ] A mid-run frame of that recording has page content in its bottom-right
      quadrant — not uniform grey (engine test; skipped with a warning if no
      system FFmpeg, as `clock-drift.spec.ts` does).
- [ ] `toContextOptions(recordingOptions(...)).recordVideo.size` equals the
      viewport; `deviceScaleFactor` stays 2 (unit test).
- [ ] `buildRenderPlan` on a real run has source scale 1 and picks the 1.25×
      zoom (renderer test).
- [ ] `execution-plane` green on all three OSes; Woodpecker green;
      `bun run check` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i47 | the recording size, its tests, the content check | packages/engine/src/execute/recording.ts, packages/engine/test/**, packages/renderer/test/plan/build.spec.ts | — | yes | sonnet |

One slot. `sonnet`: every decision is written here; the change reverts one
expression and updates three tests plus one new assertion.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/engine/test/** | i47 | #42 adds engine tests — it starts after #47 merges |
| packages/renderer/test/plan/build.spec.ts | i47 | #44 edits renderer real-run tests — serialize |

## Risks

- **Other tests assume 2×** (medium). Mitigation: grep for 2560/1440/scale 2
  across `packages/*/test` and fix each.
- **Spinner/stall findings (#40) were on the broken capture** (low). Re-measure
  after this lands.

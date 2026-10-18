# Engine — record the source video at device pixels

Issue: [#17](https://github.com/AndreyBegma/DemoFlow/issues/17) · before Phase 4 ·
Decisions: [ADR-0004](../adr/0004-recording-is-separate-from-rendering.md) §1 (accepted)

## Summary

The engine records `source.webm` at the CSS viewport size, although the page
renders at `deviceScaleFactor: 2`. A 1280×720 run therefore yields a 1280×720
video, and the renderer's 1920×1080 output upscales it 1.5× before any camera
zoom; the renderer falls back to a 1.25× zoom on such a source. ADR-0004 §1
asks for `deviceScaleFactor: 2` precisely "so zoom has pixels to spend" — the
video frame size has to follow it. This item records at
`viewport × deviceScaleFactor`, so the renderer picks its 1.6× zoom with the
pixels to back it. Surfaced by the renderer spike (#4).

## Scope

### In scope

- `videoSize = viewport × DEVICE_SCALE_FACTOR` in
  `packages/engine/src/execute/recording.ts` (`recordingOptions()`), with the
  doc comment on `RecordingOptions.videoSize` updated to say why.
- A test helper that reads the frame size from a WebM file's EBML header
  (`Segment → Tracks → TrackEntry → Video → PixelWidth / PixelHeight`), in
  `packages/engine/test/**`. No new dependency.
- An engine test that runs a scenario and asserts the recorded
  `source.webm` is `viewport × deviceScaleFactor` (2560×1440 for the 1280×720
  fixture viewport), plus a unit assertion on `toContextOptions()`.
- Existing tests that assume the video is viewport-sized, updated.

### Out of scope

- The renderer's zoom rule — `buildRenderPlan` already switches on
  `source.width / viewport.width >= 2`
  (`packages/renderer/src/plan/plan.ts`) [Confirmed].
- Making `deviceScaleFactor` configurable: it stays the
  `DEVICE_SCALE_FACTOR = 2` constant; the `@demoflow/core` contracts do not
  change.
- A size ceiling for large viewports (below, Decisions 1).
- A CI time budget or an fps assertion in CI.

## Decisions

1. **No ceiling.** The frame size is always `viewport × DEVICE_SCALE_FACTOR`,
   including 3840×2160 for a 1920×1080 viewport. The 4K cost is a stated risk,
   measured once in the pull request (7). — the owner.
2. **The frame size is checked from the file**, by parsing the WebM EBML
   header in the test, not by adding `ffmpeg-static` / `ffprobe` to the
   engine, and not by asserting only on the options object. — the owner.
3. **The WebM parser is a test helper** under `packages/engine/test/**`; it
   is not part of the engine's source or public API. — the owner.
4. **`deviceScaleFactor` stays a constant (2).** — the owner; per ADR-0004 §1.
5. **CI time is reported, not gated.** The pull request states the engine
   test duration before and after, on Woodpecker and on each OS of the
   GitHub `execution-plane` matrix (Linux, macOS, Windows). No threshold
   blocks the merge; the owner judges the numbers at review. — the owner.
6. **The renderer is not touched.** — the issue, out of scope.
7. **A one-off 4K measurement goes in the pull request**: one recorded run at
   a 1920×1080 viewport, reporting the frame size, the number of frames
   against the run's duration (effective fps), and the file size. Nothing is
   added to CI for it. — the owner.

## Acceptance criteria

- [ ] For a run at the 1280×720 fixture viewport, the engine test reads
      2560×1440 from the recorded `source.webm` header.
- [ ] `toContextOptions(recordingOptions(scenario, dir)).recordVideo.size`
      equals `viewport × DEVICE_SCALE_FACTOR` for any viewport (unit test).
- [ ] The WebM header helper lives under `packages/engine/test/**`; no
      dependency is added to any `package.json`, and `bun.lock` is unchanged.
- [ ] The engine tests pass under Node with Vitest (the package's `test`
      script — never `bun test`), locally, in Woodpecker and on all three
      OSes of the GitHub `execution-plane` workflow.
- [ ] `buildRenderPlan` picks the 1.6× zoom for such a run with no renderer
      change: a renderer test or a recorded run shows `sourceScale >= 2`.
- [ ] The pull request reports the engine test duration before and after,
      per CI (Woodpecker; GitHub matrix per OS).
- [ ] The pull request reports the 1920×1080 measurement of Decision 7:
      frame size, frame count vs duration, file size.
- [ ] `bun run check` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i17-engine | the recording size and its tests | packages/engine/src/execute/recording.ts, packages/engine/test/** | — | yes | sonnet |

One slot: a one-line source change and its tests. `sonnet` because every
decision is written down above.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/engine/test/capture/** | i17-engine | #18 and #19 also extend the engine's capture tests — do not run them in parallel with this slot on the same test file |

## Risks

- **4K recording at a 1920×1080 viewport** (medium). Chromium's screencast
  and Playwright's VP8 encode at 3840×2160 may drop frames on CI runners, and
  run directories grow. Mitigation: the measurement of Decision 7; a ceiling
  is a follow-up issue if the numbers call for it.
- **Slower engine tests on CI** (low). Mitigation: reported in the pull
  request (Decision 5).
- **Playwright's WebM layout** (low). That the header carries
  `PixelWidth` / `PixelHeight` in the video track is [Unknown] until the
  helper reads one; the helper walks the EBML tree rather than reading fixed
  offsets.

# Spike — record the source at device pixels through a CDP screencast

Issue: [#82](https://github.com/AndreyBegma/DemoFlow/issues/82) · Phase 4, step 1 (started early, owner's choice) ·
Decisions: [ADR-0004](../adr/0004-recording-is-separate-from-rendering.md) §1,
[roadmap.md](../product/roadmap.md) (Phase 4), spec [47](47-restore-viewport-recording.md)

## Summary

ADR-0004 §1 records at `deviceScaleFactor: 2` "so zoom has pixels to spend",
but Playwright's `recordVideo` delivers frames at the CSS viewport size; asking
it for a larger `size` only pads the frame (#47). This spike answers whether a
Chrome DevTools Protocol screencast (`Page.startScreencast`, frames at device
pixels) can replace `recordVideo` as the source, and at what cost. It builds a
prototype behind an opt-in flag, measures it against fixed criteria, and ends
with a report and a decision. **The default capture does not change in this
item.**

## Scope

### In scope

- A prototype capture in `packages/engine` behind an opt-in switch
  (`DEMOFLOW_CAPTURE=cdp`, read only by the engine; undocumented). It starts a
  CDP screencast at `viewport × deviceScaleFactor`, receives frames with their
  timestamps, acks them, and encodes them to `source.webm` (VP9 via the
  renderer's FFmpeg resolution, or the engine's own pipe to FFmpeg — the spike
  chooses and says why) at a constant 25 fps, duplicating frames across gaps
  so the video stays constant-rate.
- Frame timing: the screencast frame metadata's timestamp maps each frame onto
  the engine clock; the sync mark (#19, #48) must still be found by the
  renderer.
- A measurement harness (test or script under `packages/engine/test/**`) that
  records the fixture scenarios with both captures and reports, per OS (CI
  matrix): frame size, effective fps and longest frame gap, dropped/duplicated
  frames, text sharpness at the renderer's 1.6× zoom (an edge-contrast metric
  on a fixed text region), run time, file size.
- `docs/research/82-cdp-capture-spike.md`: method, numbers, sample frames
  (1× vs 2× at 1.6× zoom), the decision against the criteria, and — if
  accepted — what the follow-up issue changes.

### Out of scope

- Making CDP capture the default; any renderer change; Phase 4 effects.

## Decisions

1. **The orchestrator decides by criteria fixed here** — owner (roadmap). Accept
   CDP capture only if **all** hold on Linux, macOS and Windows CI:
   - text in the fixed region is measurably sharper at 1.6× zoom than the 1×
     source upscaled (edge-contrast metric at least 1.5× the 1× value);
   - 25 fps with no frame gap longer than 200 ms during steps, on every run;
   - the renderer finds the sync mark on every run and the #19/#48 offset test
     passes against the CDP source;
   - CI time for the real-run suites no more than 2× the 1× baseline.
   Otherwise the source stays 1× and the report says why.
2. **Started before npm and `record`**, because it touches only the engine's
   capture — owner, 2026-10-18.

## Acceptance criteria

- [ ] With `DEMOFLOW_CAPTURE=cdp`, a fixture run produces a constant-25-fps
      `source.webm` at `viewport × 2`, with page content in every quadrant (the
      #73 layout check passes on it).
- [ ] Without the switch, behaviour and all existing tests are unchanged.
- [ ] The harness reports every metric of Decision 1, per OS, from CI runs (run
      ids in the report).
- [ ] `docs/research/82-cdp-capture-spike.md` states the decision against each
      criterion with the numbers.
- [ ] `bun run check` passes; Woodpecker and all three OSes green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i82 | the prototype capture, harness and report | packages/engine/src/**, packages/engine/test/**, docs/research/82-cdp-capture-spike.md | — | yes | opus |

One slot. `opus`: an unproven capture path with timing and encoding decisions.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/engine/src/** | i82 | #68/#69 (apps/cli) do not touch it; #75 bundles the engine but does not edit it |

## Risks

- **Screencast frame pacing** (high): CDP delivers frames on change, not at a
  fixed rate, and can stall (#40). Mitigation: constant-rate encoding with
  duplicated frames; the gap criterion.
- **Cost on CI** (medium). Mitigation: the 2× CI-time criterion.

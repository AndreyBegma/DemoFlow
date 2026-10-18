# Engine and renderer — a sync mark that is always recorded and unbiased

Issue: [#48](https://github.com/AndreyBegma/DemoFlow/issues/48) · bug · high ·
Builds on: [spec 19](19-clock-sync-mark.md)

Depends on #42
Depends on #44

## Summary

Two defects in #19's sync mark, both measured on CI and locally [Confirmed]:

1. **Missing.** In 3 of 8 fixture runs the mark never appears in the video:
   frame 0 is the blank page, frame 1 is already the app, although the
   timeline says the mark was up from ≈ 30 ms to ≈ 185 ms. The renderer falls
   back to the defaults.
2. **Biased late.** `offMs` is read on the engine clock after the clear's
   double `requestAnimationFrame` plus the `page.evaluate` round-trip. On CI
   runners the renderer's offset was −83.2 ms against the drift method's
   −35.6 ms (Windows, develop run 39127667058), 47.6 ms apart; locally ~10 ms.
   A too-negative offset moves mask **ends** earlier too, and ends carry no
   padding — a field can be uncovered for about a frame at the end of an
   interval.

This item records the mark's edges on the page's own clock and maps them to
the engine clock precisely, holds the mark until it is on video, and pads mask
ends by a frame.

## Scope

### In scope

- Engine (`packages/engine/src/execute/sync-mark.ts`, `run.ts`):
  - **Page-clock edges.** The page records `performance.now()` at the frame
    the mark is painted and at the frame it is cleared (the `rAF` timestamp of
    the first frame without it). The engine maps page time to engine time by
    an NTP-style exchange: `t0 = clock.now()`, page returns
    `performance.now()`, `t1 = clock.now()`; engine time = page time +
    (midpoint − page time at the exchange); repeat 3–5 times and keep the
    exchange with the smallest round-trip. `onMs`/`offMs` are the mapped
    page-clock edges.
  - **Recorded before cleared.** The mark is held until at least
    `SYNC_MARK_HOLD_MS` has passed **and** the recording has had time to
    capture it: wait for the page's first paint after navigation-ready of the
    blank page, then hold ≥ 200 ms (≥ 5 frames at 25 fps). The exact rule is
    the slot's to choose and prove with the miss rate below.
- Renderer (`packages/renderer/src/plan/plan.ts`):
  - **Mask trail.** With a measured offset, every mask span ends one source
    frame later than today (`maskTrailMs = 1000 / source.fps`); without a
    measured offset, 200 ms later — symmetric with the lead.
- Tests: un-quarantine the #19 offset test on CI
  (`packages/renderer/test/plan/build.spec.ts`).

### Out of scope

- A different sync method (CDP screencast timestamps).
- The spinner quarantine (#40).

## Decisions

1. **Page clock for edges, mapped by the best of N round-trips.** —
   orchestrator (owner delegated).
2. **Hold until recorded**, proven by a miss rate, not by reasoning. —
   orchestrator.
3. **Pad mask ends symmetrically with the lead.** A late mask end is safe; an
   early one leaks. — orchestrator.

## Acceptance criteria

- [ ] Over 20 local `customers.demo.json` runs (Linux), the renderer finds the
      mark in at least 19; the PR reports the count before and after.
- [ ] On those runs, the renderer's offset is within 20 ms of the drift
      method's on every run where both exist; the PR reports min/max/median
      differences before and after.
- [ ] The #19 offset test runs on CI again (no `skipIf`) and passes on all
      three OSes on the PR, three runs in a row.
- [ ] With a measured offset, a mask span ends `1000 / fps` ms after
      `out(endMs)`; without, 200 ms after (renderer unit tests).
- [ ] `bun run check` passes; Woodpecker green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i48 | edge mapping, hold rule, mask trail, un-quarantine | packages/engine/src/execute/sync-mark.ts, packages/engine/src/run.ts, packages/engine/test/**, packages/renderer/src/plan/**, packages/renderer/test/plan/** | #42, #44 | yes | opus |

One slot: the engine's edges and the renderer's trail must be proven
together against the drift method. `opus`: the hold rule and the clock mapping
are decided here by measurement.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/engine/src/**, packages/renderer/src/plan/plan.ts | i48 | #42 edits these — i48 starts after #42 merges |
| packages/renderer/test/plan/build.spec.ts | i48 | #44 quarantines the test there — i48 starts after #44 merges |

## Risks

- **Clock mapping still off on a loaded runner** (medium). Mitigation: best of
  N exchanges; the 20 ms local bound plus the CI test.
- **Longer hold slows every run by ~100 ms** (low). Accepted.

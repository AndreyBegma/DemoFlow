# Recording — measure screencast stalls on the corrected capture, then un-quarantine

Issue: [#40](https://github.com/AndreyBegma/DemoFlow/issues/40) · bug · medium

## Summary

The renderer test "keeps the slow report's spinner: the wait for it plays in
real time" (`packages/renderer/test/plan/build.spec.ts`) is skipped on CI since
PR #37: the source video froze for 1.0–1.8 s during the slow report on CI
runners. Those measurements were taken on the 2560×1440 capture that #47 showed
was broken (page in the top-left quarter) and that has since been reverted to
1× [Confirmed]. This item re-measures on the corrected capture and either
un-quarantines the test or states, with numbers, why it stays.

## Scope

### In scope

- Measure the longest source-frame gap during the slow report's spinner on
  each CI OS, on the current capture: 5 runs per OS, using the test's own
  independent FFmpeg motion check.
- If no stall ≥ the renderer's idle threshold (1 s) appears in any of the 15
  runs: remove the CI skip.
- If stalls remain: keep the skip, record the numbers in the test's comment and
  in this issue, and file a follow-up for the recording side.

### Out of scope

- Changing the recording pipeline or the fixture.
- The renderer's idle detector.

## Decisions

1. **Measure before un-quarantining.** — orchestrator (owner delegated).
2. **5 runs per OS** is the evidence bar. — orchestrator.

## Acceptance criteria

- [ ] The PR reports, per OS, the longest source-frame gap in the spinner
      window over 5 runs, with run ids.
- [ ] Either the CI skip is removed and the test passes on all three OSes in
      three consecutive runs, or the skip stays with the measured numbers in
      its comment and a follow-up issue is linked.
- [ ] `bun run check` passes; Woodpecker green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i40 | the measurement and the quarantine decision | packages/renderer/test/plan/build.spec.ts | — | yes | sonnet |

One slot. `sonnet`: the decision rule is written here.

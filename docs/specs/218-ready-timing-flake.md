# waitForReady timing test flakes on macOS CI

Issue: [#218](https://github.com/AndreyBegma/DemoFlow/issues/218)
Depends on: nothing

## Summary

This test fails intermittently on `execution-plane (macos-latest)`:

- file: `packages/engine/test/execute/ready.spec.ts`
- suite: `waitForReady (#198)`
- test: "passes within 100 ms of a signal sent 500 ms into the step"

It failed on #215, which does not touch the engine (164 ms against a bound of
< 100). It also failed once under parallel load on a developer host. The test
came with #198 (PR #212). The engine polls every 50 ms, so the bound leaves
50 ms of slack for a loaded VM.

## Decisions

1. **Diagnose first.** The root cause is not proven. Find out which it is:
   - the wall-clock margin is wrong for a loaded CI VM;
   - the engine really ends the step late after the signal.

   Record what you measured in the PR body.
2. **If the bound is wrong**, assert what `waitForReady` guarantees instead of
   a wall-clock margin: for example, the step ends after the page's own signal
   timestamp and within a bounded number of poll intervals of it, measured on
   the page's clock. `packages/engine/test/execute/page-frames.ts` (#173) is
   the precedent. Raising the number alone is not a fix.
3. **If the engine is late**, fix the engine. The test stays as it is.
4. **No quarantine.** Do not skip the test and do not retry it.

## Acceptance criteria

- The PR names the root cause and the evidence for it.
- `execution-plane (macos-latest)` passes the test in 10 consecutive runs. A
  loop of the single test inside one CI job is acceptable evidence; the loop is
  removed before the PR is ready.
- `bun run check`, `bun run test` and `bun run build` are green, and so is the
  execution-plane matrix.

## Open questions

None.

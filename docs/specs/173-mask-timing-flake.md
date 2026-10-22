# Mask visibility timing test flakes on macOS CI

Issue: [#173](https://github.com/AndreyBegma/DemoFlow/issues/173)
Depends on: nothing

## Summary

This test fails intermittently on `execution-plane (macos-latest)` and passes
on a rerun:

- file: `packages/engine/test/execute/mask.spec.ts`
- suite: `mask visibility`
- test: "ends both intervals where the page hid the field: display none,
  shown, hidden again"

It failed on #170 (97 ms against a bound of ≤ 50) and on #172, a version bump
(84 ms). Neither PR touches masking. The test came with the #155 fix (e748964).

## Decisions

1. **Diagnose first.** This is a bug whose root cause is not proven. Find out
   which of these it is:
   - the 50 ms wall-clock margin is wrong for a loaded CI VM;
   - the engine really ends the mask interval late on macOS.

   Record what you measured in the PR body.
2. **If the bound is wrong**, assert what the mask guarantees instead of a
   wall-clock margin. For example, the interval ends at or before the frame
   where the field is hidden, or relative to the page's own hide timestamp.
   Raising the number alone is not a fix.
3. **If the engine is late**, fix the engine. The test stays as it is.
4. **No quarantine.** Do not skip the test and do not retry it.

## Acceptance criteria

- The PR names the root cause and the evidence for it.
- `execution-plane (macos-latest)` passes the test in 10 consecutive runs. A
  loop of the single test inside one CI job is acceptable evidence.
- `bun run check`, `bun run test` and `bun run build` are green, and so is the
  execution-plane matrix.

## Open questions

None.

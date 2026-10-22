# Runner log rotation test flakes on Windows CI

Issue: [#219](https://github.com/AndreyBegma/DemoFlow/issues/219)
Depends on: nothing

## Summary

This test fails intermittently on `execution-plane (windows-latest)` and passes
on a rerun:

- file: `apps/cli/test/runner/files.spec.ts`
- suite: `runner logs`
- test: "prints the log, and follows it across a rotation"

It failed on #214, which does not touch the CLI:
`expected '…info first\n…' to contain 'third'`. The spec was last changed by
#192 (d370174) and e53399c.

## Decisions

1. **Diagnose first.** The root cause is not proven. Find out which it is:
   - the test waits on wall-clock time while the follower polls;
   - the follower really misses a line written right after a rotation on
     Windows (rename semantics, an open handle, or a size check that misreads
     the new file).

   Record what you measured in the PR body.
2. **If the follower loses lines**, fix it in `apps/cli/src/runner/`. The test
   stays as it is.
3. **If the test is racing**, it waits on the follower's own observable state
   (the line appearing in its output), not on a fixed sleep.
4. **No quarantine.** Do not skip the test and do not retry it.

## Acceptance criteria

- The PR names the root cause and the evidence for it.
- `execution-plane (windows-latest)` passes the test in 10 consecutive runs. A
  loop of the single test inside one CI job is acceptable evidence; the loop is
  removed before the PR is ready.
- `bun run check`, `bun run test` and `bun run build` are green, and so is the
  execution-plane matrix.

## Open questions

None.

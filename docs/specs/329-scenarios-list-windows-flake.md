# `scenarios.list` truncation test times out on the Windows runner

Issue: [#329](https://github.com/AndreyBegma/DemoFlow/issues/329)
Depends on: nothing

## Summary

`apps/cli/test/runner/launch.spec.ts` › `scenarios.list` › "keeps the first
100 and says it truncated" writes `LIST_MAX_SCENARIOS + 5` (105) scenario
files, sends a `scenarios.list` request and waits for the answer through the
file's `answered()` helper, which calls `vi.waitFor` with its default
1000 ms timeout. On GitHub's `execution-plane (windows-latest)` job, listing
and parsing 105 files sometimes takes longer, and the test fails with
`AssertionError: expected 0 to be greater than or equal to 1` (release PR
#324, runs 40101132839 and 40104189779). It passes on rerun, and on Linux and
macOS.

## Scope

- `answered(count = 1, timeout?)` passes `{ timeout }` to `vi.waitFor` when
  given.
- The 105-file test calls `answered(1, 10_000)`.

### Out of scope

- The daemon's listing code. Its behaviour is correct; only the test's wait is
  too short for a slow filesystem.
- Other `vi.waitFor` calls in the file.

## Decisions

1. **Raise the wait for this one test, not globally.** *Why:* only this test
   does 105 file writes and parses; a global timeout would hide real hangs in
   the other cases.
2. **10 s.** *Why:* an order of magnitude over the observed ~1.2 s, well
   inside Vitest's per-test timeout.

## Acceptance criteria

- [ ] `answered()` accepts an optional timeout; every other caller is
      unchanged.
- [ ] The truncation test waits up to 10 s.
- [ ] No production code changes; no test is skipped.
- [ ] The execution-plane matrix is green on all three OSes.

## Touches

- `apps/cli/test/runner/launch.spec.ts`

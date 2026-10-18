# `demoflow record` must not capture an extra step on a slow runner

Issue: [#103](https://github.com/AndreyBegma/DemoFlow/issues/103) · bug · medium ·
Builds on: spec [79](79-demoflow-record.md)

## Summary

`apps/cli/test/record/record.spec.ts` › "records navigate, click, typing and a
picked heading into a scenario that runs and passes" recorded five steps
instead of four on `macos-latest` (run 39157766840, attempt 5) and passed on
every other run [Confirmed]. A recorder that adds steps under load produces
scenarios a person did not perform.

## Scope

### In scope

- Make the test print the recorded steps on a mismatch.
- Find the extra step (reproduce on CI with re-runs; locally with CPU
  throttling if it helps) and fix the capture rule in
  `apps/cli/src/record/**` — not the assertion.

### Out of scope

- New record features.

## Decisions

1. **Fix the rule, keep the assertion exact.** — orchestrator (owner delegated).

## Acceptance criteria

- [ ] The extra step is named in the PR with the failing run's printed steps.
- [ ] A unit test reproduces the cause deterministically (e.g. a delayed
      navigation or a split input event fed to `steps.ts`) and passes with the fix.
- [ ] `record.spec.ts` passes on all three OSes in five consecutive runs of the
      same commit (run ids in the PR).
- [ ] `bun run check` passes; Woodpecker green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i103 | the capture rule | apps/cli/src/record/**, apps/cli/test/record/** | — | yes | opus |

`opus`: the cause is unproven.

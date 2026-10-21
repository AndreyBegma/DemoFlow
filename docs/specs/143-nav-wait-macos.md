# Navigation wait still misses a submit on loaded macOS runners

Issue: [#143](https://github.com/AndreyBegma/DemoFlow/issues/143) · bug ·
Follows [117](117-late-navigation-wait.md) (PR #132)

## Summary

#117 replaced the fixed 100 ms navigation window after `click` / `press` with
a `navigate`-event probe and a wait for the commit. On loaded macOS runners two
engine tests still fail, and they fail on pull requests that do not touch the
engine (PR #142, `apps/cli` only). So the execution-plane check is red for
every pull request that runs it. This slice finds the root cause and fixes it.
The fix lands either in the probe or in a test whose bound is wrong for a
loaded runner, and the spec does not presume which.

## Evidence

All of it is from `execution-plane (macos-latest)` on PR #142, 2026-10-21.

| Run / job | Test | Failure |
|---|---|---|
| 39590100279 / 119188627361 | `press.spec.ts:147`, "waits for the navigation a submit starts, as a click does" | URL `…/form`, expected `/results?q=nav` |
| same | `pending-navigation.spec.ts:159`, "a pushState route change and a click that changes nothing add no wait" | 1900 ms ≥ 1500 ms |
| re-run, job 119194268668 | `pending-navigation.spec.ts:159` | 1586 ms ≥ 1500 ms |

Ubuntu and Windows were green in both runs. PR #132 was green on macOS when
it merged.

## Scope

### In scope

- Diagnosis on a loaded runner, using the method #114's worker used:
  CPU burners on most cores, then repeated runs of `press.spec` and
  `pending-navigation.spec`, timing each step against the probe's events.
  Measure where the 1.5–1.9 s goes on a step that does not navigate, and why
  a submit's navigation is missed.
- The fix in `packages/engine/src/execute/**`, its tests, or both.

### Out of scope

- Any change to the step contract, the timeline schema or the renderer.

## Decisions

1. **The root cause comes first, then the fix.** (orchestrator) The PR states
   which of these it is, with measurements:
   - a real defect: the probe misses an event, or a step that does not
     navigate waits too long;
   - a test bound that does not hold on a loaded runner.
2. **No silent loosening.** (orchestrator) A bound may change only when the
   measurement shows that the time is not spent in DemoFlow's wait. For
   example, Playwright's own click on a loaded runner. The new bound comes
   with the measured distribution.
3. **Steps that do not navigate gain no wait.** (spec 117's default, kept)

## Acceptance criteria

- [ ] The PR names the root cause of each failure, with timings from a loaded
      local run (before and after).
- [ ] `press.spec` and `pending-navigation.spec` pass 30 times in a row with
      most cores busy, on Linux locally, and twice in a row on the
      `execution-plane` matrix (macOS, Windows, ubuntu). The second CI run is
      a re-run of the same commit.
- [ ] A step that does not navigate takes no longer than on `develop` today
      (median and p95 from the loaded runs, in the PR).
- [ ] No acceptance criterion of #117 is weakened. Its busy-wait tests still
      pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i143 | the navigation wait | packages/engine/** | — | yes | opus |

One slot. It is `opus` because the root cause is not proven.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/engine/** | i143 | do not open |

## Risks

- **A fix that hides the race behind a longer wait** (medium). Mitigation:
  Decision 2, and the no-added-wait criterion with measured numbers.

## Open questions

- None. Default: keep #117's behaviour and change only what the measurement
  proves wrong.

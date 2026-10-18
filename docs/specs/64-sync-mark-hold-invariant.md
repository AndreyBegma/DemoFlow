# Engine — the sync mark's recorded hold is never shorter than its hold

Issue: [#64](https://github.com/AndreyBegma/DemoFlow/issues/64) · bug · medium ·
Builds on: [spec 48](48-sync-mark-reliability.md)

## Summary

On Ubuntu CI (PR #61, run 39137427988 attempt 3) the engine recorded
`offMs − onMs` = 394.74 ms although the page holds the mark until its
`requestAnimationFrame` timestamps are ≥ `SYNC_MARK_HOLD_MS` (400 ms) apart
(`packages/engine/src/execute/sync-mark.ts`) [Confirmed]. The recorded edges
therefore do not come from the same timestamps, or the same page→engine
mapping, as the hold check. The test tolerates 5 ms and still failed.

## Scope

### In scope

- Find which timestamps differ and make `onMs` / `offMs` the very timestamps
  the hold loop compares, mapped with one exchange.
- Tighten the test to `offMs − onMs ≥ SYNC_MARK_HOLD_MS` (no slack).

### Out of scope

- The hold length, the clock mapping method (#48), the drift reference (#62).

## Decisions

1. **Invariant by construction, not tolerance.** — orchestrator (owner delegated).

## Acceptance criteria

- [ ] The PR names which timestamps differed, with code and a log line.
- [ ] `offMs − onMs ≥ SYNC_MARK_HOLD_MS` by construction; the test asserts it
      without slack.
- [ ] `execution-plane` green on all three OSes in three consecutive runs (a run
      red only on #62's offset test is re-run and not counted).
- [ ] `bun run check` passes; Woodpecker green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i64 | the hold invariant | packages/engine/src/execute/sync-mark.ts, packages/engine/test/execute/** | — | yes | sonnet |

One slot. `sonnet`: the rule is written here; the diagnosis is local reading
of one module.

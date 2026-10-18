# MCP — a task is terminal only after its staged inline scenario is removed

Issue: [#92](https://github.com/AndreyBegma/DemoFlow/issues/92) · bug · medium ·
Builds on: [spec 68](68-mcp-generate-poll-cancel.md) (Decision 5 as amended in #78)

## Summary

`apps/cli/test/mcp/server.spec.ts` › "runs an inline scenario, writing only
under the home" fails intermittently — on macOS (release PR #89) and Ubuntu
(PR #93): the staged inline scenario `<home>/mcp/<taskId>.demo.json` still
exists when `get_task` already reports a terminal status [Confirmed]. The task
becomes terminal when the child exits, while the staged file is deleted
afterwards, so a client can observe a finished task whose staging is not yet
cleaned up.

## Scope

### In scope

- The task's terminal status (completed, failed, cancelled, timed_out) is set
  only after the staged file's deletion has finished (or failed — a failed
  unlink is logged on stderr and does not change the task's status).
- A unit test with an injected slow unlink proving the order.

### Out of scope

- Any other MCP behaviour.

## Decisions

1. **Order, not retries**: the fix is the ordering in the queue; the test is
   not given a wait loop. — orchestrator (owner delegated).

## Acceptance criteria

- [ ] A `TaskQueue` unit test: with an unlink that resolves after 200 ms,
      `get_task` reports `running` until the unlink resolves, then `completed`.
- [ ] A failed unlink logs one stderr line and the task still completes.
- [ ] `server.spec.ts` "runs an inline scenario…" passes on all three OSes in
      five consecutive runs of the same commit (run ids in the PR).
- [ ] `bun run check` passes; Woodpecker green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i92 | the cleanup order | apps/cli/src/mcp/**, apps/cli/test/mcp/** | — | yes | sonnet |

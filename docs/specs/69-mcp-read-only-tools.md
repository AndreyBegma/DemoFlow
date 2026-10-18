# MCP — validate scenarios, list demos, check the project

Issue: [#69](https://github.com/AndreyBegma/DemoFlow/issues/69) · Phase 3 (MCP integration), second slice ·
Builds on: [spec 68](68-mcp-generate-poll-cancel.md)

Depends on #68

## Summary

With #68 an agent can start, poll and cancel a demo. This slice adds the
read-only operations from vision §3.3 that make an agent effective without
trial runs: validate a scenario before queueing it, list recent demos, and
check whether a project is ready to run demos.

## Scope

### In scope

- `validate_scenario`: `{ project?, scenario? | file? }` → `{ valid: true }` or
  the same `invalid-scenario` error shape as #68, without running anything.
- `list_demos`: `{ project?, limit? (default 20, max 100) }` → recent runs from
  `<home>/runs/*/result.json`, newest first: `{ taskId, scenarioName, status,
  startedAt, durationMs?, video? }`. Runs whose `result.json` is missing or
  invalid are skipped.
- `check_project`: `{ project? }` → `{ root, configValid, scenarios: string[]
  (the `demoflow/**/*.demo.json` files), ffmpeg: 'system' | 'bundled' | 'missing',
  browser: 'installed' | 'missing' }`.

### Out of scope

- Writing scenario files into the repository; any website reference (Phase 5).

## Decisions

1. **Read-only**: none of these tools starts a browser or writes a file. —
   orchestrator (owner delegated), following the #68 interview's split.
2. **Same error shape and project resolution as #68.** — spec 68.

## Acceptance criteria

- [ ] The server lists six tools (three from #68, three here) with input schemas.
- [ ] `validate_scenario` returns `valid: true` for every fixture scenario and
      the zod issue paths for a broken one; it starts no process.
- [ ] `list_demos` returns runs newest first, honours `limit`, skips a corrupt
      `result.json`, and lists only runs of the given project's home.
- [ ] `check_project` reports the fixture's scenarios and the FFmpeg/browser
      availability; a directory without `demoflow.config.json` is
      `project-not-found`.
- [ ] Tests under Node with Vitest on all three OSes; `bun run check` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i69 | the three read-only tools | apps/cli/src/mcp/**, apps/cli/test/mcp/** | #68 | yes | sonnet |

One slot. `sonnet`: shapes and behaviour are written here.

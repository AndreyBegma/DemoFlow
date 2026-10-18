# MCP — generate, poll and cancel a demo

Issue: [#68](https://github.com/AndreyBegma/DemoFlow/issues/68) · Phase 3 (MCP integration), first slice ·
Decisions: [ADR-0001](../adr/0001-control-plane-execution-plane-one-package.md) (`demoflow mcp` is a stdio subcommand),
[ADR-0003](../adr/0003-scenario-format-and-project-config.md) (the scenario schema is the MCP input schema),
[ADR-0008](../adr/0008-cloud-boundary.md) (MCP works without an account; commands only from local config)

## Summary

Claude Code and other MCP clients can generate a demo today only by shelling
out to `demoflow run`. This item adds `demoflow mcp`, a local stdio MCP server
(vision §3.3) with three tools: start a demo (returns a task ID at once), read
a task's status and result (optionally waiting up to 60 s), and cancel a task.
Runs execute one at a time in a child `demoflow run --json` process, so a
browser or encoder failure never takes the server down, and finished tasks are
read back from their run directories after a restart. No account and no
website are involved (ADR-0008 §1).

## Scope

### In scope

- `demoflow mcp`: stdio MCP server built on the official
  `@modelcontextprotocol/sdk` (pinned exactly, per project rules).
- Tools `generate_demo`, `get_task`, `cancel_task` (below).
- A hidden `--run-id <id>` option on `demoflow run`, so the task ID is known
  before the child starts (the run directory is `<home>/runs/<runId>/`, spec 5).
- An in-memory FIFO queue, one running task at a time; a per-task timeout.
- Registration instructions in the CLI's `--help` for `mcp`
  (`claude mcp add demoflow -- npx demoflow mcp`).

### Out of scope

- `validate_scenario`, `list_demos`, project availability — #69.
- A project registry; the website page reference for a video (Phase 5).
- Parallel runs.

## Decisions

All by the owner in the #68 interview (2026-10-18) unless noted.

1. **First slice = start, status, cancel.** The other operations of vision
   §3.3 follow in #69.
2. **The project is a path.** A tool argument `project` (absolute path); when
   absent, the server's working directory. The project root is found exactly
   as the CLI finds it (`findProjectRoot`, `demoflow.config.json`). No registry.
3. **A task runs in a child process**: `demoflow run <scenario> --json
   --run-id <taskId>` via `process.execPath` and the CLI's own entry point.
   Status comes from the child's exit and the run directory's `result.json`.
4. **One task at a time.** Further tasks wait as `queued` (FIFO).
5. **The scenario is a file or inline.** `scenario` (an object, validated
   against `ScenarioSchema` from `@demoflow/core` before queueing) **or** `file`
   (a path to a `*.demo.json` inside the project). An inline scenario is written
   to `<runDir>/scenario.demo.json` and run from there; nothing is written into
   the repository. Starting the app, `baseUrl` and allowed origins come only
   from the project's `demoflow.config.json` (ADR-0008 §4) — the tool takes no
   command or URL.
6. **`get_task` can wait**: optional `waitSeconds` (0–60, default 0) holds the
   reply until the task reaches a terminal status or the wait ends.
7. **Timeout**: 15 minutes per task by default; `generate_demo` accepts
   `timeoutMinutes` (1–60). On expiry the child is killed and the task is
   `timed_out`.
8. **Restart**: task ID = run ID. A finished task is read back from
   `<home>/runs/<taskId>/result.json` after the server restarts. Queued and
   running tasks die with the server: on shutdown (stdin closed, SIGINT,
   SIGTERM) the server kills its child and exits — no orphans (cf. #31).
9. **Errors are structured for an agent**: every tool error is
   `{ code, message, hint }`; scenario validation errors carry the zod issue
   paths. — orchestrator.
10. **SDK**: `@modelcontextprotocol/sdk`, the official TypeScript SDK. —
    orchestrator.

## API (MCP tools)

`generate_demo`
- input: `{ project?: string, scenario?: Scenario, file?: string, timeoutMinutes?: number }`
  — exactly one of `scenario` / `file`.
- output: `{ taskId: string, status: 'queued' | 'running', position: number }`.

`get_task`
- input: `{ taskId: string, waitSeconds?: number }`.
- output: `{ taskId, status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out', stages?: Stages, failedStep?: { stepIndex, message }, artifacts?: { video?: string, timeline?: string, source?: string, runDir: string } }`
  — `stages` and `failedStep` from `result.json` (`RunResultSchema`); paths are
  absolute local paths (the client is the local OS user, ADR-0008 §1).

`cancel_task`
- input: `{ taskId: string }`.
- output: `{ taskId, status }` — a queued task is removed; a running task's child
  is killed and the task becomes `cancelled`; a finished task is unchanged.

Error codes (minimum): `project-not-found`, `invalid-project-config`,
`invalid-scenario`, `file-not-in-project`, `task-not-found`,
`both-or-neither-scenario`.

## Acceptance criteria

- [ ] `demoflow mcp` speaks MCP over stdio: a test client (the SDK's client
      over an in-memory or stdio transport) lists exactly the three tools with
      their input schemas.
- [ ] `generate_demo` with the fixture's `customers.demo.json` returns a task
      ID immediately; `get_task` with `waitSeconds` eventually returns
      `completed` with an existing MP4 at `artifacts.video`.
- [ ] An inline scenario runs the same way and is written only under the run
      directory (the project tree is unchanged — test checks `git status`-style
      file listing before/after).
- [ ] Two tasks submitted back to back: the second is `queued` while the first
      runs, then completes; they never run at the same time.
- [ ] `cancel_task` on a running task kills its child (the process is gone) and
      reports `cancelled`; on a queued task it never starts.
- [ ] A task exceeding `timeoutMinutes` (test uses a tiny value against a slow
      scenario) is `timed_out` and its child is gone.
- [ ] After restarting the server, `get_task` on a finished task returns the
      same result from disk; on shutdown no child process remains.
- [ ] Invalid input returns `{ code, message, hint }`: an invalid inline
      scenario lists zod issue paths; a `file` outside the project is
      `file-not-in-project`.
- [ ] `demoflow run --run-id <id>` writes to `<home>/runs/<id>/`; without it,
      behaviour is unchanged (existing CLI tests pass).
- [ ] Tests under Node with Vitest on all three OSes; `bun run check` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i68-cli | the `--run-id` option | apps/cli/src/commands/run.ts, apps/cli/src/main.ts, apps/cli/test/commands/** | — | yes | sonnet |
| i68-mcp | the MCP server, queue, tools | apps/cli/src/mcp/**, apps/cli/test/mcp/**, apps/cli/package.json, bun.lock | i68-cli | no | opus |

`i68-mcp` is `opus`: the first MCP module in the repository, with process
lifecycle and queue semantics to get right. It also registers the `mcp`
subcommand in `apps/cli/src/main.ts` — that file is handed over once i68-cli
merges.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/cli/src/main.ts | i68-cli, then i68-mcp after it merges | — |
| apps/cli/package.json, bun.lock | i68-mcp (the SDK dependency) | — |

## Risks

- **Orphaned children** (high — #31 showed how they accumulate). Mitigation:
  kill on every shutdown path; an acceptance test.
- **An agent waits forever** (medium). Mitigation: `waitSeconds` capped at 60;
  per-task timeout.
- **Scenario injection** (medium): an inline scenario cannot run a command or
  reach a non-allowed origin — the engine's origin guard and ADR-0008 §4 apply
  unchanged.

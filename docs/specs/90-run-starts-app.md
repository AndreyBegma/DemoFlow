# `demoflow run` starts the application from `devCommand`

Issue: [#90](https://github.com/AndreyBegma/DemoFlow/issues/90) · feature ·
Decisions: [ADR-0003](../adr/0003-scenario-format-and-project-config.md) (`devCommand`, `readyUrl`),
[ADR-0008](../adr/0008-cloud-boundary.md) §4 (commands only from local config), spec [79](79-demoflow-record.md) (amended: the shared `startApp`)

## Summary

`demoflow run` — and therefore the MCP `generate_demo`, which runs it — never
starts the application: nobody read `devCommand` at run time until `demoflow
record` (#79) added `startApp()` in `apps/cli/src/app/dev-server.ts`
[Confirmed]. A person or an agent has to start the dev server by hand before
every run. This item makes `run` use `startApp()`.

## Scope

### In scope

- `runCommand` starts the app through `startApp(config, root)` after every
  input check and before the engine (and before `ensureChromium`'s download is
  awaited — they may overlap), and stops it after the run, on every exit path
  (success, failure, exception, SIGINT/SIGTERM).
- When `readyUrl` already answers, or `devCommand` is absent, nothing is
  started (the shared module's existing behaviour).
- A start that does not become ready within its timeout fails the `readiness`
  stage with the command's last output lines (at most 20) in the stage error.
  The `result.json` contract (spec 5) is unchanged.

### Out of scope

- Changes to `startApp()`'s own behaviour beyond what `run` needs (report it if
  needed).

## Decisions

1. **`run` and `record` share one implementation.** — orchestrator (owner
   delegated), following the #79 amendment.
2. **The app's output is not mixed into `--json` stdout**; it goes to stderr
   only when the start fails. — orchestrator.

## Acceptance criteria

- [ ] With `devCommand` set and the app not running, `demoflow run` starts it,
      waits for `readyUrl`, runs, and stops the process tree afterwards — on
      Linux, macOS and Windows (test with the fixture app's dev command).
- [ ] With the app already answering at `readyUrl`, nothing is started (the test
      asserts no child process).
- [ ] A dev command that never becomes ready fails `readiness` with its last
      output lines, exit code per spec 5, and no process left behind.
- [ ] `--json` stdout stays exactly one JSON object.
- [ ] `bun run check` passes; Woodpecker and all three OSes green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i90 | wiring `startApp` into `run` | apps/cli/src/commands/**, apps/cli/src/app/**, apps/cli/test/commands/**, apps/cli/test/app/** | — | yes | sonnet |

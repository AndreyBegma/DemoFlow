# CLI — `demoflow run` and `demoflow validate`

Issue: [#5](https://github.com/AndreyBegma/DemoFlow/issues/5) · Phase 1 ·
Decisions: [ADR-0001](../adr/0001-control-plane-execution-plane-one-package.md),
[ADR-0003](../adr/0003-scenario-format-and-project-config.md),
[ADR-0004](../adr/0004-recording-is-separate-from-rendering.md),
[ADR-0008](../adr/0008-cloud-boundary.md)

Depends on #3
Depends on #4

## Summary

The Phase 1 deliverable is "a short technical prototype that produces a
credible demo video". This item makes it one command: `demoflow run
<scenario>` validates the scenario, loads the project config, resolves where
artifacts go, runs the engine and the renderer(s), and prints where the video
is — for a person, or as JSON for an agent. It creates `apps/cli`, the package
later published as `demoflow`.

## Scope

### In scope

- `apps/cli`, package name `demoflow`, `bin: { demoflow: dist/main.js }`,
  ESM, Node ≥ 20, Vitest. Argument parsing with `commander` (pinned).
- `demoflow validate <scenario.demo.json>` and `demoflow run
  <scenario.demo.json>`.
- Project root discovery, `demoflow.config.json` loading, home and global
  config resolution (ADR-0004 §7) on Linux, macOS and Windows.

### Out of scope

- `login`, `runner`, `mcp`, `project add` (Phase 2–5), starting a dev server,
  npm publishing.

## Decisions

- **Project root**: the nearest ancestor of the scenario file containing
  `demoflow.config.json`; none → exit 2 `no-project-config`. The scenario id
  is its path relative to that root, with `/` separators on every OS.
- **Home** resolution, first hit wins: `--out <dir>`, `DEMOFLOW_HOME`,
  `artifactsDir` in the project config (relative to the project root),
  `artifactsDir` in the global config, the OS data directory. Global config:
  `$XDG_CONFIG_HOME/demoflow/config.json` or `~/.config/demoflow/config.json`;
  `~/Library/Application Support/demoflow/config.json`;
  `%APPDATA%\demoflow\config.json`. The run directory is
  `<home>/runs/<runId>/`.
- **`run` options**: `--base-url <url>` (overrides the config, still checked
  against `allowedOrigins`), `--out <dir>`, `--headed`, `--json`. There is no
  `--renderer` option: the FFmpeg compositor is the only renderer (ADR-0005,
  accepted 2026-10-17).
- **Output**: by default a short human summary (stage statuses, video paths);
  with `--json`, exactly one JSON object on stdout — the final `result.json`
  plus `runDir` — and nothing else on stdout; progress goes to stderr.
- **Exit codes**: `0` completed (with or without warnings), `1` verification
  or execution failed, `2` invalid input (schema, config, origin, missing
  env), `3` any other stage failed (recording, rendering, storage).
- **Environment for `valueFrom`**: the process environment only.

## Acceptance criteria

- [ ] `bun run --filter demoflow test` passes under Node; `bun run check` and
      `bun run build` pass at the root.
- [ ] Home resolution has a table test per rule, per OS (paths built with the
      platform's rules, the OS faked through an injected `platform` and env).
- [ ] `demoflow validate apps/fixture/demoflow/customers.demo.json` exits 0;
      a copy with a `{ role, testId }` locator exits 2 and prints the step
      path.
- [ ] With the fixture previewing on 3680, `demoflow run
      apps/fixture/demoflow/customers.demo.json --json` exits 0, prints one
      parsable JSON object whose `status` is `completed` and whose `renders`
      lists one existing MP4 file (`render/ffmpeg.mp4`), and writes nothing else
      to stdout.
- [ ] The same for `failing.demo.json` exits 1 with `status: failed`.
- [ ] `login.demo.json` without `FIXTURE_PASSWORD` exits 2 before a browser
      starts.
- [ ] `--base-url https://example.com` exits 2 with `origin-not-allowed`.
- [ ] `apps/fixture/demoflow.config.json` exists with `baseUrl
      http://localhost:3680`.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i5-config | the package, project root, config loading, home resolution | apps/cli/package.json, apps/cli/tsconfig.json, apps/cli/vitest.config.ts, apps/cli/src/config/**, apps/cli/test/config/**, apps/fixture/demoflow.config.json, bun.lock | — | yes | sonnet |
| i5-commands | `main.ts`, `validate`, `run`, output and exit codes | apps/cli/src/main.ts, apps/cli/src/commands/**, apps/cli/test/commands/** | i5-config | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/cli/package.json, bun.lock | i5-config | the lead adds `commander` for the commands slot |

## Risks

- **Windows paths in scenario ids** (medium): normalised to `/`; covered by a
  test and by #6.

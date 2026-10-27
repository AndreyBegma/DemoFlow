# `demoflow run --check`: run and verify without recording or rendering

Issue: [#360](https://github.com/AndreyBegma/DemoFlow/issues/360)
Depends on: nothing. Decision record: [ADR-0021](../adr/0021-scheduled-checks.md).

## Summary

Phase 8 checks every demo of a project on a schedule and marks a scenario
stale when it breaks (ADR-0021). A check must not record or render: nobody
watches it, and a video a day per scenario fills the disk. Today
`demoflow run` always records, and renders whenever a video exists
(`apps/cli/src/commands/run.ts`, `execute()`) [Confirmed].

This slice adds check mode to the engine and the CLI, a check pass over a
whole project, the daemon's handling of a check pass the website starts, and
the API's acceptance of a reported check run. The schedules themselves are
specs 361 (config, daemon) and 362 (website, API).

## Scope

### In scope

- `packages/engine/src/run.ts`: a `record?: boolean` run option (default
  `true`). With `false` the recorded context is opened with
  `toContextOptions(recording, version, { video: false })`, the same option
  the off-camera context already uses (ADR-0018) [Confirmed], no sync mark is
  recorded, and the `recording` stage is `skipped`.
- `packages/engine/test/**`: its tests.
- `apps/cli/src/main.ts`, `apps/cli/src/commands/run.ts`: the `--check` and
  `--exclude` flags and the check pass (Decisions 2–4).
- `apps/cli/src/runs-report/report.ts`: `kind: 'check'` on a reported check
  run (Decision 5).
- `apps/cli/src/runner/launch/**`, `apps/cli/src/runner/connection.ts`: the
  `check.start` request and `checks: true` in `launches.sync` (Decision 6).
- `apps/cli/test/**`: their tests (Vitest under Node).
- `apps/api/prisma/schema.prisma`: `Run.kind`; migration
  `apps/api/prisma/migrations/20261026120000_run_kind/`.
- `apps/api/src/projects/projects.dto.ts` (`RunReportDto.kind`),
  `apps/api/src/projects/projects.service.ts` and
  `apps/api/src/projects/runner-runs.controller.ts`: store it and return it
  with a run.
- `apps/cli/README.md`: the flags.

### Out of scope

- Any schedule (specs 361, 362) and the stale state (spec 362).
- The website starting a check pass: the daemon side is here, the API side is
  spec 362.
- Showing check runs differently on the website (spec 363).
- An MCP tool for a check. No source asks for one; `demoflow check` and the
  MCP `check_project` stay what they are (spec 266).
- `--check` with `--format`, `--headed`: refused (Decision 2).

## Decisions

1. **The engine records nothing in check mode** (ADR-0021 §1). `runScenario`
   gets `record: false`: steps and verifications run exactly as today, in a
   context without `recordVideo`; no sync mark (`recordSyncMark` needs the
   video); `stages.recording = { status: 'skipped' }`. The timeline events
   are still written: they cost little and carry the failed step. The status
   is `deriveRunStatus(stages)` as for every run (ADR-0004 §3–4).
2. **The flag.** `demoflow run --check [scenario] [--exclude <id>]... [--json]`,
   with every existing flag except `--format` and `--headed`, which are refused
   with `CommandError` `check-flag` (exit 2) before anything runs.
   - With `<scenario>`: one check run of that file.
   - Without it: a **check pass** of every `demoflow/**/*.demo.json` under
     the project root, sorted by scenario id, minus `--exclude` ids. The
     daemon's scenario listing (`apps/cli/src/runner/launch/list.ts`) already
     walks those files with its limits (`LIST_MAX_SCENARIOS` and the others);
     the pass reuses that walk, not a second one. An `--exclude` id that is no
     scenario is ignored (a deleted scenario must not break a schedule).
   - `<scenario>` is optional only with `--check`; without it the command is
     refused as today.
3. **One application start per pass** (ADR-0021 §3). `devCommand` is started
   once before the first scenario and stopped after the last, by the same
   start/stop the single run uses. A scenario whose readiness fails does not
   stop the pass; an application that fails to start fails every scenario of
   the pass with the same readiness error, each in its own `result.json`.
4. **Results.** Each scenario has its own run directory and `result.json`,
   with `renders: []` and `rendering: skipped`, and is reported on its own
   (Decision 5), so the run library and the stale state stay per scenario.
   - Text output: one summary line per scenario, then `N passed, M failed`.
   - `--json`: one object `{ "check": true, "runs": [<the run JSON of each>] }`.
     A single-file `--check --json` prints the same shape with one entry.
   - Exit code: `0` when every run passed, the existing stage-failed code when
     any failed, `2` for a refusal.
   - `--run-id` is accepted only with a single scenario (the daemon's plumbing,
     spec 248); a pass names its run directories as `demoflow run` does.
5. **Reporting.** A check run's report is the run report of spec 178 plus
   `kind: 'check'`. Ordinary runs send no `kind`. The API takes `kind` as
   optional `@IsIn(['check'])`; `Run.kind` is a nullable column (`null` is an
   ordinary run), returned with every run the API lists or shows.
   - *Why the API change is here:* the global `ValidationPipe` has
     `forbidNonWhitelisted` (CLAUDE.md), so a CLI that sends `kind` to an API
     without the field is refused with 400 and the run is never reported. The
     API part of this slice merges first (Parallel plan).
   - *Why a column, not a flag in `stages`:* the run library and the stale
     state filter on it; a JSON field would be read in application code only.
6. **The daemon runs a check pass the website starts** (ADR-0021 §2).
   - `launches.sync` gains `checks: true` when the daemon handles launches
     (beside `runOptions`, `apps/cli/src/runner/connection.ts:185`).
   - A new server frame `check.start { requestId, rootPath, exclude: string[] }`.
     The daemon checks it like `run.start` (spec 248, Decision 3): the root is
     a key into the machine's registry, `exclude` is at most
     `LIST_MAX_SCENARIOS` strings, each a valid scenario id
     (`apps/cli/src/runner/launch/scenario-id.ts`). Any other field, or any
     invalid entry, refuses the whole request with `check.error { requestId, code }`
     and spawns nothing.
   - It spawns `run --check --json --progress --project <root>` plus
     `--exclude <id>` for each checked id, and nothing else from the message.
   - It counts as the machine's one active launch (the API's `runner-busy`,
     `apps/api/src/launches/launches.service.ts`) and answers
     `check.started { requestId }` and `check.finished { requestId, passed, failed }`
     (counts). Cancel is the existing launch cancel with the same `requestId`.
   - The 15-minute launch cap (spec 248, Decision 9) applies per scenario, not
     per pass; the pass as a whole is capped at 2 hours.

## Data / Schema

```prisma
enum RunKind {
  check
}

model Run {
  // …
  // Spec 360: `check` for a run made with `demoflow run --check`; null otherwise.
  kind RunKind?
}
```

Migration `20261026120000_run_kind`: `CREATE TYPE "RunKind"` and
`ALTER TABLE "Run" ADD COLUMN "kind" "RunKind"`. No backfill.

## API

- `POST /runner/runs` (`RunReportDto`): optional `kind: 'check'`.
- Every response that carries a run (the project's runs list, the run page's
  details) gains `kind: 'check' | null`.

## Configuration

None. Check mode reads the same `demoflow.config.json`.

## Acceptance criteria

- [ ] `demoflow run --check demoflow/customers.demo.json` on the fixture passes,
      writes `result.json` with `recording: skipped`, `rendering: skipped`,
      `renders: []`, and leaves no video file in the run directory.
- [ ] The fixture's `failing` scenario under `--check` exits with the
      stage-failed code and its `result.json` has `verification: failed`.
- [ ] `demoflow run --check` with no scenario runs every fixture scenario, starts
      the application once (asserted through the start hook in tests), and
      prints one line per scenario and the totals.
- [ ] `--exclude login.demo.json` leaves that scenario out; an unknown id is ignored.
- [ ] `--check --format gif` and `--check --headed` are refused with exit 2
      and write nothing.
- [ ] A reported check run arrives with `kind: 'check'` and the API stores it;
      an ordinary run is stored with `kind = null`; a report with
      `kind: 'video'` is refused with 400.
- [ ] The daemon sends `checks: true` in `launches.sync`; a `check.start` with
      an unregistered root, an extra field or an invalid exclude id is
      refused with `check.error` and spawns nothing (unit test on the spawn
      fake).
- [ ] A valid `check.start` spawns exactly
      `run --check --json --progress --project <root> [--exclude <id>]...`.
- [ ] The engine, CLI and package-smoke suites pass on Linux, macOS and Windows.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i360-api | `Run.kind`, the migration, the report DTO | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261026120000_run_kind/**, apps/api/src/projects/** | — | yes | sonnet |
| i360-engine | `record: false` | packages/engine/src/run.ts, packages/engine/test/** | — | yes | sonnet |
| i360-cli | `--check`, the pass, the report's `kind` | apps/cli/src/main.ts, apps/cli/src/commands/run.ts, apps/cli/src/runs-report/report.ts, apps/cli/test/commands/**, apps/cli/test/runs-report/**, apps/cli/README.md | i360-engine, i360-api | no | opus |
| i360-daemon | `check.start`, `checks` in `launches.sync` | apps/cli/src/runner/launch/**, apps/cli/src/runner/connection.ts, apps/cli/test/runner/** | i360-cli | no | sonnet |

`i360-cli` is `opus`: the pass's handling of one application across several
runs (Decision 3) has to be fitted into `runCommand`'s start/stop and signal
handling, which this spec does not lay out line by line.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i360-api | do not open it (spec 362 adds its own tables after this merges) |
| apps/cli/src/runner/connection.ts | i360-daemon | do not open it |
| apps/cli/src/commands/run.ts | i360-cli | do not open it |

## Risks

- **Medium — the name.** `demoflow check` (spec 266) is the project check and
  `demoflow run --check` is a check run. Mitigation: the help text of both
  says what each does; the website and docs call this a "check run" and the
  pass a "check pass".
- **Medium — a pass that hangs.** One stuck scenario holds the machine's only
  launch slot. Mitigation: the per-scenario 15-minute cap and the 2-hour pass
  cap; the cancel path is the existing one.
- **Low — timing without video.** Some steps wait on the video clock today
  [Unknown]. Mitigation: the engine tests run the fixture scenarios with
  `record: false` on all three OS.

## Open questions

- Should a check pass stop at the first failure? Default: no, every scenario
  runs, so the stale state is complete.

Depends on nothing.

# `schedule` in `demoflow.config.json`: the runner daemon runs check passes on a schedule

Issue: [#361](https://github.com/AndreyBegma/DemoFlow/issues/361)
Depends on: #360 (`demoflow run --check` and the check pass). Decision record: [ADR-0021](../adr/0021-scheduled-checks.md).

## Summary

A team that commits its demos wants them checked without anyone remembering
to (ADR-0021). This slice adds a `schedule` block to the project config and a
scheduler inside the runner daemon that runs a check pass (spec 360) of the
project at the due time, with one catch-up pass after the machine was off or
asleep. It works without an account. When the machine is paired, the daemon
tells the website which schedule each project has, so the project page can
show it read-only (spec 363); the results reach the website as ordinary run
reports with `kind: 'check'` (spec 360).

## Scope

### In scope

- `packages/core/src/project-config.ts`: `ScheduleConfigSchema` and the
  optional `schedule` key of `ProjectConfigSchema`; `packages/core/src/index.ts`
  exports; `packages/core/schemas/project-config.schema.json` regenerated
  (`packages/core/scripts/generate-schemas.ts`); `packages/core/test/**`.
- `packages/core/src/schedule.ts` (new): `lastDueSlot(schedule, now, zone)`,
  pure, no Node APIs (ADR-0001).
- `apps/cli/src/runner/schedule/**` (new): the scheduler, its state file and
  the roots it watches.
- `apps/cli/src/runner/daemon.ts`: start the scheduler; the local mode
  (Decision 5).
- `apps/cli/src/commands/run.ts`: record the run's root in the local roots
  file (Decision 4) — one call, after the run directory is created.
- `apps/cli/src/runner/connection.ts`: send `schedules.sync` (Decision 6).
- `apps/cli/src/runner/command.ts`: `demoflow runner status` prints each
  scheduled project's next and last check.
- `apps/cli/test/**`, `apps/cli/README.md`.

### Out of scope

- The API storing `schedules.sync` and showing it: specs 362 and 363. The API
  ignores an unknown frame type until then (`parseClientMessage`,
  `apps/api/src/runner/runner-socket.ts`) [Confirmed], so this slice can merge
  first.
- Website schedules (spec 362).
- Desktop notifications. The owner chose site-only alerts; locally the result
  is in `demoflow runs` and the daemon log.

## Decisions

1. **The config shape** (ADR-0021 §5; owner, 2026-10-26: presets and a time).

   ```json
   "schedule": {
     "cadence": "weekdays",
     "at": "09:30",
     "exclude": ["demoflow/wip.demo.json"]
   }
   ```

   - `cadence`: `daily` | `weekdays` (Monday–Friday) | `weekly`.
   - `weekday`: `mon`…`sun`, required with `weekly`, refused otherwise.
   - `at`: `HH:MM`, 24-hour, machine-local time.
   - `exclude`: optional, scenario ids relative to the root, at most 100.
   - A strict object: any other key is a config error, like every config block.
   - No time zone in the file: a committed schedule means "09:30 wherever
     this machine is". The daemon reports its zone name to the website
     (Decision 6).
2. **Due slots.** `lastDueSlot(schedule, now, zone)` returns the latest slot
   at or before `now`. A pass is due when that slot is later than the last
   pass's start for this root. One pass per due slot; a machine that missed
   several slots runs **one** pass (ADR-0021 §5, owner: one catch-up run).
   DST: a local time that does not exist that day runs at the next valid
   minute; one that repeats runs once.
3. **The scheduler** ticks once a minute and on daemon start. For each
   watched root (Decision 4) it loads the config with `loadProjectConfig`; a
   root without `schedule`, or whose config fails to load, is skipped and the
   failure logged once per change. A due pass is queued; passes run one at a
   time, and never while a website-started launch runs (the daemon's one
   launch slot, spec 248). It spawns
   `run --check --json --project <root> [--exclude <id>]...` through the same
   `SpawnRun` as launches. The state file
   `<runner dir>/schedule.state.json` keeps, per root, the last pass's start
   and its counts; it is written before the spawn so a crash does not repeat
   the slot.
   - *Why a minute:* the cadence is daily at most; a minute is the precision
     the person sets.
   - *Wake from sleep:* a tick after a sleep sees a missed slot and runs the
     one catch-up pass; no OS wake API is needed.
4. **Which projects it watches.** The union of the registry of reported roots
   (`knownRoots`, `apps/cli/src/runs-report/reported-runs.ts`) [Confirmed] and
   a new local file `<runner dir>/local-roots.jsonl` that every `demoflow run`
   appends its canonical root to, deduplicated, last 500 lines.
   - *Why a second file:* the registry is written only when a report reached
     the server, and a machine without an account reports nothing; its
     schedules would never fire. A root in `local-roots.jsonl` is only ever
     used to run that root's own committed config locally, so it adds no
     power to the website (ADR-0016 §2 still keys website requests on the
     reported registry only).
5. **Local mode** (owner: works without login). Today `runForeground` exits
   with `EXIT_DAEMON_NOT_LOGGED_IN` without credentials
   (`apps/cli/src/runner/daemon.ts:67`) [Confirmed]. With no credentials and
   at least one watched root that has a `schedule`, the daemon runs the
   scheduler only: no socket, no relay, no launches. `runner status` says
   "local mode: scheduled checks only". Without credentials and with no
   schedule anywhere it exits as today. `demoflow login` later and a daemon
   restart switch it to the full mode.
6. **`schedules.sync`** (ADR-0021 §7). When connected, after `launches.sync`
   and whenever a watched root's schedule changes (checked on the tick), the
   daemon sends
   `{ type: 'schedules.sync', zone: <IANA name>, projects: [{ rootPath, schedule | null }] }`
   for the roots of the **reported registry only** (Decision 4's local-only
   roots are not sent). `schedule` is the parsed block of Decision 1 or `null`
   when the root's config has none. Nothing else from the config crosses.
7. **Reporting** is unchanged: each check run of a pass is reported by the
   `demoflow run` child with `kind: 'check'` (spec 360). Reporting off
   (`CI`, `DEMOFLOW_NO_REPORT=1`) keeps them local, as for any run.

## Configuration

`demoflow.config.json`: the `schedule` block of Decision 1. The website's
config docs (spec 364) and `apps/cli/README.md` describe it.

## Acceptance criteria

- [ ] `ProjectConfigSchema` accepts the three cadences, refuses `weekly`
      without `weekday`, `weekday` with `daily`, `at: "9:30"`, `at: "24:00"`
      and an unknown key; the regenerated JSON schema matches.
- [ ] `lastDueSlot` is right for daily, weekdays across a weekend, weekly,
      and both DST transitions in `Europe/Berlin` and `America/New_York`.
- [ ] With a fake clock, a daemon whose slot passes while it is running
      spawns exactly one `run --check …` for that root; a daemon started
      three days after the last pass spawns one, not three.
- [ ] No pass starts while a website-started launch is running; it starts
      when that launch ends.
- [ ] Without credentials and with a scheduled root, the daemon runs in local
      mode, opens no socket and runs the pass; without a scheduled root it
      exits with `EXIT_DAEMON_NOT_LOGGED_IN` as today.
- [ ] `schedules.sync` carries only roots of the reported registry, with
      `schedule` exactly as parsed or `null`, and the zone name.
- [ ] `demoflow runner status` shows the next and last check per scheduled
      project.
- [ ] CLI tests pass on Linux, macOS and Windows.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i361-core | the config block and `lastDueSlot` | packages/core/src/project-config.ts, packages/core/src/schedule.ts, packages/core/src/index.ts, packages/core/schemas/project-config.schema.json, packages/core/test/** | — | yes | sonnet |
| i361-daemon | the scheduler, local mode, `schedules.sync`, status, the local roots file | apps/cli/src/runner/**, apps/cli/src/commands/run.ts, apps/cli/test/runner/**, apps/cli/README.md | i361-core | no | opus |

`i361-daemon` is `opus`: local mode changes the daemon's start path and its
interaction with the launch slot, which this spec states but does not lay out.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/core/src/project-config.ts, packages/core/schemas/project-config.schema.json | i361-core | other Phase 8 issues that add config keys (#353, #365) rebase on whichever merges first; never edit the generated schema by hand |
| apps/cli/src/runner/connection.ts | i361-daemon | #360 also edits it; this slice starts after #360 merges |

## Risks

- **Medium — the daemon is not running.** A machine without autostart runs no
  schedule. Mitigation: `demoflow runner status` and the website (spec 363)
  say "next check when the runner is running"; the docs say to use
  `demoflow runner install`.
- **Medium — local mode surprises.** A daemon that used to exit now stays up
  without an account. Mitigation: only when a committed config asks for a
  schedule; `runner status` names the mode.
- **Low — a slow pass overlaps the next slot.** Mitigation: one pass at a
  time; a slot due during a pass is the catch-up pass.

## Open questions

- Should `exclude` accept globs? Default: no, exact ids; a glob is a later spec.

Depends on #360

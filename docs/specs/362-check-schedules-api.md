# Check schedules in the API: scheduler, check passes started from the website, stale state

Issue: [#362](https://github.com/AndreyBegma/DemoFlow/issues/362)
Depends on: #360 (`Run.kind`, the daemon's `check.start`). Decision record: [ADR-0021](../adr/0021-scheduled-checks.md).

## Summary

The website side of scheduled checks (ADR-0021). The API stores a project's
schedule, set on the website or reported from the project's config by the
daemon (spec 361), starts a check pass on the project's machine when a
website schedule is due, catches up once when the machine comes back, and
keeps a per-scenario **stale** state from the runs the machine reports. The
web UI is spec 363.

## Scope

### In scope

- `apps/api/prisma/schema.prisma`: `CheckSchedule` and `ScenarioHealth` (new
  tables), their enums; migration
  `apps/api/prisma/migrations/20261026130000_check_schedules/`.
- `apps/api/src/checks/**` (new module): schedules controller and service,
  the scheduler loop, the slot computation, the stale-state service, DTOs and
  their tests; registered in `apps/api/src/app.module.ts`.
- `apps/api/src/launches/launches.service.ts`: `startCheckPass(target, exclude)`,
  the `check.*` replies, the `checks` capability from `launches.sync`.
- `apps/api/src/runner/runner-socket.ts`: the `check.started`,
  `check.finished`, `check.error` and `schedules.sync` client messages, and
  `checks?: boolean` on `LaunchesSyncMessage`;
  `apps/api/src/runner/runner.gateway.ts`: route them.
- `apps/api/src/projects/projects.service.ts`: after a report is stored, call
  the stale-state service in the same transaction (Decision 7).
- `apps/api/src/projects/projects.dto.ts`: `staleCount` on a project in
  `GET /projects`.

### Out of scope

- The web UI (spec 363), the CLI and the daemon (specs 360, 361).
- Email, webhook or any alert besides the state the website reads (owner:
  site only).
- A "check now" button. Default: not in this slice (Open questions).
- Changing the in-memory launch model (spec 247): a check pass is one more
  kind of launch in it.

## Decisions

1. **One machine per project, by the data model.** A `Project` row belongs to
   one Runner (`@@unique([runnerId, rootPath])`,
   `apps/api/prisma/schema.prisma`) [Confirmed]; a project on two machines is
   two rows. The owner's "the machine chosen in the schedule, default the
   last one that ran the project" is therefore always the project's
   `runnerId`: the schedule names no machine of its own, and the project page
   shows which machine runs it. A project whose `runnerId` is null (the
   machine was removed) cannot have a website schedule; an existing one is
   paused with reason `no-machine`.
2. **Two sources, one table** (ADR-0021 §4). `CheckSchedule` has a `source`
   of `site` or `config`, unique per `(projectId, source)`.
   - `PUT /projects/:id/schedule` creates or replaces the `site` row. It is
     refused `409 config-schedule` when a `config` row exists.
   - `schedules.sync` (spec 361, Decision 6) upserts the `config` row of each
     project matched by `(runnerId, rootPath)`, or deletes it when `schedule`
     is `null`. A project not yet known to the server is ignored. When a
     `config` row appears and a `site` row exists, the `site` row gets
     `pausedReason = 'config-schedule'`; when the `config` row goes, the
     pause is lifted.
   - `config` rows are never run by the API: the daemon runs them (spec 361).
     They are stored only to be shown, and their `lastPassAt` is the latest
     reported check run of the project.
3. **Cadence and time zone** (ADR-0021 §5). `cadence` `daily | weekdays | weekly`,
   `weekday` `mon…sun` with `weekly` only, `at` `HH:MM`, `timeZone` an IANA
   name, `exclude` at most 100 scenario ids (`IsScenarioId`,
   `apps/api/src/launches/scenario-id.ts`). The website sends the machine's
   zone when the latest `schedules.sync` gave one, otherwise the browser's;
   the API checks it with `Intl.supportedValuesOf('timeZone')`.
4. **The scheduler** ticks every 60 s, with `setInterval` in the service like
   the existing sweeps (`launches.service.ts`, `artifacts.service.ts`)
   [Confirmed]; no new dependency. For each unpaused `site` row it computes
   the latest due slot (`apps/api/src/checks/slots.ts`; the API does not
   depend on `@demoflow/core` [Confirmed], so the function is ported with the
   same test vectors as spec 361's `lastDueSlot`). When that slot is later
   than `lastSlotAt`:
   - machine online, accepts checks, idle → `startCheckPass`; `lastSlotAt` is
     set to the slot **before** the request is sent, so a crash or restart
     does not send it twice;
   - machine offline, or busy with a launch → nothing now; it runs on a later
     tick, at most once for all slots missed meanwhile (owner: one catch-up
     run);
   - machine online but without `checks: true` → `pausedReason = 'cli-too-old'`
     until a `launches.sync` with `checks: true`.
   - *Why `lastSlotAt` and not a queue:* a missed slot is a fact computed from
     the clock, so a restart of the API loses nothing.
5. **A check pass is a launch.** `startCheckPass` uses the launch map and the
   one-active-launch-per-Runner rule of `LaunchesService` [Confirmed]. It
   sends `check.start { requestId, rootPath, exclude }` (spec 360, Decision 6);
   `check.finished` ends it with counts. The run reports of the pass arrive
   over `POST /runner/runs` with `kind: 'check'` as usual. `GET /projects/:id/launch`
   shows a pass as `{ kind: 'check', status, passed?, failed? }`.
6. **The stale state** (ADR-0021 §6). `ScenarioHealth` has one row per
   `(projectId, scenarioPath)`: `state` (`passed | failed`), `since`
   (the time of the run that made the last transition), `lastRunId`.
   - Every stored report updates it, a check or an ordinary run: same state →
     only `lastRunId` changes; a different state → `state`, `since` and
     `lastRunId` change.
   - "Stale" is `state = failed`. No email or other alert (owner: site only).
   - Deleting a run does not recompute the state; deleting the project
     cascades.
7. **Same transaction.** The health update runs inside the report's
   transaction (`projects.service.ts` `report`) so a report and its state
   never disagree.

## Data / Schema

```prisma
enum ScheduleSource {
  site
  config
}

enum ScheduleCadence {
  daily
  weekdays
  weekly
}

model CheckSchedule {
  id           String          @id @default(uuid())
  projectId    String
  project      Project         @relation(fields: [projectId], references: [id], onDelete: Cascade)
  source       ScheduleSource
  cadence      ScheduleCadence
  // `mon`…`sun`; set only for `weekly`.
  weekday      String?
  // `HH:MM`, 24-hour, in `timeZone`.
  at           String
  timeZone     String
  exclude      String[]
  // `config-schedule`, `no-machine` or `cli-too-old`; null while it runs.
  pausedReason String?
  // The latest slot a pass was started for (site rows only).
  lastSlotAt   DateTime?
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt

  @@unique([projectId, source])
}

model ScenarioHealth {
  projectId    String
  project      Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  scenarioPath String
  state        RunStatus
  since        DateTime
  lastRunId    String

  @@id([projectId, scenarioPath])
  @@index([projectId, state])
}
```

`Project` gains the back-relations `schedules CheckSchedule[]` and
`health ScenarioHealth[]`. Migration `20261026130000_check_schedules`
creates both tables and enums, and backfills `ScenarioHealth` from each
`(projectId, scenarioPath)`'s latest `Run`.

## API

All routes take the session (`SessionGuard`) and act only on the caller's
projects; another user's project is `404`, as for every project route.

| Route | Body / answer |
|---|---|
| `GET /projects/:id/schedule` | `{ site: Schedule \| null, config: Schedule \| null, machine: { id, name, online } \| null }` |
| `PUT /projects/:id/schedule` | `{ cadence, weekday?, at, timeZone, exclude? }` → the `site` schedule; `409 config-schedule`, `409 no-machine` |
| `DELETE /projects/:id/schedule` | deletes the `site` row; `204` |
| `GET /projects/:id/health` | `[{ scenarioPath, scenarioName, state, since, lastRunId }]` |
| `GET /checks/stale` | the caller's stale scenarios across projects, newest `since` first, at most 50: `[{ projectId, projectName, scenarioPath, scenarioName, since, lastRunId }]` |
| `GET /projects` | each project gains `staleCount` |

`Schedule` is `{ source, cadence, weekday, at, timeZone, exclude, pausedReason, nextDueAt, lastPassAt }`.
`nextDueAt` is computed, never stored.

## Acceptance criteria

- [ ] **Authorization:** another user's project id on every route above is
      `404`; `GET /checks/stale` and `GET /projects` never return another
      user's schedules or stale scenarios (integration test with two users,
      each with a failed run).
- [ ] `PUT` with `weekly` and no `weekday`, `at: "25:00"`, an unknown zone,
      101 excludes, or an unknown key is `400`.
- [ ] `PUT` on a project with a `config` row is `409 config-schedule`.
- [ ] A `schedules.sync` with a schedule creates the `config` row and pauses
      an existing `site` row; one with `null` deletes it and lifts the pause.
- [ ] With a fake clock: a due slot with the machine online and idle sends one
      `check.start`; the same slot never sends a second; three missed slots
      while offline send one after reconnect; a busy machine gets it after its
      launch ends.
- [ ] A machine whose `launches.sync` lacks `checks: true` is never sent
      `check.start`, and the schedule shows `cli-too-old`.
- [ ] A failed report after a passed one flips `ScenarioHealth` to `failed`
      with `since` = that run's start; a second failure changes only
      `lastRunId`; a later pass flips it back.
- [ ] The migration's backfill gives each scenario the state of its latest run.
- [ ] `bun run test` passes in `apps/api`.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i362-schema | the tables, the migration, the stale state, `staleCount` | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261026130000_check_schedules/**, apps/api/src/checks/health/**, apps/api/src/projects/** | — | yes | opus |
| i362-scheduler | schedules routes, scheduler, slots, socket messages, check passes | apps/api/src/checks/schedules/**, apps/api/src/checks/checks.module.ts, apps/api/src/app.module.ts, apps/api/src/launches/**, apps/api/src/runner/runner-socket.ts, apps/api/src/runner/runner.gateway.ts | i362-schema | no | opus |

Both are `opus`: the schema and the backfill are decided here but not
written out as SQL, and the scheduler's interplay with the in-memory launch
map has to be fitted into code this spec only cites.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i362-schema | #360 adds `Run.kind` first; other Phase 8 API issues that add tables (#347) append distinct tables and keep both on conflict |
| apps/api/src/runner/runner-socket.ts | i362-scheduler | #347 and #356 add their own messages; rebase, keep every entry of `CLIENT_MESSAGES` |
| apps/api/src/app.module.ts | i362-scheduler | one import line each for other new modules |

## Risks

- **Medium — two slot implementations** (CLI core and API). Mitigation: the
  same table of test vectors in both suites; spec 364 documents one rule.
- **Medium — one API process.** The scheduler and the launch map are in
  memory; two API containers would start a pass twice. Staging and
  production run one API container (`deploy/README.md`) [Confirmed];
  `lastSlotAt` written before sending limits the damage to one duplicate.
- **Low — the backfill** on a large `Run` table. Mitigation: one
  `DISTINCT ON` query; the table is small today.

## Open questions

- A "Check now" button on the project page? Default: not in Phase 8; the
  person can start a run.
- Should a stale scenario clear when the scenario is deleted from the
  repository? Default: no; the row stays until a run passes or the project is
  deleted.

Depends on #360

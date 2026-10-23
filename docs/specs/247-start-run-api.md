# Start and cancel a run from the website (API)

Issue: [#247](https://github.com/AndreyBegma/DemoFlow/issues/247)
Depends on: nothing. It follows #233 (the request/answer pattern on the
runner socket), which has landed.

## Summary

[ADR-0008](../adr/0008-cloud-boundary.md) §3 lists four things the website may
make a Runner do. Streaming shipped with #191–#193 and deleting artifacts with
#233–#235. This spec and its two siblings add the other two: **start a run of
a scenario that exists as a file in a registered project, and cancel it**.
[ADR-0016](../adr/0016-website-started-runs.md) settles what that needs beyond
ADR-0008: listing a project's scenarios (ids and names), and what "registered"
means on the machine.

This spec is the API side. It also fixes the **protocol** that the daemon
(#248) and the project page (#249) build against, the way 233 did for
deletion.

- The browser asks for a project's scenarios. The API asks the project's
  machine over its socket and passes the list on. Nothing is stored.
- The browser starts a run with a project id and a scenario id, and nothing
  else. The API sends the machine the project's `rootPath` and the scenario
  id, and waits for the machine to say the run started.
- While the run goes, the API holds a **launch** in memory: its state, and at
  the end the server run id the CLI reported. The browser polls it.
- The browser can cancel the launch. The API forwards that to the machine.
- The run's result reaches the server the way every run's does: the CLI's own
  `POST /runner/runs` (spec 178). The launch only links to it.

## Scope

### In scope

- `apps/api/src/launches/` (new module): the controller, `LaunchesService`
  (pending requests and launches in memory), DTOs and the scenario id rule.
- `apps/api/src/runner/runner-socket.ts`: the new messages and their
  `class-validator` shapes.
- `apps/api/src/runner/runner-connections.service.ts`: route `scenarios.*`
  and `run.*` to a new `LaunchSink`, and tell it when a socket closes.
- `apps/api/src/app.module.ts`: register the module.
- `apps/api/src/runner/runner-socket.fixtures.ts` and integration specs.

### Out of scope

- The daemon (#248) and the project page (#249).
- A database table. Launches live in memory only (Decision 9).
- Progress inside a run (stages, steps). The launch has a state, not a log.
- Choosing formats, a base URL, headed mode or environment from the website
  (ADR-0016 §4).
- Re-syncing a running launch after the machine reconnects (Decision 7).
- Several API instances (#120; the relay and #233 have the same limit).

## Protocol

Eight messages are added to the runner socket, as JSON text frames.
`requestId` is a UUID v4 that the API chooses. For `run.*` it is the
**launch id** and stays the same for the launch's whole life.

| Direction | Message |
|---|---|
| API → Runner | `{ type: 'scenarios.list', requestId, rootPath }` |
| Runner → API | `{ type: 'scenarios.listed', requestId, scenarios: [{ id, name }], truncated, skipped }` |
| Runner → API | `{ type: 'scenarios.error', requestId, code }` |
| API → Runner | `{ type: 'run.start', requestId, rootPath, scenarioId }` |
| Runner → API | `{ type: 'run.started', requestId, scenarioName }` |
| Runner → API | `{ type: 'run.error', requestId, code }` |
| API → Runner | `{ type: 'run.cancel', requestId }` |
| Runner → API | `{ type: 'run.finished', requestId, outcome, runId }` |

- **`rootPath`** is the `Project.rootPath` the API holds, which the machine
  reported (spec 178, Decision 2). The machine treats it only as a key into
  its own registry (ADR-0016 §2–3). The browser never sends it.
- **Scenario id rule.** Both the API (on input) and the daemon (on receipt)
  accept a scenario id only when all of these hold:
  - 1 to 255 characters, with `/` as the separator;
  - it starts with `demoflow/` and ends with `.demo.json`;
  - no segment is empty, `.` or `..`;
  - no `\`, `:`, and no control character (U+0000–U+001F, U+007F).
- **`scenarios.listed`**: at most **100** entries, sorted by `id`. `name` is
  the scenario's `name`, 1 to 200 characters. `truncated` is true when the
  project has more valid scenarios than were sent. `skipped` counts
  `*.demo.json` files that failed to parse and are not listed. The frame stays
  under the socket's 64 KiB limit (`RUNNER_SOCKET_MAX_PAYLOAD`); the daemon
  drops entries from the end and sets `truncated` to make it fit.
- **`scenarios.error` codes:** `project-unknown` (the root is not in the
  machine's registry, or it no longer holds a `demoflow.config.json`) and
  `io`.
- **`run.started`** means the daemon checked everything and the `demoflow run`
  child is running. `scenarioName` is the scenario's `name`.
- **`run.error` codes**, sent instead of `run.started`:
  - `project-unknown`: as above;
  - `scenario-not-found`: the id breaks the rule, or the file does not exist
    inside the root (the daemon resolves links);
  - `scenario-invalid`: the file does not parse as a scenario;
  - `config-invalid`: `demoflow.config.json` does not load;
  - `busy`: the machine already runs a website-started run;
  - `reporting-off`: `CI` or `DEMOFLOW_NO_REPORT=1` is set for the daemon
    (ADR-0016 §4);
  - `io`: the child could not be spawned, or anything else.
- **`run.finished`**: `outcome` is `passed`, `failed`, `cancelled` or
  `timed-out`. `runId` is the **server** run id that the child's report got,
  or `null` when there was no report (a cancelled run, an app that never got
  ready, a report that failed).
- **`run.cancel`** for a launch the daemon does not run is ignored.
- **Version skew.** A daemon that predates #248 logs the new types as unknown
  and never answers, so the API times out (Decision 5). An answer with an
  unknown `requestId`, or from a machine the request was not sent to, is
  dropped and logged once per socket. `scenarios.error` and `run.error` take
  any code string of up to 64 characters; a code the API does not know maps
  to 502 `runner-error`. A frame that fails validation is logged and dropped,
  and its request times out. The socket stays open in every case.

## Decisions

1. **Endpoints**, on a new `LaunchesController` under `projects/:id`, with
   `SessionGuard` and the origin check of every mutating route:
   - `GET /projects/:id/scenarios` → 200
     `{ scenarios: { id, name }[], truncated, skipped }`;
   - `POST /projects/:id/launch` with `{ scenarioId }` → 202 `{ launch }`
     once the machine sent `run.started`;
   - `GET /projects/:id/launch` → 200 `{ launch }`, the project's latest
     launch, or `null`;
   - `DELETE /projects/:id/launch` → 202 `{ launch }` in state `cancelling`.

   `LaunchView` is
   `{ id, scenarioId, scenarioName, state, startedAt, finishedAt, runId }`.
   `state` is one of `starting`, `running`, `cancelling`, `passed`, `failed`,
   `cancelled`, `timed-out`, `lost`. Times are ISO 8601; `scenarioName`,
   `finishedAt` and `runId` may be null.
2. **Input.** `StartLaunchDto { scenarioId }` with `class-validator`: the
   scenario id rule (Protocol) as a custom validator. Anything else is 400 from
   the global `ValidationPipe`.
3. **Ownership and project state**, checked before anything is sent, in this
   order:
   - another user's project, or an unknown one: 404 `not-found` (#178
     Decision 5);
   - `rootPath` is null: 409 `project-unbound`;
   - `runnerId` is null or the Runner is revoked: 503 `runner-removed`;
   - the Runner is offline: 503 `runner-offline`;
   - for `POST` only: this Runner already has a launch in `starting`,
     `running` or `cancelling`, for any project: 409 `runner-busy`.

   `GET /projects/:id/launch` and `DELETE /projects/:id/launch` check
   ownership only; a launch whose machine went away is already `lost`
   (Decision 7).
4. **Runner answers as HTTP:**

   | Runner code | HTTP |
   |---|---|
   | `project-unknown` | 409 `project-unknown` |
   | `scenario-not-found` | 404 `scenario-not-found` |
   | `scenario-invalid` | 422 `scenario-invalid` |
   | `config-invalid` | 422 `config-invalid` |
   | `busy` | 409 `runner-busy` |
   | `reporting-off` | 409 `reporting-off` |
   | `io`, or an unknown code | 502 `runner-error` |

   A failed start leaves no launch behind.
5. **Timeouts**, on the injected `Clock`, swept every second like
   `ArtifactsService`:
   - `scenarios.list`: no answer within **10 s** → 504 `runner-timeout`;
   - `run.start`: no answer within **15 s** → 504 `runner-timeout`. The API
     then sends `run.cancel` for that launch id, so nothing runs that the
     website does not know about, and drops the launch. A late `run.started`
     is dropped;
   - `cancelling`: no `run.finished` within **30 s** → state `lost`;
   - `running`: no `run.finished` within **20 min** (the daemon's own cap is
     15 min, spec 248) → state `lost`.
6. **Cancel.** `DELETE` on a launch in `running` sends `run.cancel`, sets
   `cancelling` and answers 202 at once. A launch in `starting`, or no active
   launch: 409 `not-running`. A launch already `cancelling`: 202 again, and
   nothing more is sent.
7. **Socket close.** When the Runner's socket closes (or is replaced or
   revoked): a pending `scenarios.list` or `run.start` ends with 503
   `runner-offline`; a launch in `running` or `cancelling` becomes `lost`.
   The run may still finish on the machine and reach the library through its
   report; a `run.finished` on a later socket has an unknown `requestId` and
   is dropped.
8. **Finish.** On `run.finished` for a launch in `running` or `cancelling`,
   the state becomes the `outcome` (a run that finished before the kill keeps
   its real outcome) and `finishedAt` is set. A non-null `runId` is kept only
   when a `Run` with that id has the launch's `projectId` and `runnerId`;
   otherwise it is set to null and logged. The browser never sees a run id
   that is not its own.
9. **In memory.** `LaunchesService` holds the pending list requests and the
   launches in maps by `requestId`. A finished launch (any terminal state) is
   kept **10 minutes** for `GET`, then dropped. Nothing is written to the
   database: the run itself arrives through `POST /runner/runs`, and the
   launch is only its live status. An API restart closes every socket, so
   Decision 7 applies.
10. **Routing.** `RunnerConnections` gains a `LaunchSink`
    (`message(runnerId, message): boolean` and `closed(runnerId)`), the same
    seam as `ArtifactsSink`, with its own "warned stray" flag per socket.
    `parseClientMessage` learns the five Runner messages: `requestId` is a
    UUID v4; `scenarios` is an array of at most 100 nested objects
    (`ValidateNested`), each with an `id` that follows the scenario id rule
    and a `name` of 1 to 200 characters; `truncated` is a boolean and
    `skipped` an integer ≥ 0; `outcome` is one of the four; `runId` is a
    string of up to 64 characters or null.
11. **Logging.** One structured line per list request (`scenarios.list`) and
    per launch end (`launch`): project id, runner id, outcome or end state,
    and duration. No email, no path, no scenario id.

## Acceptance criteria

API integration tests with a fake Runner socket (extend
`runner-socket.fixtures.ts`), fake clock:

- [ ] `GET /projects/:id/scenarios`: the fake receives `scenarios.list` with
      the project's `rootPath` and a UUID `requestId`; its answer comes back
      as 200 with the same entries, `truncated` and `skipped`.
- [ ] `POST /projects/:id/launch`: the fake receives `run.start` with
      `rootPath` and `scenarioId`; on `run.started` the answer is 202 with a
      `running` launch, and `GET /projects/:id/launch` returns it.
- [ ] Invalid scenario ids (`../x.demo.json`, `demoflow/a\\b.demo.json`,
      `demoflow/x.json`, `/abs/demoflow/x.demo.json`, 256 characters) are 400
      and send nothing.
- [ ] 404 for another user's and an unknown project; 409 `project-unbound`;
      503 `runner-removed` and `runner-offline`; nothing is sent.
- [ ] A second `POST` while a launch is active, for the same or another
      project on the same machine: 409 `runner-busy`, nothing sent.
- [ ] Each Runner code of Decision 4 maps to its status, and no launch is
      left (`GET` returns null).
- [ ] List and start timeouts → 504 `runner-timeout`; after the start
      timeout the fake receives `run.cancel` with the launch id; a late answer
      is dropped and the socket stays open.
- [ ] `DELETE` on a running launch sends `run.cancel` and returns
      `cancelling`; `run.finished` `cancelled` ends it; no answer in 30 s →
      `lost`. `DELETE` with no active launch → 409 `not-running`.
- [ ] A socket close: pending requests → 503 `runner-offline`; a running
      launch → `lost`.
- [ ] `run.finished` with a `runId` of this project and machine is kept; one
      of another project, or unknown, becomes null.
- [ ] A finished launch is still returned 9 minutes later and gone after 10.
- [ ] An answer with an unknown `requestId`, or from another machine, is
      dropped, and the socket stays open; an unknown `run.error` code → 502
      `runner-error`.
- [ ] The existing runner socket, video and artifacts tests stay green.
      `bun run check`, `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/api/**` | #247 | None of #248 and #249 touch it. No other open issue does today. |
| `apps/api/src/runner/runner-socket.ts`, `runner-connections.service.ts` | #247 | Shared with any later socket work; rebase on whichever merges first. |

## Open questions

None.

# Live progress of a website-started run (API)

Issue: #301
Depends on: nothing. It follows #247 (launches) and #284 (re-sync), which
have landed.

## Summary

Specs [247](247-start-run-api.md), [248](248-runner-starts-runs.md) and
[249](249-project-page-start-run.md) left progress inside a run out: "The
launch has a state, not a log." A website-started run takes minutes (app
start, steps, rendering), and the project page shows only **Running** and an
elapsed clock for all of it.

This spec is the API side, and it fixes the **protocol** that the daemon
(#302) and the project page (#303) build
against, the way 247 did for 248 and 249.

- While its child runs, the daemon sends `run.progress`: which **phase** the
  run is in (starting the app, running the steps, rendering), and during the
  steps **step n of m**.
- The API keeps only the **latest** progress on the in-memory launch and
  returns it in `LaunchView`. Nothing is stored, nothing is logged per frame.
- A daemon that never sends it leaves `progress: null`, which is today's
  page.

[ADR-0008](../adr/0008-cloud-boundary.md) §2 lets a runner send "the status
of every stage". A phase name and two step numbers are less than that: no
action, locator, caption, URL, value or path crosses (Decision 2).

## Scope

### In scope

- `apps/api/src/runner/runner-socket.ts`: `RunProgressMessage`, its
  `class-validator` shape, `RUN_PHASES`, `MAX_PROGRESS_STEPS`, and its place
  in `CLIENT_MESSAGES` and `LaunchMessage`.
- `apps/api/src/runner/runner-connections.service.ts`: route `run.progress`
  to the `LaunchSink` with the other `run.*` messages.
- `apps/api/src/launches/launches.service.ts`: keep the latest progress on
  `Launch`, add `progress` to `LaunchView`.
- `apps/api/src/runner/runner-socket.fixtures.ts`,
  `apps/api/src/runner/runner-socket.spec.ts` and
  `apps/api/src/launches/launches.integration.spec.ts`: tests.

### Out of scope

- The daemon and the `demoflow run` child (#302) and the
  project page (#303).
- A database column or a history of progress. Launches stay in memory
  (spec 247, Decision 9).
- Step contents (action, locator, caption), stage durations, failure
  messages. The run page has those after the report (#263–#265).
- Progress in `launches.sync` after a reconnect (Decision 6).
- Progress of runs started locally or through `demoflow mcp`.
- Pushing progress to the browser (SSE, WebSocket). The page keeps its 2 s
  poll (Decision 7).

## Protocol

One message is added to the runner socket, as a JSON text frame.

| Direction | Message |
|---|---|
| Runner → API | `{ type: 'run.progress', requestId, phase, step, steps }` |

- **`requestId`** is the launch id (spec 247 Protocol), a UUID v4.
- **`phase`** is one of `RUN_PHASES`:
  - `app`: the child checked its input and is starting the project's app
    (and, on first use, downloading Chromium);
  - `steps`: the browser runs the scenario's steps;
  - `rendering`: the steps are over and the video is being rendered.
- **`step`** and **`steps`**: for `steps`, integers with
  `1 ≤ step ≤ steps ≤ MAX_PROGRESS_STEPS` (10,000). `step` is the 1-based
  number of the step that started last, counting a `repeat` as its expanded
  steps (the engine's `stepIndex` + 1); `steps` is the expanded total. For
  `app` and `rendering`, both are `null`.
- **When.** Only between `run.started` and `run.finished`, at most once per
  second, and only when it changed (spec #302). It may
  never come: a run that fails before its app starts, or a daemon that
  predates #302.
- **Version skew.**
  - A daemon that predates #302 never sends it; the launch
    keeps `progress: null`.
  - An API that predates this spec logs `run.progress` as an unknown type
    and drops it (`parseClientMessage`), one warning per frame. The socket
    stays open. This slice merges first, so staging never runs that pair for
    long.
  - A frame that fails validation is logged and dropped like any invalid
    frame. The launch keeps its last valid progress.

## Decisions

1. **Where the contract lives.** `RunProgressMessage` is a class in
   `runner-socket.ts` next to `RunFinishedMessage`: `@IsIn(['run.progress'])`
   `type`, `@IsUUID('4')` `requestId`, `@IsIn(RUN_PHASES)` `phase`, and
   `step` and `steps` each `@ValidateIf(value !== null)`, `@IsInt`, `@Min(1)`,
   `@Max(MAX_PROGRESS_STEPS)`. It joins `CLIENT_MESSAGES` and the
   `LaunchMessage` union. *Why:* every runner message is defined there and
   the CLI parses frames itself (spec 284, Decision 1).
2. **What crosses: a phase and two numbers.** Not the stage map of
   `result.json`, not the step's action or caption. *Why:* the page needs
   "where is it" and "how far"; the six stages run partly at once
   (execution, verification and recording overlap), so a single phase reads
   better and is smaller. It stays well inside ADR-0008 §2, so no ADR is
   needed.
3. **Cross-field check in the service.** `LaunchesService` accepts a frame
   only when `phase === 'steps'` has both numbers with `step ≤ steps`, or
   another phase has both `null`. Otherwise it is dropped and counted as
   stray (Decision 5). *Why:* `class-validator` checks each field;
   one plain condition is clearer than a custom class decorator.
4. **Which launches take it.** A valid frame from the launch's own machine,
   for a launch in `starting`, `running` or `cancelling` that is not
   `finishing`, replaces `launch.progress`. It does not touch `since`,
   `detachedAt` or any timeout. *Why:* the child can print its first line
   before the API has processed `run.started`; accepting `starting` avoids a
   stray warning for a frame that is simply early. Progress is not a
   heartbeat: the timeouts of specs 247 and 284 stay as they are.
5. **Strays.** A frame for an unknown launch, another machine's launch or an
   ended one returns `false` from `message()`, so `RunnerConnections` drops
   it and logs once per socket with the existing `warnedStrayLaunch` flag.
   The socket stays open.
6. **Reconnect.** A detached launch keeps its last progress and shows it.
   `launches.sync` does not carry progress; the next `run.progress` on the
   new socket replaces it. *Why:* the daemon sends again on the next change,
   which during steps is seconds away; carrying it in the sync is a larger
   change for little.
7. **The view.** `LaunchView` gains
   `progress: { phase, step, steps } | null`. It is the stored progress
   while `state === 'running'`, and `null` in every other state, and before
   the first frame. *Why:* `starting` lasts under 15 s, `cancelling` and the
   terminal states make the phase misleading, and the run page tells how a
   finished run went. The page keeps polling every 2 s (spec 249); one frame
   per second at most is enough for it.
8. **No database, no per-frame log.** Progress is never written to the
   database and `LaunchesService` logs nothing per frame. The launch end log
   line (spec 247, Decision 11) is unchanged. *Why:* up to 900 frames in a
   15-minute run would drown the log, and the run's real record is its
   report.

## Acceptance criteria

API integration tests with a fake Runner socket (extend
`runner-socket.fixtures.ts`), fake clock:

- [ ] `parseClientMessage` accepts `run.progress` for `app` and `rendering`
      with null numbers and for `steps` with `1/1` and `10000/10000`, and
      rejects a missing `requestId`, an unknown phase, `step: 0`, a
      non-integer, and `steps: 10001`.
- [ ] A running launch: before any frame, `GET /projects/:id/launch` returns
      `progress: null`; after `app` it returns `{ phase: 'app', step: null,
      steps: null }`; after `steps` 3/7 it returns `{ phase: 'steps', step: 3,
      steps: 7 }`; after `rendering`, the rendering progress.
- [ ] `steps` with `step > steps`, and `app` with numbers, are dropped; the
      launch keeps its previous progress; the socket stays open.
- [ ] A frame that arrives while the launch is `starting` is kept, and shown
      once `run.started` makes it `running`.
- [ ] After `DELETE` the view is `cancelling` with `progress: null`; after
      `run.finished` it is the outcome with `progress: null`.
- [ ] A frame for an unknown launch id or from another machine changes
      nothing and the socket stays open.
- [ ] Progress frames do not reset the 20-minute `running` timeout (fake
      clock: the launch still ends `lost` at 20 minutes with frames every
      second).
- [ ] A launch detached by a socket close still returns its last progress;
      after the re-sync, a new frame replaces it.
- [ ] The existing runner socket, video, artifacts and launches tests stay
      green. `bun run check`, `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/api/src/launches/**` | #301 | No other open issue. |
| `apps/api/src/runner/runner-socket.ts`, `runner-connections.service.ts` | #301 | Shared with any later socket work; rebase on whichever merges first. |
| `apps/cli/**` | #302 | This slice does not touch it. |
| `apps/web/**` | #303 | This slice does not touch it. |

## Open questions

None.

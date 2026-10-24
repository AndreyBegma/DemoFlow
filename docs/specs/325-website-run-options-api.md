# Start a website run with chosen output formats (API)

Issue: #325
Depends on: nothing. [ADR-0017](../adr/0017-website-run-options.md) lands
with the specs PR. It follows #247 (start and cancel), #284 (`launches.sync`)
and #301 (progress), which have landed.

## Summary

[ADR-0017](../adr/0017-website-run-options.md) supersedes
[ADR-0016](../adr/0016-website-started-runs.md) §4's "the website chooses
nothing but the scenario": the website may choose the **output formats** of a
run it starts, and nothing else. This slice is the API side, and it fixes the
**protocol** the daemon (#326) and the web
(#327) build against, the way 247 did.

- The browser may add `formats` to `POST /projects/:id/launch`.
- The API forwards them as `run.start.options.formats`, only to a machine that
  said it accepts options.
- The launch shows which formats it asked for.
- The web learns, from the scenario list and the run detail, whether the
  machine accepts the choice.

## Scope

### In scope

- `apps/api/src/launches/launches.dto.ts`: `formats` on `StartLaunchDto`.
- `apps/api/src/launches/launches.controller.ts`: pass `formats`; the
  `runner-outdated` check.
- `apps/api/src/launches/launches.service.ts`: `options` on `run.start`,
  `formats` on `Launch` and `LaunchView`, `runOptions` on `ScenarioList`, the
  `options-invalid` mapping.
- `apps/api/src/runner/runner-socket.ts`: `options` on the `run.start`
  server message; `runOptions` on `LaunchesSyncMessage`; the `RUN_OPTIONS`
  constant.
- `apps/api/src/runner/runner-connections.service.ts`: keep the announced
  options per connection; `runOptions(runnerId)`.
- `apps/api/src/videos/runs.service.ts`: `runOptions` on the run detail's
  `machine`.
- Tests: `launches.integration.spec.ts`, `runner-socket.spec.ts`,
  `runner-socket.fixtures.ts`, `run-details.integration.spec.ts`.

### Out of scope

- The daemon (#326) and the web
  (#327).
- Headed mode, base URL, environment, output directory, or any other option
  (ADR-0017 §2–3).
- Telling the website the project's configured default formats (ADR-0017,
  Consequences).
- Storing the chosen formats in the database. The run's report already
  records the formats it rendered (spec 133).

## Protocol

Changes to the runner socket of spec 247. Everything not named here is as it
is.

| Direction | Message | Change |
|---|---|---|
| API → Runner | `{ type: 'run.start', requestId, rootPath, scenarioId, options? }` | `options` is new and optional: `{ formats: RunFormat[] }`. |
| Runner → API | `{ type: 'launches.sync', running, runOptions? }` | `runOptions` is new and optional: the options this daemon accepts. Today only `'formats'`. |
| Runner → API | `{ type: 'run.error', requestId, code }` | New code `options-invalid`. |

- **`options`** is present only when the browser sent `formats`. It then
  holds exactly one key, `formats`: 1 to 9 entries, each a member of
  `RUN_FORMATS` (`apps/api/src/projects/projects.dto.ts`, the API's copy of
  `RENDER_FORMATS`), each at most once, in the browser's order (the render
  order, spec 133). The API never sends an empty `options` or an empty list.
  - *Why omit it rather than send `options: {}`:* the default frame stays byte
    for byte what every daemon already handles.
- **`runOptions`** is an array of at most 8 strings of at most 32 characters.
  The API keeps only the strings it knows (`RUN_OPTIONS = ['formats']`) and
  drops the rest without logging. A sync without the field means `[]`. A
  daemon from before #285 sends no sync at all; its machine is `[]` too.
  - *Why on `launches.sync`:* it is already the daemon's first frame on every
    socket (spec 285, Decision 1), so the API knows before the first request,
    and a daemon is upgraded only by restarting it, which opens a new socket.
    The connect request carries no CLI version, and `Runner.cliVersion` is
    the version at pairing, so neither can be trusted for this.
- **`options-invalid`**: the daemon refused the options (ADR-0017 §4), for
  example a format the API knows and the daemon's older enum does not.
- **Version skew.**
  - An older API strips `runOptions` (`validateSync` runs with
    `whitelist: true`, `runner-socket.ts`) and never sends `options`: a new
    daemon behaves as today.
  - An older daemon ignores `options` (it reads only `requestId`, `rootPath`
    and `scenarioId`, `apps/cli/src/runner/launch/index.ts`), which is why
    the API never sends `options` to a machine without `'formats'`
    (Decision 3).

## Decisions

1. **Input.** `StartLaunchDto` gains `formats?: RunFormat[]`:
   `@IsOptional()`, `@IsArray()`, `@ArrayMinSize(1)`, `@ArrayMaxSize(9)`,
   `@ArrayUnique()`, `@IsIn(RUN_FORMATS, { each: true })`. The global
   `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`) answers 400 for
   anything else, including any other key.
   - *Why reject `[]` instead of reading it as "default":* absence already
     means default; two spellings of one thing invite a client bug that sends
     `[]` by accident and gets surprising files.
   - *Why any member of the enum, not the project's `render.formats`:*
     ADR-0017 §1. The API does not know the project's config anyway.
2. **Order is kept.** The list reaches the daemon in the order it came. The
   API does not sort or reorder it.
   - *Why:* `render.formats` and `--format` both mean "in this order" (spec
     133); the web decides the order.
3. **`runner-outdated`.** In `LaunchesController.target`'s order (spec 247,
   Decision 3), after `runner-offline` and before the service's
   `runner-busy`: when `formats` is present and
   `connections.runOptions(runnerId)` does not include `'formats'`, answer
   409 `runner-outdated` and send nothing.
   - *Why refuse instead of starting without the formats:* ADR-0017 §4: a run
     that ignores the person's choice looks like it worked and produces the
     wrong files.
   - *Why before `runner-busy`:* it is a property of the machine that a retry
     will not change; the busy answer suggests waiting.
4. **The announced options live on the connection.** `RunnerConnections`
   reads `runOptions` from a valid `launches.sync` when it routes it, keeps
   the known entries on that `Connection`, and then hands the message to the
   `LaunchSink` as today. `runOptions(runnerId): readonly RunOption[]`
   returns them for the current socket, and `[]` when there is none or it has
   not announced. A replaced or closed socket takes its options with it.
   - *Why the connection and not `LaunchesService`:* the run detail
     (`videos/runs.service.ts`) already asks `RunnerConnections` whether a
     machine is online; the same seam answers what it accepts, with no new
     module dependency.
   - A start with formats sent in the moment between a socket opening and its
     sync is `runner-outdated`. *Why acceptable:* the sync is the daemon's
     first frame; the window is a round trip.
5. **The launch keeps its formats.** `Launch` and `LaunchView` gain
   `formats: RunFormat[] | null`: the list sent, or null when none was. It is
   set at start and never changes. A launch reattached by `launches.sync`
   keeps the value it had.
   - *Why null and not the project's list:* the API does not know the
     project's defaults (ADR-0017, Consequences); null tells the web to say
     "the project's formats".
6. **Answers.** `RUNNER_ERRORS` gains `options-invalid` → 422
   `options-invalid`. A failed start leaves no launch, as for every other
   code.
7. **The web learns what the machine accepts.**
   - `ScenarioList` gains `runOptions: RunOption[]`, read from
     `connections.runOptions(runnerId)` when the list answer arrives.
   - The run detail's `machine` gains `runOptions: RunOption[]`, `[]` when
     offline.
   - *Why both:* the project page loads the scenario list before it shows the
     picker; the run page's Run again never lists scenarios and needs it from
     the run detail it already loads (#327).
8. **Logging.** The `launch` line gains `formats` as the count of formats, or
   `default`. No format names are needed to debug, and none are secret, but
   the line stays short.

## Acceptance criteria

API integration tests with a fake Runner socket (extend
`runner-socket.fixtures.ts` with a sync that can carry `runOptions`), fake
clock:

- [ ] A start without `formats` sends `run.start` with exactly the keys
      `type`, `requestId`, `rootPath`, `scenarioId`.
- [ ] A start with `['gif', 'mp4-vertical']` to a machine that announced
      `['formats']` sends `options: { formats: ['gif', 'mp4-vertical'] }`;
      the 202 launch and `GET /projects/:id/launch` show those `formats`; a
      start without has `formats: null`.
- [ ] 400, nothing sent: `formats: []`, `['mov']`, `['mp4', 'mp4']`, ten
      entries, `'mp4'` (not an array), and `{ scenarioId, headed: true }`.
- [ ] 409 `runner-outdated`, nothing sent: formats to a machine whose sync had
      no `runOptions`, and to one that sent no sync. The same project without
      formats starts.
- [ ] After a socket is replaced by one whose sync has no `runOptions`,
      formats are `runner-outdated`.
- [ ] `run.error` `options-invalid` → 422 `options-invalid`; `GET` returns
      null.
- [ ] `GET /projects/:id/scenarios` has `runOptions` `['formats']` or `[]`.
- [ ] The run detail's `machine.runOptions` is `['formats']` for an announcing
      online machine and `[]` offline.
- [ ] `parseClientMessage` (`runner-socket.spec.ts`): a sync with
      `runOptions: ['formats', 'later']` is valid and keeps `formats` only
      once routed; nine entries, a 33-character entry, or a non-array is
      `invalid launches.sync`.
- [ ] The existing launches, runner socket, run detail, artifacts and video
      tests stay green. `bun run check`, `bun run test` and `bun run build`
      are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/api/src/launches/**` | this issue | No other open issue. |
| `apps/api/src/runner/runner-socket.ts`, `runner-connections.service.ts` | this issue | Shared with any later socket work; rebase on whichever merges first. |
| `apps/api/src/videos/runs.service.ts` | this issue | One field on `machine`; rebase on any run-detail work. |

## Open questions

None.

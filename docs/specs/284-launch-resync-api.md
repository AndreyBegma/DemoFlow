# Re-sync a running launch after the runner reconnects (API)

Issue: [#284](https://github.com/AndreyBegma/DemoFlow/issues/284)
Depends on: nothing. It follows #247 (launches) and #248 (the daemon's
launcher), which have landed.

## Summary

[ADR-0007](../adr/0007-runner-pairing-and-connection.md) §3 promises "a
resumable job state after a reconnect". Website-started runs do not have one
yet: when a machine's socket closes, every `running` or `cancelling` launch
becomes `lost` at once (spec 247, Decision 7), even though the run goes on
(spec 248, Decision 11) and the machine is usually back a few seconds later.

This spec is the API side, and it fixes the **protocol** that the daemon
(#285) builds against, the way 247 did for 248.

- When a socket closes, an active launch is **detached** instead of `lost`.
  The browser keeps seeing its state.
- On every new socket, the daemon first sends `launches.sync`: the launch ids
  it is still running, possibly none.
- The API **reattaches** each detached launch the machine lists, and ends the
  ones it does not list as `lost`.
- A machine that does not come back, or does not send `launches.sync` (a
  daemon that predates #285), ends its detached launches as `lost`, the same
  end state as today, a little later.

## Scope

### In scope

- `apps/api/src/runner/runner-socket.ts`: the `launches.sync` message, its
  `class-validator` shape, and its place in `LaunchMessage`.
- `apps/api/src/runner/runner-connections.service.ts`: route
  `launches.sync` to the `LaunchSink`, and tell the sink when a socket opens
  (`opened(runnerId)`).
- `apps/api/src/launches/launches.service.ts`: detach, sync, reattach and the
  two new timeouts.
- `apps/api/src/runner/runner-socket.fixtures.ts`,
  `apps/api/src/runner/runner-socket.spec.ts` and
  `apps/api/src/launches/launches.integration.spec.ts`: tests.

### Out of scope

- The daemon (#285).
- `packages/shared`. The runner protocol has never lived there: the API's
  shapes are in `runner-socket.ts`, and the CLI parses frames itself
  (Decision 1).
- Adopting a launch the API does not know, after an API restart
  (Decision 6).
- The outcome of a run that finished while the machine was offline. It ends
  `lost`; the run still reaches the library through its report (Decision 5).
- A launch in `starting` when the socket closes. It still fails with 503
  `runner-offline` as in spec 247, Decision 7.
- A database table. Launches stay in memory (spec 247, Decision 9).
- Several API instances (#120).

## Protocol

One message is added to the runner socket, as a JSON text frame.

| Direction | Message |
|---|---|
| Runner → API | `{ type: 'launches.sync', running: string[] }` |

- **`running`** holds the `requestId` (launch id, spec 247 Protocol) of each
  website-started run whose child the daemon still has, including one it is
  killing. At most **16** entries, each a UUID v4. Today the daemon runs at
  most one (spec 248, Decision 6); the room is for later.
- **When.** The daemon sends it on every new socket, as its **first frame**,
  before `pong`, `rotated` or any answer, and without waiting for `hello`.
  An empty list is sent too: it says "nothing is running".
- **Once per socket.** The API acts on the first `launches.sync` of a socket.
  A later one, or one after the sync window closed (Decision 4), is dropped
  and logged once per socket, with the existing `warnedStrayLaunch` flag. The
  socket stays open.
- **Version skew.**
  - A daemon that predates #285 never sends it. The sync window closes after
    10 s and its detached launches end `lost` (Decision 4).
  - An API that predates this spec logs `launches.sync` as an unknown type and
    drops it (`parseClientMessage`). The socket stays open, and the API
    behaves as today.
  - A frame that fails validation (not an array, more than 16 entries, an
    entry that is not a UUID v4) is logged and dropped like any invalid
    frame. It counts as no sync, so the window closes as in Decision 4.

## Decisions

1. **Where the contract lives.** `LaunchesSyncMessage` is a class in
   `runner-socket.ts` next to the `run.*` shapes: `@IsIn(['launches.sync'])`
   `type`, and `running` with `@IsArray`, `@ArrayMaxSize(16)` and
   `@IsUUID('4', { each: true })`. It joins `CLIENT_MESSAGES` and the
   `LaunchMessage` union. *Why:* every runner message is defined there; the
   CLI does not depend on `@demoflow/shared`, which is glue between the API
   and the website only (CLAUDE.md). Moving the protocol is a separate
   decision.
2. **Detach on close.** `LaunchesService.closed(runnerId)` no longer ends a
   `running` or `cancelling` launch. It sets an internal `detachedAt` (the
   clock time of the first close; a second close while detached keeps it).
   `LaunchView` does not change: the browser sees `running` or `cancelling`.
   Pending `scenarios.list` and `starting` launches end with 503
   `runner-offline` as before. *Why:* the run goes on during a blip; showing
   `lost` and then something else would misreport it twice.
3. **Reconnect grace.** A detached launch whose machine has no new socket
   within **90 s** of `detachedAt` ends `lost`. *Why:* the daemon backs off
   1 s, 2 s, 4 s … (±20 %, spec 151 Decision 7); 90 s covers its first six
   attempts after a stable connection, and stays well under the 20-minute
   `RUN_TIMEOUT_MS`.
4. **Sync window.** `RunnerConnections.accept` calls the new
   `LaunchSink.opened(runnerId)` right after the socket becomes the machine's
   current one, before any `await`. That opens the machine's sync window. It
   closes on the first valid `launches.sync`, or after **10 s**. When it
   closes without a sync, every detached launch of that machine ends `lost`.
   A window is opened on every socket, with or without detached launches.
   *Why:* the daemon sends the frame first, so 10 s is ample even on a slow
   link; a short window means an old daemon gets today's end state promptly.
5. **Reconcile.** On a `launches.sync` inside the window, for each detached
   launch of that machine:
   - listed: it is **reattached**: `detachedAt` is cleared, its state is kept,
     and `since` is kept for `running` (the 20-minute timeout still counts
     from `run.started`). A `cancelling` launch has `run.cancel` sent again on
     the new socket and `since` reset, so its 30 s timeout starts over;
   - not listed: it ends **`lost`** with `runId: null`. *Why:* the machine no
     longer has the child, and the `run.finished` it sent while offline was
     dropped (spec 248, Decision 10). `lost` claims nothing it cannot prove;
     the run, if it reported, is in the library. Carrying finished outcomes
     in the sync is a larger change left for later.
6. **Unknown ids are ignored.** A listed id that is not a detached launch of
   that machine (another machine's launch, an ended one, or one this API never
   held because it restarted) is ignored and logged once per socket. Nothing
   is sent for it: no `run.cancel`, no adoption. *Why:* adopting needs the
   project and scenario to cross again and a new trust check; cancelling would
   kill a user's run on every deploy (staging deploys on each merge). The run
   still reports, and a new `POST` while it goes gets the daemon's `busy`
   (409 `runner-busy`), which is true.
7. **`run.finished` while detached or before the sync.** A `run.finished`
   from the launch's own machine for a detached launch is accepted as today
   (spec 247, Decision 8) and clears `detachedAt`. *Why:* it is the machine
   telling the outcome; there is nothing to wait for.
8. **Cancel while detached.** `DELETE` on a detached `running` launch sets
   `cancelling` and answers 202, as in spec 247 Decision 6, without sending.
   `run.cancel` is sent when the launch is reattached (Decision 5). While
   detached, the 30 s cancel timeout does not run; the grace and the window
   still do. A `DELETE` on an attached launch whose `sendTo` fails still ends
   it `lost`, as today.
9. **Busy.** A detached launch is active: `POST` for that machine is 409
   `runner-busy` once it is online again and until the launch ends.
   (While it is offline, 503 `runner-offline` comes first, spec 247
   Decision 3.)
10. **Timers** run on the injected `Clock` in the existing 1 s sweep:
    `RECONNECT_GRACE_MS = 90_000` and `SYNC_TIMEOUT_MS = 10_000` are exported
    next to the other launch constants.
11. **Logging.** One structured line per sync (`launches.sync`): runner id,
    counts of reattached, lost and ignored ids. A launch ended by Decisions
    3–5 logs its end as today, with `lost`. No path, no scenario id.

## Acceptance criteria

API integration tests with a fake Runner socket (extend
`runner-socket.fixtures.ts`), fake clock:

- [ ] `parseClientMessage` accepts `launches.sync` with 0, 1 and 16 UUID v4
      ids, and rejects 17 entries, a non-UUID entry, and a missing
      `running`.
- [ ] Reconnect with a running launch: the socket closes, `GET` still says
      `running`; a new socket sends `launches.sync` with the launch id; the
      launch stays `running`, and a later `run.finished` `passed` ends it
      `passed` with its `runId`.
- [ ] Reconnect after the run finished: the new socket sends
      `launches.sync` with `running: []`; the launch ends `lost` with
      `runId: null`.
- [ ] Reconnect with no message (an old daemon): 10 s after the new socket
      opens, the launch is `lost`; the socket stays open.
- [ ] No reconnect: 90 s after the close the launch is `lost`, and not
      before.
- [ ] A `cancelling` launch that is reattached receives `run.cancel` again on
      the new socket; a `DELETE` while detached returns `cancelling` and the
      fake receives `run.cancel` only after its sync lists the launch.
- [ ] A synced id the API does not know (as after a restart) or of another
      machine is ignored: nothing is sent, no launch appears, the socket
      stays open.
- [ ] A second `launches.sync` on the same socket changes nothing and is
      dropped.
- [ ] A `starting` launch still fails with 503 `runner-offline` on close.
- [ ] `POST` while a detached launch of that machine is reattached or
      awaiting sync: 409 `runner-busy`.
- [ ] The existing runner socket, video, artifacts and launches tests stay
      green, apart from the 247 socket-close case, which now expects the
      grace. `bun run check`, `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/api/src/launches/**` | #284 | No other open issue. |
| `apps/api/src/runner/runner-socket.ts`, `runner-connections.service.ts` | #284 | Shared with any later socket work; rebase on whichever merges first. |
| `apps/cli/**` | #285 | #284 does not touch it. |

## Open questions

None.

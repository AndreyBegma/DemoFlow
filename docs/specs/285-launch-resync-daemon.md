# The runner daemon re-announces running launches after a reconnect

Issue: [#285](https://github.com/AndreyBegma/DemoFlow/issues/285)
Depends on: nothing to build. The protocol is in
[284](284-launch-resync-api.md#protocol). Merge after #284, so staging has
both ends.

## Summary

When the daemon's socket drops while a website-started run goes, the run
carries on (spec 248, Decision 11), but the API cannot tell whether it still
does. Spec 284 lets the API keep the launch **detached** for a while and asks
the machine, on its next socket, which launches it still runs.

This slice is the daemon's side.

- On every socket that opens, the daemon's first frame is
  `launches.sync { running }`: the launch id of the child it still has, or an
  empty list.
- Nothing else changes. A run that finished while offline still reaches the
  server through its report, and its `run.finished` is still dropped.

## Scope

### In scope

- `apps/cli/src/runner/launch/index.ts`: `LaunchPort.running()`, the ids of
  the launches whose child is alive; a repeated `run.cancel` stays harmless.
- `apps/cli/src/runner/connection.ts`: send `launches.sync` first on every
  open.
- `apps/cli/test/runner/connection.spec.ts`,
  `apps/cli/test/runner/launch.spec.ts`,
  `apps/cli/test/runner/daemon-launch.spec.ts` and
  `apps/cli/test/runner/fakes.ts`: tests.

### Out of scope

- The API (#284).
- Holding a `run.finished` that could not be sent and replaying it after a
  reconnect (spec 284, Decision 5).
- A launch still in its checks when the socket drops: the API has already
  failed it (spec 284, Out of scope). It is not announced (Decision 2).
- `apps/cli/src/runner/daemon.ts`: the launcher is already passed to the
  connection as `launches`.

## Decisions

1. **When.** `RunnerConnection.onOpen` sends `launches.sync` straight after
   it marks the socket open, before the first ping is scheduled and before
   any frame is handled. It does not wait for `hello`. It is sent on the first
   socket too, and on every reconnect. *Why:* the API reconciles on the first
   sync of a socket and closes its window after 10 s (spec 284, Decision 4);
   the earliest frame cannot race an answer or a `run.finished`.
2. **What.** `running` is `deps.launches?.running() ?? []`.
   `Launcher.running()` returns `[requestId]` when the current launch has a
   spawned child (`launch.child` is set), including one being killed after a
   cancel or the 15-minute cap, and `[]` otherwise. *Why:* a child that is
   still alive will still send `run.finished`; a launch with no child yet
   has no run the API could reattach, and the API failed its start on close.
3. **Only ids the API can accept.** An id that is not a UUID v4 (the daemon
   does not validate `requestId` on `run.start`, spec 248) is left out of
   `running` and logged. *Why:* one bad entry makes the API drop the whole
   frame (spec 284, Protocol), which would lose the launches that are valid.
4. **No change to finishing.** `run.finished` is still sent on the socket
   current at that moment, or dropped (spec 248, Decision 10). A run that
   finished while offline is not announced; the API ends its launch `lost`,
   and its report still reaches the library.
5. **A second `run.cancel` is harmless.** The API sends `run.cancel` again
   when it reattaches a `cancelling` launch (spec 284, Decision 5). For the
   running launch, `stop` keeps the first `ending` reason and the child's
   `kill()` is called again; that must neither throw nor send a second
   `run.finished`. *Why:* the API cannot know whether the first cancel
   arrived before the drop.
6. **Log.** One `info` line in `runner.log` per sync sent: the number of
   launches announced. No path, no scenario id (spec 248, Decision 13).

## Acceptance criteria

Vitest under Node, on the execution-plane matrix (Linux, macOS and Windows):

- [ ] On the first open, the first frame the fake server receives is
      `{ type: 'launches.sync', running: [] }`, before any `pong` or
      `rotated`.
- [ ] With a running launch (injected spawn), the socket drops and the
      daemon reconnects: the first frame on the new socket is
      `launches.sync` with exactly that launch's `requestId`.
- [ ] With no running launch on reconnect, it is `running: []`.
- [ ] A launch whose child exited while offline: the reconnect announces
      `running: []`, no `run.finished` is sent on the new socket, and the run
      report path is unchanged (the existing report tests stay green).
- [ ] A launch still in its checks is not announced; one whose child is being
      killed is.
- [ ] A launch with a `requestId` that is not a UUID v4 is not announced, and
      the log says so.
- [ ] Two `run.cancel` frames for the running launch send exactly one
      `run.finished` `cancelled`.
- [ ] A connection without `launches` sends `running: []`.
- [ ] The existing runner tests stay green. `bun run check` and
      `bun run build` are green, and so is the execution-plane matrix.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/cli/src/runner/connection.ts`, `apps/cli/src/runner/launch/**`, `apps/cli/test/runner/**` | #285 | #284 does not touch them. No other open issue. |

## Open questions

None.

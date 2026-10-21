# Runner daemon and live connection (Runner pairing, slice 2)

Issue: [#151](https://github.com/AndreyBegma/DemoFlow/issues/151) · Phase 5 ·
Runner pairing slice 2 of 2 ·
[ADR-0007](../adr/0007-runner-pairing-and-connection.md) Decisions 3–4,
[ADR-0008](../adr/0008-cloud-boundary.md) ·
Builds on [135](135-runner-pairing.md)

## Summary

Slice 1 (#135) pairs a machine: `demoflow login` stores a revocable `dfr_`
device token, and `/app/machines` lists, renames and revokes machines. The
website still cannot tell whether a machine is reachable. ADR-0007 Decision 3
defines the connection: one persistent WebSocket, opened by the Runner, with
heartbeats both ways, reconnect with backoff, and state that can resume.
Decision 4 adds rotation every 30 days and immediate close on revocation.

This slice builds that connection and the process that holds it:
- a background `demoflow runner` daemon that can be set to start at login on
  Linux, macOS and Windows;
- live online status, last-seen time and last-seen address on
  `/app/machines`.

No jobs run over the socket yet. Starting runs, progress and playback are later
slices.

## Scope

### In scope

- **API**:
  - the WebSocket endpoint `/runner` (`wss://<host>/api/runner` through Caddy);
  - token authentication on the upgrade;
  - heartbeats, an online registry, last-seen time and address;
  - rotation, and a socket close on revoke.
- **CLI**:
  - `demoflow runner start | stop | status | logs`;
  - `demoflow runner install | uninstall`;
  - the connection client;
  - the post-login prompt;
  - `engines.node` raised to `>=22`.
- **Web**: online status, last seen (time and IP), and a 15 s refresh on
  `/app/machines`.

### Out of scope

- Jobs, cancel, progress, metadata sync and playback over the socket (ADR-0008
  Decision 3, ADR-0009). This slice gives the protocol a `type` field so they
  can be added.
- A system-wide service (root/admin). Autostart is per user, at login.

## Decisions

1. **A background daemon, not a foreground command.** (owner, 2026-10-21)
   - **Commands**: `demoflow runner start` (detaches from the terminal),
     `stop`, `status`, and `logs [--follow]`.
   - **One daemon per machine**: a lock file next to `credentials.json`. A
     second `start` reports the running PID and exits 0.
   - **Log**: `runner.log` in the same directory, rotated at 5 MB with 3
     files kept.
   - `demoflow logout` stops the daemon first.
2. **Autostart at login on all three OSes.** (owner)
   `demoflow runner install` registers it and `uninstall` removes it:
   - Linux: a systemd user unit (`~/.config/systemd/user/demoflow-runner.service`,
     enabled);
   - macOS: a LaunchAgent (`~/Library/LaunchAgents/dev.demoflow.runner.plist`,
     `RunAtLoad`, `KeepAlive` on crash only);
   - Windows: a Task Scheduler task at logon for the current user
     (`schtasks /Create /SC ONLOGON /TN DemoFlowRunner`), with no admin rights
     needed.
   `install` refuses without a credential file. `status` reports whether
   autostart is installed. The unit runs the same `node` and CLI path that ran
   `install`, written as absolute paths.
3. **After `demoflow login`**, the CLI asks "Start the runner now? [Y/n]".
   (owner)
   - With no TTY it does not start the daemon and prints the command instead.
   - `--start` and `--no-start` skip the question.
4. **CLI on Node 22 or later.** (owner) `apps/cli` `engines.node` becomes
   `>=22`, so the built-in `WebSocket` client is used and the CLI gains no
   dependency. The README and the CI matrix move in the same slice
   [Confirmed: today `>=20`].
5. **Transport, per ADR-0007 Decision 3.** (ADR)
   - The daemon opens `wss://<server>/api/runner`, where `<server>` is the
     one stored by `login` (#135), so `ws://` works against a local stack.
     The token is sent as `Authorization: Bearer dfr_…`; it is never put in
     the URL.
   - The API serves it on `/runner` with `@nestjs/websockets` and
     `@nestjs/platform-ws`, both pinned exactly. These are new API
     dependencies, and the API is the only workspace that gains one.
   - Messages are JSON `{ type, … }`. This slice uses `hello`, `ping`,
     `pong`, `rotate`, `rotated` and `bye`.
6. **Heartbeats** (orchestrator, within ADR-0007):
   - each side pings every 25 s;
   - a side that hears nothing for 60 s closes the socket;
   - the server marks the machine offline at close, or 60 s after the last
     message.
7. **Reconnect** (orchestrator): exponential backoff from 1 s to 60 s with
   ±20 % jitter, reset after a connection that has stayed up for 60 s. A
   second connection with the same token closes the older one with code
   `4409` (`replaced`).
8. **Rotation every 30 days, over the socket.** (ADR-0007 Decision 4;
   handshake by the orchestrator)
   1. On connect, if the token is 30 or more days old, the server sends
      `{ type: "rotate", token }`.
   2. The daemon writes `credentials.json` atomically and replies
      `{ type: "rotated" }`.
   3. Only then does the old hash stop working.
   4. If no ack arrives within 24 h, the new token is discarded and the old
      one stays. The next connect retries.
   The token's age is the new `Runner.tokenIssuedAt`.
9. **Revocation closes the socket immediately.** (ADR-0007 Decision 4)
   - `DELETE /runners/:id` (#135) and `POST /runner/logout` close a live
     socket with code `4401` (`revoked`).
   - The daemon logs the reason, does not reconnect, and exits.
   - A `401` on the upgrade does the same.
10. **Last seen: the time and the full IP, shown only to the owner.** (owner,
    ADR-0007 Consequences)
    - Only the latest values are kept, with no history, and they are deleted
      with the machine.
    - The address is the client IP as the API sees it behind Caddy and
      Cloudflare, using the same trusted-proxy setting as #120.
11. **Online status by polling.** (owner) `/app/machines` refetches
    `GET /runners` every 15 s while the page is visible
    (`document.visibilityState`).

## Data / Schema

One migration, `apps/api/prisma/migrations/<timestamp>_runner_connection`.
It alters `Runner`, a table #135 created. Nothing else touches `Runner` in
this wave.

```prisma
model Runner {
  // … slice 1 fields unchanged …
  tokenIssuedAt   DateTime  @default(now()) // backfilled from createdAt
  pendingTokenHash String?  @unique         // rotation in flight (Decision 8)
  pendingIssuedAt  DateTime?
  lastSeenAt      DateTime?
  lastSeenIp      String?
}
```

Online is not a column. It lives in an in-memory registry of open sockets, on
one API instance as today (#120). `GET /runners` adds `online: boolean`,
`lastSeenAt` and `lastSeenIp` to each machine.

## API

- `GET /runner` with `Upgrade: websocket`. Authentication is the
  `RunnerTokenGuard` check from #135, applied before the upgrade completes: an
  unknown or revoked token answers `401`, and no socket opens.
- The server sends `{ type: "hello", runnerId, serverTime }` after the
  upgrade.
- `ping` / `pong` carry `{ at }`. Every message updates `lastSeenAt`, written
  to the database at most once a minute. `lastSeenIp` is written on connect.
- The rotate and revoke flows follow Decisions 8 and 9.
- `GET /runners` extends the #135 shape, and nothing else in it changes.

## CLI

- `demoflow runner start | stop | status | logs [--follow] | install |
  uninstall`. `status` prints:
  - whether the daemon is running (PID, uptime);
  - the connection state (`connected` / `reconnecting in Ns` / `revoked`);
  - the server;
  - whether autostart is installed.
- The daemon is the same CLI binary run as `demoflow runner --foreground`
  (hidden). `start` spawns it detached, with stdio to the log and
  `windowsHide` on Windows. The autostart units call `--foreground` directly.
- The token never appears in the log, the unit files or `status`.

## UI

`/app/machines` (#135) adds:
- a status dot, green "Online" or grey "Offline";
- "Last seen" as a relative time, with the IP as a secondary line;
- the 15 s refresh.
Strings go under `machines.*`. When there is no machine, or none online, the
empty state hints `demoflow runner start`.

## Acceptance criteria

- [ ] **End to end on a local stack**:
      1. `demoflow login --server http://localhost:3670 --start`;
      2. `/app/machines` shows the machine Online within 15 s, with last-seen
         time and IP;
      3. `demoflow runner stop`, and it shows Offline within 75 s;
      4. `demoflow runner start`, Online again;
      5. Revoke on the website: the daemon exits within 2 s and `runner.log`
         says `revoked`.
      The PR shows screenshots of steps 2 and 3.
- [ ] **Authorization tests**:
      - user B's `GET /runners` never shows A's online state or IP;
      - a socket opened with A's token can never be associated with B;
      - an upgrade with a revoked or unknown token gets `401` and no socket.
- [ ] Heartbeat: with a fake clock, a client that stops ponging is closed and
      marked offline after 60 s (test).
- [ ] Reconnect: killing the API makes the daemon reconnect with backoff, and
      the delays it logs grow and are capped at 60 s (test with a fake
      clock).
- [ ] Rotation: a token 30 days old gets `rotate`. The old hash keeps working
      until `rotated` and stops after it. Without an ack, the old token still
      works after 24 h and the pending one is cleared (tests).
- [ ] A second connection with the same token closes the first with `4409`.
- [ ] `install` then `uninstall` writes and removes the unit, plist or task. A
      test covers each OS's generated file or command line. The real
      install/uninstall runs on Linux, macOS and Windows in the
      `execution-plane` matrix, under a temporary HOME or profile.
- [ ] `demoflow logout` stops a running daemon before revoking.
- [ ] No token in `runner.log`, unit files, `status` or `--json` output (test
      greps for `dfr_`).
- [ ] `engines.node` is `>=22`. The CI matrix and README agree. Every other
      CLI command behaves as before.
- [ ] `bun run check`, `test` and `build` pass. `execution-plane` is green on
      all three OSes. Woodpecker is green. After merge, staging accepts
      `wss://demoflow-app.luna-realm.com/api/runner` through Caddy and
      Cloudflare (checked by the orchestrator with a paired machine).

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i151-api | socket endpoint, registry, rotation, schema | apps/api/**, bun.lock, deploy/README.md | #135 | yes | opus |
| i151-daemon | daemon, connection client, login prompt, engines | apps/cli/**, README.md, .github/workflows/** | i151-api | no | opus |
| i151-web | online status on `/app/machines` | apps/web/** | i151-api | no | sonnet |
| i151-install | `runner install` / `uninstall` | apps/cli/src/runner/install/**, apps/cli/test/runner/install/** | i151-daemon | no | sonnet |

- **i151-api** decides the schema change on `Runner` and the socket's
  authentication boundary, so it is `opus`.
- **i151-daemon** decides how the daemon detaches and locks on three OSes,
  so it is `opus`.
- **i151-web** and **i151-install** execute a contract written here, so they
  are `sonnet`. The install mechanisms are named per OS in Decision 2.
- **i151-install** comes after **i151-daemon**: it registers the
  `--foreground` entry point that daemon builds, and both write
  `apps/cli/src/main.ts` (the daemon slot adds the `runner` command group, the
  install slot only its two subcommands inside `src/runner/install/`).

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| Runner table, migration `<timestamp>_runner_connection` | i151-api | do not open |
| bun.lock, apps/api/package.json | i151-api | do not open |
| apps/cli/src/main.ts, apps/cli/package.json | i151-daemon | i151-install registers its subcommands through the group the daemon slot adds |
| .github/workflows/** | i151-daemon (Node 22 matrix) | do not open |
| apps/web/src/i18n/en.ts | i151-web | do not open |

## Risks

- **The socket authenticates the wrong user** (critical). Mitigation:
  authentication happens on the upgrade, using #135's guard; the named
  authorization tests.
- **Cloudflare or Caddy drops idle WebSockets** (medium) [Unknown: the
  Cloudflare idle timeout on this zone]. Mitigation: 25 s pings sit well
  under Cloudflare's 100 s idle limit, and the orchestrator runs the staging
  check after merge.
- **Autostart differs per OS** (medium). Mitigation: per-OS tests of the
  generated files, and a real install/uninstall in the three-OS matrix.
- **A rotation is lost mid-write** (medium). Mitigation: the old token stays
  valid until the ack, files are written atomically, and pending tokens expire
  after 24 h.

## Open questions

- None. Default for an unsettled detail: follow ADR-0007 and #135's
  conventions (hash-only storage, 404 for foreign ids, opt-in throttles).

Depends on #135

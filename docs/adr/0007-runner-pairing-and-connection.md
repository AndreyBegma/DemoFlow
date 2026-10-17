# ADR-0007: Runner pairing, connection and credential

Status: accepted · Date: 2026-10-17

## Context

The runner executes jobs on the user's machine and must not need an inbound
port (vision §3.2, §10). A website session, a registered machine, a live
connection and a running job are four different things.

## Decision

1. **Pairing is a device-code flow**, like `gh auth login`. `demoflow login`
   asks the API for a device code, prints a short user code (`ABCD-1234`) and
   opens the browser at the approval page. The signed-in user sees the
   machine's name and OS and approves it. The runner, polling, receives its
   credential. The code expires after 10 minutes and works once. It works over
   SSH without a local browser.
2. **The credential is an opaque device token**: 256 random bits, of which the
   database stores only a hash. The runner keeps it in a file in its config
   directory readable only by the user (mode 0600; the user's profile ACL on
   Windows). No native keychain module.
3. **The connection is one persistent WebSocket**, `wss://<host>/api/runner`,
   opened by the runner: jobs, cancellation, progress, metadata sync and
   playback streaming (ADR-0009) travel over it. Heartbeats both ways,
   reconnect with backoff, and a resumable job state after a reconnect.
4. **Rotation and revocation.** The server rotates the token over the socket
   every 30 days. Revoking a machine on the website invalidates the token and
   closes its socket at once.

## Consequences

- The same proven arrangement as AgentDock's runner behind Caddy and
  Cloudflare (WebSocket through `/api/*`).
- A stolen token file is a full machine credential until it is revoked; the
  website shows each machine's last-seen time and address to make that
  visible.

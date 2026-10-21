# Pair a machine with `demoflow login` (Runner pairing, slice 1)

Issue: [#135](https://github.com/AndreyBegma/DemoFlow/issues/135) · Phase 5 ·
Runner pairing slice 1 of 2 ·
[ADR-0007](../adr/0007-runner-pairing-and-connection.md),
[ADR-0008](../adr/0008-cloud-boundary.md) ·
Builds on [120](120-accounts-api.md), [124](124-sign-in-pages.md)

## Summary

Sign-in is done (#120, #124, #126). The roadmap's next Phase 5 step is Runner
pairing. This slice registers a machine with an account through the device-code
flow ADR-0007 decided: `demoflow login` prints a code, the signed-in user
approves it on the website, and the CLI receives a revocable device token. The
website lists the account's machines and can rename or revoke them. The
persistent WebSocket connection, heartbeats, token rotation and online status
are slice 2. Nothing in this slice sends jobs or demo data to the cloud.

## Scope

### In scope

- **API** (`apps/api`): the `Runner` and `DeviceCode` tables, the device-code
  endpoints (RFC 8628 shape), approve and deny for a signed-in user, the
  machine list with rename and revoke, and a bearer-token guard with two runner
  endpoints (`self`, `logout`).
- **Web** (`apps/web`): `/app/device` (approve or deny a code) and
  `/app/machines` (list, rename, revoke), plus a link from `/app`.
- **CLI** (`apps/cli`): `demoflow login` and `demoflow logout`, and the
  credential file.

### Out of scope

- The WebSocket `wss://<host>/api/runner`, heartbeats, reconnect, token
  rotation, online status and last-seen address (slice 2, ADR-0007 Decisions 3
  and 4).
- Jobs, projects, metadata sync, playback (later Phase 5 slices, ADR-0008,
  ADR-0009).
- Account deletion, which revokes every Runner token (its own Phase 5 slice).

## Decisions

1. **Slice 1 is pairing without the socket.** (owner, 2026-10-21) The socket,
   heartbeats, rotation and online status are slice 2.
2. **Device-code flow, as ADR-0007 Decision 1**, in the RFC 8628 shape:
   - the user code is `ABCD-1234`: 8 characters from an unambiguous alphabet
     (no `0 O 1 I L`), shown with a dash;
   - the code expires after 10 minutes and works once;
   - the CLI polls every 5 s. Polling faster answers `slow_down`, and the CLI
     adds 5 s to its interval.
3. **The device token, as ADR-0007 Decision 2**:
   - 256 random bits, base64url, prefixed `dfr_` so a leaked token is
     recognisable;
   - only its SHA-256 hash is stored, like `Session.tokenHash` [Confirmed:
     `apps/api/prisma/schema.prisma`];
   - the CLI keeps it in a file with mode 0600. On Windows the file is under
     the user profile, whose ACL already limits it to the user.
4. **Only a verified email may approve.** (owner) Approve and deny sit behind
   `SessionGuard` and `VerifiedGuard` [Confirmed:
   `apps/api/src/auth/verified.guard.ts`]. An unverified user sees "verify your
   email first", with the resend button from #124.
5. **At most 20 active (unrevoked) machines per account.** (owner) Approving a
   21st answers `409 runner_limit`. The page says to revoke one first.
6. **Approval page.** (owner)
   - `demoflow login` opens `/app/device?code=ABCD-1234`. The page shows the
     code, the machine's hostname and OS, and the time the code was issued, and
     asks the person to check that the code matches their terminal before
     approving.
   - The name is prefilled with the hostname and can be edited.
   - Approve and Deny. Without `?code`, the page shows an input for the code,
     for SSH sessions with no browser.
   - A guest is sent to `/sign-in` and returned to the same URL after signing in.
7. **Machine name: the hostname, editable** on approval and later in the list.
   (owner) Names are 1–64 characters after trimming, not unique.
8. **Commands are `demoflow login` and `demoflow logout`**, per ADR-0007 and
   ADR-0008 Decision 1. (owner) Every other command keeps working without an
   account.
   - `login` when already paired prints the account email and machine name and
     exits 0. `--force` pairs again and revokes the old token first.
   - `logout` revokes the token on the server, then deletes the file. When the
     server cannot be reached, it deletes the file and says the machine is
     still listed on the website until revoked there.
9. **Default server: staging.** (owner) `https://demoflow-app.luna-realm.com`
   until production exists. `--server <url>` and `DEMOFLOW_SERVER` override it.
   The server URL is stored with the token, and `logout` uses the stored one.
10. **What the cloud stores about a machine.** (ADR-0008 Decision 2 allows
    machine metadata only) Name, OS (`process.platform` and release), CLI
    version, pairing time, last time the token was used, revocation time.
    Nothing else: no paths, no usernames, no IP address in this slice. The
    last-seen address comes with the socket in slice 2.

## Data / Schema

One migration, `apps/api/prisma/migrations/<timestamp>_runners`. It adds two
new tables, and no existing table is altered except relations on `User`.

```prisma
model Runner {
  id         String    @id @default(uuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  name       String
  os         String    // e.g. "linux 6.19.10"
  cliVersion String
  tokenHash  String    @unique // SHA-256 of the dfr_ token
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?
  revokedAt  DateTime?
  @@index([userId])
}

model DeviceCode {
  id             String    @id @default(uuid())
  deviceCodeHash String    @unique // SHA-256 of the polling secret
  userCode       String    @unique // "ABCD1234", stored without the dash
  hostname       String
  os             String
  cliVersion     String
  expiresAt      DateTime
  lastPolledAt   DateTime?
  approvedAt     DateTime?
  deniedAt       DateTime?
  approvedById   String?
  runnerName     String?   // the name the approver chose
  consumedAt     DateTime? // token issued; the row is dead
  createdAt      DateTime  @default(now())
}
```

The plaintext token is created when the CLI's first poll after approval
succeeds. It is returned once and never stored. Expired and consumed
`DeviceCode` rows are deleted when they are seen, as #120 does for its tokens.

## API

The API sees paths without the `/api` prefix; Caddy strips it [Confirmed:
`deploy/staging/Caddyfile`]. Every input is a DTO with `class-validator`.

**Public, throttled per IP** (the opt-in throttlers of #120
[Confirmed: `apps/api/src/auth/auth-throttle.ts`]):

| Method and path | Body | Answer |
|---|---|---|
| `POST /runner/device/code` | `{ hostname, os, cliVersion }` | `200 { deviceCode, userCode: "ABCD-1234", verificationUri, verificationUriComplete, expiresIn: 600, interval: 5 }` |
| `POST /runner/device/token` | `{ deviceCode }` | `200 { token, runnerId, name, email }` once approved. Before that, `400 { error }` with `authorization_pending`, `slow_down`, `access_denied` or `expired_token` (RFC 8628 §3.5) |

**Signed in** (`SessionGuard`; approve and deny also `VerifiedGuard`;
`Origin` check as in #120):

| Method and path | Answer |
|---|---|
| `GET /runner/device/:userCode` | `{ userCode, hostname, os, cliVersion, createdAt }`. `404` if unknown, expired or already used |
| `POST /runner/device/:userCode/approve` `{ name }` | `204`. `409 runner_limit` at 20 active machines |
| `POST /runner/device/:userCode/deny` | `204` |
| `GET /runners` | the user's unrevoked machines, newest first |
| `PATCH /runners/:id` `{ name }` | `200` with the machine |
| `DELETE /runners/:id` | `204`. Sets `revokedAt`; the token stops working at once |

**Runner token** (`Authorization: Bearer dfr_…`, a new `RunnerTokenGuard`).
A revoked or unknown token answers `401`. Each accepted call sets
`lastUsedAt`, at most once a minute.

| Method and path | Answer |
|---|---|
| `GET /runner/self` | `{ runnerId, name, email }` |
| `POST /runner/logout` | `204`. Revokes this token |

`GET /runners`, `PATCH` and `DELETE` act only on the caller's machines. Another
user's id answers `404`, never `403`, so ids cannot be probed.

## UI

- `/app/device` and `/app/machines` use the Glass UI primitives and the `t()`
  dictionary, as #124 did. Every string sits under `device.*` or `machines.*`.
- `/app` gains a "Machines" link next to "Account settings".
- `/app/machines` columns: name, OS, CLI version, paired, last used. Each row
  has Rename (inline) and Revoke (with a confirmation). The empty state shows
  `npx demoflow login`.

## CLI

- `demoflow login [--server <url>] [--force]`:
  1. requests a code;
  2. prints the code and the URL, and opens the URL in the browser when there
     is one (never fails without one);
  3. polls until approved, denied or expired;
  4. writes the credential file;
  5. prints `Logged in as <email> on <name>`.
  It exits 1 on deny or expiry, with the reason.
- `demoflow logout`: Decision 8.
- **Credential file**: `credentials.json` next to the global config
  [Confirmed: `apps/cli/src/config/home.ts` resolves
  `$XDG_CONFIG_HOME/demoflow/` or `%APPDATA%\demoflow\`]. It holds
  `{ server, token, runnerId }` and is written with mode 0600 through a temp
  file and a rename.
- The token never appears in logs, `--json` output or error messages.

## Configuration

- API: no new variable. `WEB_URL` already gives `verificationUri`.
- CLI: `DEMOFLOW_SERVER` (documented in the CLI's README section).

## Acceptance criteria

- [ ] **End to end on a local stack** (`bun run start:dev`):
      1. `demoflow login --server http://localhost:3670` prints a code;
      2. opening the URL while signed in and verified shows the hostname and
         OS;
      3. Approve;
      4. the CLI prints `Logged in as …`;
      5. `/app/machines` lists the machine;
      6. Revoke;
      7. `GET /runner/self` with the token answers 401.
      The PR shows screenshots of steps 2 and 5.
- [ ] **Authorization tests**:
      - user B can neither read, rename nor revoke user A's machine through
        `GET`, `PATCH` or `DELETE /runners/:id` (404 each time);
      - B's `GET /runners` never contains A's machines;
      - B cannot approve a code and attach it to A.
- [ ] An unverified user gets 403 on approve and deny. The page shows the
      verify banner.
- [ ] A 21st active machine answers `409 runner_limit`. After revoking one,
      approval works.
- [ ] Every `token` poll state is tested: pending; slow_down when polled
      within 5 s; denied (`access_denied`); expired after 10 min with a fake
      clock (`expired_token`); a second poll after the token was issued
      answers `expired_token`, never a second token.
- [ ] The database holds no plaintext token or device code. A test reads the
      rows and checks that each stored value is a SHA-256 hex digest.
- [ ] `demoflow logout` revokes the token on the server and deletes the file.
      With the server down, it deletes the file and prints the website hint.
- [ ] The credential file has mode 0600 on Linux and macOS (test). On Windows
      the test checks only that the file is under `%APPDATA%`.
- [ ] `demoflow run`, `validate`, `record` and `mcp` behave exactly as before
      without a credential file. The existing CLI tests pass unchanged.
- [ ] `bun run check`, `test` and `build` pass. `execution-plane` is green on
      all three OSes for the CLI slot. Woodpecker is green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i135-api | schema, migration, endpoints, guards | apps/api/**, deploy/staging/env/api.env.example, deploy/README.md | — | yes | opus |
| i135-web | `/app/device`, `/app/machines` | apps/web/** | i135-api | no | sonnet |
| i135-cli | `demoflow login` / `logout` | apps/cli/** | i135-api, #133 | no | sonnet |

- **i135-api** decides the schema and an authorization boundary, so it is
  `opus`.
- **i135-web** and **i135-cli** execute the contract in this spec against the
  merged API, so they are `sonnet`.
- **i135-cli** also waits for #133, whose slot owns `apps/cli/**` until it
  merges.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma, migration `<timestamp>_runners` | i135-api | do not open |
| apps/web/src/i18n/en.ts | i135-web | do not open |
| apps/cli/src/main.ts | i135-cli (after #133 merges) | do not open |
| bun.lock | nobody: no new dependency expected. A browser opener uses the platform command (`xdg-open`, `open`, `start`) | — |

## Risks

- **A cross-account approval or revoke** (critical). This is an account
  boundary. Mitigation: the named authorization tests, 404 for foreign ids,
  and approval bound to the session user.
- **Phishing with a code** (medium): someone sends the victim a
  `/app/device?code=` link. Mitigation: the page asks the person to compare the
  code with their own terminal, and shows the hostname, OS and issue time.
- **Token leakage in the CLI** (medium). Mitigation: the 0600 file, the token
  never printed, and the `dfr_` prefix for secret scanners.
- **Polling load** (low). Mitigation: a 5 s interval with `slow_down`, the
  per-IP throttle on both public endpoints, and a 10-minute expiry.

## Open questions

- None. Default for an unsettled detail: follow RFC 8628 and #120's
  conventions (hash-only storage, opt-in throttles, 404 for foreign ids).

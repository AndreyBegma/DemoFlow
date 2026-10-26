# Share a run's video: the Share model, disk storage, upload through the runner socket

Issue: [#347](https://github.com/AndreyBegma/DemoFlow/issues/347)
Depends on: nothing. Implements [ADR-0019](../adr/0019-opt-in-share-links.md).

## Summary

[ADR-0019](../adr/0019-opt-in-share-links.md) lets a person share one render
of a run through a link that works without an account. This slice is the
API's half of creating, listing, extending and revoking a share: the `Share`
table, the directory the shared files live in, the upload that pulls one
render and a poster from the owning runner over its existing socket, the
per-file and per-user limits, and the deletes that cascade from a run, a
project and an account. The public page and file (#348), the daemon's side
(#349) and the website (#350, #351) build on it.

## Scope

### In scope

- `apps/api/prisma/schema.prisma`: the `Share` model and `ShareStatus` enum;
  `User.shares` and `Run.shares` relations.
- `apps/api/prisma/migrations/20261027090000_shares/migration.sql` (new).
- `apps/api/src/shares/` (new module): `shares.module.ts`,
  `shares.controller.ts` (session), `runner-shares.controller.ts` (device
  token), `shares.dto.ts`, `shares.service.ts`, `share-storage.ts` (the
  directory), `share-upload.service.ts` (the pull), `share-sweeper.ts`, and
  their specs.
- `apps/api/src/runner/runner-socket.ts`: `share.prepare` (server → daemon),
  `share.prepared` / `share.error` (daemon → server), `asset` on
  `video.open`, `features` on `launches.sync`.
- `apps/api/src/runner/runner-connections.service.ts`: store a connection's
  `features`; route `share.*` answers.
- `apps/api/src/videos/video-relay.service.ts`: a file sink beside the HTTP
  response sink, so an upload reuses streams, credit and timeouts.
- `apps/api/src/videos/runs.service.ts`: `machine.features` on the run page;
  after `remove`, delete the removed shares' directories.
- `apps/api/src/projects/projects.service.ts`: the same after a project
  delete and a bulk run delete.
- `apps/api/src/users/account.service.ts`: the same after an account delete.
- `apps/api/src/app.module.ts`: register `SharesModule`.
- `apps/api/.env.example`, `deploy/staging/env/api.env.example`: the share
  variables (Configuration).
- `deploy/staging/docker-compose.yml`: the `shares` volume on `api`.
- `apps/api/Dockerfile`: create `/data/shares` owned by `node` before
  `USER node`, so the named volume is writable.
- `deploy/README.md`: the shares volume, its limits, and that it is not
  backed up.

### Out of scope

- `GET /s/:token`, the file, the poster, the password unlock and the view
  counter (#348).
- The daemon's answer to `share.prepare`, the poster, `demoflow share` and
  the MCP tool (#349).
- Every web page (#350, #351).
- Replacing the file of an existing share after a re-render: #356 adds
  `POST /shares/:id/update` inside `apps/api/src/shares/**` after this
  merges (ADR-0020 §6; ADR-0019, Consequences). Keep the upload in
  `share-upload.service.ts` callable for an existing share so #356 reuses it.
- `deploy/production/`: it does not exist on `develop` yet [Confirmed]; it is
  #289's. Whichever of #289 and this slice merges second adds the `shares`
  volume and variables there too (Risks).
- Changing a share's password after creation (Open questions).

## Decisions

1. **Table.** [Source: ADR-0019 §4–5]

   ```prisma
   enum ShareStatus {
     uploading
     ready
     failed
     lost
   }

   model Share {
     id           String      @id @default(cuid())
     // 32 random bytes, base64url (`generateToken`). Stored as is: the owner
     // copies the link again (ADR-0019, Consequences).
     token        String      @unique
     userId       String
     user         User        @relation(fields: [userId], references: [id], onDelete: Cascade)
     runId        String
     run          Run         @relation(fields: [runId], references: [id], onDelete: Cascade)
     format       String
     status       ShareStatus @default(uploading)
     // The scenario's name at share time, and what the daemon sent (#349).
     title        String
     description  String?
     // `[{ title, atMs }]`, at most 100.
     chapters     Json        @default("[]")
     sizeBytes    Int         @default(0)
     posterBytes  Int         @default(0)
     width        Int?
     height       Int?
     durationMs   Int?
     // argon2id (`PasswordHasher`), null without a password.
     passwordHash String?
     expiresAt    DateTime
     views        Int         @default(0)
     failure      String?
     createdAt    DateTime    @default(now())
     updatedAt    DateTime    @updatedAt

     @@unique([runId, format])
     @@index([userId, createdAt(sort: Desc)])
     @@index([expiresAt])
   }
   ```

   - `token` comes from `generateToken()` in `apps/api/src/auth/tokens.ts`
     [Confirmed: it exists].
   - `@@unique([runId, format])`: **one share per run and format.** Creating
     a second answers `409 share-exists` with the existing id; the website
     shows the existing link instead.
   - `sizeBytes` is an `Int`: the 200 MB file limit is far below 2³¹.
   - `runId` cascades: deleting the run on the website deletes the share
     (ADR-0019 §5). `userId` cascades: deleting the account deletes them all.
2. **Storage.** `ShareStorage` owns one directory, `SHARE_DIR`. A share's
   files are `<SHARE_DIR>/<share.id>/file.<ext>` (`ext` is `mp4`, `gif` or
   `webm` from the format) and `<SHARE_DIR>/<share.id>/poster.jpg`. Bytes are
   written to `<name>.part` and renamed when the stream ends with the size
   its head announced; anything else deletes the `.part`. Ids are cuids from
   the database, never a string from a request, so no path is built from
   input.
3. **Limits.** [Source: owner, Phase 8 interview] `SHARE_MAX_FILE_BYTES`
   (default 209 715 200, 200 MB) and `SHARE_USER_QUOTA_BYTES` (default
   2 147 483 648, 2 GB). The quota counts `sizeBytes + posterBytes` of the
   user's shares in `uploading` and `ready`. Both are checked **before** the
   upload against the size in the run's `renders` (`Run.renders`, spec #263
   [Confirmed]) and **again** against the size the daemon's `video.head`
   announces; a head over either limit cancels the stream (`video.cancel`)
   and fails the share with `file-too-large` / `quota-exceeded`.
4. **Upload: the API pulls.** [Source: owner, "WebSocket, the relay's
   chunk protocol"; ADR-0019 §3] After the row is created (`uploading`):
   1. The API sends `share.prepare { requestId, runId, format }` and waits up
      to 30 s for the answer.
   2. The daemon answers `share.prepared { requestId, description?,
      chapters, posterSize }` or `share.error { requestId, code }`
      (`not-found`, `no-render`, `io`; any string ≤ 64, as `video.error`).
      `description` ≤ 2 000 characters; `chapters` ≤ 100 entries of
      `{ title ≤ 200 characters, atMs ≥ 0 integer }`; `posterSize` ≤ 1 MB.
   3. The API opens `video.open { streamId, runId, format, range: null,
      asset: 'poster' }` into a file sink, then `video.open { streamId,
      runId, format, range: null }` for the render. Both use
      `VideoRelay`'s existing head timeout, chunk timeout, credit and
      acknowledgements (`VIDEO_CHUNK_MAX`, `VIDEO_CREDIT`, spec #191
      [Confirmed]); the file sink acknowledges a chunk once it is written.
      Uploads count against `MAX_STREAMS_PER_RUNNER` like playback.
   4. Both files complete: `status = ready`, sizes and the render's
      `width`, `height`, `durationMs` (from `Run.renders`) stored. Any
      failure: `status = failed`, `failure = <code>`, files deleted, quota
      released.

   `asset` is sent only to a daemon that announced `share` (Decision 6), so
   a daemon that does not know the field never receives it.
5. **Lifetime.** `expiresInDays` is `7`, `30` or `90`, default `30`.
   `POST /shares/:id/extend` sets `expiresAt = min(max(expiresAt, now) + 30
   days, now + 90 days)`; a share already at the cap answers `409
   at-max-expiry`. [Source: owner, Q8]
6. **Capability.** `launches.sync` carries `features?: string[]`
   (`ArrayMaxSize(8)`, each ≤ 32), next to `runOptions` (spec #325
   [Confirmed]) — one capability list shared with the editor, which adds
   `edits` (ADR-0020). Whichever of this slice and #355/#356 lands first adds
   the field; the other appends its string. The API keeps the strings it
   knows per connection; this slice knows `share`. A share for a machine without `share` answers
   `409 runner-outdated`; an offline machine `409 runner-offline`. The run
   page's `machine` gains `features: string[]` beside `runOptions`.
   [Source: ADR-0019 §7]
7. **Who may create.** The website: the run's owner, through the session.
   The CLI and MCP (#349): `POST /runner/shares` with the device token
   (`RunnerTokenGuard` [Confirmed]); the run must be one **this** runner
   reported (`Run.runnerId`). The MCP rule (`share.allowMcp`) is enforced by
   the CLI on the machine, where the config is; the API cannot tell an MCP
   call from a CLI call and does not try.
8. **Password.** Optional, 8–128 characters, hashed with `PasswordHasher`
   (argon2id, ADR-0006 [Confirmed]) and never returned. Unlocking is #348.
9. **Deletes.** [Source: owner, Q13; ADR-0019 §5]
   - `DELETE /shares/:id` deletes the row and the directory.
   - Run delete (`RunsService.remove`), bulk run delete and project delete
     (`ProjectsService`), and account delete (`AccountService.delete`)
     delete the rows through the cascades; after the transaction commits
     each deletes the directories of the share ids it collected first.
   - `ShareSweeper`, every 10 minutes and once on boot: deletes expired
     shares and their directories; deletes any directory under `SHARE_DIR`
     with no row (the backstop for every cascade); fails `uploading` rows
     older than 15 minutes (`failure = 'timed-out'`). On boot it also marks
     `ready` rows whose `file.<ext>` is missing as `lost`.
   - Deleting a run's artifacts on the machine (`DELETE /runs/:id/artifacts`)
     does **not** touch its shares.
10. **Logging.** As the run delete does (spec #263, Decision 7): event,
    share id, run id, outcome. Never the token, the password, the title or
    the description.

## API

All under the session (`SessionGuard`) unless marked. Bodies are DTOs with
`class-validator` decorators; the global `ValidationPipe` rejects unknown
fields.

| Method and path | Body | Answer |
|---|---|---|
| `POST /shares` | `{ runId: uuid, format: RunFormat, expiresInDays?: 7 \| 30 \| 90, password?: string }` | `202 ShareView` (`status: uploading`) |
| `GET /shares` | — | `200 { shares: ShareView[], quota: { usedBytes, limitBytes, maxFileBytes } }`, newest first |
| `GET /shares/:id` | — | `200 ShareView` |
| `POST /shares/:id/extend` | — | `200 ShareView` |
| `DELETE /shares/:id` | — | `204` |
| `POST /runner/shares` (device token) | as `POST /shares` | `202 ShareView` |
| `GET /runner/shares/:id` (device token) | — | `200 ShareView` |

`ShareView`: `{ id, url, fileUrl, runId, projectId, title, format, status,
failure, sizeBytes, width, height, durationMs, hasPassword, views, expiresAt,
createdAt }`. `url` is `${WEB_URL}/s/<token>`; `fileUrl` is
`${WEB_URL}/s/<token>/file`, or `null` while a password is set.

Errors (`{ error }`, as the runs API): `404 not-found` (no such run or share
for this user — never "forbidden"), `409 format-not-rendered`, `409
artifacts-deleted`, `409 runner-offline`, `409 runner-outdated`, `409
share-exists` (with `shareId`), `413 file-too-large` (with `maxFileBytes`),
`409 quota-exceeded` (with `usedBytes`, `limitBytes`), `409 at-max-expiry`.

## Configuration

| Variable | Default | Where |
|---|---|---|
| `SHARE_DIR` | `./data/shares` (relative to the API's working directory) | `apps/api/.env.example`; staging `/data/shares` |
| `SHARE_MAX_FILE_BYTES` | `209715200` | both examples |
| `SHARE_USER_QUOTA_BYTES` | `2147483648` | both examples |

`deploy/staging/docker-compose.yml`: a named volume `shares` mounted at
`/data/shares` on `api`, and `SHARE_DIR: /data/shares` in its environment.
`.gitignore` gains `apps/api/data/` if it is not covered [Unknown].

## Acceptance criteria

- [ ] The migration `20261027090000_shares` applies on an empty database and
      on `develop`'s schema; `prisma migrate dev` reports no drift.
- [ ] With a fake daemon that announced `share` (`runner-socket.fixtures.ts`):
      `POST /shares` answers 202, the daemon receives `share.prepare`, then a
      poster `video.open` with `asset: 'poster'`, then the render's
      `video.open`; after both streams end, `GET /shares/:id` is `ready` and
      both files exist under `SHARE_DIR/<id>/` with the announced sizes.
- [ ] A daemon without `share` in `launches.sync` gets nothing and the
      request answers `409 runner-outdated`; an offline machine `409
      runner-offline`.
- [ ] A render whose size in `Run.renders` exceeds `SHARE_MAX_FILE_BYTES`
      answers 413 before any message is sent; a `video.head` over the limit
      cancels the stream and fails the share with `file-too-large`, leaving
      no file.
- [ ] A share that would push the user over `SHARE_USER_QUOTA_BYTES`
      answers `409 quota-exceeded`; deleting a share frees its bytes for the
      next one.
- [ ] `share.error`, a head timeout and a dropped socket each leave the share
      `failed` with no `.part` file.
- [ ] `POST /shares/:id/extend` follows Decision 5, including the 90-day cap.
- [ ] **Authorization:** user B gets `404` for `GET`, `POST …/extend` and
      `DELETE` on user A's share, `GET /shares` never lists A's shares, and
      `POST /shares` with A's run id answers `404`. A device token of B's
      machine cannot share a run reported by A's machine, nor a run of B's
      reported by another of B's machines.
- [ ] Deleting the run (single and bulk), its project, or the account deletes
      the share rows and, once the call returns, their directories.
- [ ] `DELETE /runs/:id/artifacts` leaves the run's shares `ready`.
- [ ] The sweeper deletes expired shares and orphan directories, fails stale
      `uploading` rows, and marks a `ready` share whose file is gone as
      `lost`.
- [ ] No log line contains a token, a password, a title or a description.
- [ ] `bun run check`, `bun run build`, `bun run test` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i347-api | the whole slice | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261027090000_shares/**, apps/api/src/shares/**, apps/api/src/runner/runner-socket.ts, apps/api/src/runner/runner-connections.service.ts, apps/api/src/runner/runner-socket.fixtures.ts, apps/api/src/videos/video-relay.service.ts, apps/api/src/videos/runs.service.ts, apps/api/src/projects/projects.service.ts, apps/api/src/users/account.service.ts, apps/api/src/app.module.ts, apps/api/.env.example, apps/api/Dockerfile, deploy/staging/docker-compose.yml, deploy/staging/env/api.env.example, deploy/README.md | — | yes | opus |

One slot: the schema, the protocol and the relay's sink are one design and
cannot be reviewed apart.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i347-api | #362 adds a distinct table (`Schedule`): an append, keep both |
| apps/api/src/runner/runner-socket.ts, runner-connections.service.ts | i347-api | #356 and #362 also add messages; cut after this merges |
| apps/api/src/videos/video-relay.service.ts | i347-api | do not open it |
| deploy/staging/docker-compose.yml, deploy/staging/env/api.env.example | i347-api | #289 may copy them into deploy/production/; #348 adds one variable after this merges |

## Risks

- **Disk fills on the shared host** (medium). The quota bounds each user, not
  the number of users. Mitigation: limits in env, expiry ≤ 90 days, `status.sh`
  can be extended to print the volume's size; watch it after launch.
- **#289 lands production without the volume** (medium). Mitigation: the
  second of the two to merge adds `shares` to `deploy/production/`; the
  reviewer of the second checks it.
- **Upload competes with playback** (low). Both use the runner's four
  streams; a fifth is `busy`. Mitigation: an upload failing `busy` fails the
  share with `runner-busy`; the person tries again.
- **The stored token** (low). A database leak exposes live links. Mitigation:
  expiry, revocation, optional password (ADR-0019, Consequences).

## Open questions

- Changing or removing a share's password after creation — default: not in
  this slice; revoke and share again.
- One share per run and format — default: yes (Decision 1); several links for
  one file is a later change if asked.

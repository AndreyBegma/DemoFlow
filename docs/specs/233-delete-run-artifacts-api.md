# Delete a run's artifacts on its machine (API)

Issue: [#233](https://github.com/AndreyBegma/DemoFlow/issues/233)
Depends on: nothing. It follows #191 (the relay), which has landed.

## Summary

[ADR-0008](../adr/0008-cloud-boundary.md) §3 lists four things the website may
make a Runner do: start a run, cancel a run, stream a video, and **delete a
run's artifacts**. Streaming shipped with #191–#193. Specs
[191](191-video-relay-api.md) and [192](192-runner-serves-video.md) left
deletion out of scope, and [193](193-run-video-page.md) left the button out.
Vision §16 lists it as an MVP criterion: "Runner access can be revoked and
local artifacts can be deleted".

This spec is the API side. It also fixes the **protocol** that the daemon
(#234) and the run page (#235) build against, the way 191 did for playback.

- The browser sends `DELETE /api/runs/:id/artifacts` with its session.
- The API checks that the run belongs to the user and that its machine is
  online.
- The API asks the Runner over its socket to delete the run's directory, and
  waits for the answer.
- On success the API records when the artifacts were deleted. The run's
  metadata stays: it is the user's history, and the library keeps listing it.

## Scope

### In scope

- `apps/api/src/videos/`: the endpoint, a small request/answer service, and
  `artifactsDeletedAt` in the run views.
- `apps/api/src/projects/projects.service.ts`: `toRunView` carries the new
  field.
- `apps/api/src/runner/`: the socket's new messages, and routing them to the
  service.
- `apps/api/prisma/`: one migration adding `Run.artifactsDeletedAt`.

### Out of scope

- The daemon's handler (#234) and the run page (#235).
- Starting and cancelling runs from the website (ADR-0008 §3's other two
  items). They need their own specs.
- Deleting the run's metadata, or a project's runs in bulk.
- Downloads and the loopback shortcut (spec 191, Out of scope).

## Protocol

Two messages are added to the runner socket, as JSON text frames.
`requestId` is a UUID v4 that the API chooses. `runId` is the **server's** run
id (`Run.id`). No path crosses in either direction (ADR-0008 §2).

| Direction | Message |
|---|---|
| API → Runner | `{ type: 'artifacts.delete', requestId, runId }` |
| Runner → API | `{ type: 'artifacts.deleted', requestId }` |
| Runner → API | `{ type: 'artifacts.error', requestId, code }` |

- **`artifacts.deleted`** means the run's directory no longer exists on the
  machine. That includes "it was already gone": the request is idempotent.
- **Error codes:**
  - `not-found`: the run is unknown to this machine (no line in its
    `reported-runs.jsonl`), or the directory fails the daemon's boundary
    check (spec 234 Decision 3);
  - `io`: the deletion failed part-way, for example a file held open on
    Windows.
- **Version skew.** A daemon that predates #234 logs `artifacts.delete` as
  unknown and never answers, so the API times out (Decision 4). An
  `artifacts.deleted` or `artifacts.error` with an unknown `requestId` is
  dropped and logged once per socket. The socket stays open.

## Decisions

1. **Endpoint.** `DELETE /runs/:id/artifacts` on `RunsController`, with the
   same `SessionGuard` and origin check as every mutating route.
   - Another user's run, or an unknown one: 404 `not-found` (#178
     Decision 5).
   - `artifactsDeletedAt` is already set: 204 at once. Nothing is sent to the
     Runner.
   - Success: 204, no body.
2. **Machine state**, checked before anything is sent, the same as playback
   (spec 191 Decision 2):
   - `run.runnerId` is null: 503 `runner-removed`;
   - the Runner is offline: 503 `runner-offline`.
3. **Runner answers:**
   - `artifacts.deleted`: set `Run.artifactsDeletedAt = now()` (the injected
     `Clock`), then 204;
   - `not-found`: 404 `artifacts-missing`. Nothing is recorded, because the
     API cannot tell "deleted by hand" from "this machine never had it";
   - `io`: 502 `runner-error`. Nothing is recorded, so the user can retry.
4. **Timeout.** No answer within **15 s**: 504 `runner-timeout`. Nothing is
   recorded. A late answer for that `requestId` is dropped. The timer uses
   the injected `Clock`.
5. **Socket close.** When the Runner's socket closes (or is replaced or
   revoked) before the answer, the pending request ends with 503
   `runner-offline`.
6. **Playback after deletion.** `GET /runs/:id/video/:format` on a run with
   `artifactsDeletedAt` set answers 410 `artifacts-deleted` before it
   contacts the Runner. It is checked after ownership and the format, and
   before the machine state.
7. **Schema.** `Run.artifactsDeletedAt DateTime?`, through
   `prisma migrate dev --name run_artifacts_deleted_at`. `RunView` (the
   `ProjectRun` of `GET /projects/:id/runs`, `lastRun` and `GET /runs/:id`)
   gains `artifactsDeletedAt: string | null`, as ISO 8601.
8. **Where it lives.**
   - `apps/api/src/videos/artifacts.service.ts` keeps the pending requests in
     a map by `requestId`, like `VideoRelay` keeps streams.
   - `RunnerConnections` routes `artifacts.*` messages to it and tells it when
     a socket closes. Use the same sink seam as `video.*`, widened or
     paralleled; do not route through `VideoRelay`.
   - `parseClientMessage` learns the two messages with `class-validator`
     DTOs: `requestId` is a UUID v4, `code` is one of the two codes.
9. **Logging.** One structured line per request, `artifacts.delete`, with the
   run id, the outcome and the duration. No email and no path.

## Acceptance criteria

API integration tests with a fake Runner socket (extend
`runner-socket.fixtures.ts`):

- [ ] the fake receives `artifacts.delete` with the server run id and a UUID
      `requestId`; on `artifacts.deleted` the answer is 204 and
      `artifactsDeletedAt` is set;
- [ ] a second `DELETE` on that run is 204 and sends nothing to the fake;
- [ ] 404 for another user's run and an unknown run, and nothing is sent;
- [ ] 503 `runner-removed` and `runner-offline`;
- [ ] `not-found` → 404 `artifacts-missing`, `io` → 502 `runner-error`, and
      `artifactsDeletedAt` stays null in both;
- [ ] no answer → 504 `runner-timeout` (fake clock); a late answer is dropped
      and the socket stays open;
- [ ] a socket close before the answer → 503 `runner-offline`;
- [ ] an answer with an unknown `requestId` is dropped, and the socket stays
      open;
- [ ] `GET /runs/:id/video/:format` after deletion → 410 `artifacts-deleted`,
      and nothing is sent to the fake;
- [ ] `GET /runs/:id`, `GET /projects/:id/runs` and `lastRun` carry
      `artifactsDeletedAt` (null, then the ISO time).
- [ ] The existing runner socket and video tests stay green.
      `bun run check`, `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/api/**` | #233 | #236 edits `apps/api/src/projects/projects.dto.ts` and `apps/api/src/videos/video-relay.service.ts` (format lists only). Rebase on whichever merges first. |

## Open questions

None.

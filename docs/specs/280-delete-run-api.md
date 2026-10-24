# Delete a run's metadata (API)

Issue: [#280](https://github.com/AndreyBegma/DemoFlow/issues/280)
Depends on: nothing. It follows #233 (deleting a run's files) and #263 (run
details), which have landed.

## Summary

The website can delete a run's video files on its machine
([233](233-delete-run-artifacts-api.md), [235](235-run-page-delete-artifacts.md))
but not the run itself: its row stays in the project's library forever. Specs
233 and 235 listed "deleting the run's metadata" as out of scope.

This spec is the API side: an owner-scoped delete of **one run's row**.

- The browser sends `DELETE /api/runs/:id` with its session.
- The API deletes the row only if the run is in one of the caller's projects,
  in one statement.
- Nothing is sent to the Runner. The run's files on the machine are not
  touched ([ADR-0008](../adr/0008-cloud-boundary.md) §3 lists "delete a run's
  artifacts" as its own action; deleting metadata is not a Runner action at
  all).

The web action is #281; deleting several runs at once is #286.

## Scope

### In scope

- `apps/api/src/videos/runs.controller.ts`: the `DELETE /runs/:id` route.
- `apps/api/src/videos/runs.service.ts`: `RunsService.remove(userId, id)`.
- `apps/api/src/videos/runs.dto.ts`: `RunIdParamsDto`.
- `apps/api/src/videos/run-delete.integration.spec.ts` (new): the tests.

### Out of scope

- The run page action (#281) and bulk delete (#286).
- Deleting the run's files on the machine (that is #233's
  `DELETE /runs/:id/artifacts`; this route never calls it).
- A soft delete, an undo, or a trash.
- Any schema change: no migration (Decision 2).
- `packages/shared`: no shared type changes. The response has no body.

## Decisions

1. **Endpoint.** `DELETE /runs/:id` on `RunsController`, behind the
   controller's `SessionGuard` and the global origin check
   (`apps/api/src/app.setup.ts`, `originCheck`), like every mutating route.
   - The `id` param is validated by `RunIdParamsDto`: `@IsString()`,
     `@Length(1, 64)`, the same rule as `RunVideoParamsDto.id`. A longer id is
     400 from the global `ValidationPipe`.
   - Success: 204, no body.
   - Another user's run, or an unknown id: 404 `{ error: 'not-found' }`
     through `runError`, the body every run route already answers
     (spec 178 Decision 5). The two are indistinguishable, so nothing leaks
     about other accounts.

   *Why:* the run routes already live on `RunsController` under `runs/:id`,
   with the same ownership rule; a second controller would duplicate it.

2. **Hard delete, no migration.** `RunsService.remove` runs
   `prisma.run.deleteMany({ where: { id, project: { userId } } })` and throws
   404 `not-found` when `count !== 1`. One statement: no read-then-delete
   race between the ownership check and the delete.

   No row references a run. `Run.stages` and `Run.renders` are JSON columns of
   the row itself (spec 263), not tables; `Run` has no child relation in
   `apps/api/prisma/schema.prisma`. Deleting the row removes everything the
   site holds about the run, so no cascade and no migration are needed.

   *Why:* a soft delete would need a migration, a filter on every run query
   (library, `lastRun`, run page, launch `ownRunId`, cursor check) and a purge
   job, for an undo nobody asked for. The data is the user's own history of a
   local tool; the files, the real artifact, stay on the machine.

3. **Repeated delete is 404, not 204.** Once the row is gone the API cannot
   tell "already deleted" from "never yours", and must not (Decision 1). The
   web (#281, #286) treats 404 after a delete as "already gone" and moves on.

   *Why:* keeping a tombstone just to answer 204 is the soft delete of
   Decision 2 by another name.

4. **Files on the machine.** Nothing is sent over the runner socket. The run's
   directory and its line in the machine's `reported-runs.jsonl` stay. After
   the delete, the site can no longer ask the machine to delete those files
   (#233 needs the row), so the web confirmation tells the user to delete the
   video files first (#281 Decision 2).

   *Why:* ADR-0008 §3 is a closed list of what the website may make a Runner
   do; chaining a file deletion onto a metadata delete would turn one click
   into an irreversible change on the machine the user did not confirm.

5. **In-flight work for that run**, none of which needs new code:
   - **A pending `artifacts.delete`** (#233) for the run: the Runner's answer
     still resolves the original request; `ArtifactsService` records with
     `updateMany`, which matches no row and does nothing.
   - **An open video stream** through `VideoRelay`: it is left to finish or be
     dropped by the browser; the relay holds no reference to the row. The run
     page unmounts the player before it deletes (#281 Decision 3).
   - **A launch** (#247): a running launch has no `runId` yet; the row only
     exists after the CLI's report, which comes at the end. A finished launch
     kept in memory (up to 10 minutes) may still carry the deleted run's id;
     its "Open the run" link then lands on the run page's 404. A late
     `run.finished` naming the deleted id becomes `runId: null` through the
     existing `ownRunId` count.
   - **A new report** from the CLI always creates a new row with a new id
     (`ProjectsService.report`); a deleted run never comes back.

   *Why:* every path already tolerates a missing row; adding cancellation
   hooks would widen the change for no user-visible gain.

6. **The project stays**, even with no runs left. `lastRun` and the run count
   of `GET /projects` are computed from the remaining rows.

7. **Logging.** One structured line per request, `run.delete`, with the run
   id and the outcome (`deleted` or `not-found`). No email, no path, no
   scenario name.

## Protocol

```
DELETE /api/runs/:id          (session cookie, Origin = WEB_URL)
204                           deleted
404 { error: 'not-found' }    unknown, another user's, or already deleted
400                           id longer than 64 characters
401                           no session
```

## Acceptance criteria

API integration tests (`run-delete.integration.spec.ts`, built on
`apps/api/src/test/test-app.ts` and the helpers the other `videos`
integration specs use to sign in and report a run):

- [ ] The owner's `DELETE /runs/:id` is 204; then `GET /runs/:id` is 404, the
      run is missing from `GET /projects/:id/runs`, and the project's
      `lastRun` is the next newest run (or null).
- [ ] Another user's run: 404 `not-found`, and the row still exists.
- [ ] An unknown id: 404 `not-found`.
- [ ] A second `DELETE` of the same run: 404 `not-found`.
- [ ] A 65-character id: 400.
- [ ] Without a session: 401; with a foreign `Origin`: rejected by the origin
      check, and the row still exists.
- [ ] With a fake Runner socket connected (`runner-socket.fixtures.ts`), the
      delete sends nothing to it.
- [ ] A run with `artifactsDeletedAt` set, and one without, both delete the
      same way.
- [ ] No file under `apps/api/prisma/` changes.
- [ ] The existing run, video, artifacts and launches tests stay green.
      `bun run check`, `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/api/src/videos/runs.controller.ts`, `runs.service.ts`, `runs.dto.ts` | #280 | #286 adds its route to `apps/api/src/projects/`, not here. Rebase on whichever merges first. |

## Open questions

None.

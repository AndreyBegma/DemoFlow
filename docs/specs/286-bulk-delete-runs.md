# Delete several runs at once from the project library

Issue: [#286](https://github.com/AndreyBegma/DemoFlow/issues/286)
Depends on: #280 (the delete semantics), #281 (`lib/run-delete.ts`, the
strings' shape). It merges after both.

## Summary

With #280 and #281 a run can be deleted one at a time from its page. Specs 233
and 235 also listed "a project's runs in bulk" as out of scope. This slice
adds a batch delete to the API, scoped to one project, and multi-select with
**Delete selected** to the project library ([178](178-projects-and-library.md),
[257](257-library-status-filter.md)).

As in #280, only the site's rows are deleted. Nothing goes to the Runner and
the video files on the machine stay ([ADR-0008](../adr/0008-cloud-boundary.md)
§3).

## Scope

### In scope

- `apps/api/src/projects/projects.controller.ts`: the
  `POST /projects/:id/runs/delete` route.
- `apps/api/src/projects/projects.service.ts`: `ProjectsService.removeRuns`.
- `apps/api/src/projects/projects.dto.ts`: `DeleteRunsDto` and
  `DELETE_RUNS_MAX`.
- `apps/api/src/projects/runs-delete.integration.spec.ts` (new): the tests.
- `apps/web/src/lib/api.ts`: `deleteProjectRuns(projectId, runIds)`.
- `apps/web/src/lib/run-delete.ts` and `run-delete.test.mjs`: the batch
  outcome mapping.
- `apps/web/src/components/projects/runs-table.tsx`: a checkbox column, the
  selection, the `SelectionBar` and the confirmation.
- `apps/web/src/i18n/en.ts`: strings under `projects.library.select.*` and
  `projects.library.bulkDelete.*`.

### Out of scope

- Deleting runs across projects, or every run of a project by filter (delete
  the project for that).
- Deleting video files in bulk (#233 is per run, and needs each machine
  online).
- Selecting runs not yet loaded ("select all 340").
- An undo.

## Decisions

1. **Endpoint.** `POST /projects/:id/runs/delete` with body
   `{ runIds: string[] }`, on `ProjectsController` (`SessionGuard`, global
   origin check). Answer: 200 `{ deleted: number }`.
   - The project is not the caller's, or unknown: 404, the same
     `NotFoundException` as `GET /projects/:id/runs`; nothing is deleted.
   - `POST` with an action path, not `DELETE` with a body: a body on `DELETE`
     is allowed but unevenly handled by proxies and clients.

   *Why:* scoping to a project means a wrong selection can never reach runs
   of another project, and the library page is the only place that selects
   runs.

2. **Validation.** `DeleteRunsDto.runIds`: `@IsArray()`, `@ArrayMinSize(1)`,
   `@ArrayMaxSize(DELETE_RUNS_MAX)`, `@ArrayUnique()`, each `@IsString()`
   `@Length(1, 64)`. `DELETE_RUNS_MAX = 100`, two library pages
   (`RUNS_PAGE_SIZE = 50`). Anything else is 400 from the global
   `ValidationPipe`, and nothing is deleted.

   *Why:* a bound keeps one request one short statement; 100 covers what a
   person selects by hand.

3. **Per-id, idempotent, one statement.** `removeRuns` checks the project as
   `runs()` does, then runs
   `prisma.run.deleteMany({ where: { projectId, id: { in: runIds } } })`
   and returns its `count`. Ids that are not runs of this project (unknown,
   already deleted, another project's or another user's) are skipped, not an
   error. The answer carries the count only, never which ids matched.

   *Why:* all-or-nothing would fail a whole batch because one run was deleted
   a moment earlier in another tab, which is exactly the state the user
   wants. The single statement is atomic either way. The count reveals
   nothing about other accounts: only this project's rows can match.

4. **Same consequences as #280.** No migration, no message to the Runner, and
   the in-flight cases of #280 Decision 5 hold per run. One structured log
   line, `runs.delete`, with the project id, the number asked and the number
   deleted.

5. **Selection in the table.** `runs-table.tsx` gains a first column of Glass
   UI `Checkbox` (`@andrewbehma/glass-ui/checkbox`):
   - each row's checkbox has the accessible label `Select {scenario}`;
   - the header checkbox selects or clears every **loaded** row; it is
     `indeterminate` when some are selected;
   - the selection is a `Set` of run ids in the table's state. It survives
     **Load more** and is cleared when the status filter changes (the page
     already remounts the table with `key={status}`).

6. **The bar.** Glass UI `SelectionBar` (exported from the package root,
   `@andrewbehma/glass-ui`), shown while something is selected: label
   `{count} selected`, **Clear**, and one danger action **Delete selected**.
   Above `DELETE_RUNS_MAX` selected, the action is disabled and the bar's
   label reads `{count} selected (at most 100 at once)`.

   *Why:* `SelectionBar` is the library's primitive for exactly this (count,
   clear, bulk actions, keyboard); the vision keeps glass for floating
   controls (§9), which this is.

7. **Confirmation.** One Glass UI `ConfirmDialog`:
   - title: `Delete {count} runs?` (`Delete 1 run?` for one);
   - consequence: `They are removed from your library. Their video files stay
     on the machine; to remove them, open a run and use Delete video files
     first. This cannot be undone.`;
   - confirm: **Delete runs** (danger); cancel: **Keep**.

8. **Results** (`bulkDeleteOutcome` in `lib/run-delete.ts`):
   - 200: the deleted ids leave the table's local state and the selection is
     cleared; then `router.refresh()` so the project header and `lastRun`
     follow. When `deleted` is less than the number sent, an info `Banner`:
     `{n} of the selected runs were already gone.`;
   - 404 (the project is gone): the existing `projects.errors.notFound` text
     in a danger `Banner`;
   - anything else, or a network failure: `auth.errors.unknown`; the
     selection stays so the user can retry.
   - When the table ends up empty and more pages exist, nothing loads by
     itself: **Load more** stays.

9. **Strings** in `en.ts`: `projects.library.select.row`
   (`Select {name}`), `select.all`, `select.count`, `select.countMax`,
   `select.clear`, and `projects.library.bulkDelete.{action, title, titleOne,
   consequence, confirm, cancel, partlyGone}`. No literal UI text (spec 121).

## Protocol

```
POST /api/projects/:id/runs/delete     (session cookie, Origin = WEB_URL)
{ "runIds": ["<uuid>", ...] }          1..100 unique strings, each 1..64 chars

200 { "deleted": 3 }                   the number of this project's runs removed
400                                    body fails validation; nothing deleted
404                                    project unknown or not the caller's
401                                    no session
```

## Acceptance criteria

API (`runs-delete.integration.spec.ts`):

- [ ] Three of the owner's runs in the project: 200 `{ deleted: 3 }`, and
      `GET /projects/:id/runs` no longer lists them; the other runs stay.
- [ ] A list mixing the project's runs with an unknown id, a run of another
      of the caller's projects and another user's run: only the project's
      runs are deleted, `deleted` counts them, and the others still exist.
- [ ] The same request twice: the second answers `{ deleted: 0 }`.
- [ ] Another user's project, or an unknown one: 404, and nothing is deleted.
- [ ] An empty list, 101 ids, a duplicate id, a 65-character id, or a
      missing `runIds`: 400, and nothing is deleted.
- [ ] No session: 401. Nothing is sent to a connected fake Runner.
- [ ] No file under `apps/api/prisma/` changes.

Web:

- [ ] The library shows a checkbox per row and a header checkbox; selecting
      shows the `SelectionBar` with the count; **Clear** and Escape empty it.
- [ ] The selection survives **Load more** and clears on a filter change.
- [ ] Above 100 selected, **Delete selected** is disabled.
- [ ] Confirming sends one `POST /api/projects/:id/runs/delete` with the
      selected ids; the rows disappear; cancelling sends nothing.
- [ ] A short `deleted` count shows the "already gone" banner; a failure
      shows the error and keeps the selection.
- [ ] `run-delete.test.mjs` covers the batch outcome mapping (200 full, 200
      partial, 404, 500, network failure).
- [ ] `bun run check`, `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/src/i18n/en.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/run-delete.ts` | #281 first | #286 extends them after #281 merges. |
| `apps/api/src/projects/projects.*` | #286 | No other open issue edits them today. |

## Open questions

None.

# Filter a project's run library by status

Issue: [#257](https://github.com/AndreyBegma/DemoFlow/issues/257)
Depends on: nothing. The library (#178) has landed.

## Summary

Vision §6, "Demo library", asks to "filter by project, date, and status".
The library is already per project (spec 178). `GET /projects/:id/runs` pages
through every run of a project, newest first, 50 at a time (spec 178,
Decision 5), so a project with many runs has no way to show only its failed
ones. This slice adds a **status** filter to that endpoint and to the
project page.

## Scope

### In scope

- `apps/api/src/projects/projects.dto.ts`: `status` on `RunsPageQueryDto`.
- `apps/api/src/projects/projects.controller.ts` and
  `projects.service.ts`: pass and apply it.
- `apps/api/src/projects/projects.integration.spec.ts`: its tests.
- `apps/web/src/lib/api.ts`: `listProjectRuns` takes an optional status.
- `apps/web/src/app/app/projects/_data.ts` and
  `apps/web/src/app/app/projects/[id]/page.tsx`: read `?status=` and pass
  it.
- `apps/web/src/components/projects/runs-table.tsx`: the control and "Load
  more" with the filter.
- `apps/web/src/i18n/en.ts`: strings in the `projects.library` block.

### Out of scope

- Filtering by date, and search. Status is the filter the stored data
  answers directly; a date range needs its own control and decisions, and no
  issue asks for it yet.
- A filter on `/app/projects` or across projects.
- Any schema change or migration. `Run.status` exists (spec 178,
  Decision 1).

## Decisions

1. **API.** `GET /projects/:id/runs?status=passed|failed`. `status` is
   optional; absent means every run, exactly as today. On
   `RunsPageQueryDto` it is `@IsOptional() @IsIn(RUN_STATUSES)`, the same
   constant `RunReportDto` uses. Any other value is 400 from the global
   `ValidationPipe`.
2. **Query.** The status joins the `where` of the existing query:
   `{ projectId, status }`. Order, page size and the cursor mechanics stay
   as they are.
3. **Cursor.** The existing check, "the cursor is a run of this project",
   becomes "a run of this project **with this status**" when a status is
   given; otherwise it is 400 `Unknown cursor`, as today.
   - *Why:* Prisma's cursor must be in the filtered set to page from it; a
     cursor from another filter would give a wrong page silently.
4. **Ownership.** Unchanged: another user's or an unknown project is 404
   (spec 178, Decision 5), checked before the status is used.
5. **Web control.** Above the runs table, a Glass UI segmented control (or
   its closest primitive) with **All**, **Passed**, **Failed**.
   - The choice is the URL's `?status=` (absent for All), so it survives a
     reload and can be linked. Changing it navigates to the page with the new
     query, and the server component loads the first page with that status.
   - An unknown `?status=` value in the URL is treated as All, not sent.
   - "Load more" passes the same status with the cursor.
6. **Empty filtered page.** "No passed runs." / "No failed runs." with the
   existing empty-state look; the unfiltered empty state is unchanged.
7. **Strings.** In `projects.library`: the control's label and three
   options, and the two empty texts.

## Acceptance criteria

API integration tests (existing style, `projects.integration.spec.ts`):

- [ ] With passed and failed runs, `?status=failed` returns only failed runs
      newest first, `?status=passed` only passed, no `status` all of them.
- [ ] Paging with a status: 51 failed runs give 50 and a cursor, and the
      second page with the same status gives the last one.
- [ ] A cursor of a passed run with `?status=failed` is 400
      `Unknown cursor`.
- [ ] `?status=running` and `?status=` are 400; another user's project is
      404.

Web:

- [ ] The control shows the URL's status; switching reloads the table with
      it; "Load more" keeps it; the empty filtered page shows its text.
- [ ] `bun run check`, `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/api/src/projects/**` | #257 | No other open issue touches `apps/api`. |
| `apps/web/src/app/app/projects/**`, `apps/web/src/components/projects/runs-table.tsx`, `apps/web/src/lib/api.ts` | #257 | No other open issue. #256 reuses `_data.ts` helpers without editing them. |
| `apps/web/src/i18n/en.ts` | #257 (`projects.library` block) | #256 adds a `dashboard` block; each edits its own block; merge the base before opening the PR. |

## Open questions

None.

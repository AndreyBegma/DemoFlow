# Delete a run from the run page

Issue: [#281](https://github.com/AndreyBegma/DemoFlow/issues/281)
Depends on: #280 (`DELETE /runs/:id`). It can be built against
[280](280-delete-run-api.md)'s contract, then merged after it, the way #235
was built against #233.

## Summary

With #280 the API can delete one run's row. This slice puts a **Delete run**
action on the run page. After it the user lands on the project's library,
where the run is gone. The confirmation says plainly that the video files on
the machine are not deleted, and points at **Delete video files** (#235) while
they still exist.

## Scope

### In scope

- `apps/web/src/lib/api.ts`: `deleteRun(runId)`.
- `apps/web/src/lib/run-delete.ts` (new) and `run-delete.test.mjs` (new): the
  result → outcome mapping.
- `apps/web/package.json`: add `src/lib/run-delete.test.mjs` to the `test`
  script.
- `apps/web/src/components/projects/delete-run.tsx` (new): the button, the
  confirmation and the error banner.
- `apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx`: render it.
- `apps/web/src/i18n/en.ts`: strings under `runPage.deleteRun.*`.

### Out of scope

- The API (#280) and bulk delete from the library (#286).
- Deleting the video files together with the run (#280 Decision 4).
- An undo.
- Docs pages and the docs sidebar.

## Decisions

1. **The control.** A danger-styled Glass UI `Button` labelled **Delete run**
   at the bottom of the run page's first `Card` (the title and metadata),
   right-aligned, separate from the playback card's **Delete video files**.
   It is always enabled: deleting a row needs no machine online.

   *Why:* the two deletes act on different things (the site's record vs the
   machine's files); keeping each in its own card keeps the labels honest.

2. **Confirmation.** Glass UI `ConfirmDialog`, the same primitive as
   `run-playback.tsx` and `delete-account.tsx`:
   - title: `Delete this run?`;
   - consequence, when the run has formats and `artifactsDeletedAt` is null:
     `The run is removed from your library. Its video files stay on the
     machine; to remove them, use Delete video files first. This cannot be
     undone.`;
   - consequence otherwise: `The run is removed from your library. This
     cannot be undone.`;
   - confirm: **Delete run** (danger); cancel: **Keep**.

   *Why:* once the row is gone the site can no longer reach those files
   (#280 Decision 4), so the user must hear that before, not after.

3. **Order on confirm.** The page calls `deleteRun`; the confirm button shows
   its pending state (`busy`). The playback card is left alone: the page
   navigates away on success, which unmounts the player and drops its range
   request.

4. **Results** (`runDeleteOutcome(result)` in `lib/run-delete.ts`):
   - 204: `gone`;
   - 404 (`not-found`): `gone` too. The run was already deleted, in another
     tab or by bulk delete, which is the state the user asked for;
   - any other failure, including a network error (`error: 'unknown'` with no
     status): the key `auth.errors.unknown` ("Something went wrong. Try
     again."), shown in a danger `Banner` above the button; the dialog closes
     and the page stays.

   On `gone`: `router.replace('/app/projects/<projectId>')`, then
   `router.refresh()`. `replace`, not `push`, so Back does not return to a
   404.

5. **Where the data comes from.** `page.tsx` passes `runId`, `projectId`,
   and `filesRemain` (`run.formats.length > 0 && run.artifactsDeletedAt ===
   null`) to `DeleteRun`. When the files are deleted on the same page,
   `RunPlayback` already calls `router.refresh()`, so `filesRemain` turns
   false without new state.

6. **Strings** live in `en.ts` under `runPage.deleteRun.*` (`open`, `title`,
   `consequenceFiles`, `consequence`, `confirm`, `cancel`). No literal UI text
   in components (spec 121). The generic error reuses `auth.errors.unknown`.

## Acceptance criteria

- [ ] The run page shows **Delete run** for every run, whatever the
      machine's state.
- [ ] The confirmation shows the "files stay on the machine… use Delete video
      files first" text for a run with formats and no `artifactsDeletedAt`,
      and the short text otherwise.
- [ ] Cancelling sends nothing.
- [ ] Confirming sends `DELETE /api/runs/:id`; on 204 the browser is on
      `/app/projects/<id>` and the run is not in the table; Back does not
      return to the deleted run.
- [ ] A 404 answer behaves like 204.
- [ ] A 500 or a network failure shows "Something went wrong. Try again."
      and the page stays.
- [ ] `run-delete.test.mjs` covers 204, 404, 500 and a network failure, and
      runs in `bun run test` for `apps/web`.
- [ ] Only Glass UI primitives (`Button`, `ConfirmDialog`, `Banner`); no
      literal UI strings in the component.
- [ ] `bun run check` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/src/i18n/en.ts`, `apps/web/src/lib/api.ts`, `apps/web/package.json` | #281 | #286 adds its own keys, client function and test file. #286 merges after #281. |

## Open questions

None.

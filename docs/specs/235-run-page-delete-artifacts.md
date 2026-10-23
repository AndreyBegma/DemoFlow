# Delete a run's video files from the run page

Issue: [#235](https://github.com/AndreyBegma/DemoFlow/issues/235)
Depends on: #233 (`DELETE /runs/:id/artifacts`, `artifactsDeletedAt`). It can
be built against [233](233-delete-run-artifacts-api.md)'s contract, then
merged after it, the way #193 was built against #191.

## Summary

[Spec 193](193-run-video-page.md) built the run page and left "deleting
artifacts" out of scope. With #233 and #234, the website can ask the machine
that recorded a run to delete that run's files (ADR-0008 §3). This slice puts
the action on the run page, and shows a run whose files are gone as such
instead of trying to play it.

## Scope

### In scope

- `apps/web/src/lib/api.ts`: `artifactsDeletedAt` on `ProjectRun`, and
  `deleteRunArtifacts(runId)`.
- `apps/web/src/components/player/`: a delete control beside the playback,
  and the "deleted" state.
- `apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx`: pass the new
  field.
- `apps/web/src/components/projects/runs-table.tsx`: a "Files deleted" badge
  on such rows.
- `apps/web/src/i18n/en.ts`: strings.

### Out of scope

- The API (#233) and the daemon (#234).
- Deleting the run itself (its metadata), or several runs at once.
- Docs pages and the docs sidebar.

## Decisions

1. **The control.** A danger-styled Glass UI `Button` labelled
   **Delete video files**, under the player in the playback card. It shows
   only when the run has formats and `artifactsDeletedAt` is null.
   - It is disabled with the hint "The machine is offline." when `machine`
     is null or offline, the same state the player already reads.
2. **Confirmation.** Glass UI `ConfirmDialog`, the same primitive as
   `delete-account.tsx`:
   - title: `Delete the video files of this run?`;
   - body: `The files are removed from {machine}. The run stays in your
     library. This cannot be undone.`;
   - confirm: **Delete files** (danger); cancel: **Keep**.
3. **Order on confirm.** The player is unmounted first, so the browser drops
   its range request and the relay cancels the stream. Then the page calls
   `deleteRunArtifacts`. While it waits, the dialog's confirm button shows
   its pending state.
4. **Results.**
   - 204: the playback card shows the deleted state (Decision 5) and the
     page calls `router.refresh()`.
   - `runner-offline`, `runner-removed`: a danger `Banner`, "The machine is
     offline. Try again when it is connected."; the player comes back.
   - `runner-timeout`, `runner-error`: "The machine did not delete the
     files. Try again."; the player comes back.
   - `artifacts-missing`: "The machine no longer has this run's files."; the
     player comes back (it will report the missing video itself).
   - Any other failure: the app's existing "Something went wrong. Try
     again." string.
5. **Deleted state.** When `artifactsDeletedAt` is set, the playback card
   shows a Glass UI `EmptyState` instead of the player: title
   `Video files deleted`, body `Deleted from the machine on {date}.`, with
   the date through `formatDate`. No request goes to the video endpoint.
   A 410 `artifacts-deleted` from the player (a race with another tab) shows
   the same state.
6. **Library.** `runs-table.tsx` shows a neutral `Badge` "Files deleted" in
   the formats cell of a run with `artifactsDeletedAt` set.
7. **Strings** live in `en.ts` under `runPage.delete.*`, `runPage.deleted.*`
   and `projects.runs.filesDeleted`. No literal UI text in components
   (spec 121).

## Acceptance criteria

- [ ] The run page shows **Delete video files** for a run with formats and
      an online machine, disabled with the offline hint otherwise, and not at
      all once the files are deleted.
- [ ] Confirming unmounts the player, then sends `DELETE
      /api/runs/:id/artifacts`; cancelling sends nothing.
- [ ] On 204 the deleted state replaces the player, and a reload still shows
      it (from `artifactsDeletedAt`).
- [ ] Each error code of Decision 4 shows its message, and the player comes
      back.
- [ ] A run with `artifactsDeletedAt` never requests its video; a 410 from
      the player shows the deleted state.
- [ ] The library row of such a run shows the "Files deleted" badge.
- [ ] Unit tests (the existing `*.test.mjs` style in `apps/web/src/lib/`)
      cover the error-code → message mapping.
- [ ] `bun run check` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/src/i18n/en.ts`, `apps/web/src/components/player/run-playback.tsx` | #235 | #236 adds two format labels and the vertical flag for `webm-vertical`. Rebase on whichever merges first. |

## Open questions

None.

# Download a run's video from the run page

Issue: [#<issue>](https://github.com/AndreyBegma/DemoFlow/issues/<issue>)
Depends on: #299 (the `?download=1` flag). It can be built
against [that spec](video-download-api.md)'s contract and merged after it,
the way #235 was built against #233.

## Summary

The run page (`/app/projects/[id]/runs/[runId]`) plays the run through the
relay ([193](193-run-video-page.md)) but offers no way to save the file. The
roadmap rules out share links: sharing is by file. This slice adds a
**Download** button to the playback card for the format that is selected in
the format switcher. The file comes from the user's machine through the API;
nothing is stored on the server.

## Scope

### In scope

- `apps/web/src/lib/playback.ts` and `playback.test.mjs`:
  `downloadUrl(runId, format)`.
- `apps/web/src/components/player/run-playback.tsx`: the button and its
  click handler.
- `apps/web/src/i18n/en.ts`: `runPage.download.*`.

### Out of scope

- The API (#299) and the daemon (no change).
- The loopback shortcut (see #299, Out of scope).
- Download from the library table, the projects list, or several formats at
  once.
- A progress bar or in-page error for a download already under way: the
  browser's download UI owns it (Decision 3).
- Docs: a later docs slice may mention it next to playback.

## Decisions

1. **What is downloaded: the selected format.** One **Download** button
   beside the format switcher, not one per format.
   - *Why:* the switcher already picks a format, and the run details card
     (`run-details.tsx`) already lists each format's size, so one button keeps
     the card small and has nothing new to explain.
2. **How: a same-origin link, not `fetch`.** `downloadUrl(runId, format)`
   returns `videoUrl(runId, format) + '?download=1'`. The click creates an
   `<a href={url} download>` and clicks it (or sets `location.href`); the
   server's `Content-Disposition: attachment` names the file.
   - *Why:* `fetch` plus a `Blob` would hold the whole video in the tab's
     memory before saving; a link lets the browser stream it to disk and
     resume it with a `Range` request. `/api` is same-origin through the
     existing rewrite, so the session cookie goes with it and the `download`
     attribute is honoured.
3. **Re-check before starting.** The click first calls `getRun(runId)` (the
   same call as the existing `refetchMachine`), updates `machine` and
   `deletedAt` from it, and starts the download only when the machine is
   online and `artifactsDeletedAt` is null. Otherwise the page shows the
   state it already has for that case (offline or removed banner, or the
   "deleted" empty state). While the check runs the button shows its pending
   state.
   - *Why:* a navigation cannot read the HTTP status, so a 503 or 410 would
     reach the user as a broken download or a page of JSON. One cheap request
     catches the common causes (machine went offline, files deleted in another
     tab) with the page's existing messages. A failure after that (timeout,
     the file missing on disk) is rare and the browser reports it as a failed
     download.
4. **When it is enabled.**
   - Files deleted: the card already renders only the "deleted" empty state,
     so there is no button.
   - No formats: the existing "no formats" banner, no button.
   - Machine removed or offline on load: the button is a disabled Glass UI
     `Button` with the hint "The machine is offline." beside it, the same
     layout as the delete button (`run-playback.tsx`, delete row).
   - While deleting the files: disabled.
   - *Why:* the same rules the delete button follows, so the two controls
     never disagree about the machine.
5. **Look.** A Glass UI `Button` with `variant="glass"` in the same row as
   the format switcher (or above the player when there is one format). No
   new component library import.
   - *Why:* a secondary action next to what it acts on; `solid` stays for
     **Run again** and `danger` for deletion.
6. **Strings** in `en.ts` under `runPage.download.*`: `button` ("Download"),
   `checking` ("Checking…"), `offlineHint` ("The machine is offline."). No
   literal UI text in the component (spec 121).

## Acceptance criteria

- [ ] With an online machine, the playback card shows **Download**;
      switching format changes the URL it opens.
- [ ] Clicking it calls `GET /api/runs/:id`; online and not deleted, the
      browser requests `/api/runs/:id/video/<format>?download=1` and saves
      the file.
- [ ] The re-check finding the machine offline or removed starts no download
      and shows the existing offline or removed banner.
- [ ] The re-check finding `artifactsDeletedAt` set shows the existing
      "deleted" state.
- [ ] An offline or removed machine on load shows the button disabled with
      "The machine is offline."; it is disabled while deleting the files.
- [ ] Playback, Retry and the delete button behave as before.
- [ ] `playback.test.mjs` covers `downloadUrl` (each format, an id that needs
      encoding); `package.json` already runs that file.
- [ ] `bun run check` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/src/components/player/run-playback.tsx`, `apps/web/src/lib/playback.ts` | this issue | No open issue touches them today. |
| `apps/web/src/i18n/en.ts` | this issue | Shared with any later web work; rebase on whichever merges first. |
| `apps/api/**` | #299 | Not touched here. |

## Open questions

None.

# Run page that plays the video through a VideoPlayer adapter

Issue: [#193](https://github.com/AndreyBegma/DemoFlow/issues/193)
Depends on: #191 (`GET /runs/:id` and `GET /runs/:id/video/:format`). It can
be built against [191](191-video-relay-api.md)'s contract, then merged after
it.

## Summary

Roadmap, Phase 6. The run library from #178 lists runs, but nothing plays.
This slice adds a page per run that plays its video through the relay
(ADR-0009 §1).

ADR-0009 §2 says playback goes through a `VideoPlayer` adapter, with two
implementations: Luna Player and the native `<video>` element.

`luna-player` on npm is still 0.1.2 on 2026-10-22, and it ships no player
component (ADR-0009 Update). So only the native implementation is built now.
The adapter is the seam where Luna plugs in once a version with the
component is published.

## Scope

### In scope

- `apps/web`: `/app/projects/[id]/runs/[runId]`, the `VideoPlayer` adapter
  with the native implementation, a link from the library table, the API
  client for `GET /runs/:id`, and strings.

### Out of scope

- The Luna implementation, and installing `luna-player`.
- Downloads, deleting artifacts, and sharing (roadmap: no public share
  links).
- The API (#191) and the daemon (#192).

## Decisions

1. **Route.** `/app/projects/[id]/runs/[runId]` is a server component that
   loads `GET /runs/:runId` through `_data.ts`, the same way the library page
   does.
   - A 404, or a run whose `project.id` is not `[id]`, calls `notFound()`.
   - A failed API call shows the existing error state of the library page.
2. **Metadata.** The page shows a readable content card (vision §9: glass
   only for chrome) with:
   - scenario name and path;
   - status, using the existing `run-status`;
   - when, as an absolute and a relative time, using the existing helpers;
   - duration;
   - failed step (1-based in the UI, as the library shows it);
   - machine name;
   - CLI version.

   Breadcrumbs lead back to the project.
3. **Formats.** The page offers the run's `formats` in this order: `mp4`,
   `webm`, `mp4-vertical`, `gif`.
   - The first one present is the default.
   - With more than one, a segmented control from Glass UI switches between
     them. Unknown strings are ignored.
   - `gif` renders as `<img>`, not through the player, because a GIF is not
     a video.
   - The source is `/api/runs/${id}/video/${format}`, same-origin, so the
     session cookie goes with it.
4. **Adapter.** It lives in `apps/web/src/components/player/`:
   - `VideoPlayer` is a props interface: `src`, `vertical: boolean`, and
     `onError(): void`.
   - `NativeVideoPlayer` renders `<video controls preload="metadata"
     playsInline>`. It uses aspect 16:9, or 9:16 for `mp4-vertical`, and
     fits within the card.
   - `choosePlayer()` returns the native player. Its doc comment names the
     trigger (a `luna-player` release with the player component, ADR-0009
     §2) and the fallback rule: when Luna fails to load, use native.
   - It is a client component, and nothing else in the page needs to be one.
5. **Availability.** The states come from `GET /runs/:id` and the player's
   `onError`:
   - `machine: null`: "The machine that recorded this run was removed. Its
     videos are no longer reachable from the site." There is no player.
   - `machine.online === false`: "<name> is offline. Start it with
     `demoflow runner start`, then retry." There is no player, and a Retry
     button refetches the run.
   - Online, and the player errors: "<name> could not send this video. The
     file may have been deleted from the machine." The page refetches first.
     If the machine went offline meanwhile, the offline message shows
     instead. A Retry button remounts the player.
   - **Why the error is not read from the response:** a `<video>` element
     exposes no HTTP status. A probe request would double the traffic. The
     run's online flag is enough to tell the two useful cases apart.
6. **Pure logic** goes in `apps/web/src/lib/playback.ts`, with no React:
   - `orderFormats(formats)`;
   - `videoUrl(runId, format)`;
   - `availability(machine, playerFailed)`, which returns one of
     `'removed' | 'offline' | 'failed' | 'ready'`.

   `playback.test.mjs` tests it with `node --test`, like `docs-nav`. The web
   `test` script runs both files.
7. **Library.**
   - In `runs-table.tsx`, the scenario cell links to the run page.
   - The `projects.library.playsLater` string and its hint are removed.
8. **Strings.** All strings go in a new `runPage` block in `en.ts`.
9. **API client.** `lib/api.ts` gains `getRun(id, target?)`, returning
   `{ run, project, machine }` as #191 Decision 9 defines it.

## Acceptance criteria

- `playback.test.mjs` covers:
  - format order, unknown formats ignored, and the default choice;
  - the URL;
  - all four availability states, including "failed while online, then
    offline after refetch".
- The run page renders:
  - metadata;
  - a player for `mp4`, `webm` and `mp4-vertical`;
  - an `<img>` for `gif`;
  - the format switcher with two or more formats;
  - the removed, offline and failed messages, with retry where specified.
- Check it against a local API with #191 and a paired daemon with #192 when
  both are on `develop`. Otherwise use a stubbed API response, and say which
  in the PR.
- The library links each run to its page, and the Phase 6 hint is gone.
- `luna-player` does not appear in `apps/web/package.json`.
- `bun run check`, `bun run test` and `bun run build` are green.

## Open questions

None.

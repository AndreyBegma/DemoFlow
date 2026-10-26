# Timeline editor with an in-browser preview on the run page

Issue: [#357](https://github.com/AndreyBegma/DemoFlow/issues/357)
Depends on #356 (the editor API).

## Summary

The owner wants to fix a video on the website without re-recording: retime
and retype captions, choose which steps zoom and how much, retitle the cards,
change the background and the window, and trim the run with any number of
freely placed cuts. Everything is dragged on a timeline and previewed at once
in the browser over the video already playing; the exact result comes from
**Render**, which the machine does (ADR-0020). This slice is the editor:
loading the model, editing it in the browser, saving, rendering and showing
progress. Export, reset and the share update are #358.

## Scope

### In scope

- `apps/web/src/app/app/projects/[id]/runs/[runId]/edit/page.tsx` (new): the
  editor route.
- `apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx`: an **Edit**
  button next to Run again / Delete [Confirmed: the page renders
  `RunAgain` and `DeleteRun`].
- `apps/web/src/components/editor/` (new): the editor shell, the timeline and
  its tracks, the inspector, the preview overlay, the render bar.
- `apps/web/src/lib/edits.ts` and `edits.test.mjs` (new): the edit state as
  pure functions (time mapping, drag, snapping, merge of cuts, dirty check,
  the request body).
- `apps/web/src/lib/api.ts`: client calls for the endpoints of #356.
- `apps/web/src/i18n/en.ts`: `editor.*`.

### Out of scope

- Export, reset and update share (#358).
- An exact preview: the browser draws an approximation (Decision 5).
- Undo history beyond the current session (Decision 7).
- Editing on a phone. The editor needs a pointer and a wide window; below
  768 px it shows a notice and a link back.

## UI

The page: the player on top, the timeline under it, an inspector on the
right (Glass UI `SidePanel` [Confirmed: exported by `@andrewbehma/glass-ui`]).
Content surfaces stay solid; glass is for the floating render bar only
(vision §9).

- **Timeline**, in output time of the current render, with a playhead that
  follows the video and seeks on click. Tracks, top to bottom:
  - **Steps:** one block per event from `startMs` to `endMs`, labelled by
    action; a targeted step shows a zoom marker when it zooms.
  - **Captions:** one block per caption; drag to move, drag either edge to
    retime, double-click to edit the text inline (Glass UI `InlineEdit`), a
    button to add one at the playhead, Delete to remove.
  - **Trim and cuts:** the two trim handles at the ends; drag on the track to
    draw a cut; drag a cut's edges or body; Delete removes it. Overlapping or
    touching cuts merge.
  - **Cards:** intro, scene and outro blocks, read-only in position.
- **Inspector**, for the selection: a step's zoom (`Toggle` + `Slider`
  1–3, default "renderer default"); a caption's text; the cards (intro
  on/off, title, subtitle; scenes on/off; outro on/off, title, CTA); style
  (background preset `SegmentedControl` of the six presets, or a colour; window
  on/off, corner radius `Slider`, shadow `Toggle`). Limits as in
  `RunEditsSchema` (#353): captions 1–120 characters, card text 1–80.
- **Render bar:** **Save** (enabled when dirty), **Render** (saves first),
  a format choice defaulting to the current render's formats (as the launch
  dialog's, spec 327 — the same component if it can be shared), and progress
  from `GET /runs/:id/render` (`Progress` with `percent`, indeterminate when
  null). On `finished` the player reloads the new file; on `failed` a
  `Banner` with the error.
- **Unavailable states**, each a `SectionUnavailable` with the reason and,
  where it helps, a link: machine offline (`runner-offline`), daemon too old
  (`runner-outdated`, "update the CLI"), artifacts deleted (410), run not
  renderable (`no-recording`, `run-unfinished`).

## Decisions

1. **Edits are kept in timeline ms; the timeline is drawn in output ms.** The
   page converts through the model's `timeMap` (#355). A drag in output time
   maps to timeline time through the segment under the pointer. Inside a card
   segment there is no timeline time: a caption cannot start in a card, and a
   cut handle snaps to the card's edge. *Why:* ADR-0020 §1 fixes edits to the
   timeline; the person sees and drags the video they watch.
2. **The first state is what the video shows.** Without `edits`, the caption
   list is seeded with every caption the model has (step captions,
   `pageCaptions`), at the times the renderer uses (a step caption from the
   step's start to its end plus 800 ms, a page caption for 3 s, each cut by
   the next [Confirmed: `TIMING.captionTailMs`, `pageCaptionMs` in
   `plan.ts`]), so saving without a change keeps every caption (#353,
   Risks).
3. **Only what changed is sent.** The request body holds `captions` only when
   the list differs from the seed, `zoom` only for steps whose value
   differs from the timeline's, and so on; an unchanged editor saves `{
   schemaVersion: 1 }` — or nothing: Save stays disabled.
4. **Zoom only on a step.** The zoom controls exist only for events with a
   `box` (ADR-0012 §2); the timeline offers no free-time zoom (ADR-0020 §2).
5. **The preview is approximate and says so.** Over the playing video the page
   draws: the caption text in a band like the renderer's; a rectangle for the
   zoom target and the zoom strength as a label (no actual zoom of the
   picture); grey veils over cut and trimmed-off ranges, and playback jumps
   over them; the background colour and corner radius in a small swatch, not
   on the video. A note under the player: "Preview — render for the exact
   result". *Why not more:* the video playing is the *current render*, with
   its own captions, zoom and cards baked in; drawing a faithful second
   composite in the browser would be a second renderer (ADR-0005).
6. **Playback uses a native `<video>` element** with the same relay URL as the
   run page (`apps/web/src/lib/playback.ts` [Confirmed]). The editor needs
   `currentTime`, seeking and `timeupdate`, which `VideoPlayerProps` does not
   expose [Confirmed: `src`, `shape`, `onError` only]. The run page keeps
   the Luna adapter.
7. **Leaving with unsaved edits** asks for confirmation (`beforeunload` and a
   `ConfirmDialog` on in-app navigation). Undo/redo (Ctrl+Z / Ctrl+Shift+Z)
   works within the page's session.
8. **A failed run** can be edited, but the trim's end handle stops at the
   failed step and a cut cannot cover it (#354, `trim-hides-failure`); the
   track shows why on hover.

## Acceptance criteria

`apps/web/src/lib/edits.test.mjs` (`node --test`, like the other lib tests
[Confirmed: `apps/web/src/lib/*.test.mjs`]):

- [ ] Output → timeline → output round-trips within 1 ms on a map with idle
      segments and two cards; a time inside a card maps to its edge.
- [ ] Seeding: a model with two step captions and one page caption gives
      three captions at the renderer's times; an unchanged state is not dirty
      and builds no `captions` key.
- [ ] Drawing a cut over another merges them; a cut over the failed step of a
      failed model is refused; trim handles never cross.
- [ ] Moving a caption past the next one keeps the list ordered and
      non-overlapping (the next one is pushed or the move stops — the
      function documents which).

Manual check on staging with a paired machine (written in the pull request):

- [ ] Edit opens the editor for a run; captions, a zoom, a cut, an outro
      title and a background change, Save, Render: the new video has them.
- [ ] Machine offline: the editor shows the offline state and no tracks.
- [ ] Another user's run id in the URL is a 404 page (the API answers 404).
- [ ] `bun run check` and `bun run build` are green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i357-state | edit state and API calls | apps/web/src/lib/edits.ts, apps/web/src/lib/edits.test.mjs, apps/web/src/lib/api.ts | #356 merged | yes | opus |
| i357-ui | the editor page and components | apps/web/src/app/app/projects/[id]/runs/[runId]/edit/**, apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx, apps/web/src/components/editor/**, apps/web/src/i18n/en.ts | i357-state | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| `apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx` | i357-ui | #350 (Share dialog) adds a button to the same row; #358 adds nothing here. Rebase on whichever lands first. |
| `apps/web/src/i18n/en.ts` | i357-ui | #350, #351, #358, #363 add their own keys: append-only blocks, rebase. |
| `apps/web/src/lib/api.ts` | i357-state | #350, #351, #363 add calls: rebase. |

## Risks

- **Medium — the preview misleads.** It cannot show the real zoom or the
  card look. Mitigation: Decision 5's note, and Render is one click away.
- **Medium — a large timeline is slow to drag.** Mitigation: tracks render
  only the visible window; the state functions are pure and tested.

## Open questions

- Should the timeline zoom horizontally for long runs? Default: yes, with
  Ctrl+scroll and a fit-to-width button.

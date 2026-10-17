# Renderer spike — Remotion and an FFmpeg compositor on one render plan

Issue: [#4](https://github.com/AndreyBegma/DemoFlow/issues/4) · Phase 1 ·
Decisions: [ADR-0004](../adr/0004-recording-is-separate-from-rendering.md),
[ADR-0005](../adr/0005-renderer-chosen-by-spike.md)

Depends on #3
Gate: the owner watches both videos and chooses; ADR-0005 is accepted in a
separate pull request after this one merges.

## Summary

The core technical risk of DemoFlow is whether a functional browser
recording can become a video that looks like a product presentation. This
item answers it twice: one **render plan** computed from the timeline, and two
renderers that draw it — Remotion and an FFmpeg compositor — so the
comparison is of renderers, not of two different interpretations of the
timeline. It ends with a report and a recommendation; the owner decides.

## Scope

### In scope

- `packages/renderer` (`@demoflow/renderer`), ESM, Node, Vitest.
- `buildRenderPlan(runDir, options): RenderPlan` — pure except for one FFmpeg
  probe of the source.
- Two implementations of `Renderer.render(runDir, plan, out)` writing
  `render/<renderer>.mp4` and updating `result.json` (`rendering` stage,
  `renders[]`).
- `bun run --filter @demoflow/renderer spike <runDir>` rendering both.
- `docs/research/renderer-spike.md` with the comparison, and ADR-0005
  amended with the recommendation (status stays `proposed`).

### Out of scope

- Titles, scene transitions and export formats other than MP4 (Phase 4).
- Choosing the renderer — the Gate.

## Decisions

The render plan, in output time:

- **Time map**: idle stretches (no timeline event and FFmpeg `freezedetect`
  reports a frozen frame) longer than `idle.thresholdMs` (1 000) are
  compressed to `idle.compressToMs` (400). A spinner moves, so it is never
  frozen and never cut.
- **Cursor**: a drawn arrow cursor following `pointer.from → pointer.to` of
  each event with ease-in-out over the event's movement time, resting
  between events. Hidden before the first pointer event.
- **Click emphasis**: an expanding ring, 300 ms, at the click point.
- **Camera**: zoom 1.6× centred on the target box of `click`, `fill` and
  `select` steps, eased in over 500 ms before the action and out 400 ms
  after; consecutive targets closer than 400 px keep the zoom and pan.
  Never zoom past the source pixels (source is 2× the viewport, ADR-0004).
- **Scroll** is the page's real scrolling — the camera does not fake it.
- **Masks**: a blurred rectangle over the target box of every `masked` event,
  from its start until the field leaves the viewport or the page navigates.
- **Captions**: `marker` (kind `caption`) and step `caption` texts as a
  lower-third for the step's duration plus 800 ms.
- **Failure** (ADR-0004 §4): a FAILED watermark on every frame when the run
  failed, and a 3 s end card "Verification failed at step N: <message>".
- **Output**: 1920×1080, 30 fps, H.264, yuv420p, `+faststart`.
- **FFmpeg binary**: `ffmpeg-static` (pinned) for both renderers, so install
  friction is measured on the same footing; a system FFmpeg on `PATH`
  overrides it.

## Acceptance criteria

- [ ] `bun run --filter @demoflow/renderer test` passes under Node.
- [ ] `buildRenderPlan` unit tests, on a hand-written timeline: an idle gap of
      3 000 ms becomes 400 ms; a 1 500 ms spinner on a changing frame is kept;
      two clicks 200 px apart produce one continuous zoom; a masked event
      yields a mask rect for its whole visible span.
- [ ] For the engine's `customers.demo.json` and `failing.demo.json` runs,
      both renderers write an MP4 that `ffprobe` reports as 1920×1080, 30 fps,
      H.264, and `result.json` lists both under `renders[]`.
- [ ] The failing run's MP4s show the watermark on the first and last frame
      and end on the failure card (checked by extracting both frames).
- [ ] The `login.demo.json` MP4s: in every frame between the password
      event's start and the navigation, the password field's box is covered
      (a frame sampled every 500 ms differs from the unmasked source inside
      the box).
- [ ] `docs/research/renderer-spike.md` has a table per renderer: render time
      for the three fixture runs on the author's machine, MP4 size, packages
      and download size added to `npm i -g demoflow`, whether it installs and
      renders on Linux, macOS and Windows [via #6's matrix when available,
      otherwise marked Unknown], licence terms quoted from Remotion's own
      licence file, and the reproducible command to render both videos.
- [ ] ADR-0005 states the recommendation and its reasons; its status is still
      `proposed`.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i4-plan | the package, the `Renderer` interface, `buildRenderPlan`, the FFmpeg probe | packages/renderer/package.json, packages/renderer/src/index.ts, packages/renderer/src/renderer.ts, packages/renderer/src/plan/**, packages/renderer/test/plan/**, packages/renderer/tsconfig.json, packages/renderer/vitest.config.ts, bun.lock | — | yes | opus |
| i4-remotion | the Remotion renderer | packages/renderer/src/remotion/**, packages/renderer/test/remotion/** | i4-plan | no | opus |
| i4-ffmpeg | the FFmpeg compositor | packages/renderer/src/ffmpeg/**, packages/renderer/test/ffmpeg/** | i4-plan | no | opus |
| i4-report | the spike script, the comparison, the ADR amendment | packages/renderer/scripts/**, docs/research/renderer-spike.md, docs/adr/0005-renderer-chosen-by-spike.md | i4-remotion, i4-ffmpeg | no | opus |

The lead adds every dependency both renderers need (`remotion`,
`@remotion/renderer`, `@remotion/bundler`, `react`, `react-dom`,
`ffmpeg-static`) and creates `src/remotion/index.ts` and `src/ffmpeg/index.ts`
as stubs re-exported from the barrel, so neither renderer slot edits a shared
file.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/renderer/package.json, bun.lock | i4-plan | a renderer that needs another dependency says so in its pull request; the lead's follow-up adds it |
| packages/renderer/src/index.ts | i4-plan | do not open |
| docs/adr/0005-renderer-chosen-by-spike.md | i4-report | — |

## Risks

- **Source sharpness at 1.6× zoom** (high): Playwright may encode the video
  at the viewport size rather than the device pixels [Unknown]. Mitigation:
  the plan slot checks the source dimensions with `ffprobe` first and reports
  them in its pull request; if the source is 1×, the zoom factor drops to
  1.25× and the report says so.
- **Remotion needs its own headless Chrome download** (medium) [Unknown],
  which adds to the install. Measured in the report, not avoided.
- **Remotion's licence** (medium): free for individuals and companies of up to
  three people, paid beyond. Mitigation: quoted from the source in the report;
  the owner decides with it in view.
- **Clock drift between video and timeline** (medium, from #3): an
  `offsetMs` option in the plan, measured once per run if #3's check
  shows drift.

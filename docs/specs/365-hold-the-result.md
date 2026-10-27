# Hold the result on screen

Issue: [#365](https://github.com/AndreyBegma/DemoFlow/issues/365)
Depends on: nothing

## Summary

A demo such as "create a post" ends right after its last action. The viewer
sees the click on **Publish** and the video stops before the new post shows
up, so the one thing the demo exists to prove (the feature works) is
never on screen. Three things in the code cause it:

- The engine closes the browser context as soon as the last step returns
  (`packages/engine/src/run.ts`, `await context.close()` after `execute`).
  The source video ends there, before a late server response has painted.
  [Confirmed]
- The renderer keeps a fixed `TIMING.tailMs = 1_000` after the last event
  (`packages/renderer/src/plan/plan.ts`), and it cannot be configured.
  [Confirmed]
- A trailing `wait` is a frozen stretch outside every `ACTIVE` action, so the
  idle trim (`render.idle.thresholdMs`, 1000 ms by default) shortens it to
  `compressToMs` (400 ms). An author who adds a `wait` to show the result
  loses it in the render. [Confirmed: `idleStretches` in
  `packages/renderer/src/plan/time-map.ts` subtracts only the `ACTIVE`
  windows]

This slice adds a hold at the end of every successful video
(`render.endHoldMs`) and a `hold` on any step. The engine records the hold and
the idle trim never cuts it. An assertion step with `zoom` keeps the camera on
the element it found for the length of its hold, so the result is both shown
and pointed at.

## Scope

### In scope

- `packages/core/src/step.ts`: `hold` in the fields every step may carry.
- `packages/core/src/project-config.ts`: `render.endHoldMs`.
- `packages/core/src/timeline.ts`: `holdMs` on `TimelineEventSchema`.
- `packages/core/schemas/*.schema.json`: regenerated
  (`bun run --filter @demoflow/core schema`; `test/json-schema.spec.ts` fails
  while they are stale).
- `packages/engine/src/run.ts`: sleep the step's `hold` after the step and
  stamp `holdMs`; on success, sleep `endHoldMs` after the last step before
  `context.close()`. `RunOptions.endHoldMs`.
- `packages/renderer/src/plan/types.ts`, `plan.ts`, `time-map.ts` (only if
  `idleStretches` needs a new input): the hold windows count as active, the
  tail is `endHoldMs`, and an assertion's zoom lasts through its hold.
- `apps/cli/src/commands/run.ts` and `render.ts` (`renderPlanOptions`): pass
  `config.render.endHoldMs` to `runScenario` and to `buildRenderPlan`.
- Tests: `packages/core/test/**`, `packages/engine/test/**`,
  `packages/renderer/test/plan/**` and one real-run test under
  `packages/renderer/test/ffmpeg/**` (Vitest under Node).
- Docs: `apps/web/src/app/docs/scenarios/page.mdx` (a `### hold` section next
  to `### Zoom`, and a "Show the result" example), and
  `apps/web/src/app/docs/config/page.mdx` (the `render.endHoldMs` row in the
  render table, next to `idle.*`).

### Out of scope

- A "wait for the page to settle" mode (network idle, stable DOM). The owner
  chose explicit holds; a polling page would never settle.
- The `demoflow record` panel. It can gain a "Hold" control later, like spec
  224's "Wait for ready".
- The `demoflow/playwright` fixture (`packages/playwright`). It records a
  `.demo.json`, the engine replays it, and a hold in that file just works.
- Failed runs. They keep ending at the failure, followed by the failure card
  (ADR-0004 §4).
- A new overlay style beyond the highlight in Decision 5.

## Decisions

1. **`render.endHoldMs`**, an integer from 0 to 10000, default **2500**
   (owner, R1). After the last step of a **successful** run the engine keeps
   recording this long. The renderer keeps the same length after the last
   event and puts the outro card (if any) after it. `0` gives the old ending
   minus the 1 s tail: the video ends at the last event.
   - *Why in `render.*` and not in the scenario:* it is a style choice for the
     whole project, like `idle` and `cards`. A scenario that wants more uses a
     `hold` on its last step (Decision 2).
   - `TIMING.tailMs` is removed; `endHoldMs` replaces it.
2. **`hold` on any step**: an integer from 100 to 10000 ms, optional, in
   `common` next to `caption`, `timeoutMs` and `record` (owner, R1). After the
   step's action returns, the engine sleeps `hold` ms. The timeline event
   keeps `endMs` at the end of the action and adds `holdMs`, so the action's
   duration stays truthful and the renderer knows the window
   `[endMs, endMs + holdMs]`.
   - A `hold` on an off-camera step (`record: false`) is refused at parse
     time, because nothing would show it.
   - A `hold` on the last step and `endHoldMs` both apply: the hold first,
     then the end hold.
   - A step that fails does not hold. The run stops at the failure as today.
3. **The idle trim never cuts a hold.** Every hold window and the end-hold
   window join the `active` intervals passed to `idleStretches`, so a frozen
   page during a hold plays at real speed. This is the reason `hold` exists
   rather than `wait`. `wait` keeps its current behaviour (it is idle and gets
   compressed), and the docs say to use `hold` to show something.
4. **The engine records the hold.** `RunOptions.endHoldMs` (default 0, so
   callers that do not pass it keep today's behaviour) is slept after a
   successful `execute`, before `marked.list()` and `context.close()`. The CLI
   passes `config.render.endHoldMs`. Holds count towards the run's
   `durationMs`.
5. **An assertion with `zoom` stays zoomed through its hold** (owner, R2). On
   an `assertVisible` or `assertText` that has `zoom`, the shot's `endMs` in
   `cameraKeyframes` becomes `out(endMs + holdMs)`; on the last step it also
   covers the end hold. The camera then zooms out over 400 ms as usual, or the
   video ends zoomed in if the hold runs to the end.
   - Assertion steps already accept `zoom`: `step('assertVisible',
     { target, ...zoom })` and `assertText` in `packages/core/src/step.ts`.
     ADR-0012 is unchanged: nothing zooms unless the step asks. [Confirmed]
   - **Highlight:** for the same window, a soft outline is drawn around the
     asserted element's box (2 px, the frame's accent colour, 8 px corner
     radius, fading in over 200 ms). It is drawn only when the step has
     `zoom`, because the owner asked for the highlight together with the zoom.
     It is planned like a click ring (`ClickRing` in
     `packages/renderer/src/plan/types.ts`) and follows the camera and the
     vertical and square crops.
6. **Old runs re-rendered.** `demoflow render` on a run recorded before this
   change has no `holdMs` and a source that ends about at the last event. The
   tail is clamped to the source's duration, so these runs render as before,
   minus whatever the old 1 s tail took beyond the source. No migration is
   needed.

## Configuration

```jsonc
// demoflow.config.json
{ "render": { "endHoldMs": 2500 } }   // 0–10000, default 2500
```

```jsonc
// a step
{ "action": "click", "target": { "role": "button", "name": "Publish" } },
{ "action": "assertVisible", "target": { "text": "My first post" }, "zoom": true, "hold": 2000 }
```

`hold`: 100–10000 ms. Refused on a `record: false` step.

## Acceptance criteria

- [ ] `ProjectConfigSchema` accepts `render.endHoldMs` 0–10000, defaults it
      to 2500, and refuses −1, 10001 and 1.5. `StepSchema` accepts `hold`
      100–10000 on every action, refuses 99 and 10001, and refuses `hold`
      together with `record: false`. The committed `schemas/` match
      `jsonSchemas()`.
- [ ] Engine: a two-step scenario with `hold: 1500` on step 0 and
      `endHoldMs: 2000` produces a timeline whose event 0 has `holdMs: 1500`
      and `endMs` at the end of the action. Event 1 starts at least 1500 ms
      after event 0's `endMs`, and the source video lasts at least 2000 ms
      past event 1's `endMs`.
- [ ] Engine: a run whose step fails does not sleep `endHoldMs` (duration
      within 500 ms of the failure).
- [ ] Renderer plan (unit, `packages/renderer/test/plan/**`): with a freeze
      covering a step's whole hold window, the time map keeps that window at
      1:1. The same freeze covering a `wait` of the same length is compressed
      to `compressToMs`.
- [ ] Renderer plan: the video ends at `lastEvent.endMs + endHoldMs` (in
      output time, before any outro card), clamped to the source's duration.
      `endHoldMs: 0` ends it at the last event.
- [ ] Renderer plan: an `assertVisible` with `zoom: true` and `hold: 2000`
      has a camera keyframe at full zoom at `out(endMs + 2000)` and an outline
      overlay covering `[out(endMs), out(endMs + 2000)]`. Without `zoom` there
      is no zoom and no outline.
- [ ] **Real run** (`packages/renderer/test/ffmpeg/**`, the fixture app): a
      scenario that clicks a button which reveals an element after 600 ms,
      with `endHoldMs: 2500`. In the rendered MP4 the revealed element is
      visible in every sampled frame from the moment it appears until at
      least 2500 ms before the end. Sample the frames the way
      `render.spec.ts` already does.
- [ ] Failed runs render exactly as before: the frames up to the failure,
      then the failure card. The existing failure-card tests pass unchanged.
- [ ] `demoflow render` of a run directory recorded before this change (a
      fixture timeline without `holdMs`) succeeds, and its duration does not
      exceed the source's.
- [ ] The docs pages describe `hold`, `render.endHoldMs`, and why `hold`
      rather than `wait`, with the example above.

## Parallel plan

Honestly one slot. The timeline field, the engine and the renderer are one
contract and change together, and the renderer cannot be tested without the
engine's `holdMs`.

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i365-hold | the hold end to end | packages/core/src/step.ts, packages/core/src/project-config.ts, packages/core/src/timeline.ts, packages/core/schemas/**, packages/core/test/**, packages/engine/src/run.ts, packages/engine/test/**, packages/renderer/src/plan/**, packages/renderer/test/**, apps/cli/src/commands/run.ts, apps/cli/src/commands/render.ts, apps/cli/test/**, apps/web/src/app/docs/scenarios/page.mdx, apps/web/src/app/docs/config/page.mdx | — | yes | opus |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/core/src/step.ts, project-config.ts, timeline.ts, packages/core/schemas/** | i365-hold | Phase 8 slices #353 (edits.json) and #361 (`schedule`) also edit `packages/core`. Merge #365 first, or rebase onto it. The schema files are regenerated, never hand-merged |
| packages/renderer/src/plan/plan.ts | i365-hold | #353 and #354 (edits and trims) apply to the same plan. Whoever merges second rebases |
| apps/cli/src/commands/render.ts (`renderPlanOptions`) | i365-hold | #355 adds `edits.json` there |

## Risks

- **Medium: longer runs and CI time.** Every successful run grows by 2.5 s.
  Mitigation: the fixture's CI scenarios and real-run tests set
  `endHoldMs: 0` except the one test that checks it.
- **Medium: the visual baselines change.** The extra tail changes the frame
  count of renders that `packages/renderer/test/visual/**` compares.
  Mitigation: regenerate the baselines in this pull request, as the roadmap
  asks of an intended change.
- **Low: clock offset at the end.** The tail is measured in timeline time and
  converted with `toSource`; a source shorter than expected is clamped
  (Decision 6) rather than read past its end.
- **Low: highlight on a moving element.** The box is the one measured when the
  assertion passed. An element that animates afterwards drifts out of its
  outline. The docs advise putting the hold on a settled element.

## Open questions

- Should a `hold` on a step that the page annotates with `window.demoflow.caption`
  extend the caption? Default: no. Captions keep their own timing
  (`captionTailMs`, `pageCaptionMs`).
- Should the outline also show on a `waitFor` with `zoom`? Default: no, only
  the two assertions (owner, R2).

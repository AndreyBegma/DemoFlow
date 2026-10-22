# `data-demoflow-mask` masks a marked element in the video

Issue: [#197](https://github.com/AndreyBegma/DemoFlow/issues/197)
Depends on: nothing

## Summary

Roadmap, Phase 7, item 1. [ADR-0013](../adr/0013-page-side-contract.md) §2
fixes the contract. An element the application marks with `data-demoflow-mask`
is blurred in the rendered video whenever it is on screen. No package and no
scenario step are needed.

- The engine watches every document of a run from inside the page, frame by
  frame. It records when each marked element is on screen, and where.
- The timeline carries these intervals in a new optional field,
  `maskedElements`.
- The renderer blurs them the way it blurs masked `fill` fields.

Masked `fill` fields (#18, #155, #185) are unchanged. This is a second source
of masks, next to them.

## Scope

### In scope

- `packages/core/src/timeline.ts`: `maskedElements` on `TimelineSchema`, with
  its type exported from `index.ts`.
- `packages/engine/src/execute/marked-masks.ts` (new):
  - the page script, installed with `context.addInitScript` next to the
    navigation probe (#117);
  - the engine side, which collects what the page reports and maps it onto
    the engine clock.
- `packages/engine/src/run.ts`: install the script, and write
  `maskedElements` into the timeline.
- `packages/engine/src/execute/actions.ts`: the `assertText` message rule
  (Decision 9).
- `packages/renderer/src/plan/`: mask spans for `maskedElements`.
- `apps/fixture`: a page with a marked element, and the scenario
  `masked-elements.demo.json` for the end-to-end test.

### Out of scope

- Iframes and shadow DOM (ADR-0013 §6).
- Masking the raw source recording or `screenshot` step images (ADR-0003 §5,
  ADR-0013 §2).
- The website's docs page (`apps/web/src/app/docs/scenarios/page.mdx`). A live
  worker owns `apps/web` (#193). A follow-up issue adds a section there once
  #193 has merged, using the user-facing text below.
- The ready signal: #198.

## Decisions

1. **Presence masks, whatever the value.** `data-demoflow-mask`,
   `data-demoflow-mask=""` and `data-demoflow-mask="false"` all mask.
   - *Why:* a value that unmasks is one typo away from a leak. To unmask, the
     application removes the attribute.
2. **The element's border box is masked.** The box comes from
   `getBoundingClientRect()`, in viewport CSS pixels, like every other box in
   the timeline. The renderer's usual margin (`maskMarginPx`) is added.
   - Descendants that overflow the box (absolutely positioned, or
     `overflow: visible`) are **not** covered. The docs say so.
   - *Why:* taking the union of the descendants' boxes on every frame costs a
     walk of the subtree per frame. The common case, a marked `<span>` or
     `<input>`, has no overflow.
3. **"On screen" is the masked-field rule (#18).** That is: connected,
   `checkVisibility()`, computed `visibility: visible`, and a non-empty box.
   It is the `shown` function already in `mask-watch.ts`, shared and not
   copied.
   - An element scrolled out of the viewport is still on the page. Its
     interval stays open, and its box moves out of the viewport.
4. **Found in the page, from document start.** An init script runs on every
   document of the context:
   - a `MutationObserver` (`childList`, `subtree`, `attributes` with
     `attributeFilter: ['data-demoflow-mask']` plus `style`, `class` and
     `hidden`);
   - a `requestAnimationFrame` loop that runs only while at least one
     `[data-demoflow-mask]` is in the document. Each frame it samples
     `document.querySelectorAll('[data-demoflow-mask]')`.

   Two page times are stamped for each element:
   - **start**: the time of the mutation that added the element or the
     attribute, if the observer saw it; otherwise the time of the last frame
     sampled *without* it. If no frame has been sampled yet on this document,
     the document's start (`0` in page time). This is never after the first
     paint that shows the element.
   - **end**: the first frame sampled without it (the #155 convention). This
     is never before the last paint that shows it.

   *Why in the page, and not at step boundaries like masked fills:* the
   application decides when the element appears, often in the middle of a
   `wait` or after a fetch. A step-boundary start would leak every frame up to
   the step's end.
5. **The page reports; the engine does not poll.** The script calls a binding
   (`page.exposeBinding`, under a name in the `demoflow.` namespace that
   page code cannot reach casually) on every change:
   - appeared, with its box;
   - box changed;
   - gone.

   Each report carries the page time and an element id that is unique per
   document. Reports are batched per frame. The engine keeps them, so a
   document that navigates away loses nothing it has already reported.
6. **Clock mapping errs safe on both edges.** Page time maps onto the engine
   clock through the sync-mark exchange (#19, #48, `MaskWatch.read`), done
   once per document when its first report arrives, with
   `SYNC_EXCHANGES` round trips.
   - A **start** uses the bound that errs early: the maximum over the round
     trips of `sentMs − pageMs`.
   - An **end** uses the bound that errs late: the minimum of
     `receivedMs − pageMs`, as `MaskWatch` does today.

   If a document's exchange fails, for example because it navigated first,
   that document's reports fall back to step boundaries:
   - a start is the `startMs` of the step during which the report arrived, or
     of the step before it when the report arrived in the first 50 ms of a
     step;
   - an end is the `endMs` of the step during which it arrived.

   *Why:* a late start or an early end shows the secret. A late end and an
   early start only blur a little longer.
7. **A box change splits the interval.** When the box moves by more than 1 px
   on any edge, the open interval ends at that frame's time and a new one
   starts at the previous frame's time. Neighbouring intervals therefore
   overlap by one frame, which `MaskVisibilitySchema` allows once the earlier
   one is closed.
   - The renderer does **not** shift these boxes by page-scroll events, as it
     does for fills. The engine has already measured them in viewport space.
   - *Why:* a marked element can move for reasons the timeline does not
     record, such as layout, animation or an app-driven scroll. Measured
     boxes cover every one of those.
8. **Caps, then the whole viewport.** At most 200 marked elements per run,
   and at most 2,000 intervals per element. Past either cap, one final entry
   is recorded:
   - its box is the whole viewport;
   - it starts at the report that crossed the cap;
   - it has no end, so the mask lasts to the end of the video.

   No warning is printed. `EngineObserver` has no warning hook, and adding one
   would need `apps/cli`, which a live worker owns. The blurred viewport in the
   video is the signal.
   - *Why:* the timeline stays bounded, and crossing a cap can only blur more.
9. **`assertText` does not leak a marked element's text.** When the step's
   target is a marked element, or inside one
   (`element.closest('[data-demoflow-mask]')`), a failure message reads:

   ```
   expected text "<scenario text>" in a masked element
   ```

   The text that was found is not included. The scenario's own text is not
   secret (ADR-0003 §5), so it stays.
   - *Why:* the failure card (ADR-0004 §4) renders the message into the
     video.

   Other steps already put no page text in their messages.
10. **Timeline shape.** The new field is
    `maskedElements?: Array<{ intervals: MaskVisibility }>`, with
    `intervals.min(1)`. There is one entry per element, in the order elements
    first appeared, and `schemaVersion` stays `1`.
    - An element removed and inserted again is the same DOM node, so it keeps
      its entry. A new node gets a new entry.
    - The field is omitted when it would be empty. Existing timelines,
      renders and the visual baselines (#73) are unchanged.
    - *Why a top-level field:* `maskVisibility` belongs to a masked `fill`
      event (its refinement says so). A marked element belongs to no step.
11. **Navigation.** An interval still open when its document is replaced ends
    at the `endMs` of the step during which the navigation committed. That
    errs late. The renderer then applies spec 146's `documentEnd` to it, as it
    does for `maskVisibility` intervals, except when the interval overlaps a
    sibling. A failed run keeps open intervals open to the end of the video,
    as #42 does.
12. **The renderer.** `maskSpans` gains a second loop over
    `timeline.maskedElements`. Each interval becomes a span:
    - it starts at `out(startMs) − leadMs` and ends at
      `out(endMs) + trailMs`, or at the end of the video when the interval is
      open;
    - it has one static key, with the grown box;
    - `documentEnd` applies, except when the interval overlaps a sibling;
    - holds (spec 114) and the vertical export (#176) use these spans as they
      use the others.

## User-facing text (for the docs follow-up)

> Add `data-demoflow-mask` to any element that must not appear in the video —
> an API key, an e-mail address, a balance. DemoFlow blurs the element's box
> whenever it is on screen; nothing else is needed. The attribute masks the
> rendered video only: the raw recording in the run directory and `screenshot`
> images are not masked. Content in iframes or shadow DOM, and content that
> overflows the marked element's box, is not covered — mark the element that
> holds it.

## Acceptance criteria

Vitest under Node, on the execution-plane matrix (Linux, macOS and Windows):

- **Core:** `TimelineSchema` accepts `maskedElements`. It rejects an empty
  `intervals`, unordered intervals, and an open interval that is not last.
  Every existing timeline fixture still parses.
- **Engine, inline pages** (served like `mask.spec.ts` does), each checked
  against the recorded frames with `page-frames.ts`:
  - marked from load: one interval, starting at or before the first frame
    that shows the element;
  - inserted by `setTimeout` 300 ms into a `wait`: the start is at or before
    its first frame;
  - removed, `display: none`, `visibility: hidden`, and attribute removed
    (one test each): the end is at or after its last frame;
  - attribute added to an element already shown: an interval starts at or
    before the first frame after the change;
  - a CSS `transform` animation: every frame's element box lies inside the
    union of the intervals covering that frame;
  - scrolled out of the viewport: the interval stays open;
  - navigated away while shown: the interval ends no earlier than the old
    document's last frame;
  - a failed run: the open interval stays open;
  - no marked element: the timeline has no `maskedElements` key;
  - 201 marked elements: the last entry is the whole viewport and open;
  - a failing `assertText` inside a marked element: the message does not
    contain the element's text.
- **Renderer, plan:** a `maskedElements` interval gives a span from
  `out(startMs) − lead` to `out(endMs) + trail`, with a static box grown by the
  margin. Page-scroll events do not move it.
- **End to end**, modelled on the #185 test in
  `packages/renderer/test/ffmpeg/render.spec.ts`:
  - the fixture's `masked-elements.demo.json` is recorded and rendered;
  - on every output frame where the unmasked render shows the marked
    element, the masked render differs from it inside the element's box.
- `bun run check` and `bun run build` are green, and so is the
  execution-plane matrix.

## Open questions

None.

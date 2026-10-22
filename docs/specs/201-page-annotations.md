# Scenes and captions from the page: `window.demoflow.scene()` and `caption()`

Issue: [#201](https://github.com/AndreyBegma/DemoFlow/issues/201)
Depends on: #198, and through it #197. This issue extends the `window.demoflow`
object and the page-script install that #198 introduces, and adds a timeline
field next to #197's `maskedElements`. Start from `develop` after #198 has
merged.

## Summary

Roadmap, Phase 7, item 3. [ADR-0014](../adr/0014-page-annotations.md) extends
[ADR-0013](../adr/0013-page-side-contract.md) for it. The application sets
scenes and captions itself:

```js
// when the checkout page has rendered
window.demoflow?.scene('Checkout');
// when the payment form opens
window.demoflow?.caption('Paying with a card');
```

- A page `scene` gives the same scene card as a scenario `marker` with
  `kind: "scene"` at that moment.
- A page `caption` gives the same lower-third as a `caption` marker, shown for
  3 s or until the next caption.

The engine records each call at the time it receives it, in a new optional
timeline field, `annotations`. The renderer reads that field next to the
step markers.

## Scope

### In scope

- `packages/core/src/timeline.ts`: `annotations` on `TimelineSchema`, with
  its type exported from `index.ts`.
- `packages/engine/src/execute/annotations.ts` (new):
  - the page methods, added to the object #198 defines;
  - the binding;
  - the engine-side collector.
- The page-script install (`installPageScripts`, #198 Decision 9).
- `packages/engine/src/run.ts`: write `annotations` into the timeline.
- `packages/renderer/src/plan/`:
  - scene cards from `scene` annotations (`cards.ts`);
  - captions from `caption` annotations (`plan.ts`).
- Tests in `packages/core/test`, `packages/engine/test/execute`, and
  `packages/renderer/test/plan`.

### Out of scope

- The website's docs page. #203 adds it after this issue merges, using the
  user-facing text below.
- `demoflow record` turning page annotations into steps (`apps/cli/**`).
- An npm package wrapping the global.
- A switch that turns off page annotations only (ADR-0014 §7).
- Iframes and shadow DOM (ADR-0013 §6).

## Decisions

1. **One object, extended.** #198 defines `window.demoflow` as a frozen
   `{ version: 1, ready }`. This issue adds `scene` and `caption` to that same
   definition, in the same install. It does not define the property a second
   time.
   - *Why:* `Object.freeze` forbids adding methods later. Two scripts that
     each define the property would race on every document.
2. **Validation in the page and again in the engine.** A valid text is a
   string that is non-empty after `trim()` and at most 120 characters after
   trimming. Anything else is ignored: the method returns `undefined` and
   does not throw. The trimmed text is what is recorded.
   - Page code can reach the binding directly, so the engine checks again and
     drops what fails. The binding is named in the `demoflow.` namespace, as
     #197's is.
   - *Why 120:* it is the limit of a step `caption` (`step.ts`). A page caption
     fits wherever a step caption fits, including the vertical caption band
     (#176).
3. **The time is when the engine receives the call.** The binding's callback
   reads the engine clock. There is no sync-mark exchange, unlike #197's
   masks.
   - *Why:* binding latency is a few milliseconds. A scene card or a caption
     a few milliseconds late is invisible, and #197's careful clock mapping
     exists for secrets, not for labels.
4. **Main frame only.** The binding's `source.frame` must be the page's main
   frame. Otherwise the call is dropped (ADR-0013 §6).
5. **A cap of 100 per run**, counted in the engine across all documents. Calls
   past the cap are dropped and nothing is printed, as #197 Decision 8 does
   (`EngineObserver` has no warning hook).
6. **Before the first step and after the last.**
   - A call received before step 0 starts is recorded at step 0's `startMs`.
     Scenario markers cannot be earlier either, and the timeline refines the
     sync mark against the first event.
   - A call received after the last step is recorded as it is. The renderer
     already drops scene cards at or after the end of the page and clamps
     captions to the end of the video.
7. **Timeline shape.**

   ```ts
   annotations?: Array<{ atMs: number; kind: 'scene' | 'caption'; title: string }>
   ```

   - `kind` is `MarkerKindSchema` and `title` is a trimmed string of
     1–120 characters;
   - entries are in non-decreasing `atMs`;
   - the field is omitted when empty;
   - `schemaVersion` stays `1`, and existing timelines, renders and visual
     baselines (#73) are unchanged.
   - *Why a top-level field:* events are steps (`stepIndex`). An annotation
     belongs to no step, the same reasoning as `maskedElements`.
8. **Scene cards.** `placeCards` takes the scene markers from the events and
   the `scene` annotations, ordered by timeline time. At equal times a marker
   comes first.
   - Each one becomes a card at `out(time)`, under the existing rules: only
     with `cards.scenes.enabled`, and none at or after `pageEndMs`.
   - Both sources give the same card. The renderer does not deduplicate
     (ADR-0014, Consequences).
9. **Captions.** `captions()` builds one list from two sources:
   - step captions and `caption` markers, from `out(startMs)` to
     `out(endMs) + captionTailMs`, as today;
   - `caption` annotations, from `out(atMs)` for a new
     `TIMING.pageCaptionMs = 3000`.

   The list is sorted by start, stably. The existing rule then applies: a
   later caption cuts an earlier one, and the end of the video clamps the
   last. The vertical export (#176) reads the same list.
10. **Idle and transitions are unchanged.** An annotation is not a step, so
    it adds nothing to the renderer's `ACTIVE` set. A frozen frame around it
    stays idle and compressed. The caption's 3 s are output time, so
    compression does not shorten it.
11. **Nothing leaves the machine.** Only the trimmed text and the kind reach
    the engine. The engine stores them in `timeline.json` in the run
    directory. ADR-0008 is unchanged (ADR-0014 §2).

## User-facing text (for the docs follow-up, #203)

> Your application can label its own flow. Call
> `window.demoflow?.scene('<title>')` to start a scene, and DemoFlow puts a scene
> card in the video, just as a `scene` marker does. Call
> `window.demoflow?.caption('<text>')` to show a caption for 3 seconds, or until
> the next caption. Text is up to 120 characters, and DemoFlow keeps at most 100
> annotations per run. Other calls are ignored, and the methods never throw.
> `window.demoflow` exists only while DemoFlow runs your app, so these calls do
> nothing in production. Annotation text appears in the video as written and is
> never masked, so keep secrets out of it. Calls from iframes are ignored. The
> text stays in the run directory on your machine.

## Acceptance criteria

Vitest under Node, on the execution-plane matrix (Linux, macOS and Windows):

- **Core:**
  - `TimelineSchema` accepts `annotations`;
  - it rejects an empty title, a 121-character title, an unknown `kind`, and
    entries out of `atMs` order, each with a precise path;
  - every existing timeline fixture still parses.
- **Engine, inline pages** (served like `mask.spec.ts` does):
  - `scene('Checkout')` called on load is recorded with `kind: 'scene'`;
  - `caption('…')` called 500 ms into a `wait` is recorded within 100 ms of
    the call's engine time;
  - a call from an inline `<head>` script, before `<body>` exists, counts;
  - a call on a document opened by a click counts;
  - `scene(42)`, `scene('')`, `caption('   ')`, a 121-character text and a
    call with no argument each return `undefined`, do not throw, and are not
    recorded;
  - a call from an iframe is not recorded;
  - after 101 calls, exactly the first 100 are recorded;
  - a call made before step 0 starts is recorded at step 0's `startMs`;
  - no calls: the timeline has no `annotations` key;
  - `window.demoflow.version === 1`, and `ready` still passes a
    `waitForReady` on the same document.
- **Renderer, plan:**
  - a `scene` annotation places the same scene card as a `scene` marker at the
    same time;
  - with `cards.scenes.enabled: false` it places none, and it places none at
    or after `pageEndMs`;
  - a `caption` annotation gives a caption from `out(atMs)` lasting 3,000 ms;
  - a following step caption cuts it, and it cuts an earlier step caption;
  - captions from both sources come out sorted by start;
  - the vertical plan shows a page caption in its caption band.
- `bun run check` and `bun run build` are green, and so is the
  execution-plane matrix.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i201 | the page methods, timeline field and renderer reading | packages/core/src/timeline.ts, packages/core/src/index.ts, packages/core/test/**, packages/engine/src/**, packages/engine/test/**, packages/renderer/src/plan/**, packages/renderer/test/plan/** | #198 | yes | sonnet |

One slot. `sonnet`: the binding follows #197's pattern and the global follows
#198's, so no new timing or clock problem is left open.

## Open questions

None.

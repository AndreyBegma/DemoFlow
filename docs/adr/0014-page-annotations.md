# ADR-0014: Scenes and captions from the page: `window.demoflow.scene` and `caption`

Status: accepted · Date: 2026-10-22 · Extends: [ADR-0013](0013-page-side-contract.md) ·
Spec: [201](../specs/201-page-annotations.md)

## Context

Roadmap Phase 7, item 3: the application under demonstration sets scenes and
captions through a JS API. Vision §3.5 lists "add semantic annotations to a
scenario" among the optional SDK's capabilities.

ADR-0013 fixed the page-side contract for items 1–2. Two of its rules bear on
this item:

- §3 lets `window.demoflow` grow by a method without a new `version`;
- §5 says the page side transmits nothing.

`ready` meets §5 because the engine only reads the ready set through
`waitForFunction`, so the page never hands the engine anything new. An
annotation is different: its text comes from the application and must reach
the engine, which writes it into the timeline so the renderer can draw it.
That is a new kind of flow from page to engine, so it is recorded here.
ADR-0013 is not rewritten.

Scenarios already have scenes and captions: the `marker` step
(`kind: scene | caption`) and the step `caption` field (ADR-0003 §4, spec 108).

## Decision

1. **Two methods join `ready` on `window.demoflow`:**
   - `scene(title)` starts a scene. It means what a `marker` step with
     `kind: "scene"` means at that moment.
   - `caption(text)` shows a caption. It means what a `marker` step with
     `kind: "caption"` means at that moment.

   `version` stays `1` (ADR-0013 §3). No npm package is added.
2. **The page hands the text to the engine, and nothing leaves the machine.**
   The methods deliver their text to the engine process through a Playwright
   binding on the same machine. The engine writes it into `timeline.json` in
   the run directory, and the renderer draws it into the video. Nothing is
   sent over the network. ADR-0008 is unchanged. This narrows ADR-0013 §5's
   "transmits nothing" to "sends nothing off the machine": the page side may
   hand the engine text it chose to show in the video, and nothing else.
3. **Annotations are never masked.** The application chose the text for the
   video. The documentation says that a secret does not belong in an
   annotation.
4. **Same safety rules as `ready` (ADR-0013 §5–6):**
   - both methods return `undefined` and never throw, whatever their argument;
   - an invalid text is ignored. Valid means a string that is non-empty after
     trimming and at most 120 characters, the limit of a step `caption`;
   - only calls from the main frame count.
5. **Bounded.** At most 100 annotations are kept per run. Later calls are
   ignored. A page that annotates in a loop cannot grow the timeline without
   bound.
6. **A page caption lasts 3 s or until the next caption.** It is shown for
   3,000 ms of output time, or until the next caption from either source
   starts. A page caption has no step whose end could close it. A later step
   caption or `caption` marker also cuts it, as captions cut each other today.
7. **The scenario and the page are equal sources.** Nothing switches page
   annotations off on their own. `cards.scenes.enabled: false` turns off scene
   cards from either source. A switch only for page annotations would need a
   new decision.

## Consequences

- An application can label its own flow ("Checkout", "Paying with a card") once,
  and every scenario that passes through it gets those scenes. No scenario
  has to repeat them.
- Two sources can collide, for example a scenario `scene` marker and a page
  `scene` call at the same moment. The video shows both cards, in time order.
  Avoiding that is the author's choice. The renderer does not deduplicate.
- The timeline gains a page-sourced field, as `maskedElements` (#197) did. A
  run without annotations writes the same timeline as before.
- `demoflow record` does not turn page annotations into steps. A later issue
  may add that.

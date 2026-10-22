# Fade transitions between cards, scenes and page loads

Issue: [#114](https://github.com/AndreyBegma/DemoFlow/issues/114) · Phase 4 ·
Roadmap: [roadmap.md](../product/roadmap.md) (Phase 4 — Transitions) ·
Decisions: [ADR-0004](../adr/0004-recording-is-separate-from-rendering.md),
[ADR-0005](../adr/0005-renderer-chosen-by-spike.md) · specs [108](108-cards.md), [18](18-mask-visibility.md)

Depends on #108

## Summary

After #108 the video cuts hard between a card and the page, and a document
navigation shows the browser's blank page for a moment. The roadmap asks for a
short (~300 ms) fade between scenes and on navigation, hiding the blank-page
flash, with no menu of transition styles. This item records document
navigations in the timeline and adds the fades to the render plan and the
compositor.

## Scope

### In scope

- **Engine — record navigations.** The timeline gains an additive top-level
  `navigations: [{ startMs, endMs }]`: one entry per main-frame **document**
  navigation during the run, from the navigation request to the page's `load`
  event, in the timeline clock. Same-document (SPA) route changes are not
  navigations — they have no blank page. A navigation still loading when the
  recording ends has no `endMs`. Today the timeline records none [Confirmed:
  `packages/core/src/timeline.ts`; `navigationStart` in
  `packages/engine/src/execute/actions.ts` only waits for one].
- **Core**: the `navigations` field in `TimelineSchema` (ordered, non-
  overlapping, only the last may be open), additive — `schemaVersion` stays 1.
- **Card fades**: each card (intro, scene, outro) cross-fades with the page
  over the configured duration **inside the card's own time**: the first part
  of a scene or outro card dissolves from the held page frame into the card,
  the last part of an intro or scene card dissolves from the card into the held
  page frame. Page time is never covered (spec 108, Decision 1).
- **Navigation fades**: from a navigation's `startMs` to its `endMs` the video
  holds the last page frame before `startMs` (no blank page), then dissolves
  from that held frame into the live page over the configured duration. The
  first navigation of the run (from `about:blank`) dissolves from the
  background into the page instead.
- **Overlays on held frames**: masks active at the held frame's time stay drawn
  on it, at its box, for as long as it is visible (hold and dissolve); cursor
  and rings keep following page time.
- **Config** in `RenderConfigSchema`, additive with defaults:
  `render.transitions: { enabled: true, durationMs: 300 }`, `durationMs` an
  integer 100–1000 and never longer than half the shortest card. The JSON
  Schema for project config is regenerated.
- **Off switch**: `enabled: false` reproduces the #108 output (existing golden
  images unchanged).
- **Golden images**: a mid-fade card frame, a mid-fade navigation frame, and a
  held frame with a mask.

### Out of scope

- Transition styles other than a dissolve, fades into the failure end card,
  fades on same-document route changes, export formats, 9:16.

## Decisions

1. **Dissolve only, 300 ms by default.** — roadmap (owner).
2. **Card fades take card time; navigation fades take the loading time.** —
   orchestrator: neither shortens what the page shows after it is ready.
3. **The engine records navigations; the renderer never guesses them from
   pixels.** — orchestrator, per ADR-0004 (the timeline is the contract).
4. **No fade into the failure card.** — orchestrator: the failure should be
   visible at the moment it happens.

## Acceptance criteria

- [ ] A fixture run with a link click that loads a new document records one
      `navigations` entry with `startMs < endMs`; a client-side route change
      records none (engine test, three OSes).
- [ ] The rendered video has no frame between that navigation's `startMs` and
      `endMs` that matches a blank page (render test on a real run); the frame
      mid-dissolve blends the held and the live page (golden image).
- [ ] A mask active when a navigation starts is drawn on every held and
      dissolving frame (plan test and golden image).
- [ ] A scene card's first and last 300 ms dissolve with the page; the page
      frames after the card are unchanged from #108 (plan test).
- [ ] `transitions.enabled: false` reproduces the existing golden images;
      `durationMs` outside 100–1000 is rejected; the JSON Schemas are
      regenerated.
- [ ] Before/after images in the PR; `bun run check` passes; Woodpecker and all
      three OSes green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i114 | navigations in engine and core, fades in renderer and config | packages/core/src/timeline.ts, packages/core/src/project-config.ts, packages/core/test/**, packages/core/schemas/**, packages/engine/src/**, packages/engine/test/**, packages/renderer/src/**, packages/renderer/test/**, apps/cli/src/commands/run.ts, apps/cli/test/commands/** | #108 | yes | opus |

One slot: the timeline field and its only consumer must agree. `opus`: how a
held frame is drawn with its masks is decided here.

## Risks

- **A mask missing on a held frame** (high — a secret could show while a page
  loads). Mitigation: the held-frame mask plan test, golden image, and the
  real-run mask coverage test with transitions on.
- **`load` never fires on a slow page** (medium). Mitigation: an open
  navigation holds until the next step starts or the recording ends, never
  past it.

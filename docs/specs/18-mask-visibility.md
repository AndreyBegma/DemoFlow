# Engine — record when a masked field is on screen

Issue: [#18](https://github.com/AndreyBegma/DemoFlow/issues/18) · before Phase 4 ·
Decisions: [ADR-0004](../adr/0004-recording-is-separate-from-rendering.md) (accepted),
[spec 1](1-core-contracts.md) (optional timeline fields)

Depends on #31

## Summary

The renderer blurs a `masked` field from its `fill` until a `navigate` step,
until a page scroll takes the box out of the viewport, or until the video
ends (`maskSpans` in `packages/renderer/src/plan/plan.ts`) [Confirmed]. On
the `login.demo.json` run the mask therefore stays over the signed-in page.

The issue proposed marking a click that caused a navigation. That signal does
not exist on this run: the fixture's sign-in handler calls
`preventDefault()` and re-renders the same page
(`apps/fixture/src/pages/login.tsx`) [Confirmed], so no navigation request
starts and `navigationStart` in `packages/engine/src/execute/actions.ts`
sees nothing. What the renderer needs is not "a navigation happened" but
"the masked field is no longer on the page". This item has the engine record
exactly that, as visibility intervals on the masked `fill` event, and has the
renderer end (and resume) the mask from them. Surfaced by the renderer spike
(#4).

## Scope

### In scope

- `@demoflow/core`: an optional `maskVisibility` on `TimelineEvent`.
- `@demoflow/engine`: after every step that follows a masked `fill`, check
  each masked field and record when it leaves and re-enters the page.
- `@demoflow/renderer`: `maskSpans` uses `maskVisibility` when present.

### Out of scope

- A `navigated` flag on `click` events — replaced by this item (Decisions 1).
- Navigations not caused by a step (the origin guard, as today).
- Changing the fixture app.
- Sub-step precision (an in-page observer) — see Decisions 2.

## Decisions

1. **Record the mask's life, not the click's navigation.** No `navigated`
   field is added. — the owner, after the fixture finding above.
2. **Detection is a check after each step**, not an in-page observer. After
   every step that follows a masked `fill` (the failed step included), the
   engine checks that fill's locator: the field is **gone** when the locator
   resolves to nothing, to a detached element, or to a hidden one
   (Playwright's `isVisible()` is false), or when the step navigated the main
   frame. Out of the viewport is **not** gone — the renderer already follows
   page scrolls. — the owner.
3. **Edges are conservative.** A field found gone after step *k* ends its
   interval at step *k*'s `endMs`; a field found back after step *k* starts a
   new interval at step *k*'s `startMs`. The mask is never off while the
   field could be on screen. — the owner.
4. **Intervals, not one end.** A field that comes back (a form error, a back
   navigation, the same locator on another page) gets a new interval and the
   mask returns. Each interval carries the box measured when it starts, since
   the field may come back elsewhere. — the owner.
5. **The intervals live on the masked `fill` event** as `maskVisibility`,
   not in a separate top-level list. — the owner.
6. **Optional field, `schemaVersion` stays 1** — spec 1 allows optional
   timeline fields; a required one is a new version. [Confirmed] There is no
   committed JSON Schema for the timeline (`packages/core/schemas/` holds the
   scenario and project-config schemas only) [Confirmed], so nothing is
   regenerated.
7. **Renderer fallback.** With `maskVisibility` present, `maskSpans` emits one
   span per interval (an open interval runs to the video's end) and keeps
   following page scrolls inside each interval. Without it — a timeline from
   before this change — the current rule stays. — orchestrator default,
   confirmed by the owner.
8. **The renderer change is a second slot of this issue**, cut after the
   engine slot merges. — the owner.

## Data / Schema

`packages/core/src/timeline.ts`, on `TimelineEventSchema`:

```ts
// Only on a masked `fill`: when its field was on the page (ADR-0004; #18).
maskVisibility: z
  .array(
    z.strictObject({
      startMs: msSchema,
      endMs: msSchema.optional(), // absent: still on the page when the run ended
      box: BoxSchema,
    }),
  )
  .optional(),
```

Refinements: `maskVisibility` only where `masked === true`; every interval
has `endMs >= startMs`; intervals are ordered and do not overlap; only the
last may be open. The first interval starts at the fill event's `startMs`
with the fill's target box.

## Acceptance criteria

- [ ] On a `login.demo.json` run, the password `fill` event carries
      `maskVisibility` with exactly one interval, closed at the `endMs` of the
      "Sign in" `click` step.
- [ ] A masked field that stays on the page to the end has one open
      interval (no `endMs`).
- [ ] A masked field that disappears and returns yields two intervals, the
      second starting at the `startMs` of the step after which it was found
      back, with its own box (engine test against a fixture or test page).
- [ ] Scrolling a masked field out of the viewport does not close its
      interval.
- [ ] `TimelineSchema` rejects `maskVisibility` on a non-masked event,
      overlapping or unordered intervals, and an open interval that is not
      the last (core tests).
- [ ] A timeline without `maskVisibility` still validates and renders exactly
      as before (renderer test on an existing timeline fixture).
- [ ] With `maskVisibility`, `buildRenderPlan` emits one mask span per
      interval; on the login run no mask is active after the "Sign in" click
      ends (renderer test).
- [ ] Core, engine and renderer tests pass under Node with Vitest, on
      Woodpecker and on all three OSes of the `execution-plane` workflow;
      `bun run check` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i18-engine | the contract field and the engine's visibility checks | packages/core/src/timeline.ts, packages/core/test/**, packages/engine/src/execute/**, packages/engine/src/capture/**, packages/engine/test/** | — | yes | opus |
| i18-renderer | mask spans from the intervals | packages/renderer/src/plan/**, packages/renderer/test/plan/** | i18-engine | no | sonnet |

`i18-engine` is `opus`: it changes a public contract in `@demoflow/core` and
picks where in the step loop the check runs. `i18-renderer` executes
Decision 7 against a merged contract.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/core/src/timeline.ts | i18-engine | #19 also adds a timeline field — serialize with it, do not run both at once |
| packages/engine/test/capture/** | i18-engine | #17 (i17) edits `capture.spec.ts` — i18-engine starts after #17 merges |
| packages/renderer/src/plan/plan.ts | i18-renderer | #19's renderer side reads offsets in the same file — serialize |

## Risks

- **A mask ends too early** (high — a secret on screen). Mitigation:
  Decision 3's edges, Decision 4's intervals, and the acceptance criterion
  that no mask is off while the field is visible; the renderer keeps its
  `maskLeadMs` and margin.
- **A check per masked field per step slows runs** (low). One `isVisible()`
  per open mask per step; scenarios have few masked fields.
- **A locator that resolves to several elements** (low). Treated as present
  if any match is visible — the conservative reading.

## Open questions

- None.

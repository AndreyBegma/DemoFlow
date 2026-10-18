# Engine — a masked fill that fails still masks its field

Issue: [#42](https://github.com/AndreyBegma/DemoFlow/issues/42) · bug · security · high ·
Decisions: [ADR-0004](../adr/0004-recording-is-separate-from-rendering.md) §4 (failed runs are rendered),
[spec 18](18-mask-visibility.md) (`maskVisibility`)

Depends on #47

## Summary

A masked `fill` (`valueFrom.env`) returns `masked: true` and its box only on
success (`packages/engine/src/execute/actions.ts`, `fill` case) [Confirmed].
When typing fails part-way, the failed step's event carries neither, the
renderer draws no blur, and the characters typed so far are visible in the
rendered video of the failed run — which ADR-0004 §4 always renders. This item
makes a masked fill's event masked from the moment the field is touched,
whether the step succeeds or fails.

## Scope

### In scope

- The engine marks a masked fill's event `masked: true` with
  `value: '***'` (or no value) and the field's box as soon as the field is
  located — before `fill('')` — and keeps those on the failed step's event.
- The failed masked fill also opens its `maskVisibility` interval (spec 18) so
  the renderer's interval-based masking applies; the interval stays open
  (to the end of the video) unless a later check closes it — on a failed run
  there are no later steps, so it runs to the end.
- If the box cannot be measured, the event still carries `masked: true`; the
  renderer then falls back to the **whole viewport** for that event (below).
- Renderer: a masked event with no box masks the full viewport from the
  event's start (conservative), in `maskSpans`.

### Out of scope

- Non-masked fills.
- Changing what a passing masked fill records.

## Decisions

1. **Masked from first touch.** The masked flag and box are captured before
   any keystroke and survive a failure. — orchestrator (owner delegated).
2. **No box → mask the whole viewport.** Covering too much is safe; a leak is
   not. Today such an event is not masked at all. — orchestrator.
3. **The partial value is never written** to `timeline.json` or `result.json`:
   failure messages from Playwright that echo typed text are scrubbed of the
   secret. — orchestrator.

AC 1 amended in #54: on Playwright 1.64.1 a detached field does not fail the
step (keys go to the body).

## Acceptance criteria

- [ ] An engine test: a masked fill whose typing times out part-way (main
      thread blocked on an inline page) yields a failed event with
      `masked: true`, the field's box, an open `maskVisibility` interval, and
      no partial secret in `value`, the error message, `timeline.json` or
      `result.json`.
- [ ] An engine test: a masked fill whose field is removed during typing (on an
      inline page) yields `masked: true`, the field's box and a
      `maskVisibility` interval starting at the fill.
- [ ] A masked fill whose field cannot be measured yields `masked: true` with
      no box; `buildRenderPlan` masks the full viewport from its start
      (renderer test).
- [ ] Passing masked fills record exactly what they did before (existing
      tests unchanged).
- [ ] `execution-plane` green on all three OSes; `bun run check` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i42 | masked-fill failure handling and the no-box fallback | packages/engine/src/**, packages/engine/test/execute/**, packages/renderer/src/plan/plan.ts, packages/renderer/test/plan/plan.spec.ts | #47 | yes | opus |

One slot: the engine and renderer halves are small and must agree on the
no-box case. `opus`: a secret-handling path where a wrong call leaks data.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/engine/test/** | i42 (execute/) | #47 edits engine tests — i42 starts after #47 merges |
| packages/renderer/src/plan/plan.ts | i42 | — |

## Risks

- **A failure mode that bypasses the new path** (high). Mitigation: the flag is
  set before the first Playwright call on the field; tests cover a timeout and
  a detached field.

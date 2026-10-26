# Trim and cut segments from `edits.json`

Issue: [#354](https://github.com/AndreyBegma/DemoFlow/issues/354)
Depends on #353 (`RunEditsSchema` and the renderer's edits path).

## Summary

The owner wants trimming to be free: a new start, a new end, and any number of
cut segments anywhere in the run, all dragged on the timeline (#357). This
slice adds `trim` and `cuts` to `RunEditsSchema` and makes the renderer's time
map drop them, next to the idle compression that already squeezes frozen
stretches (ADR-0004 §5). Overlays inside a cut drop with it.

## Scope

### In scope

- `packages/core/src/edits.ts`: `trim`, `cuts`, their checks in
  `checkRunEdits`, which now also takes the run's `RunResult`.
- `packages/core/test/edits.spec.ts`.
- `packages/renderer/src/plan/time-map.ts`: cuts in the time map.
- `packages/renderer/src/plan/plan.ts`: the trimmed range, cuts passed to the
  map, overlays and cards inside a cut.
- `packages/renderer/src/plan/cards.ts`, `masks.ts`, `transitions.ts` as the
  decisions below need.
- `packages/renderer/test/plan/**`: tests.

### Out of scope

- Speed changes (play a stretch faster). Not asked for.
- Cutting the source file. The source stays as recorded (ADR-0020 §1).
- The editor UI (#357).

## Data

Added to `RunEditsSchema`:

```ts
trim?: { startMs?: number; endMs?: number },   // timeline ms
cuts?: Array<{ startMs: number; endMs: number }>, // timeline ms
```

- `trim.startMs < trim.endMs` when both are set.
- `cuts`: at most 100, each `endMs > startMs`, ordered by `startMs`, not
  overlapping, not touching (a gap of at least one millisecond; two touching
  cuts are one cut — the editor merges them).

`checkRunEdits(edits, timeline, result)` adds:

- `cut-outside-trim`: a cut not entirely inside the trimmed range (or the
  run's range without a trim);
- `trim-hides-failure`: on a failed run, `trim.endMs` before the failed
  step's `endMs`, or a cut that overlaps the failed step's event
  (ADR-0004 §4, ADR-0020 §2);
- `too-short`: less than 500 ms of page left after the trim and the cuts.

## Decisions

1. **Trim sets the page range.** The output's page starts at
   `max(startMs, toSource(trim.startMs))` and ends at
   `min(sourceEndMs, toSource(trim.endMs))`, where `startMs` and
   `sourceEndMs` are what `planRender` computes today (after the sync mark,
   and the failure or the last event plus the tail) [Confirmed:
   `plan.ts`, `planRender`]. A trim can only shorten the range, never extend
   it past the recording.
2. **A cut is a stretch of source that plays in 0 ms.** `buildTimeMap` takes
   the cuts besides the idle stretches. A frozen stretch that overlaps a cut
   is subtracted by the cut first; what is left of it is still idle and is
   compressed as today. *Why in the same map:* every overlay is already
   planned through `out()` over this map [Confirmed: `pageMap`, `out`], so a
   cut moves captions, the camera, masks and cursor for free; a second map
   would have to be kept in step with the first.
3. **Overlays at a cut.**
   - A caption whose whole span is inside a cut is dropped (its mapped span
     is empty and the existing `endMs > startMs` filter removes it
     [Confirmed]); one that crosses a cut is shown on both sides.
   - A click ring whose `atMs` falls inside a cut is dropped.
   - A cursor move that crosses a cut is split at it, like at a card
     [Confirmed: `splitMoves` in `cards.ts`]; the cursor jumps to where it
     is after the cut.
   - The camera is held across the cut at its state on the cut, like across a
     card [Confirmed: `holdAcross`]; a zoom that starts inside a cut starts at
     the cut's end.
   - A scene card whose marker or page scene falls inside a cut or outside the
     trim is not placed. The intro stays at 0; the outro stays at the end.
4. **A visible join.** With `render.transitions.enabled`, each cut gets the
   dissolve a page load gets, of `transitions.durationMs` [Confirmed:
   `transitions.ts`, spec 114]. Without, a cut is a hard join.
5. **Masks never leak at a cut.** A mask span that overlaps a cut keeps
   covering on both sides; the lead and trail of a mask (#48) are measured so
   that the output frames on both sides of a join are covered whenever the
   masked field was visible in the source frame they show. The slot proves
   this with a test, not by reading. [Unknown: whether `maskSpans` applies the
   lead and trail before or after `out()`; the slot finds out and makes the
   rule hold either way.]
6. **The real durations stay.** `result.json` keeps the run's real durations
   (ADR-0004 §5); `renders[].durationMs` is the trimmed output's.

## Acceptance criteria

Vitest under Node:

- [ ] Schema: unordered, overlapping and touching cuts, 101 cuts, and
      `trim.startMs >= trim.endMs` are rejected.
- [ ] `checkRunEdits`: `cut-outside-trim`, `trim-hides-failure` (both forms)
      and `too-short` each on a minimal case; a passed run with a cut over its
      last step passes.
- [ ] `buildTimeMap` with one cut gives segments whose output skips the cut,
      and with a cut over half an idle stretch compresses only the other half.
- [ ] A plan with `trim { startMs: 2000 }` starts its page at the source frame
      of timeline 2000 (± one frame); with `trim { endMs }` its page ends
      there, followed by the outro when there is one.
- [ ] A caption inside a cut is absent; one crossing it appears before and
      after; a click ring inside a cut is absent; a scene card whose marker is
      inside a cut is absent.
- [ ] With transitions on, a cut has a dissolve; off, it does not.
- [ ] **Masking:** on the fixture run with a masked `fill`, every placement of
      a cut boundary within 300 ms of the field's visibility edges (step
      through in 10 ms) leaves no output frame in which the field is visible
      and unmasked (assert on the planned spans against the field's
      `maskVisibility`).
- [ ] Without `trim` and `cuts`, every existing plan test is unchanged.
- [ ] `bun run check` is green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i354-cuts | trim and cuts | packages/core/src/edits.ts, packages/core/test/edits.spec.ts, packages/renderer/src/plan/time-map.ts, packages/renderer/src/plan/plan.ts, packages/renderer/src/plan/cards.ts, packages/renderer/src/plan/masks.ts, packages/renderer/src/plan/transitions.ts, packages/renderer/test/plan/** | #353 merged | yes | opus |

One slot. It decides the mask rule at a join (Decision 5).

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| `packages/renderer/src/plan/plan.ts`, `time-map.ts` | this issue, after #353 | #365 (end hold) edits the source end and must not let idle compression cut its hold: rebase on whichever merges first; the hold and the trim compose (a trim end before the hold ends the video there). |
| `packages/core/src/edits.ts` | #353, then this issue | nobody else |

## Risks

- **High — a mask leak at a join.** A cut can put a frame where a masked
  field is visible right after a frame where the mask was timed to start.
  Mitigation: Decision 5 and its exhaustive acceptance test.
- **Medium — the camera at a join.** Holding the camera across a cut can leave
  the view zoomed on something that is gone. Mitigation: the hold is the rule
  for cards today and reads well there; the visual baseline suite
  ([73](73-visual-baselines.md)) gets one cut case.

## Open questions

- Should a cut shorter than one frame be refused? Default: no; it maps to
  nothing and changes nothing.

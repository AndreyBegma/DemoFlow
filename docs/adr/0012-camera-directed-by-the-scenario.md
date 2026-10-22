# ADR-0012: The camera is directed by the scenario

Status: accepted · Date: 2026-10-22 · Spec: [163](../specs/163-step-zoom.md)

## Context

The renderer zoomed on the target of every `click`, `fill` and `select`
(spec 4) and zoomed back out after it unless the next target was within 400 px
or close in time. A scenario that clicks through several buttons rendered as
zoom-in, zoom-out about once a second: a 25 s landing-style render showed eight
in/out cycles between 15 s and 23 s. The renderer cannot tell which action is
the point of a scene; the author can.

## Decision

1. **No automatic zoom.** The camera zooms only on a step that carries `zoom`.
   A scenario without `zoom` renders flat: every camera keyframe is scale 1.
2. **`zoom?: boolean | number`** on the steps whose timeline event carries the
   target's box: `click`, `fill`, `select`, `hover`, `waitFor` (not for a
   hidden target), `press` (only with a `target`), `assertVisible`,
   `assertText`. `true` is the default strength; a number `1 ≤ n ≤ 3` is that
   strength (`1` is no zoom); `false` or absent is no zoom. A `zoom` on any
   other step is a scenario error, not a no-op.
3. **The timeline event carries the step's `zoom` verbatim**; the renderer
   resolves `true`, because the strength depends on the source resolution only
   the renderer knows.
4. **Default strength 1.35** on a source with at least two pixels per CSS pixel
   (was 1.6); **1.25** on a 1× source (ADR-0010), unchanged. An explicit number
   overrides both. The render option `zoom` sets what `true` means; it never
   makes a step zoom. The per-target fit cap stays: a target fills at most 90 %
   of the zoomed view, so a large target zooms less than asked.
5. **Merging.** Two consecutive zoomed steps keep the existing rule: within
   400 px, or when the zoom-in would start before the zoom-out ends, the camera
   stays zoomed and pans. **Only a targeted step without `zoom` ends the zoom**
   between them: the camera returns to 1 after the first and zooms in again for
   the second. A step without a target — `wait`, `marker`, `navigate`,
   `screenshot`, `scroll`, a `press` without a `target` — cannot carry `zoom`,
   so it is neutral and the existing rule decides. This is how spec 163's
   Decision 4 ("a step without zoom between two zoomed steps ends the zoom") is
   read. When the zoom-in after such a break has no room, it starts as the
   zoom-out ends and arrives up to 500 ms late, as a shot in a video's first
   500 ms already does.
6. **No `schemaVersion` change.** The field is optional and additive; an old
   scenario stays valid and now renders without zoom. That change in behaviour
   is the point of this decision.

## Consequences

- Existing scenarios lose their zoom until the author adds `zoom: true` where
  it matters. The fixture scenarios (`customers`, `landing`) carry it on their
  closing click.
- Zoom on a region that is not a step's target, or at an arbitrary time, is not
  possible; it would be a new field, decided on its own.

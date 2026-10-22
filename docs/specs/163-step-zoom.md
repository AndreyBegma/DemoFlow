# Camera zoom is set per step; no automatic zoom

Issue: [#163](https://github.com/AndreyBegma/DemoFlow/issues/163)
Depends on: nothing

## Summary

The renderer zooms on the target of every `click`, `fill` and `select`
(`packages/renderer/src/plan/plan.ts`, `cameraKeyframes`, action set `CAMERA`)
and zooms back out after it unless the next target is within 400 px or close in
time. A scenario that clicks through several buttons renders as zoom-in,
zoom-out about once a second: a 25 s render showed eight in/out cycles between
15 s and 23 s.

The owner decided (2026-10-22): **the camera zooms only where the scenario asks
for it.** A step carries an optional `zoom`; a scenario without one renders flat.
The default strength drops from 1.6× to 1.35×.

## Scope

### In scope

- `packages/core`: an optional `zoom` field on steps that have a target, carried
  into the timeline event; JSON schema regenerated.
- `packages/engine`: copy the step's `zoom` into its timeline event, as it
  already does for `caption`.
- `packages/renderer`: `cameraKeyframes` zooms only on events with `zoom` set;
  new default strength.
- An ADR recording that the camera is directed by the scenario.
- Scenarios and fixtures checked into the repository that relied on automatic
  zoom (tests, golden images, examples, the landing scenario if it lives here)
  are updated so their intent survives: add `zoom: true` where a zoom was the
  point of the test, otherwise accept the flat render.

### Out of scope

- Loops over a data array and variable substitution in steps — a separate issue,
  specified on its own.
- Zoom on a region that is not a step's target, or a zoom keyframe at an
  arbitrary time.
- Re-recording the landing video (a follow-up chore, like #153).

## Decisions

1. **Field.** `zoom?: boolean | number` on the steps that have a target
   (`click`, `fill`, `select`, `hover`, and any other action whose timeline event
   carries `target.box`). Schema-level rejection on actions without a target —
   a `zoom` that cannot do anything is an error, not a no-op.
   - `true` → the default strength.
   - a number → that strength, `1 ≤ n ≤ 3`; `1` means "no zoom" explicitly.
   - `false` or absent → no zoom.
2. **Default strength.** `1.35` on a source with at least two pixels per CSS
   pixel (was `1.6`); `1.25` on a 1× source is unchanged (ADR-0010). An explicit
   number overrides both. `RenderPlanOptions.zoom` keeps overriding the default
   strength (what `true` means), not whether a step zooms.
3. **Fit still applies.** The per-target cap `min(strength, 0.9·vw/w, 0.9·vh/h)`
   stays, so a large target zooms less than asked.
4. **Merging.** Between two consecutive zoomed steps the existing rule holds
   (pan within 400 px or when the zoom-in would overlap the zoom-out). A step
   without `zoom` between two zoomed steps ends the zoom: the camera returns to 1.
5. **Timeline.** The timeline event gains `zoom?: boolean | number`, the step's
   value verbatim. The renderer resolves `true` to the default strength, because
   the strength depends on the source resolution only the renderer knows.
6. **No migration of `schemaVersion`.** The field is optional and additive; old
   scenarios stay valid and now render without zoom. That behaviour change is
   the point and is stated in the ADR and the CLI/README docs.

## Acceptance criteria

- A scenario with no `zoom` anywhere produces a render plan whose every camera
  keyframe has scale 1.
- `zoom: true` on a `click` produces a zoom on its target at 1.35× (2× source)
  or 1.25× (1× source); `zoom: 2` produces 2× (subject to the fit cap).
- Two consecutive zoomed clicks 200 px apart stay zoomed and pan; a zoomed, an
  unzoomed and a zoomed click produce zoom-out and zoom-in around the middle one.
- `zoom` on a step without a target fails scenario parsing with a message that
  names the step and the field.
- `packages/core/schemas/scenario.schema.json` is regenerated and the schema
  test passes.
- The existing plan tests (`plan.spec.ts`, `build.spec.ts`, `cards.spec.ts`) and
  visual baselines are updated to the new behaviour, each with `zoom` added where
  the test is about zoom.
- A new ADR (`docs/adr/0012-…`) says the camera is directed by the scenario and
  that automatic zoom is gone; `docs/adr/README.md` indexes it.
- `bun run check`, `bun run test`, `bun run build` green; execution-plane matrix
  green.

## Risks

- Every existing golden image with zoom changes. Update them deliberately, not by
  blanket re-record; a visual diff that is not about zoom is a regression.
- The engine and renderer run on Node (Vitest), not Bun.

## Open questions

None — strength, default and field shape were decided by the owner on
2026-10-22.

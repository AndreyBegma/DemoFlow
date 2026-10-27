# `edits.json`: captions, zoom, cards and style applied at render

Issue: [#353](https://github.com/AndreyBegma/DemoFlow/issues/353)
Depends on: nothing. [ADR-0020](../adr/0020-edits-from-the-website.md) lands
with the Phase 8 docs pull request.

## Summary

[ADR-0020](../adr/0020-edits-from-the-website.md) puts a run's edits in
`runs/<runId>/edits.json` and has the renderer apply them over the run's own
inputs. This slice is the contract and the renderer half: `RunEditsSchema` in
`@demoflow/core`, a pure check of an edits file against the run's timeline,
and `buildRenderPlan` reading the file and applying caption, zoom, card and
style edits. Trimming and cuts are #354. Nothing on the Runner, the API or the
website changes here; `demoflow render <runId>` picks the file up on its own,
because it calls `buildRenderPlan` [Confirmed: `apps/cli/src/commands/render.ts`].

## Scope

### In scope

- `packages/core/src/edits.ts` (new): `RunEditsSchema`, `RunEdits`,
  `checkRunEdits(edits, timeline)`, `RUN_EDITS_FILE = 'edits.json'`.
- `packages/core/src/index.ts`: `export * from './edits.ts'`.
- `packages/core/src/json-schema.ts`: a JSON Schema for `edits.json`, like the
  scenario's and the config's [Confirmed: the module exists; whether it is
  generated per contract or by a list is [Unknown] — follow what it does].
- `packages/core/test/edits.spec.ts` (new).
- `packages/renderer/src/plan/plan.ts`: `PLAN_INPUTS.edits`,
  `PlanInput.edits`, reading and applying the file.
- `packages/renderer/src/plan/cards.ts`: card text and switches from edits.
- `packages/renderer/test/plan/edits.spec.ts` (new), and fixture runs in
  `packages/renderer/test/plan/fixture-runs.ts` if a run directory is needed.

### Out of scope

- `trim` and `cuts` (#354). The schema here has no such keys; #354 adds them.
- Who writes the file: the Runner (#355), the API relay (#356), the editor
  (#357).
- Exporting edits to a scenario or the config (#355, #358).
- Any change to `TimelineSchema`, `RunResultSchema`, the engine or
  `demoflow run`. A fresh run has no `edits.json` and renders as today.
- Editing scene card titles, the intro/outro durations, the GIF, vertical or
  square tuning, the output size or fps, transitions, or the idle thresholds.
  The owner's list is captions, zoom per step, card text, background and
  window (ADR-0020 Context).

## Data

`edits.json`, validated by `RunEditsSchema` (zod, strict objects):

```ts
{
  schemaVersion: 1,
  // The complete caption list of the run, when present. It replaces every
  // caption from steps (`caption`, `marker` kind caption) and from the page
  // (ADR-0014). `[]` means no captions at all.
  captions?: Array<{ startMs: number; endMs: number; text: string }>,
  // Per-step zoom overrides; a step not listed keeps its timeline `zoom`.
  zoom?: Array<{ stepIndex: number; zoom: boolean | number }>,
  cards?: {
    intro?: { enabled?: boolean; title?: string; subtitle?: string | null },
    scenes?: { enabled?: boolean },
    // `null` removes the outro; an object sets it, even if the config has none.
    outro?: { title: string; cta?: string } | null,
  },
  background?: BackgroundConfig,          // as in render.background
  frame?: { enabled?: boolean; radius?: number; shadow?: boolean },
}
```

- **Times are timeline ms** (ADR-0020 §1): `msSchema` from `timeline.ts`,
  integers ≥ 0.
- **Captions:** at most 200; `text` is trimmed, 1 to 120 characters (the
  limit of a page caption, `AnnotationSchema` [Confirmed]); `endMs > startMs`;
  ordered by `startMs` and not overlapping. *Why a full list, not per-step
  patches:* the editor moves and retimes captions freely (owner), and a caption
  moved off its step is no longer the step's; one list is the only shape both
  can share without merge rules.
- **Zoom:** `stepIndex` unique within the list; `zoom` is `ZoomSchema`
  (`true`, `false`, or `1 ≤ n ≤ 3`) [Confirmed: `step.ts`]; at most one entry
  per step.
- **Cards:** text fields reuse `CardTextSchema` of `project-config.ts` (1–80,
  not only spaces) [Confirmed]; `subtitle: null` removes the intro's subtitle.
- **Background:** `BackgroundConfigSchema` [Confirmed]; **frame:** the
  `FrameConfigSchema` fields named above with the same bounds, all optional
  and without defaults (absent means "as configured").
- **Size cap:** the Runner rejects a file over 256 KiB before parsing (#355);
  the schema caps the arrays so that a valid file fits.

`checkRunEdits(edits, timeline): Issue[]` (the `issues.ts` shape [Confirmed]),
pure, used by the Runner before it writes and by the renderer before it plans:

- every `zoom[].stepIndex` is an event of the timeline whose event carries a
  `target` (ADR-0012 §2), else `zoom-no-target` at that entry;
- every caption ends at or before the timeline's last event `endMs` plus the
  tail the renderer keeps, else `caption-out-of-range`.

## Decisions

1. **The renderer reads the file itself.** `buildRenderPlan(runDir, options)`
   reads `edits.json` when it exists, parses it with `RunEditsSchema`, runs
   `checkRunEdits`, and passes it to `planRender` as `PlanInput.edits`. A file
   that fails either check fails the plan with a message naming the file and
   the first issue. *Why fail, not ignore:* a render that silently drops the
   person's edits looks like a renderer bug. *Why in `buildRenderPlan`, not in
   the CLI:* every caller (`demoflow render`, the daemon in #355) gets the same
   behaviour, and `planRender` stays pure and testable (spec 4).
2. **Captions.** With `edits.captions`, `captions()` returns that list mapped
   through `out()`, and step and page captions are not read. The vertical and
   square crops use the same list [Confirmed: `cropCaption` takes the
   planned captions].
3. **Zoom.** Before `cameraKeyframes`, each event's `zoom` is replaced by its
   override when one exists. The rest of ADR-0012 is unchanged: the default
   strength, the fit cap and the merge rule apply to the overridden values
   exactly as to a scenario's.
4. **Cards.** `placeCards` takes the edits:
   - intro `enabled` overrides `render.cards.intro.enabled`; `title` replaces
     `result.scenarioName`; `subtitle` replaces the description, `null`
     removes it;
   - scenes `enabled` overrides `render.cards.scenes.enabled`;
   - outro: an object is the outro whatever the config says (duration from
     the config's `outro.durationMs`); `null` removes it. A failed run still
     never gets an outro [Confirmed: `cards.ts`, `!input.failed`].
   - With no `render.cards` in the options at all, card edits are ignored: a
     project with cards off stays off [Confirmed: `placeCards` returns `[]`
     without a config].
5. **Style.** `edits.background` replaces `options.background`;
   `edits.frame` is merged over `options.frame` field by field before
   `FrameConfigSchema.parse`.
6. **A failed run stays visibly failed** (ADR-0004 §4, ADR-0020 §2). Edits
   change nothing about the failure card or the watermark.
7. **No schema version bump of the timeline.** `edits.json` has its own
   `schemaVersion: 1`.

## Configuration

None. `edits.json` is per run.

## Acceptance criteria

`packages/core/test/edits.spec.ts` (Vitest under Node):

- [ ] A minimal `{ schemaVersion: 1 }` parses; an unknown key, a
      `schemaVersion: 2`, a caption with `endMs <= startMs`, overlapping or
      unordered captions, 201 captions, a 121-character caption, a duplicate
      `stepIndex`, `zoom: 4`, and an outro without `title` are rejected.
- [ ] `checkRunEdits` reports `zoom-no-target` for a `wait` step and for a
      step index not in the timeline, and nothing for a `click` with a box.

`packages/renderer/test/plan/edits.spec.ts`:

- [ ] Without `edits.json`, the plan of every fixture run is identical to
      today's (deep equality with the plan built without the new code path).
- [ ] `captions: [{ startMs, endMs, text }]` gives exactly one caption at
      `out(startMs)…out(endMs)`, and none of the scenario's or the page's.
- [ ] `captions: []` gives no captions; the vertical output has none either.
- [ ] A zoom override `true` on an unzoomed `click` adds a zoom keyframe at
      that click with the default strength; `false` on a zoomed step removes
      it; `2` uses 2 (capped by the fit rule as before).
- [ ] Intro `title`/`subtitle: null`, scenes `enabled: false`, outro set on a
      config without one, and outro `null` on a config with one each give the
      expected cards; a failed run with an outro edit has no outro.
- [ ] `background: { color: '#112233' }` and `frame: { radius: 0 }` change
      the plan's frame and nothing else.
- [ ] `buildRenderPlan` on a run directory with an invalid `edits.json`
      rejects with a message that contains `edits.json`.
- [ ] `bun run check` and the renderer and core Vitest suites are green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i353-edits | the schema and the renderer apply | packages/core/src/edits.ts, packages/core/src/index.ts, packages/core/src/json-schema.ts, packages/core/test/edits.spec.ts, packages/renderer/src/plan/plan.ts, packages/renderer/src/plan/cards.ts, packages/renderer/test/plan/** | — | yes | opus |

One slot: the schema decides what the renderer can apply, and the renderer
change is small once the schema exists.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| `packages/renderer/src/plan/plan.ts` | this issue | #354 (trim, cuts) follows it. #365 (end hold) also edits `TIMING.tailMs` and the source end: rebase on whichever merges first. |
| `packages/core/src/index.ts`, `json-schema.ts` | this issue | One export line each; #361 (schedule config) may add its own. |
| `packages/core/src/project-config.ts` | nobody here | Read only; #361 and #365 edit it. |

## Risks

- **Medium — captions replace both sources.** A run whose page set captions
  (ADR-0014) loses them once the person edits any caption. Mitigation: the
  editor (#357) seeds the list with every caption the plan would show, from
  both sources, so the first save keeps them.
- **Low — an edit refers to a step of a different timeline.** A run directory
  is never re-recorded, so the indices stay valid; `checkRunEdits` catches a
  hand-edited file.

## Open questions

- Should a caption list keep a link to the step it came from (for export in
  #355)? Default: no. Export matches a caption to a step by time (#355,
  Decision 6).

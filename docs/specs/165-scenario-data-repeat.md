# Scenario data and `repeat`

Issue: [#165](https://github.com/AndreyBegma/DemoFlow/issues/165)
Depends on: #163 (both change `packages/core/src/step.ts` and the scenario JSON schema)

## Summary

A scenario declares data at the top and repeats a group of steps once per item,
substituting the item's fields into the steps. Example: post five items from a
list. Recorded once with `demoflow record`, it becomes five posts.

Decided with the owner on 2026-10-22: the data lives in the scenario. A loop is a
`repeat` step. There is one level of loops, with no nesting. Every iteration is
rendered at the author's pace. Substitution works in every string field. The
record panel can wrap recorded steps in a `repeat`.

## Scope

### In scope

- `packages/core`: `data` on the scenario, a `repeat` step, `{{…}}`
  substitution, and a pure `expandScenario()` that turns a scenario into a flat
  list of steps. JSON schema regenerated.
- `packages/engine`: runs the expanded steps; timeline events and run-result
  failures say which `repeat` and which iteration they came from.
- `apps/cli`: `demoflow run` / `validate` report substitution errors before the
  run. The `record` panel gets "Repeat over data".
- README/docs for the scenario format.

### Out of scope

- Data from an external file or CLI arguments.
- Nested `repeat`, and `repeat … times: n` without data.
- Speeding up later iterations in the render.
- A web (apps/web) scenario editor. None exists, and it would be its own phase.

## Decisions

1. **Data.** `data?: Record<string, Array<Record<string, string | number | boolean>>>`
   at the top of the scenario. Each list has at most 100 items. Keys match
   `^[A-Za-z_][A-Za-z0-9_]*$`.
2. **Step.**
   `{ action: 'repeat', each: '<data key>', as: '<name>', steps: Step[], caption?: string }`.
   - `steps` holds 1–50 steps and may not contain a `repeat`. This is a schema
     error.
   - `as` defaults to `item`.
   - `caption` on the `repeat` is shown once, before the first iteration.
   - `timeoutMs` is not allowed on `repeat`.
3. **Substitution.** `{{<as>.<field>}}` and `{{index}}` (1-based) work in every
   string field of a step inside the `repeat`: `value`, `caption`, locator
   names and texts, `url`, the marker label. Numbers and booleans are inserted
   as their string form. Spaces inside the braces are allowed. `\{{` is a
   literal `{{`.
   - An unknown key or field, an `{{…}}` outside a `repeat`, or substitution
     into `valueFrom` is an error at parse/validate time. The error names the
     step path (`steps[3].steps[1].value`).
4. **Expansion is in core, and it is pure.** The function is
   `expandScenario(scenario) → { steps: ExpandedStep[] }`, where each
   `ExpandedStep` is a plain step plus
   `origin?: { repeatIndex: number; iteration: number }`.
   - `repeatIndex` is the index of the `repeat` in `scenario.steps`.
   - `iteration` is 0-based.
   - The function uses zod only and no Node API (ADR-0001).
5. **Timeline / run result.** `stepIndex` counts expanded steps. Events and
   failures carry `origin` when it is set, so a failure reads "step 4
   (repeat #2, iteration 3)". This is additive: older timelines stay valid.
6. **Zoom (#163).** `zoom` on a step inside a `repeat` applies to every
   iteration, like any other field.
7. **Record panel.** In `demoflow record`, the user selects a contiguous run of
   recorded steps and chooses "Repeat over data".
   - The panel asks for a list name and items. Each item is one line of text
     for each `fill` value found in the selection.
   - The panel writes the `data` block and replaces each `fill` value with
     `{{item.<field>}}`. Fields are named `text`, `text2`, …, or renamed in the
     panel.
   - The first item is the recorded values.
   - Masked / `valueFrom.env` fills are left out.

## Acceptance criteria

- A scenario with `data.posts` (5 items) and a `repeat` of `click` → `fill`
  `{{post.text}}` → `click` expands to 15 steps with the right values, and
  `demoflow run` against the fixture app types all five.
- Unknown field, `{{…}}` outside a repeat, nested repeat, more than 100 items
  and substitution into `valueFrom` each fail validation, with the step path in
  the message.
- A failure inside iteration 3 reports `origin` in the run result and the
  CLI message.
- `expandScenario` has unit tests in `packages/core`. Engine and CLI tests run
  under Vitest on Node.
- In the record panel, selecting recorded steps and choosing "Repeat over data"
  with three lines writes a scenario that validates and replays three times.
- `packages/core/schemas/scenario.schema.json` is regenerated.
- `bun run check`, `bun run test` and `bun run build` are green, and so is the
  execution-plane matrix.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i165-core | schema, expansion, engine, CLI run/validate | packages/core/**, packages/engine/**, apps/cli/src/commands/**, README.md, docs/** | #163 | yes | opus |
| i165-record | "Repeat over data" in the record panel | apps/cli/src/record/**, apps/cli/test/record/** | i165-core | no | sonnet |

## Contention

| Resource | Owner | Others |
|---|---|---|
| packages/core/src/step.ts, scenario.schema.json | i165-core | do not open |

## Risks

- Substituting into locator names can produce a locator that matches nothing.
  That is a normal step failure and needs no special case.
- Record panel UI: the selection model is new. Keep it to a contiguous range.

## Open questions

None.

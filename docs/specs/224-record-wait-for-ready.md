# A "Wait for ready" control in the `demoflow record` panel

Issue: [#224](https://github.com/AndreyBegma/DemoFlow/issues/224)
Depends on: nothing. #198 has merged: it added `waitForReady` and
`ReadyNameSchema`, and it taught the panel to describe the step.

## Summary

[Spec 198](198-ready-signal.md) added the `waitForReady { name }` action
([ADR-0013](../adr/0013-page-side-contract.md) §4). It left a "wait for ready"
control in the `demoflow record` panel out of scope as a follow-up, because a
live worker held `apps/cli` (#192). Since `91e12b8`, the panel can **show** a
`waitForReady` step (`describeStep`), but it cannot **add** one. An author who
records against an application that calls `window.demoflow.ready('<name>')`
has to edit the saved `.demo.json` by hand.

This issue adds the control. The author types a ready name and presses
**Wait for ready**. The panel then appends a `waitForReady` step, the same
way **Wait** appends a `wait` step.

## Scope

### In scope

- `apps/cli/src/record/panel.ts`:
  - a `{ type: 'waitForReady'; name: string }` member of `PanelCommand`;
  - the input and the button in `PANEL_HTML`;
  - the button's handler in the panel script.
- `apps/cli/src/record/session.ts`: the `waitForReady` case of
  `applyCommand`.
- `apps/cli/test/record/**`: tests (Vitest under Node).
- `apps/web/src/app/docs/record/page.mdx`: one row in the panel table.

### Out of scope

- Detecting the page's `window.demoflow.ready()` calls during recording and
  offering their names. The recorder does not install the engine's page
  scripts, and the spec 198 follow-up asked only for a control.
- Any change to `packages/**`. The action, its schema and its replay exist.
- A timeout field on the step. `waitForReady` takes the step-level
  `timeoutMs` like every step, and the panel sets no step-level option for
  any step.
- `apps/web/src/app/docs/sdk/page.mdx` and the docs sidebar.

## Decisions

1. **One text input and one button, in their own row.** The row sits under
   the **Wait** row. The input is labelled `Ready name` with the placeholder
   `e.g. dashboard-loaded`. The button reads **Wait for ready**.
   - The input is separate from the title input of **Scene**/**Caption**: a
     ready name is an identifier, not prose.
   - Pressing the button with an empty input focuses the input and sends
     nothing, the same as an empty title for **Scene**.
2. **Validate with `ReadyNameSchema` from `@demoflow/core`.**
   - The session trims the name, then validates it with
     `ReadyNameSchema.safeParse`. There is no regex copy in the CLI.
   - A valid name pushes `{ action: 'waitForReady', name }` through the
     existing `push`. The step is appended at the end, and `render()` runs.
   - An invalid name pushes nothing. It sets `notice` to
     `"<name>" is not a ready name: <schema message>` and renders.
     `<schema message>` is the first issue's message, so it states the rule.
   - The panel script clears the input only after it sends a command. The
     session is still the authority: the panel page is not trusted to have
     validated anything.
3. **Nothing else changes.**
   - The step list already shows `wait for ready <name>` (`describeStep`).
   - Remove and move already work on any step.
   - `save.ts` already writes any `ScenarioStepInput`.
   - Capture mode is unaffected: the command does not change `mode`, the same
     as **Wait**.
4. **A `waitForReady` step can be ticked into a repeat.** `wrapRepeat`
   accepts any non-repeat step. A ready step inside a `repeat` is valid
   (spec 165 allows any step but `repeat` inside one), so nothing is added to
   stop it.
5. **Docs.** The panel table in `apps/web/src/app/docs/record/page.mdx` gets
   this row, placed after **Wait**:

   > | **Wait for ready** | A `waitForReady` step for the name in the ready field: the run waits until your app calls `window.demoflow.ready('<name>')`. See [Application SDK](/docs/sdk). |

## Acceptance criteria

- [ ] The panel has a `Ready name` input and a **Wait for ready** button.
- [ ] With a valid name, the saved `.demo.json` contains
      `{ "action": "waitForReady", "name": "<name>" }` at the position the
      button was pressed. The panel list shows `wait for ready <name>`.
- [ ] An invalid name adds no step. The panel's notice shows the name and
      the schema's rule. Test it with `"9 bad name!"` or similar: it must
      fail the regex, not only be empty.
- [ ] The step can be removed and moved like any other.
- [ ] The saved scenario passes `ScenarioSchema`.
- [ ] Tests live in `apps/cli/test/record/`:
  - one in `record.spec.ts` drives the real panel through the existing
    harness (`panelButton`, `panelShows`, `stopAndSave`) for a valid name;
  - the invalid-name path is covered too, in the same suite or as a unit
    test of the command handling.
- [ ] `apps/web/src/app/docs/record/page.mdx` has the row from Decision 5.
- [ ] `bun run check` and `bun run build` are green, and so is the
      execution-plane matrix (Linux, macOS, Windows).

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i224 | the panel control | apps/cli/src/record/panel.ts, apps/cli/src/record/session.ts, apps/cli/test/record/**, apps/web/src/app/docs/record/page.mdx | — | yes | sonnet |

## Contention

- #225 works in `apps/cli/src/mcp/**` and `apps/cli/src/runs-report/**`.
  There is no shared file.
- #210 adds its own docs page. This issue edits only `record/page.mdx` and
  leaves the sidebar alone.
- It does not touch `packages/**`, which #218, #221 and #209 hold.

## Open questions

None.

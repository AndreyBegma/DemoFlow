# A `press` step for keyboard actions

Issue: [#91](https://github.com/AndreyBegma/DemoFlow/issues/91) · feature ·
Decisions: [ADR-0003](../adr/0003-scenario-format-and-project-config.md) (scenario format; additive change),
spec [1](1-core-contracts.md) (an additive field or step keeps `schemaVersion: 1`)

Depends on #85

## Summary

The scenario format has no keyboard step, so a form submitted with Enter — or
any keyboard-only action — cannot be written by hand or recorded by
`demoflow record` (#79) [Confirmed: `STEP_ACTIONS` in `packages/core/src/step.ts`].
This item adds `press`: a key (or a short chord) sent to a target, or to the
focused element when no target is given.

## Scope

### In scope

- **Core**: `press` in `STEP_ACTIONS` and `StepSchema`:
  `{ action: 'press', key: string, target?: Locator, caption?, timeoutMs? }`.
  `key` follows Playwright's key names (`Enter`, `Tab`, `Escape`,
  `ArrowDown`, …) or a chord with `+` (`Control+a`, `Meta+k`), validated
  against an allow-list of names and modifiers (no free text — typing text is
  `fill`). The committed `packages/core/schemas/scenario.schema.json` is
  regenerated.
- **Engine**: `press` focuses the target (moving the pointer to it first, as
  `click` does, when a target is given), then `keyboard.press(key)`; waits for
  a navigation it starts, as `click` does (`navigationStart`); the timeline
  event records the key; `maskVisibility` checks (#18) run after it like any
  step.
- **Renderer**: a small key badge (e.g. `⏎ Enter`) near the target for the
  step's duration, in the compositor's existing caption style; covered by a
  new golden image (#73).
- **Record**: `demoflow record` (#79) captures Enter, Tab, Escape and arrow
  keys in a field as `press` steps on that field — never a key inside a masked
  field's value (typing stays `fill` / `valueFrom`).

### Out of scope

- Arbitrary text typing (that is `fill`), key holds, keyboard shortcuts as
  macros.

## Decisions

1. **Additive, `schemaVersion` stays 1.** — spec 1.
2. **An allow-list of keys**, not free strings. — orchestrator (owner
   delegated): keeps scenarios portable and prevents `press` becoming a typing
   channel.
3. **The badge is drawn by the renderer**, not the page. — orchestrator.

## Acceptance criteria

- [ ] `StepSchema` accepts `{ action: 'press', key: 'Enter', target: … }` and
      a chord `Control+a`; rejects an unknown key name and an empty key; the
      JSON Schema is regenerated (core tests).
- [ ] A fixture scenario that types into the customers search and presses
      Enter filters the list; the timeline event has `action: 'press'`,
      `key: 'Enter'` (engine test, all three OSes).
- [ ] A `press` that submits a form navigating to another page is waited for
      like a `click` (engine test with a test page).
- [ ] The rendered video shows the key badge during the step (golden image).
- [ ] `demoflow record` turns Enter in a text field into a `press` step and
      never records keys inside a password field (record test).
- [ ] `bun run check` passes; Woodpecker and all three OSes green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i91 | the step in core, engine, renderer and record | packages/core/src/step.ts, packages/core/test/**, packages/core/schemas/**, packages/engine/src/execute/**, packages/engine/test/**, packages/renderer/src/**, packages/renderer/test/**, apps/cli/src/record/**, apps/cli/test/record/** | #85 | yes | sonnet |

One slot: the four layers must agree on one step. `sonnet`: every decision is
written here. Depends on #85 only because that slot holds `packages/engine/**`.

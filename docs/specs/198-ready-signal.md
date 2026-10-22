# `window.demoflow.ready(name)` and a `waitForReady` step

Issue: [#198](https://github.com/AndreyBegma/DemoFlow/issues/198)
Depends on: #197 (merge order only — both edit `packages/engine/src/run.ts`
and the init-script setup; start from `develop` after #197 has merged)

## Summary

Roadmap, Phase 7, item 2. [ADR-0013](../adr/0013-page-side-contract.md) §3–5
fix the contract. A scenario can wait for a state the application reports, so
it does not have to guess with a locator or a fixed `wait`:

```js
// in the application, after the customers have loaded
window.demoflow?.ready('customers-loaded');
```

```json
{ "action": "waitForReady", "name": "customers-loaded" }
```

The engine defines `window.demoflow` on every document of a run. Outside a run
it is undefined, so the application's call is a no-op and nothing is
installed.

## Scope

### In scope

- `packages/core/src/step.ts`:
  - `waitForReady` is added to `STEP_ACTIONS` and to the step union;
  - `ReadyNameSchema` is exported;
  - `packages/core/schemas/scenario.schema.json` is regenerated.
- `packages/engine/src/execute/ready.ts` (new):
  - the page script, installed with `context.addInitScript` in the same place
    as #197's script and the navigation probe;
  - the wait.
- `packages/engine/src/execute/actions.ts`: `case 'waitForReady'`.
- Tests in `packages/core/test`, `packages/engine/test/execute` and
  `packages/renderer/test/plan` (the idle rule).

### Out of scope

- A "wait for ready" control in the `demoflow record` panel
  (`apps/cli/src/record/**`). A live worker owns `apps/cli` (#192). This is a
  follow-up.
- The website's docs page (`apps/web/src/app/docs/**`), owned by #193's
  worker. The follow-up uses the user-facing text below.
- Annotations through the JS API (roadmap Phase 7, item 3), and an npm
  package.
- Signals from iframes (ADR-0013 §6).

## Decisions

1. **A new action, `waitForReady { name }`, not a `ready` field on `waitFor`.**
   - *Why:* `waitFor` maps one to one onto Playwright's `locator.waitFor`
     (ADR-0003 §3). Making its `target` optional would make `state` and
     `zoom` conditional on which key is present, and blur its error
     messages.

   The step has the common fields (`caption`, `timeoutMs`, which defaults to
   10 s and is capped at 60 s), no `target`, and no `zoom`. A `zoom` is
   rejected by the strict object as an unknown key. The test checks the
   message.
2. **Name format.** `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` (ADR-0013 §4).
   - Inside a `repeat`, a `{{…}}` template is accepted, through `format()`
     like the step's other formatted fields. The expanded name is checked
     against the plain schema.
   - *Why:* names appear in error messages and in `result.json`. A narrow
     alphabet keeps them safe to print and to log.
3. **The page global.** The init script defines `window.demoflow` as a frozen
   object `{ version: 1, ready(name) }`. It uses `Object.defineProperty`,
   with `configurable: true` and `writable: true`.
   - An application that assigns its own `window.demoflow` is not broken. Its
     signals are lost, so the wait fails loudly with `ready-timeout`.
   - It never throws.

   The ready set lives on a registered symbol (`Symbol.for('demoflow.ready')`),
   as the navigation probe does. Page code does not see it as a property name.
4. **Signals are per document, and sticky.**
   - `ready(name)` adds `name` to the document's set.
   - The set is never cleared while the document lives.
   - A new document (a document navigation, a reload) starts empty.
   - A same-document navigation (`pushState`) keeps the set.
   - *Why:* this matches `waitFor`: waiting on a state that is already true
     returns at once, and a new page has to report again. Consuming a signal
     on each wait would hang a scenario that waits twice on one load.
5. **Invalid calls are ignored, not reported.** A non-string argument or a
   malformed name neither throws nor counts, and nothing tells the page why.
   A valid call made before `document.body` exists, from a `<head>` script,
   does count: the set does not need the DOM. The step's timeout message names what the
   scenario waited for.
6. **The wait.** `page.waitForFunction` checks the ready set, polling every
   50 ms, with `timeout: step.timeoutMs`.
   - Playwright re-runs it in the new execution context after a navigation.
     A navigation during the wait is therefore waited through, and the new
     document must signal again.
   - When the time runs out, the step fails as an `execution` failure with
     the message `ready-timeout <name>`, the same shape as
     `missing-env <name>`.
   - *Why 50 ms:* the acceptance bound is 100 ms after the signal. The CPU
     cost while waiting is negligible.
7. **Nothing leaves the machine.** `ready` does not call a binding or the
   network. The engine reads the set only through `waitForFunction`, so the
   set holds only names the scenario already knows. ADR-0008 is unchanged.
8. **Timeline and renderer.** The event is the plain step event:
   - `action: 'waitForReady'`, with its times;
   - no target, no box, no new field.

   The renderer's `ACTIVE` set does not get it, so a frozen frame during the
   wait is idle and compressed, like `wait`. A spinner that moves is not idle
   (ADR-0004 §5). `StepActionSchema` grows by one value, and an older
   timeline parses as before.
9. **The install point.** It is one `installPageScripts(context)` in
   `packages/engine/src/execute/`, which installs the navigation probe (#117),
   #197's mask script and this one. #197 lands first. If it has not created
   such a function, this issue introduces it and moves the existing installs
   into it unchanged.

## User-facing text (for the docs follow-up)

> Your application can tell a scenario when it is ready: call
> `window.demoflow?.ready('<name>')` once the state is reached, and add a step
> `{ "action": "waitForReady", "name": "<name>" }`. `window.demoflow` exists only
> while DemoFlow runs your app, so the optional call is safe in production. A
> signal lasts until the page is reloaded or another page is opened. Names are
> letters, digits and `. _ : -`, up to 64 characters. Nothing is sent anywhere.

## Acceptance criteria

Vitest under Node, on the execution-plane matrix (Linux, macOS and Windows):

- **Core:**
  - `waitForReady` with a valid name parses, and so does one with a `{{…}}`
    name inside a `repeat`;
  - a missing name, a malformed name, a `target` and a `zoom` are rejected,
    each with a precise path and message;
  - `scenario.schema.json` is regenerated, and the existing zod-vs-JSON Schema
    test passes.
- **Engine, inline pages:**
  - a signal sent on load passes the step at once (under 200 ms);
  - a signal sent 500 ms into the step passes it, and the step's `endMs` is
    within 100 ms of the signal's engine time;
  - no signal fails the step with `ready-timeout <name>` at `timeoutMs`, as
    an execution failure;
  - a signal before a document navigation does not pass a wait after it;
  - a signal survives `history.pushState`;
  - `ready(42)` and `ready('bad name!')` neither throw nor count;
  - a valid `ready` called from an inline `<head>` script, before `<body>`
    exists, counts;
  - `window.demoflow.version === 1` on the first document and on one opened
    by a click.
- **Timeline:** the `waitForReady` event has no `target` and validates
  against `TimelineSchema`.
- **Renderer, plan:** a frozen stretch during `waitForReady` is compressed,
  like `wait`.
- `bun run check` and `bun run build` are green, and so is the
  execution-plane matrix.

## Open questions

None.

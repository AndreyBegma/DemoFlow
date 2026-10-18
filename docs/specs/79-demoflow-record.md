# `demoflow record` — author a scenario by clicking

Issue: [#79](https://github.com/AndreyBegma/DemoFlow/issues/79) · roadmap step 3 ·
Decisions: [ADR-0003](../adr/0003-scenario-format-and-project-config.md) (scenario format),
[ADR-0008](../adr/0008-cloud-boundary.md) §4 (commands only from local config),
[roadmap.md](../product/roadmap.md) ("`demoflow record`")

Depends on #75

## Summary

Writing a `*.demo.json` by hand is the main barrier to a first demo. `demoflow
record` starts the project's application from `devCommand` / `readyUrl`, opens
it in a browser together with a separate step-panel window, turns the person's
clicks and typing into scenario steps with stable locators, lets them add
captions, scenes and assertions from the panel, and on stop writes a validated
scenario file and offers to run it.

## Scope

### In scope

- `demoflow record [name]` in a project (found as the CLI finds it): starts the
  app from `devCommand` / `readyUrl` in `demoflow.config.json` (ADR-0008 §4),
  opens a headed Chromium on `baseUrl` with the scenario viewport.
  *Amended in #93, orchestrator decision: `devCommand` had no
  implementation — the summary said "exactly as `demoflow run` does", but `run`
  never starts the app. Starting it is a shared module
  (`apps/cli/src/app/dev-server.ts`, `startApp(config, root) → { stop() }`, a
  no-op without `devCommand` or when `readyUrl` already answers) that `record`
  uses now and `run` adopts in a follow-up.*
- **Step panel in a separate window** (owner's choice): the live step list,
  buttons for caption, scene marker, wait, "pick an element" and stop; delete or
  reorder a step. Nothing is injected into the application's page except the
  event listeners that capture input (and are not part of the recording).
- **Captured actions**: `navigate` (the first URL and any typed-in URL), `click`,
  `fill`, `select`, `hover` (only when the panel marks it), page `scroll`.
- **Locators** in the order the scenario format prefers: `role` + `name`, then
  `label`, `placeholder`, `testId`, `text`, and `css` only as a last resort —
  each chosen locator must resolve to exactly one element at record time; a
  `css` fallback is flagged in the panel.
- **Secrets**: input into a password field (or a field the panel marks) is
  never written; the step becomes `valueFrom: { env: "<NAME>" }`, with the name
  asked in the panel (default `DEMO_PASSWORD`).
- **Assertions via "pick an element"** (owner's choice): in that mode a click
  is not passed to the page; it adds `assertVisible`, or `assertText` with the
  element's current text.
- **On stop** (owner's choice): write `demoflow/<name>.demo.json` (never
  overwrite without `--force`), validate it against the schema, print the path,
  and offer to run it now (`demoflow run`); `--no-run` skips the offer.

### Out of scope

- Recording into the MCP flow, editing an existing scenario, mobile viewports.

## Decisions

1. **Separate panel window**; **pick-element assertions**; **save, validate and
   offer a run** — owner (#79 interview, 2026-10-18).
2. **Locator preference and uniqueness check** as above — orchestrator, from
   ADR-0003's locator kinds (`packages/core/src/locator.ts`).
3. **Secrets never touch disk** — orchestrator; consistent with masking (#18,
   #42).

## Acceptance criteria

- [ ] Against the fixture app, a scripted recording session (the test drives
      the headed browser through Playwright as a user would: navigate, click
      "Customers", type in search, pick a heading as `assertText`) produces a
      scenario that validates and that `demoflow run` executes with
      `verification: passed`.
- [ ] Recorded locators are `role`/`name` where the element has an accessible
      role and name; a `css` locator appears only when nothing else is unique,
      and the panel shows it as a warning.
- [ ] Typing into the login password field records
      `valueFrom: { env: "DEMO_PASSWORD" }` and the typed text appears nowhere
      in the written file or the console output.
- [ ] In pick-element mode a click adds an assertion and does not reach the
      page (the page's click counter in a test page stays unchanged).
- [ ] An existing `demoflow/<name>.demo.json` is not overwritten without
      `--force`.
- [ ] Tests under Node with Vitest on all three OSes (headed tests use the
      platform's virtual display on Linux CI); `bun run check` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i79 | the record command, panel, capture, locator choice | apps/cli/src/record/**, apps/cli/src/main.ts, apps/cli/test/record/** | #75 | yes | opus |

One slot. `opus`: first interactive, headed feature; locator choice and input
capture are decided here.

## Risks

- **Headed browser on CI** (medium): Linux needs a virtual display (xvfb).
  Mitigation: the workflow wraps the record tests in `xvfb-run`; macOS and
  Windows run headed natively.
- **Brittle locators** (medium). Mitigation: the uniqueness check and the
  `css` warning.

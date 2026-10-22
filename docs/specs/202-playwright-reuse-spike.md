# Spike: reuse existing Playwright tests as demo scenarios

Issue: [#202](https://github.com/AndreyBegma/DemoFlow/issues/202) · Phase 7, item 4 ·
Decisions it may touch: [ADR-0001](../adr/0001-control-plane-execution-plane-one-package.md),
[ADR-0003](../adr/0003-scenario-format-and-project-config.md)

Depends on: nothing

## Summary

Many applications that DemoFlow could demonstrate already have Playwright
tests that walk through their flows. Roadmap Phase 7, item 4 asks to reuse
them as demo scenarios, and vision §4 allows scenarios "adapted from existing
tests". There are several ways to do this, and none is proven, so this issue
is a **time-boxed spike**. Its deliverable is a report with a recommendation,
not a feature.

Candidates:

1. **Trace import.** The user runs their test with `trace: 'on'`. A converter
   reads `trace.zip` and writes a `.demo.json` scenario: each recorded action,
   with its locator, becomes a step. The scenario then runs through DemoFlow
   as usual.
2. **Source conversion.** A converter parses the test file (the TypeScript
   compiler API, which `apps/cli` would have to depend on) and maps
   `page.getByRole(…).click()` and similar calls onto steps. Control flow,
   helpers and fixtures are the risk.
3. **Playwright Test fixture.** A `demoflow/playwright` entry exports a `test`
   whose `page` records like the engine does: video, timeline and sync mark,
   with step events from Playwright's `test.step` and its action hooks. The
   test itself drives the browser, and there is no scenario. This moves the
   boundary of ADR-0003, where the scenario is the contract the engine
   executes.

## Scope

### In scope

- A probe on a branch `spike/202-probe`, **never merged**:
  - `@playwright/test` as a dev dependency, pinned exactly;
  - three probe tests against `apps/fixture`, each the Playwright Test
    equivalent of an existing hand-written scenario:
    `login.demo.json` (with the password from `process.env`),
    `customers.demo.json`, and `tour.demo.json`;
  - one prototype per candidate, as far as the time box allows, with Vitest
    files under Node that run each prototype on the three probe tests and
    compare its output with the hand-written scenario.
- `docs/research/202-playwright-reuse-spike.md`: the report (Decision 3).
- On the `develop` pull request: the report, this spec's outcome line, and
  the Phase 7 links in `docs/product/roadmap.md`.

### Out of scope

- Shipping any converter, fixture or CLI command. That is the follow-up the
  report drafts.
- Tests written with other runners (Cypress, WebdriverIO).
- Changing `packages/core`, `packages/engine`, `packages/renderer` or
  `apps/cli` on `develop`.

## Decisions

1. **The criteria are fixed here.** The report measures every candidate it
   reaches against all of them:
   - **Coverage:** at least 90% of the actions in the three probe tests, by
     count, become steps whose locators equal the hand-written scenario's.
     For candidate 3, they become timeline events with the target's box. Every
     action that is not converted is named, with the reason.
   - **Secrets:** a password the test reads from `process.env` becomes
     `valueFrom.env` (candidates 1–2), or a masked fill (candidate 3). A
     literal password in the test is never written in clear to a scenario,
     a timeline or a video. Either the converter refuses it with a message
     that names the line, or it masks it.
   - **Stability:** every private or undocumented Playwright API used is
     listed. One is acceptable only if the follow-up can pin it to the
     Playwright version DemoFlow already pins, and fail with a clear message
     on another version. The trace format counts as undocumented.
   - **Platforms:** Linux, macOS and Windows, with the probe's Vitest run
     green on all three in CI.
   - **Boundaries:** the candidate fits ADR-0001 (Node, one `demoflow`
     package) and ADR-0003 (the scenario is the contract), or the report
     argues for a new ADR and drafts it.
   - **Follow-up size:** an estimate in issues, each one slice.
2. **Time box.** One working session for the probe. Candidate 1 is measured
   first, because it keeps the scenario as the contract and needs no parser.
   Candidate 2 comes next and candidate 3 last. A candidate the box does not
   reach is marked "not measured" with what is known about it from
   Playwright's documentation. It is not argued from guesses.
3. **The report** has these sections:
   - method;
   - per candidate:
     - the Playwright API to step mapping, covering at least `goto`,
       `getByRole`, `getByLabel`, `getByTestId`, `locator`, `click`, `fill`,
       `selectOption`, `press`, `hover`, `expect(…).toBeVisible()`,
       `expect(…).toHaveText()`, `waitFor` and `test.step`;
     - coverage numbers;
     - secrets handling;
     - private APIs;
     - cross-OS notes: paths, zip handling, spawning the test runner;
   - the decision against each criterion;
   - the recommended follow-up issues, each with a title, scope, touches and
     depends-on;
   - a draft ADR if a boundary moves.

   If no candidate passes, the report says so, and the roadmap item is marked
   as decided against, as #85 did for the 2× source.
4. **The probe does not merge**, so no dependency or code reaches `develop`.
   CI runs for the three OSes come from a draft pull request of the probe
   branch, closed unmerged afterwards. The report links the run ids.

## Acceptance criteria

- [ ] `docs/research/202-playwright-reuse-spike.md` covers every section of
      Decision 3 for each candidate. A candidate outside the time box is
      marked "not measured".
- [ ] Coverage is reported as counts on the three probe tests, against the
      hand-written scenarios.
- [ ] The report states the decision against each criterion of Decision 1,
      and the drafted follow-up issues, or the reason none is recommended.
- [ ] The probe branch `spike/202-probe` exists. Its Vitest run under Node is
      green on Linux, macOS and Windows, and the run ids are in the report.
- [ ] The `develop` pull request changes only `docs/research/**`, this spec's
      outcome line and `docs/product/roadmap.md`. `bun run check` is green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i202 | the probe branch and the report | docs/research/202-playwright-reuse-spike.md, docs/specs/202-playwright-reuse-spike.md, docs/product/roadmap.md (probe branch: anything, never merged) | — | yes | opus |

One slot. `opus`: an open comparison where the judgement about private
Playwright APIs and the ADR-0003 boundary is the deliverable.

## Risks

- **The trace format changes between Playwright versions** (high for
  candidate 1). Mitigation: the stability criterion, and a version pin
  checked at import.
- **Tests use helpers, fixtures and loops** (high for candidate 2): a
  test is code, not data. Mitigation: coverage is measured on real-shaped
  tests, and the report names what does not convert.
- **Candidate 3 duplicates the engine** (medium): recording, sync mark and
  masks would live in two drivers. Mitigation: the boundaries criterion and
  a draft ADR if it is still recommended.

## Open questions

None for the spike itself. The answers are its deliverable.

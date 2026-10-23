# Playwright-reuse spike: trace import, source conversion, or a Test fixture

Issue: [#202](https://github.com/AndreyBegma/DemoFlow/issues/202) ·
Spec: [202-playwright-reuse-spike](../specs/202-playwright-reuse-spike.md) ·
Decisions: [ADR-0001](../adr/0001-control-plane-execution-plane-one-package.md),
[ADR-0003](../adr/0003-scenario-format-and-project-config.md)

**Outcome: recommend candidate 3 in one specific form. A Playwright Test
fixture records the test as it runs and writes a scenario, and the engine
replays that scenario. The form the spec drafted is rejected: a fixture that
writes the timeline and video itself records at test speed, so its video is
not a demo. The scenario stays the contract. The new public entry
`demoflow/playwright` moves ADR-0001's module table, so a draft ADR is
included.**

| Candidate | Coverage (of 30) | What decides it |
|---|---|---|
| 1. Trace import | 24 (80.0%) | Below 90%. The trace keeps no screenshot file name, and a scroll the test makes through `evaluate` or `mouse.wheel` carries no intent. The trace format and the internal selector syntax are undocumented. Each can be pinned, and the probe pins both. |
| 2. Source conversion | 24 (80.0%) | Below 90%. A helper function is code, not data, and so are scrolls. `typescript` (26 MB) would become a runtime dependency of `demoflow`. |
| 3a. Fixture writes timeline + video (the spec's form) | 28 (93.3%) | Passes coverage, but runs at test speed. The whole login flow takes 0.3 s of video, against 2.6–3.3 s when the engine replays it. To fix that, the fixture would have to re-implement the engine's pacing, sync mark and masks: two drivers. |
| **3b. Fixture records a scenario, the engine replays it** | **28 (93.3%)** | Passes every criterion. It uses only public Playwright API, and it keeps ADR-0003. The engine replayed all three recorded scenarios on Linux, macOS and Windows. |

## Method

The probe is on the branch
[`spike/202-probe`](https://github.com/AndreyBegma/DemoFlow/tree/spike/202-probe)
at commit
[84aa203](https://github.com/AndreyBegma/DemoFlow/commit/84aa20346b63245851d914f16f7f96b3b5a0fbeb).
The branch is never merged, and is deleted once this report's pull request is
open, so the commit link is the durable reference. Every path below is under
`spike/202/` at that commit.

- **Isolation.** `spike/202` is a standalone package, not a workspace. It
  pins `@playwright/test` 1.64.1 (the engine's `playwright` pin), `vitest`
  5.0.3 and `typescript` 6.0.2 exactly. It imports `packages/core` and
  `packages/engine` by path, read-only, and changes nothing under `packages/`
  or `apps/`.
- **Probe tests** (`probe-tests/`). The three scenarios the spec names,
  `login`, `customers` and `tour`, rewritten as Playwright Test files the way
  a team would write them:
  - the password comes from `process.env.FIXTURE_PASSWORD`;
  - `customers` fills its search box through a helper, `search(page, q)`, and
    groups its flow in `test.step`s;
  - `tour` scrolls through `page.evaluate(() => window.scrollTo(…))` and
    `page.mouse.wheel`, because Playwright has no "scroll to bottom" action.

  `probe-tests-demoflow/` holds the same three files with only the import line
  changed, and a test asserts that this line is the only difference.
- **Runs.** A Vitest global setup spawns `node <@playwright/test>/cli.js test`
  once, with no shell. It runs two projects:
  - `plain`: `trace: 'on'`, for candidate 1;
  - `demoflow`: the fixture, recording video at 1280×720 and
    `deviceScaleFactor` 2, for candidate 3.

  Candidate 2 reads the `plain` sources.
- **Coverage.** Each candidate's output is validated with the core
  `ScenarioStepSchema` (candidate 3b's with `parseScenario`, as a whole
  scenario). It is then compared with the hand-written `.demo.json` by the
  longest common subsequence (`src/compare.ts`).
  - Two steps are equal when the action, the locator and the action's own
    fields agree. Candidate 3 also needs the box the fixture measured.
  - `caption`, `zoom`, `timeoutMs` and an assertion's `match` are not
    compared, because a test has no captions. `match` is reported below.
  - The denominator is the hand-written steps: login 5, customers 11, tour 14,
    so 30 in all. A step a candidate writes that the scenario lacks is listed
    as "extra" and costs nothing.
- **Pinned results.** Each spec asserts the per-probe counts it measured, so
  every OS has to reproduce the same numbers.
- **CI.** `.github/workflows/spike-202.yml` exists on the probe branch only.
  It runs on `ubuntu-latest`, `macos-latest` and `windows-latest`: it builds
  the fixture, serves it with `.github/scripts/serve-fixture.mjs`, typechecks
  the probe and runs the Vitest suite under Node 24. Runs are triggered by
  push to the probe branch, not by a draft pull request as Decision 4 says,
  because the brief said the probe is never opened as a pull request.

| Run | Commit | Linux | macOS | Windows |
|---|---|---|---|---|
| [39836392562](https://github.com/AndreyBegma/DemoFlow/actions/runs/39836392562) | 4b90a20 (candidates 1–3a) | green | green | red: the probe's own "only the import differs" check split on `\n` and met CRLF. All coverage counts matched Linux. |
| [39837067738](https://github.com/AndreyBegma/DemoFlow/actions/runs/39837067738) | 84aa203 (final: 3b and the engine replay) | green | green | green |

The final run printed the same counts on all three OSes: trace import 24/30,
source conversion 24/30, fixture 28/30. It printed this engine-replay span
for login: Linux 2,563 ms, macOS 3,320 ms, Windows 2,647 ms.

## Candidate 1: trace import

`src/trace-import.ts`, `src/selector.ts` and `src/zip.ts`.

A test-runner `trace.zip` holds two event streams that share `callId`s:

- `test.trace` is the runner's view. It has `test.step`, `pw:api` and `expect`
  calls in source order, each with a stack that gives `file:line`.
- `<n>-trace.trace` is the library's view of the same calls. It has the class
  and method, and the params with the locator compiled to an internal
  selector, such as `internal:role=button[name="Sign in"i]`.

The importer walks the runner stream for order, steps and lines, and joins it
to the library stream for the action and its exact locator. The quote suffix
carries `exact`: `"…"i` is a substring match and `"…"s` is exact. Calls made
inside fixtures and hooks are dropped.

### Mapping

| Playwright | Trace event (library) | Step |
|---|---|---|
| `page.goto(url)` | `Frame.goto {url}` | `navigate {path}`, or `{url}` when it leaves `baseURL` |
| `getByRole(r, {name, exact})` | `internal:role=r[name="…"i\|s]` | `{ role, name, exact? }` |
| `getByLabel(t)` | `internal:label="…"i\|s` | `{ label, exact? }` |
| `getByTestId(t)` | `internal:testid=[data-testid="…"s]` | `{ testId }` |
| `getByText(t)` | `internal:text="…"i\|s` | `{ text, exact? }` |
| `locator(css)` | the bare selector, `tbody` | `{ css }` |
| `.click()` | `Frame.click` | `click` |
| `.fill(v)` | `Frame.fill {value}` | `fill {value}`, or `{valueFrom}` (see Secrets) |
| `.selectOption(o)` | `Frame.selectOption {options:[{valueOrLabel}]}` | `select {option}` (one option only) |
| `.press(k)` | `Frame.press {key}` | `press {key}`, if `pressKeyProblem` accepts it |
| `.hover()` | `Frame.hover` | `hover` |
| `expect(l).toBeVisible()` | `Frame.expect {expression:"to.be.visible"}` | `assertVisible` |
| `expect(l).toHaveText(t)` | `Frame.expect {expression:"to.have.text", expectedText:[{string}]}` | `assertText {text, match:"exact"}` |
| `expect(l).toContainText(t)` | the same, with `matchSubstring: true` | `assertText {text, match:"contains"}` |
| `.waitFor({state, timeout})` | `Frame.waitForSelector` | `waitFor {state, timeoutMs?}` |
| `test.step(title)` | runner `test.step` | `marker {title, kind:"scene"}` |
| `page.screenshot({path})` | `Page.screenshot {type}`, with **no path** | not converted |
| `page.evaluate(…)`, `page.mouse.*` | `Frame.evaluateExpression`, `Page.mouseWheel` | not converted |

Not converted, each with a reason in the output:
- a chained selector (`>>`, `nth=`, a frame hop);
- a regex in a locator or in `toHaveText`;
- a negated `expect`;
- `selectOption` with several options;
- `press` of a printable character, which is typing.

### Coverage: 24 of 30 (80.0%)

| Probe | Converted | Not converted, and why |
|---|---|---|
| login | 5 / 5 | none |
| customers | 11 / 11 | none. The helper is invisible to the trace: it records the calls the helper made. |
| tour | 8 / 14 | Two `screenshot`s: the trace keeps no file name, so there is nothing to name the step after. Two page scrolls: `evaluate` is opaque. One container scroll: `mouse.wheel` has no target. The `Slow report` caption: `test.step` can only mean a scene. |

Extras: a `Create` scene (a `test.step` the scenario lacks) and a
`hover {testId: log-panel}` (how the test aims the wheel).

`login`'s `toHaveText` becomes `match: "exact"`. The hand-written step has
the default, `contains`. The importer is right: `toHaveText` matches the full
text.

### Secrets

- **The trace itself holds the password in clear.** It is in the runner's
  title (`Fill "<password>"`) and in both streams' `params.value`. The probe
  asserts this. Playwright does not mask fill values, so a `trace.zip` from a
  login test is a secret, whatever DemoFlow does with it.
- The importer takes `--secret-env NAME` (`secretEnv` in the probe). A filled
  value equal to that variable's current value becomes
  `valueFrom: { env: NAME }`. The scenario never holds it.
- Any other non-empty fill into a field whose label, placeholder or name looks
  like a secret (`/pass(word|code|phrase)?|secret|token|\bpin\b/i`) is refused.
  The message names the line: `refusing to write a literal password at
  login.spec.ts:8`.
- **Limit:** a secret typed into a field whose label does not look like one
  passes in clear. The trace's DOM snapshots would tell the field's `type`,
  but they are another undocumented format.

### Private and undocumented APIs

All of these come from Playwright 1.64.1. The spec counts the trace format as
undocumented.

1. The `trace.zip` layout: `test.trace` beside `<n>-trace.trace`, and the
   `context-options` header with `version: 10` and `playwrightVersion`.
2. The event schema: `before`/`after`, `callId`/`parentId`, `class`, `method`,
   `params`, and `stack`.
3. The internal selector syntax: `internal:role`, `internal:label`,
   `internal:testid`, `internal:text` and `internal:attr`, with the `i`/`s`
   quote suffixes.
4. The `expect` encoding: `expression` (`to.be.visible`, `to.have.text`),
   `expectedText[].string`/`matchSubstring` and `isNot`.
5. The zip as Playwright writes it: stored or deflated, no zip64. The probe
   reads it with `node:zlib` and adds no dependency.

**Pinnable: yes.** The importer refuses any other header with `trace from
Playwright 1.65.0 (format 10); this importer reads Playwright 1.64.1 (format
10) only`, and a test covers it. The cost is that every Playwright bump in
`demoflow` re-verifies the importer, and a user whose tests run another
Playwright version cannot import at all. Most suites pin their own Playwright,
which rarely equals DemoFlow's.

### Cross-OS

- The zip is read in memory, with no extraction, so no path in the archive
  touches the file system.
- Stack paths are absolute and OS-native (backslashes on Windows). The
  importer reports only the base name, split on `[\\/]`.
- The user's runner is spawned as `process.execPath <@playwright/test>/cli.js`,
  with no shell, `npx` or `.cmd` shim.
- The counts are the same on all three OSes.

## Candidate 2: source conversion

`src/source-convert.ts`, using the TypeScript compiler API.

It walks a test's body statement by statement. It understands:
- `page.getByX(…)` and `page.locator(…)` chains, and a `const` bound to one;
- `expect(…).toX(…)`;
- `test.step(title, body)`;
- string literals, and `process.env.X` (also `?? ''` and `!`).

Everything else is reported as not converted, with `file:line`.

### Mapping

The same table as candidate 1, read from source:

| Playwright | Step |
|---|---|
| `page.goto('/x')` | `navigate {path}`. A computed URL is not converted. |
| `getByRole('r', { name, exact })`, `getByLabel`, `getByTestId`, `getByText`, `getByPlaceholder`, `locator(css)` | the matching locator, from literal arguments only |
| `.click()`, `.hover()` | `click`, `hover` |
| `.fill('v')`, `.fill(process.env.X)` | `fill {value}`, `fill {valueFrom: {env: X}}` |
| `.selectOption('o')` | `select {option}` |
| `.press('Enter')` | `press {key}` |
| `.waitFor({ state, timeout })` | `waitFor {state, timeoutMs}` |
| `.scrollIntoViewIfNeeded()` | `scroll {target}` |
| `expect(l).toBeVisible()` | `assertVisible` |
| `expect(l).toHaveText('t')` / `toContainText('t')` | `assertText`, `exact` / `contains` |
| `test.step('t', …)` | `marker {title, kind:"scene"}`, then the body |
| `page.screenshot({ path: test.info().outputPath('n.png') })` or a literal path | `screenshot {name}` |
| a helper call, a loop, `if`, `page.evaluate`, `page.mouse.*` | not converted |

### Coverage: 24 of 30 (80.0%)

| Probe | Converted | Not converted, and why |
|---|---|---|
| login | 5 / 5 | none |
| customers | 9 / 11 | Both search fills: `search(page, 'Ada')` is a helper call. Its body is not inlined (`customers.spec.ts:13`, `:14`). |
| tour | 10 / 14 | Two page scrolls (`page.evaluate`), one container scroll (`page.mouse` is not a locator), and the `Slow report` caption. Screenshots convert, because the source has the file name. |

Candidates 1 and 2 miss different steps: candidate 1 the screenshots,
candidate 2 the helper. A hybrid would reach at most 26 of 30 (86.7%). That
figure is arithmetic, not a measurement. The trace does carry a copy of the
test source (`src/<sha1>.ts`) and each call's line. Scrolls stay out of reach
for both, so the hybrid stays below 90%.

Inlining helpers is where this candidate's cost grows without limit:
- same-file functions;
- then imported ones;
- then page objects and fixtures;
- then loops over data.

Each is a partial evaluator of TypeScript. A test is code, not data.

### Secrets

- `process.env.X` becomes `valueFrom: { env: "X" }` directly. No value is ever
  read, so nothing can leak.
- A literal into a secret-looking field is refused with its line (tested:
  `literal.spec.ts:3`). The label heuristic has the same limit as candidate 1.

### Private and undocumented APIs

None in Playwright: the converter reads method names from the public API.
It depends on the TypeScript compiler API. That API is public, but it would
put `typescript` (26 MB installed) into `demoflow`'s runtime dependencies,
against ADR-0001's "one install" spirit. A JavaScript test file would need
the same parser.

### Cross-OS

- Pure parsing, with no process to spawn.
- On Windows, a checkout with `core.autocrlf` gives CRLF sources.
  TypeScript accepts them, but any line-based code around it must split on
  `\r?\n`. The probe's own check failed on exactly that in run 39836392562.
- The counts are the same on all three OSes.

## Candidate 3: Playwright Test fixture

`src/fixture.ts` and `src/recorded-steps.ts`.

The test changes one line: it imports `test` and `expect` from the fixture
instead of `@playwright/test`. The fixture then does the following, using
public API only:

- **Page.** It overrides `page` with a `Proxy` over `Page` whose `getBy*` and
  `locator` return a `Proxy` over `Locator`. Each action reads
  `boundingBox()` and records an event with the locator it was built from and
  the box.
- **`expect`.** Its `expect` is a `Proxy` that unwraps the locator and records
  `toBeVisible`, `toHaveText` and `toContainText`.
- **`test.step`.** Its `test` is a `Proxy` whose `step` records a scene first.
- **Scrolls.** `page.evaluate` and `page.mouse.wheel` record a `scroll` when
  the page's scroll position changed. The fixture records what happened, not
  what the test meant.
- **Sync mark.** Before the test body runs, on the blank page, it paints the
  engine's sync mark (`recordSyncMark`, imported from `packages/engine`).
- **Teardown.** It writes three files:
  - `demoflow-timeline.json`: the events, the sync mark and the video path;
  - the source video, through `video.saveAs`. `video.path()` is a temporary
    file Playwright deletes after the test.
  - `recorded.demo.json`: the same events as a scenario.

### Mapping

| Playwright | Event | Recorded step |
|---|---|---|
| `page.goto(url)` | `navigate` | `navigate {path}` |
| `getByRole`, `getByLabel`, `getByTestId`, `getByText`, `getByPlaceholder`, `locator` | the locator, from the factory's arguments | the same |
| `.click()`, `.hover()` | the event with `target.box` | `click`, `hover` |
| `.fill(v)` | `fill`, masked `***` when the field is `type=password` or the value equals an env var | `fill {value}` or `{valueFrom: {env}}` |
| `.selectOption(o)` | `select` with the box | `select {option}` |
| `.press(k)` | `press` with the box | `press {key, target}` |
| `.waitFor()` | `waitFor`, with the box measured after it resolves | `waitFor {state}` |
| `expect(l).toBeVisible()` / `toHaveText(t)` / `toContainText(t)` | `assertVisible` / `assertText` with the box | the same |
| `test.step(title)` | `marker` | `marker {kind:"scene"}` |
| `page.screenshot({path})` | `screenshot`, named from the path | `screenshot {name}` |
| `page.evaluate(…)` that scrolls the page | `scroll {before, after}` | `scroll {to: top\|bottom}` |
| `page.mouse.wheel` over a container | no page movement, so nothing | not converted |

### Coverage: 28 of 30 (93.3%)

The count is the same for 3a (timeline events with a box) and 3b (recorded
steps): they are the same events.

| Probe | Converted | Not converted, and why |
|---|---|---|
| login | 5 / 5 | none |
| customers | 11 / 11 | none. The helper runs, and the fixture sees its calls. |
| tour | 12 / 14 | The container scroll: the fixture watches only the page's scroll position. The `Slow report` caption: `test.step` can only mean a scene. Both are follow-up 3. |

### 3a against 3b: why the fixture should not write the video itself

The probe measured the fixture's own recording. From the first event to the
last, the login flow spans **under 0.3 s** on Linux (the test asserts < 2 s
on every OS). The engine paces a demo:
- the pointer travels to each target (`moveSteps`);
- typing runs at 35 ms a key (`TYPING_DELAY_MS`);
- it waits for readiness and settles navigations.

A test does none of that, because it is built to be fast. The renderer cannot
slow time down, because the frames between two actions do not exist. So 3a's
video is a correct recording of a test and not a demo. Making it a demo means
running the engine's pacing, pointer, mask tracking and navigation recording
inside the fixture: a second driver, which the spec's risk table predicted.

3b avoids that. The same events become a scenario, and `runScenario` replays
it. The probe replays all three recorded scenarios through the engine,
unchanged, on all three OSes:
- execution and recording both pass;
- the login replay spans **2.6–3.3 s** (CI: Linux 2.6, macOS 3.3, Windows
  2.6) against 0.3 s for the test.

The fixture's timeline and video become a by-product. The follow-up can drop
them, and the sync-mark import with them.

### Secrets

- **Masked by what the field is**, not by where the value came from. A fill
  into `input[type=password]` is recorded as `***`, `masked: true`. This also
  covers a literal password in the test.
- The test runs in the fixture's process, so a filled value that equals an
  environment variable's value (8 characters or more) is traced back to it.
  The recorded step is `valueFrom: { env: "FIXTURE_PASSWORD" }`.
- A masked value with no variable behind it writes no step. The follow-up
  should refuse it with the test's line (`test.info()` and the stack) instead
  of dropping it silently.
- The probe asserts that the password appears in neither the timeline nor the
  recorded scenario.
- The raw Playwright video of the test (3a) is not masked, like the source
  recording in ADR-0003 §5. In 3b it is not needed at all: the engine records
  the replay with its usual masks.

### Private and undocumented APIs

No private Playwright API is used. What the fixture relies on:

1. `test.extend` overriding the built-in `page` fixture, `testInfo.outputPath`,
   `page.video().saveAs` and `Locator.boundingBox`. All are documented.
2. **Undocumented behaviour.** Playwright works through a `Proxy` over `Page`
   and `Locator` whose methods are bound to the real object. `expect` is given
   the real locator, unwrapped, because its matchers check the type.
   `test.step` is reached through a `Proxy` over `test`. This is the stability
   risk. It is a pattern Playwright does not promise to keep working, not a
   format, and it fails loudly (a `TypeError` in the test), never silently.
   The follow-up checks it with a test per supported `@playwright/test` minor.
3. Unlike candidate 1, it does not tie the user's Playwright to DemoFlow's:
   it runs inside the user's own `@playwright/test`. The recorded scenario is
   replayed by DemoFlow's Playwright, so the two can differ.

### Cross-OS

- It runs inside the user's test runner, so DemoFlow spawns nothing.
- Output paths come from `testInfo.outputPath`, and the video from `saveAs`,
  with no hand-built paths.
- The CRLF note from candidate 2 applies to anything that reads test files
  line by line.
- The counts, the masking, the sync mark and the engine replay are the same
  on all three OSes.

## Against Decision 1

| Criterion | 1. Trace import | 2. Source conversion | 3a. Fixture, own video | 3b. Fixture records a scenario |
|---|---|---|---|---|
| Coverage ≥ 90% | **fails**: 80.0% | **fails**: 80.0% | passes: 93.3% | passes: 93.3% |
| Secrets | passes. The trace file itself is a secret. Label heuristic only. | passes, label heuristic only | passes: masked by field type | passes: masked by field type and mapped to the env name |
| Stability | passes as specified: undocumented format, pinned to 1.64.1 with a clear refusal. It couples the user's Playwright to DemoFlow's. | passes: public API only | passes: public API. Proxy behaviour is undocumented and fails loudly. | as 3a |
| Platforms | green on all three ([runs](#method)) | green | green | green, the engine replay included |
| Boundaries | fits ADR-0001/0003 | fits ADR-0003. ADR-0001: adds `typescript` at runtime. | **moves ADR-0003**, because the timeline has no scenario. It duplicates the engine. | fits ADR-0003. **Moves ADR-0001's module table**: a new entry and a peer dependency. Draft ADR below. |
| Follow-up size | 2 issues, but the format must be re-verified on every Playwright bump | 2 issues, then unbounded helper inlining | 4+ issues, including a second driver | 4 issues (below) |
| Demo quality (not in Decision 1, found here) | engine replay | engine replay | **test speed: not a demo** | engine replay |

**Recommendation: 3b.** It is the only candidate that passes coverage without
moving the scenario contract. It uses no private Playwright API, and its
output runs through the engine the project already has.

## Follow-up issues

Drafts for the orchestrator to file. Each is one slice.

### 1. ADR: Playwright Test fixture records scenarios (`demoflow/playwright`)

- **Scope:** file the draft ADR below as `docs/adr/00NN-…`, take the next
  free number, and add it to the ADR index. Update roadmap Phase 7 item 4 to
  point to it.
- **Touches:** `docs/adr/**`, `docs/product/roadmap.md`.
- **Depends on:** nothing.

### 2. `demoflow/playwright`: a fixture that records a scenario

- **Scope:**
  - A new module `packages/playwright` (`@demoflow/playwright`, imports
    `@demoflow/core` only), published as the `demoflow/playwright` subpath of
    the one `demoflow` package, with `@playwright/test` as an optional peer
    dependency.
  - It exports `test` and `expect`.
  - It records only when `DEMOFLOW_RECORD=1`, and is a pass-through otherwise,
    so the suite stays fast.
  - It writes `demoflow/<file>/<test title>.demo.json` (slugged) and validates
    it with `parseScenario`.
  - The mapping and masking measured here. A masked fill with no env variable
    behind it fails the test with its line.
  - Tests: the three probe tests against `apps/fixture`, run under Vitest on
    Node, on Linux, macOS and Windows.
- **Touches:** `packages/playwright/**` (new), `apps/cli/package.json`
  (`exports`, `peerDependencies`), `.github/workflows/execution-plane.yml`
  (paths).
- **Depends on:** 1.

### 3. Fixture: container scrolls and captions

- **Scope:**
  - Record a `mouse.wheel` over a scrollable element as
    `scroll {to, within}`. Find the scroll container under the pointer and
    compare its `scrollTop` before and after.
  - Export `demoflow.caption(text)` and `demoflow.scene(title)` helpers for
    tests, mapped to `marker` with the right `kind`. These are the two steps
    no candidate reached.
- **Touches:** `packages/playwright/**`.
- **Depends on:** 2.

### 4. Docs: reuse Playwright tests

- **Scope:** the website's docs page for `demoflow/playwright`:
  - the one-line import change and `DEMOFLOW_RECORD=1`;
  - what is recorded and what is not (control flow is recorded as it ran,
    once);
  - how secrets are handled;
  - that a `trace.zip` holds fill values in clear.
- **Touches:** the web app's docs pages (the same place as #203).
- **Depends on:** 2. Follow-up 3, once it ships, adds two more rows to the
  same page.

Not recommended: a `demoflow import playwright-trace` command (candidate 1)
and a source converter (candidate 2). The probe code for both stays on the
probe commit for reference.

## Draft ADR

> # ADR-00NN: Playwright tests become scenarios through a recording fixture
>
> Status: proposed · Extends: ADR-0001 §3 · Keeps: ADR-0003 ·
> Spike: [#202](../research/202-playwright-reuse-spike.md)
>
> ## Context
>
> Roadmap Phase 7, item 4: reuse existing Playwright tests as demo scenarios.
> Spike #202 measured three ways on three probe tests:
> - trace import: 80% of steps;
> - source conversion: 80%;
> - a Playwright Test fixture: 93%.
>
> A fixture that writes the timeline and video itself records at test speed:
> 0.3 s for a login flow the engine replays in 2.6–3.3 s. To be a demo, it would
> need a second copy of the engine's pacing, pointer, masks and sync.
>
> ## Decision
>
> 1. **The fixture records a scenario. The engine still records the demo.**
>    `demoflow/playwright` exports `test` and `expect`. When `DEMOFLOW_RECORD=1`
>    is set, the fixture writes each test's actions as a `.demo.json` scenario
>    under `demoflow/`. That scenario is then run by `demoflow run` like any
>    other. The scenario stays the contract the engine executes (ADR-0003).
>    The fixture never writes a timeline or a video.
> 2. **One package, a new entry.** The fixture lives in `packages/playwright`
>    (`@demoflow/playwright`, may import `@demoflow/core` only). It is
>    published as the `demoflow/playwright` subpath of the one `demoflow`
>    package. `@playwright/test` is an optional peer dependency. The fixture
>    runs inside the user's test runner, on the user's Playwright version.
>    The replay uses DemoFlow's pinned Playwright.
> 3. **Public Playwright API only.** No trace format, no internal selector
>    syntax. The fixture wraps `Page`, `Locator`, `expect` and `test.step`.
>    Its tests run against every supported `@playwright/test` minor.
> 4. **Secrets.**
>    - A fill into `input[type=password]`, or of a value equal to an
>      environment variable's, is never written in clear.
>    - It becomes `valueFrom: { env }` when the variable is known.
>    - Otherwise the test fails with its line. ADR-0003 §5 is unchanged.
> 5. **What a test cannot express is not guessed.** A scroll is recorded from
>    its effect. A caption or a scene beyond `test.step` comes from explicit
>    helpers the fixture exports. Control flow is recorded as it ran, once.
>
> ## Consequences
>
> - Teams get a demo from an existing test by changing one import and setting
>   one variable. The recorded scenario is committed and reviewed like a
>   hand-written one, and can be edited to add captions and zoom.
> - `demoflow` gains a peer dependency and a module that runs inside third-party
>   test runners. A Playwright change in how `Page`/`Locator` tolerate a
>   `Proxy` breaks recording loudly, and the per-minor test catches it.
> - Trace import and source conversion are not pursued (spike #202).

## Findings worth keeping

- A Playwright `trace.zip` from a test that fills a password holds it in
  clear, in two places. Worth a line in DemoFlow's docs wherever traces come
  up.
- The engine's `runScenario` launches its own browser. It cannot attach to a
  page someone else owns. 3b does not need it to, and that is part of why 3b
  is small.
- A Windows checkout gives CRLF files. Anything that reads a test or scenario
  file line by line must split on `\r?\n`.
- Playwright's `page.video().path()` is deleted after the test. A fixture
  must `saveAs` while it still runs.

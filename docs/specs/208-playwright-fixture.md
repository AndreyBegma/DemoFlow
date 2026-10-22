# `demoflow/playwright`: a Playwright Test fixture that records a scenario

Issue: [#208](https://github.com/AndreyBegma/DemoFlow/issues/208)
Depends on: nothing. [ADR-0015](../adr/0015-playwright-tests-become-scenarios.md)
is on `develop` with this spec. This issue edits no file under
`packages/core`, `packages/engine`, `packages/renderer` or `apps/fixture`: it
imports `@demoflow/core`, and uses `@demoflow/engine` and `@demoflow/fixture`
in its tests only.

## Summary

Roadmap Phase 7, item 4. Spike #202 ([report](../research/202-playwright-reuse-spike.md))
chose candidate 3b, and ADR-0015 records it. A team changes one import line:

```ts
// before
import { test, expect } from '@playwright/test';
// after
import { test, expect } from 'demoflow/playwright';
```

Then it records once and replays:

```sh
DEMOFLOW_RECORD=1 npx playwright test tests/login.spec.ts
npx demoflow run demoflow/playwright/login-spec/signs-in.demo.json
```

The fixture records what the test did as a scenario. The engine records the
demo from that scenario, with its usual pacing, pointer, masks and sync mark.
The spike's probe measured 28 of 30 steps on its three probe tests; the two
missing steps are #209's.

## Scope

### In scope

- `packages/playwright` (new), `@demoflow/playwright`:
  - `src/index.ts` exports `test` and `expect`, and nothing else in this issue;
  - `src/**` imports only `@demoflow/core`, `@playwright/test` and Node
    built-ins (ADR-0015 §2);
  - `@playwright/test` is a `peerDependency` (`>=1.62.0 <2.0.0`) and a
    `devDependency` pinned to `1.64.1`, the engine's `playwright` pin;
  - Vitest tests under `test/` (`*.spec.ts`), and the Playwright test files
    they run under `test/playwright/`, named `*.pw.ts` so Vitest never picks
    them up.
- `apps/cli/package.json`: `@demoflow/playwright` as a `workspace:*`
  dependency (so turbo builds it first), and the peer dependency with
  `peerDependenciesMeta: { "@playwright/test": { "optional": true } }`.
- `apps/cli/scripts/manifest.ts` and `apps/cli/scripts/stage.ts`: the
  published manifest gains `exports`, `peerDependencies` and
  `peerDependenciesMeta`; the stage bundles a second entry. Their tests under
  `apps/cli/test/scripts/**`.
- `apps/cli/scripts/smoke.mjs`: the `demoflow/playwright` checks below.
- `.github/workflows/execution-plane.yml` and
  `.github/workflows/package-smoke.yml`: `packages/playwright/**` in both
  `paths` lists; `--filter=@demoflow/playwright` in the execution-plane test
  step; the older-minor compatibility step (Decision 10).
- `bun.lock`.

### Out of scope

- Container scrolls (`scroll {within}`), `scrollIntoViewIfNeeded`, and the
  `demoflow.caption` / `demoflow.scene` helpers: #209.
- The website's docs page: #210.
- A `demoflow record`-style command for Playwright, trace import, source
  conversion (ADR-0015, Consequences).
- Any change to the scenario format, the engine or the renderer.
- Firefox and WebKit projects: they record the same steps, and the replay is
  Chromium (ADR-0001 §4). Nothing in the fixture checks the browser.

## Decisions

1. **Recording is opt-in, read once.** `process.env.DEMOFLOW_RECORD === '1'`
   is read when `demoflow/playwright` is imported (Playwright workers inherit
   the environment). Any other value, or none, is pass-through:
   - `expect` is `@playwright/test`'s `expect` itself (`===`);
   - `test` is `base.extend({})` with no `page` override, so `page` is the
     built-in `Page`, not a `Proxy`;
   - no file or directory is created.

   *Why:* the suite stays as fast as before, and the `Proxy` risk (ADR-0015 §3)
   only exists while recording.
2. **The `page` fixture is overridden while recording.** It yields a `Proxy`
   over the real `Page`. Its `getBy*` and `locator` methods return a `Proxy`
   over the real `Locator` that carries the locator's scenario form (or the
   reason it has none). Every other property is the real one, bound to the
   real object. `expect` is a `Proxy` that hands matchers the real, unwrapped
   locator, because they check its type. `test` is a `Proxy` whose `step`
   records a scene marker first. Everything that passes through the page
   between the fixture's setup and teardown is recorded, so `beforeEach` and
   `afterEach` actions are part of the scenario, as they are part of the test.
3. **Mapping.** The spike's measured table, with the box measurement dropped
   (3b does not need it):

   | Playwright | Recorded step |
   |---|---|
   | `page.goto(url)` | `navigate {path}` when `url` is under the test's `baseURL`, else `navigate {url}` |
   | `getByRole(r, {name?, exact?})` | `{ role, name?, exact? }` |
   | `getByLabel(t, {exact?})`, `getByText`, `getByPlaceholder` | `{ label \| text \| placeholder, exact? }` |
   | `getByTestId(t)` | `{ testId }` |
   | `locator(css)` | `{ css }` |
   | `.click()`, `.hover()` | `click`, `hover` |
   | `.fill(v)` | `fill {value}` or `fill {valueFrom: {env}}` (Decision 5) |
   | `.selectOption(o)` with one string, or an array of one | `select {option}` |
   | `.press(k)` when `pressKeyProblem(k)` is `undefined` | `press {key, target}` |
   | `.waitFor({state?, timeout?})` | `waitFor {state, timeoutMs?}`; `timeoutMs` only when given and inside the schema's bounds |
   | `expect(l).toBeVisible()` | `assertVisible` |
   | `expect(l).toHaveText(s)` / `toContainText(s)` with a string | `assertText {text, match: "exact" \| "contains"}` |
   | outermost `test.step(title, …)` | `marker {title, kind: "scene"}`, then its body's steps |
   | `page.screenshot({path})` | `screenshot {name}`, the path's base name without extension, slugged to `[a-z0-9-]+` |
   | `page.evaluate(…)` or `page.mouse.wheel(…)` that moves the page | `scroll {to: "top"}` when it ends at 0, `{to: "bottom"}` when it ends at the maximum |

   A step is recorded when the Playwright call resolves. A call that throws
   records nothing (the test fails anyway).
4. **What has no scenario form** (ADR-0015 §5):
   - **Fails the test**, with `demoflow: cannot record <call> at <file>:<line>: <reason>`:
     an action (click, hover, fill, select, press, waitFor) on a locator with
     no scenario form; any other state-changing call (`check`, `uncheck`,
     `setChecked`, `dblclick`, `tap`, `type`, `pressSequentially`, `clear`,
     `setInputFiles`, `dragTo`, `dispatchEvent`, `selectText` on a locator;
     `page.keyboard.*`; `page.mouse.click|dblclick|down|up|move`;
     `page.reload`, `goBack`, `goForward`, `setContent`); `press` of a key
     `pressKeyProblem` refuses; `selectOption` with several options or a
     non-string option.
   - **No scenario form for a locator**: a regex anywhere in it; options
     beyond those in the table; a `locator()` with options, or whose selector
     contains `>>` or starts with an engine prefix (`text=`, `xpath=`,
     `internal:`, `//`); a locator built from another (`first`, `last`, `nth`,
     `filter`, `and`, `or`, `locator`/`getBy*` on a locator, `frameLocator`).
   - **Left out and reported**, as a test annotation
     `{ type: 'demoflow', description: 'not recorded: <call> at <file>:<line>: <reason>' }`:
     any other assertion (negated, a regex, `toHaveURL`, `expect.poll`, …);
     `page.evaluate` that does not move the page; `page.mouse.wheel` that does
     not move the page (a container scroll, #209); a page scroll that ends
     between the top and the bottom; `page.screenshot` without a `path`.
   - Read-only calls (`textContent`, `isVisible`, `count`, `boundingBox`,
     `inputValue`, …) pass through silently.

   `<file>` is the test file's path relative to the Playwright config's
   directory, with `/` separators on every OS. `<line>` is the first stack
   frame in the test file (`testInfo.file`, compared after normalising
   separators and `file://` URLs). Annotations never contain a filled value.

   *Why fail on actions:* a dropped action changes what the application
   does, so the replay would diverge later with a confusing error. A dropped
   assertion or scroll changes nothing the replay depends on.
5. **Secrets.** Before a fill, the fixture asks the element whether it is an
   `HTMLInputElement` with `type === 'password'`. Then:
   - a value of 8 characters or more that equals an environment variable's
     current value becomes `valueFrom: { env: NAME }`. When several match, the
     first name in sorted order wins;
   - otherwise, a password-field value fails the test:
     `demoflow: refusing to record a password at <file>:<line>: fill it from an environment variable`;
   - otherwise, the value is written as `value`.

   The fixture writes no timeline and no video, so the value is in no file it
   writes. The engine masks the replay as usual.
6. **Where the scenario goes.** At teardown, only when `testInfo.status` is
   `'passed'`, the fixture writes
   `<configDir>/demoflow/playwright/[<project>/]<file>/<title>.demo.json`:
   - `<configDir>` is `path.dirname(testInfo.config.configFile)`, or
     `process.cwd()` when there is no config file;
   - `<project>` is the slugged project name, present only when the config
     has more than one project;
   - `<file>` is the test file relative to `testInfo.project.testDir`, each
     segment slugged, the extension folded in (`auth/login.spec.ts` →
     `auth/login-spec`);
   - `<title>` is the slugged `titlePath` after the file (describe blocks and
     the test title), joined with `-`;
   - slugging: lowercase, runs of anything outside `[a-z0-9]` become `-`,
     trimmed of `-`, at most 80 characters, `test` when empty.

   A second test reaching the same path in the same worker fails with
   `demoflow: <path> is already written by "<other title>"`. A failed test
   leaves an existing file untouched.
7. **What the scenario holds.** `schemaVersion: 1`; `name`: the `titlePath`
   after the file, joined with ` › `; `description`:
   `Recorded from <file> by demoflow/playwright.`; `viewport`: the page's
   `viewportSize()` when it is set; `steps`. No `baseUrl`: the project's
   `demoflow.config.json` decides where the replay runs. The file is
   validated with `parseScenario` before writing; an invalid one fails the
   test with the issues. It is written as 2-space JSON with `\n` line endings
   and a final newline, with no timestamps, so recording twice gives the same
   bytes.
8. **The published entry.** `stage.ts` bundles
   `packages/playwright/src/index.ts` with esbuild to
   `dist/playwright/index.js` in `dist/npm/`, with `@playwright/test`, `zod`
   and Node built-ins external, `@demoflow/core` bundled in. The
   `externals` plugin accepts the peer dependencies as external. The
   declaration file `dist/playwright/index.d.ts` comes from `tsc` on
   `packages/playwright`; its public types reference `@playwright/test` only,
   and the stage fails if it imports anything else. The manifest gains:

   ```json
   "exports": {
     "./playwright": {
       "types": "./dist/playwright/index.d.ts",
       "import": "./dist/playwright/index.js"
     },
     "./package.json": "./package.json"
   },
   "peerDependencies": { "@playwright/test": ">=1.62.0 <2.0.0" },
   "peerDependenciesMeta": { "@playwright/test": { "optional": true } }
   ```

   The peer range is a range by nature; every `dependencies` and
   `devDependencies` version stays exact (`bunfig.toml`).
9. **The CLI does not load the fixture.** `src/main.ts` never imports
   `@demoflow/playwright`, and `dist/bin/main.js` does not reference
   `@playwright/test`.
10. **Supported minors: 1.62, 1.63, 1.64.** The full suite runs against
    `@playwright/test` 1.64.1 on Linux, macOS and Windows. A compatibility
    suite runs the three probe tests against 1.62.1 and 1.63.0 on Linux only,
    through exact npm aliases in `packages/playwright`'s `devDependencies`
    (`"playwright-test-1-62": "npm:@playwright/test@1.62.1"`, and 1.63.0
    likewise), each with its own Chromium installed in that step. The probes
    import an internal `createTest(base, baseExpect)` so each alias's `test`
    is wrapped.
    - *Why Linux only for older minors:* what can break across versions is how
      `Page` and `Locator` tolerate a `Proxy`, which does not depend on the
      OS. The fixture's own behaviour is proven on all three OSes with the
      pin.
    - Raising the floor or adding a minor changes the peer range, the aliases
      and this list in one pull request.

## Acceptance criteria

Vitest under Node, in the execution-plane workflow on Linux, macOS and
Windows unless a line says otherwise. The Vitest suite spawns
`node <@playwright/test>/cli.js test` with no shell, against the built
`apps/fixture` served the way `packages/engine/test/execute/fixture-server.ts`
serves it, with `FIXTURE_PASSWORD` set to a random value it generates.

- [ ] **Probes.** `test/playwright/` holds `login`, `customers` and `tour`
      written as a team would, as in the spike's `probe-tests/`: the password
      from `process.env.FIXTURE_PASSWORD`, a `search(page, q)` helper and
      `test.step`s in `customers`, `page.evaluate(() => window.scrollTo(…))`
      and `page.mouse.wheel` in `tour`.
- [ ] **Coverage.** With `DEMOFLOW_RECORD=1`, each recorded scenario
      deep-equals a committed expected file in `test/expected/`. Compared with
      the hand-written `apps/fixture/demoflow/*.demo.json`, ignoring
      `caption`, `zoom`, `timeoutMs` and `match`: `login` 5/5, `customers`
      11/11, `tour` 12/14 (the container scroll and the `Slow report` caption
      are missing; a `Create` scene and a `hover {testId: log-panel}` are
      extra).
- [ ] **Replay.** Each recorded scenario passes `parseScenario`, and
      `runScenario` from `@demoflow/engine` (a devDependency) replays it with
      the execution and recording stages passing. The login replay's span is
      at least 2 s (the test's own run is under 2 s).
- [ ] **Secrets.** `login`'s recorded fill is
      `valueFrom: { env: "FIXTURE_PASSWORD" }`. The password string appears in
      no file under the output directory and in no annotation. A probe that
      fills a literal into the password field fails with
      `refusing to record a password at test/playwright/literal.pw.ts:<line>`
      and writes no scenario.
- [ ] **Loud failures.** A probe that clicks `getByRole('row').first()` fails
      with `cannot record` and its line; one that calls `page.keyboard.type`
      fails likewise.
- [ ] **Reported omissions.** The `tour` run's annotations include
      `not recorded: page.mouse.wheel at test/playwright/tour.pw.ts:<line>`.
- [ ] **Pass-through.** Without `DEMOFLOW_RECORD`, and with
      `DEMOFLOW_RECORD=0`, the three probes pass, no `demoflow/` directory is
      created, `util.types.isProxy(page)` is `false` inside a probe, and the
      exported `expect` is `@playwright/test`'s.
- [ ] **Paths.** Unit tests: `auth/login.spec.ts` + `['Auth', 'signs in']`
      gives `demoflow/playwright/auth/login-spec/auth-signs-in.demo.json`; a
      second project adds its slug; an 81-character title is cut to 80; two
      titles slugging to the same path fail the second test. Recording twice
      gives byte-identical files.
- [ ] **Locators.** Unit tests for every row of Decision 3 and every "no
      scenario form" case of Decision 4.
- [ ] **Package** (`smoke.mjs`, the package-smoke workflow on Linux, macOS
      and Windows):
      - the packed manifest has the `exports`, `peerDependencies` and
        `peerDependenciesMeta` of Decision 8, and `@playwright/test` is not in
        `dependencies`;
      - installed alone, `demoflow --version` works and `npm install` reports
        no missing peer error;
      - installed beside `@playwright/test@1.64.1`,
        `import('demoflow/playwright')` exposes `test` and `expect`;
      - `dist/bin/main.js` does not contain `@playwright/test`, and
        `dist/playwright/index.d.ts` imports only `@playwright/test`.
- [ ] **Minors** (Linux): the three probes record the same files against
      1.62.1 and 1.63.0 as against 1.64.1.
- [ ] `manifest.ts` tests cover the new fields. `bun run check`,
      `bun run build` and the execution-plane and package-smoke matrices are
      green.

## Risks

- **`Proxy` over `Page`/`Locator` on another `@playwright/test` version**
  (medium). Playwright does not promise it. Mitigation: Decision 10's
  per-minor suite, and a failure is a `TypeError` in the test, never a silent
  wrong scenario.
- **`expect` from `@playwright/test` with a recording locator** (medium).
  A file that imports `expect` from `@playwright/test` but `test` from
  `demoflow/playwright` gives its matchers a `Proxy`, and they throw. The
  docs (#210) say to import both from `demoflow/playwright`; the error
  message is Playwright's.
- **Settling after `page.mouse.wheel`** (low). Playwright does not wait for
  the scroll to finish. The fixture polls the scroll position until it is
  unchanged for two animation frames, at most 1,000 ms, before comparing.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i208 | the fixture, its package entry and its CI | packages/playwright/**, apps/cli/package.json, apps/cli/scripts/manifest.ts, apps/cli/scripts/stage.ts, apps/cli/scripts/smoke.mjs, apps/cli/test/scripts/**, .github/workflows/execution-plane.yml, .github/workflows/package-smoke.yml, bun.lock | — | yes | opus |

One slot. `opus`: three hard parts in one slice — `Proxy` wrapping of
Playwright's objects with loud failures, a second published entry with an
optional peer dependency, and a cross-OS, per-minor test harness that spawns
Playwright Test. It may run beside i197: it edits nothing i197 owns. Its
`bun.lock` change conflicts only with another lockfile change.

## Open questions

None. The peer range and the supported minors (Decision 10) are the
orchestrator's choice under its standing autonomy.

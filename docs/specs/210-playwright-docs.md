# Docs: reuse Playwright tests

Issue: [#210](https://github.com/AndreyBegma/DemoFlow/issues/210)
Depends on: #208 (the fixture), and after #209 (merge order), so the page
documents container scrolls and the `demoflow.caption`/`scene` helpers in
one pass (Decision 4). Shares two files with #203 (Decision 5).

## Summary

The website documents `demoflow/playwright`
([ADR-0015](../adr/0015-playwright-tests-become-scenarios.md)) on a new docs
page, `/docs/playwright` ("Reuse Playwright tests"). The text is checked
against the merged code of #208 (and #209), which wins where it differs
from the specs.

## Scope

### In scope

- `apps/web/src/app/docs/playwright/page.mdx` (new), with
  `metadata = { title: 'Reuse Playwright tests' }`, as the other docs pages
  set theirs.
- `apps/web/src/lib/docs-nav.ts`: an entry `/docs/playwright` with the label
  `docs.nav.playwright` (Decision 5 says where).
- `apps/web/src/i18n/en.ts`: `docs.nav.playwright: 'Reuse Playwright tests'`.
- `apps/web/src/app/docs/record/page.mdx`: one sentence linking to
  `/docs/playwright` for teams that already have Playwright tests.

### Out of scope

- Any change to behaviour, or to `packages/**` and `apps/cli/**`.
- The Application SDK page (#203).
- Search, docs versioning and translations (spec 179).

## Decisions

1. **The page structure:**
   1. **Intro.** If you already have Playwright tests, change one import and
      record each test as a scenario; DemoFlow then records the demo from the
      scenario, at demo pace, with its masks. The test itself is not the
      video.
   2. **`## Set up`.** `npm i -D demoflow` beside `@playwright/test` (the
      supported range from #208's merged peer dependency); the import
      change, for `test` **and** `expect`; why both must come from
      `demoflow/playwright` (a matcher given a recording locator from the
      other `expect` throws).
   3. **`## Record and replay`.** `DEMOFLOW_RECORD=1 npx playwright test …`;
      where files land (`demoflow/playwright/…`, with the project segment
      when there are several projects, and the slug rules in one sentence);
      only passing tests are written; `npx demoflow run <file>`; commit and
      review the scenario, and edit it to add captions or zoom. Without the
      variable, nothing is wrapped or written.
   4. **`## What is recorded`.** A table of what becomes which step, from the
      merged mapping, and the rule for the rest: an action DemoFlow cannot
      express fails the test with its line; an assertion or scroll it cannot
      express is left out and listed in the test's annotations (with an
      example message). Control flow (helpers, loops, `if`) is recorded as it
      ran, once. `beforeEach`/`afterEach` actions are part of the scenario.
   5. **`## Scenes and captions`.** `test.step` becomes a scene; the
      `demoflow` fixture's `scene()` and `caption()` (with a code example);
      the 120-character caption limit (Decision 4).
   6. **`## Secrets`.** A fill into a password field, or of a value equal to
      an environment variable's (8 characters or more), is written as
      `valueFrom: { env }`; a password with no variable fails the test, and
      the message says to read it from the environment. A link to
      `/docs/scenarios` for `valueFrom`.
   7. **A warning callout: `trace.zip` holds filled values in clear.**
      Playwright's own traces (`trace: 'on'`) record every `fill` value,
      passwords included, in the action's title and parameters. DemoFlow does
      not read traces, but a trace from a login test is a secret: do not
      attach it to a public CI run or an issue. This stands whatever DemoFlow
      does, so it goes on the page as a callout, not a footnote.
2. **Examples are TypeScript Playwright tests and JSON scenarios.** Each JSON
   example parses with `ScenarioSchema`, and each recorded example is what
   the merged fixture writes for the test shown beside it.
3. **Links.** From `/docs/record` (one sentence). Not from the landing page.
4. **#209 before this page.** The orchestrator holds this issue until #209
   has merged, and the page then documents §5 and the container-scroll row
   of §4. The page must not call container scrolls or captions unsupported
   only for #209 to make it wrong a week later.
5. **#203 edits the same two files.** Both this issue and #203 add one entry
   to `DOCS_NAV` in `docs-nav.ts` and one label to `en.ts`'s `docs.nav`.
   - The orchestrator does not run the two at the same time.
   - The entry goes right after `/docs/sdk` when #203 has merged, otherwise
     right after `/docs/record`. Whichever merges second rebases; the
     conflict is two adjacent lines in each file.
   - #203 depends on #197, #198 and #201, and this issue on #208; either may
     land first.

## Acceptance criteria

- [ ] `/docs/playwright` renders with the parts of Decision 1. It is in `DOCS_NAV` where Decision 5 says, labelled
      "Reuse Playwright tests".
- [ ] `node --test src/lib/docs-nav.test.mjs` (the web app's `test` script)
      passes with the new entry.
- [ ] Every code example matches the merged contract: the import path
      `demoflow/playwright`, `DEMOFLOW_RECORD=1`, the output path layout,
      the peer range, the `demoflow` fixture's method names, and the error
      and annotation messages quoted on the page equal the strings in
      `packages/playwright/src`.
- [ ] Every JSON example parses with `ScenarioSchema`.
- [ ] The page contains the `trace.zip` warning of Decision 1 §7.
- [ ] `/docs/record` links to `/docs/playwright`.
- [ ] `bun run check` and `bun run build` are green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i210 | the docs page and its links | apps/web/src/app/docs/**, apps/web/src/lib/docs-nav.ts, apps/web/src/i18n/en.ts | #208; after #209; not beside #203 | yes | sonnet |

One slot. `sonnet`: prose from two specs, but every path, range and message
must be checked against merged code, which is too easy to get subtly wrong
for haiku.

## Open questions

None.

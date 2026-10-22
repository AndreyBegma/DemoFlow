# Docs: the Application SDK page

Issue: [#203](https://github.com/AndreyBegma/DemoFlow/issues/203)
Depends on: #197, #198, #201. Docs land after the features. Start from
`develop` after all three have merged.

## Summary

Phase 7 gives the application under demonstration three ways to take part in
a run, with no package to install. The website documents them on one new docs
page, `/docs/sdk` ("Application SDK"), and links to it from the scenario
docs:

- `data-demoflow-mask`, in #197 and spec 197;
- `window.demoflow.ready()` and the `waitForReady` step, in #198 and spec 198;
- `window.demoflow.scene()` and `caption()`, in #201 and spec 201.

The text comes from each spec's "User-facing text" section. It is checked
against the merged code, which wins where they differ. The contracts are
[ADR-0013](../adr/0013-page-side-contract.md) and
[ADR-0014](../adr/0014-page-annotations.md).

## Scope

### In scope

- `apps/web/src/app/docs/sdk/page.mdx` (new), with `metadata.title`
  `'Application SDK'`, as the other docs pages set theirs.
- `apps/web/src/lib/docs-nav.ts`: an entry `/docs/sdk` with the label
  `docs.nav.sdk`, after `/docs/record`.
- `apps/web/src/i18n/en.ts`: `docs.nav.sdk: 'Application SDK'`.
- `apps/web/src/app/docs/scenarios/page.mdx`:
  - a `waitForReady` row in the steps table;
  - a link to `/docs/sdk` from the "Scene markers" and "Secrets and masking"
    sections.

### Out of scope

- Any change to behaviour, or to `packages/**`.
- Docs for the Playwright reuse (#202). Its follow-ups, if any, bring their
  own.
- Search, versioning of the docs, and translations (spec 179).

## Decisions

1. **One page for the page side.** All three features are things the
   application does in its own code, not things a scenario does, so they go
   on their own page, not the scenarios page. The scenarios page keeps one
   row for `waitForReady`, which is a step, and links across.
2. **The page structure:**
   1. A short intro: everything here is optional; `window.demoflow` exists
      only while DemoFlow runs the app, so call it as `window.demoflow?.…`
      and it does nothing in production; nothing is sent anywhere; the main
      frame only (no iframes, no shadow DOM).
   2. `## Mask an element`: the attribute, an HTML example, and the limits
      from spec 197's text (the rendered video only, not the raw recording
      or `screenshot` images; no iframes, shadow DOM or overflowing content).
      Also that any value masks, and removing the attribute unmasks.
   3. `## Tell a scenario you are ready`: the JS call and the
      `waitForReady` step side by side, the name format (letters, digits and
      `. _ : -`, starting with a letter or a digit, up to 64 characters), and
      the signal lasting until the page is reloaded or another page is
      opened. A missing signal fails the step with `ready-timeout <name>`.
   4. `## Scenes and captions from your app`: the two calls, the 120-character
      limit, at most 100 per run, the 3 s caption, that annotations are not
      masked, and that `cards.scenes.enabled: false` turns off scene cards
      from both sources (link to `/docs/config#cards`).
3. **Examples are plain JS and JSON.** No framework-specific snippet, and no
   TypeScript declaration for `window.demoflow`. A typed wrapper is a later
   npm package (ADR-0013 §1).

## Acceptance criteria

- [ ] `/docs/sdk` renders with the four parts of Decision 2. It is in
      `DOCS_NAV` after "Recording", labelled "Application SDK".
- [ ] `node --test src/lib/docs-nav.test.mjs` (the web app's `test` script)
      passes with the new entry.
- [ ] Every code example matches the merged contract: the attribute name,
      `window.demoflow?.ready/scene/caption`, and the step
      `{ "action": "waitForReady", "name": "…" }`, which parses with
      `ScenarioSchema`.
- [ ] The limits stated on the page (64-character names, 120-character
      annotations, 100 per run, 3 s captions) equal the merged code's
      constants.
- [ ] `/docs/scenarios` has a `waitForReady` row and links to `/docs/sdk`
      from "Scene markers" and "Secrets and masking".
- [ ] `bun run check` and `bun run build` are green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i203 | the docs page and its links | apps/web/src/app/docs/**, apps/web/src/lib/docs-nav.ts, apps/web/src/i18n/en.ts | #197, #198, #201 | yes | sonnet |

One slot. `sonnet`: prose transcribed from three specs, but each limit and
example must be checked against merged code. That is too easy to get subtly
wrong for haiku.

## Open questions

None.

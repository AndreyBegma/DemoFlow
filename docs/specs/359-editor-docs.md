# Docs: editing a video on the website

Issue: [#359](https://github.com/AndreyBegma/DemoFlow/issues/359)
Depends on #358 (the last editor slice); describes #353–#358 as they landed.

## Summary

The editor (#357, #358) changes how a person fixes a video: edit, render,
export into the repository. The website's docs (`/docs`, spec 179) need one
page for it and two corrections: what crosses to the server while the editor
is open (ADR-0020 §4), and `edits.json` in a run directory.

## Scope

### In scope

- `apps/web/src/app/docs/editor/page.mdx` (new): the page.
- `apps/web/src/lib/docs-nav.ts`: an entry `{ href: '/docs/editor', label:
  'docs.nav.editor' }` after `/docs/runner` [Confirmed: `DOCS_NAV` and its
  label union].
- `apps/web/src/lib/docs-nav.test.mjs`: the new entry [Confirmed: the test
  checks every entry has a page file].
- `apps/web/src/i18n/en.ts`: `docs.nav.editor`.
- `apps/web/src/app/docs/runner/page.mdx`: a short section "Editing from the
  website" (what the website may ask the machine, what crosses, that nothing
  is stored), linking to the new page.
- `apps/web/src/app/docs/config/page.mdx`: one paragraph on `edits.json`
  overriding `render.*` for one run, and that it is never read from the
  config.

### Out of scope

- The CLI page: `demoflow render --progress` and `demoflow edits apply` are
  documented by #355.
- The sharing page (#352).

## The page

Sections, in this order, with screenshots of the editor on the fixture
project (`apps/fixture`):

1. **What you can change** — captions (text and timing), zoom per step,
   intro and outro text, scene cards on or off, background and window, trim
   and cuts. What you cannot: zoom at a free time (ADR-0012), steps, URLs,
   anything the scenario runs.
2. **Preview and Render** — the preview is approximate; Render runs on your
   machine with the project's current config plus the edits, and replaces the
   run's files.
3. **Where edits live** — `runs/<runId>/edits.json` on the machine; the
   server keeps nothing; the next run of the scenario does not know them.
4. **Export to the repository** — the patch, the config fragment,
   `npx demoflow edits apply <runId>` (`--dry-run`, `--config`), and what is
   never exported (trims, cuts, free-timed captions, steps from a `repeat`
   or an `include`).
5. **Reset** — and that Reset does not change a shared copy.
6. **Shared links** — Update share link keeps the URL, expiry and views.
7. **When the editor is unavailable** — machine offline, CLI too old,
   files deleted, run not renderable; what to do for each.
8. **Privacy** — while the editor is open, step times and target positions
   cross to your browser through the server and are not stored
   (ADR-0020 §4).

## Decisions

1. **One page, not a section of the runner page.** The editor is a task of
   its own ("fix my video"), and the runner page is about pairing and the
   daemon.
2. **Screenshots are from the fixture app**, never from a real application,
   like the other docs pages [Unknown: whether the docs keep screenshots in
   `apps/web/public/docs/`; follow what existing pages do].

## Acceptance criteria

- [ ] `/docs/editor` renders, is in the side navigation after Runner, and
      `docs-nav.test.mjs` passes.
- [ ] Every command and flag on the page exists in `apps/cli/src/main.ts`
      (`edits apply`, `--dry-run`, `--config`, `render --progress`).
- [ ] The runner page's new section and the config page's paragraph link to
      `/docs/editor`.
- [ ] `bun run check` and `bun run build` are green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i359-docs | the docs | apps/web/src/app/docs/editor/**, apps/web/src/lib/docs-nav.ts, apps/web/src/lib/docs-nav.test.mjs, apps/web/src/i18n/en.ts, apps/web/src/app/docs/runner/page.mdx, apps/web/src/app/docs/config/page.mdx | #358 merged | yes | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| `apps/web/src/lib/docs-nav.ts`, `docs-nav.test.mjs`, the `docs.nav.*` keys | this issue | #352 (sharing docs) and #364 (schedule docs) add entries: one line each, rebase. |
| `apps/web/src/app/docs/runner/page.mdx`, `config/page.mdx` | this issue | #352, #364 and #365's docs may add sections: rebase. |

## Risks

- **Low — the docs describe a behaviour that changed during review.**
  Mitigation: the page is written last, against merged code.

## Open questions

None.

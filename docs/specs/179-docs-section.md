# Documentation section on the site

Issue: [#179](https://github.com/AndreyBegma/DemoFlow/issues/179)
Depends on: nothing

## Summary

Roadmap, Phase 5: the landing page has "documentation as its own section".
Today its Docs link points at the GitHub README (`apps/web/src/app/page.tsx`,
`DOCS_URL`).

The owner decided on 2026-10-22:

- **MDX pages on the site are the primary documentation.**
- **The repository wiki stays as a supplement** for long guides and FAQ. The
  site links to it.

## Scope

### In scope

- `apps/web`: MDX support (`@next/mdx`, pinned exactly), a `/docs` layout with
  a side navigation, and the pages below.
- The landing page and the header link to `/docs` instead of the README.
- A short "More guides" page that links to the wiki's pages.

### Out of scope

- Search.
- Versioned docs.
- Moving the wiki's content into MDX beyond what the pages below need.
- Translations: English only, like the UI.

## Decisions

1. **Pages** live in `apps/web/src/app/docs/`, one folder per page with
   `page.mdx`:
   - `/docs`: Getting started (`npx demoflow`, the first scenario, the first
     run).
   - `/docs/scenarios`: the scenario format, steps, `caption`, `timeoutMs`,
     `zoom` (#163), `data` and `repeat` (#165), and masking.
   - `/docs/config`: the project config, `render.*` (frame, background, cards,
     transitions, formats).
   - `/docs/cli`: commands and flags, the update prompt (#166) and its opt-out.
   - `/docs/record`: `demoflow record`, including "Repeat over data".
   - `/docs/runner`: pairing, `runner install`, and status on the site.
   - `/docs/mcp`: the MCP tools.
   - `/docs/more`: links to the wiki.
2. **Truth.** Write each page from the code and the specs, not from the
   README. Where the README and the code disagree, the code wins. Note the
   README's drift in the PR body; do not edit the README.
3. **Look.** Content surfaces are plain and readable (vision §9). Use Glass UI
   only for the docs chrome: side nav and header. Code blocks are
   monospace and readable in light and dark.
4. **i18n.** UI chrome strings (nav labels, "On this page", "More guides") go
   in `en.ts`, in their own block. The page bodies are the MDX content.
5. **Static.** Every docs page is statically rendered (no session needed) and
   linked from the public header.

## Acceptance criteria

- `/docs` and every page in Decision 1 render statically, with the side
  navigation, in light and dark.
- The landing page and the header link to `/docs`. No link points at the
  README for docs any more.
- `bun run build` produces the pages. `bun run check` and `bun run test` are
  green.
- One test, in the web app's existing style, checks that every nav entry
  resolves to a page.

## Contention

| Resource | Owner | Others |
|---|---|---|
| apps/web/src/i18n/en.ts | #177, #178, #179 | own block each; merge the base before the PR |
| bun.lock, apps/web/package.json | #179 (MDX deps) | do not open |

## Open questions

None.

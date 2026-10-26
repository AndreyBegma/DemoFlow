# Docs: sharing a video

Issue: [#352](https://github.com/AndreyBegma/DemoFlow/issues/352)
Depends on: #349, #350, #351.

## Summary

Sharing (ADR-0019) reaches users through three doors — the run page, `demoflow
share` and the MCP tool `share_demo` — and changes what leaves the machine.
This slice adds a **Sharing** page to the website's docs and brings the CLI,
MCP, config and runner pages up to date, so a user learns what a share
uploads, who can open it, how long it lives and how to revoke it before they
press the button.

## Scope

### In scope

- `apps/web/src/app/docs/share/page.mdx` (new).
- `apps/web/src/lib/docs-nav.ts`: `{ href: '/docs/share', label:
  'docs.nav.share' }` after `/docs/runner` [Confirmed: `DOCS_NAV`]; the nav
  test keeps passing (`docs-nav.test.mjs` checks every entry has a page
  [Confirmed: `docsPageFile`]).
- `apps/web/src/i18n/en.ts`: `docs.nav.share`.
- `apps/web/src/app/docs/cli/page.mdx`: `demoflow share`.
- `apps/web/src/app/docs/mcp/page.mdx`: `share_demo` and its refusal.
- `apps/web/src/app/docs/config/page.mdx`: `share.allowMcp`.
- `apps/web/src/app/docs/runner/page.mdx`: one paragraph — the runner
  uploads a render only for a share you created, and an older CLI cannot
  share.

### Out of scope

- `apps/cli/README.md` (#349 documents the command there).
- `deploy/README.md` (#347, #348).

## Decisions

1. **The Sharing page**, in this order:
   1. *What a share is:* a copy of one rendered file on DemoFlow's server,
      opened by anyone with the link, until it expires or you revoke it.
   2. *What is uploaded:* exactly ADR-0019 §2's list, and what never is.
   3. *Creating one:* from the run page (with a screenshot-free description
      of the dialog), `demoflow share <runId>` with its flags, and
      `share_demo` with `share.allowMcp`.
   4. *Password, expiry, extend, revoke, views.* That the file link is off
      while a password is set; 7/30/90 days; Extend adds 30 up to 90 days
      from now; what deletes a share and what does not (deleting local files
      does not).
   5. *Limits:* 200 MB per file and 2 GB per account on demoflow's hosted
      service; self-hosters set `SHARE_MAX_FILE_BYTES`,
      `SHARE_USER_QUOTA_BYTES`.
   6. *Embedding:* the file link in a README (`![…](…/file)` for a GIF) and
      as a `<video src>`.
   7. *Errors:* `runner-offline`, `runner-outdated`, `quota-exceeded`,
      `file-too-large`, `share-not-allowed`, and what to do about each.
2. **Wording follows the code**, not this spec: the writer reads the merged
   #347–#351 and quotes their real flags, codes and limits. Where they
   differ from this spec, the code wins and the page says what the code does.
3. Every page stays English, MDX, in the style of the existing docs pages.

## Acceptance criteria

- [ ] `/docs/share` renders and appears in the side navigation after Runner.
- [ ] The page lists what is uploaded and what never is, matching ADR-0019 §2.
- [ ] Every flag of `demoflow share` and every error code above appear with
      the exact spelling the merged code uses.
- [ ] The CLI, MCP, config and runner pages link to `/docs/share`.
- [ ] `bun run check`, `bun run build` pass; `docs-nav.test.mjs` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i352-docs | the docs | apps/web/src/app/docs/share/**, apps/web/src/app/docs/cli/page.mdx, apps/web/src/app/docs/mcp/page.mdx, apps/web/src/app/docs/config/page.mdx, apps/web/src/app/docs/runner/page.mdx, apps/web/src/lib/docs-nav.ts, apps/web/src/i18n/en.ts | #349, #350, #351 | yes | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/src/lib/docs-nav.ts | i352-docs | #359 and #364 add entries; one at a time |
| apps/web/src/app/docs/cli/page.mdx, mcp/page.mdx, config/page.mdx | i352-docs | #359, #364, #365 may add sections; rebase |

## Open questions

- A screenshot of the dialog — default: none until the UI settles.

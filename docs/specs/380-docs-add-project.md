# Docs: adding a project from the website, and allowed roots

Issue: [#380](https://github.com/AndreyBegma/DemoFlow/issues/380)
Depends on: #379 (the dialog this page describes; #377 and #378 come before
it). Decided by [ADR-0022](../adr/0022-projects-added-from-the-website.md).

## Summary

The website's Runner page (`apps/web/src/app/docs/runner/page.mdx`) explains
pairing, autostart and website-started runs, and says a project appears after
the machine reported a run [Confirmed: sections "Pair a machine" … "Status on
the site"]. With #377–#379 a project can be added from the website. This
slice documents the flow, the allowed roots and their commands, and corrects
the sentences that ADR-0022 made untrue.

## Scope

### In scope

- `apps/web/src/app/docs/runner/page.mdx`: a new section **Add a project from
  the website** after "Runs started from the website", and a section
  **Allowed folders** (`demoflow runner allow | disallow | roots`, the default
  home-without-hidden-folders rule, what the website can and cannot see,
  what "Create config" writes).
- `apps/web/src/app/docs/cli/page.mdx`: the three `runner` subcommands in the
  command reference [Confirmed: the page exists].
- Every sentence on the docs pages that says a project only appears after a
  local run: rewritten to "after a local run, or when added from the
  website".
- `apps/web/src/lib/docs-nav.test.mjs` only if a new page is added (it is not
  by default: both sections live on the Runner page).

### Out of scope

- Product code. Screenshots are optional; a short Glass UI–styled diagram of
  the flow is enough.

## Decisions

1. **One page, two sections**, no new nav entry. *Why:* adding a project is a
   Runner capability; the nav (`apps/web/src/lib/docs-nav.ts`) stays at ten
   entries.
2. **Security note in plain words:** the machine decides which folders the
   website may name; nothing is cloned or downloaded; "Create config" writes
   two files and never overwrites; `devCommand` is set by the person in the
   repository. *Source:* ADR-0022 §1–§3.
3. **Troubleshooting table:** `Offline`, `Update the CLI`,
   `outside the allowed folders`, `config invalid`, `already a project`,
   each with the fix.

## Acceptance criteria

- [ ] The Runner page documents the dialog's steps and every refusal shown by
      #379, with the fix for each.
- [ ] `demoflow runner allow`, `disallow` and `roots` are documented with an
      example on Linux/macOS and on Windows paths.
- [ ] No docs page still says a project can only be registered by a local run.
- [ ] `bun run check` and the docs nav test pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i380-docs | the two sections and the CLI reference | apps/web/src/app/docs/runner/page.mdx, apps/web/src/app/docs/cli/page.mdx | #379 merged | yes | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/src/app/docs/runner/page.mdx | i380-docs | #352, #359, #364 add sections; keep all |
| apps/web/src/app/docs/cli/page.mdx | i380-docs | #349, #355, #360, #361 add commands |

## Risks

- **Docs drift from #377's final command names** (low): written after #379
  merges, from the merged code.

## Open questions

- A dedicated "Projects" docs page? Default: no, until projects gain more
  than one way in.

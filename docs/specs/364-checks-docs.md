# Website docs: scheduled checks and stale demos

Issue: [#364](https://github.com/AndreyBegma/DemoFlow/issues/364)
Depends on: #361 (the config schedule and the daemon), #363 (the website UI). Decision record: [ADR-0021](../adr/0021-scheduled-checks.md).

## Summary

Document scheduled checks on the website's docs: what a check run is, the
two places a schedule can live and which wins, how a scenario becomes stale
and how it clears, and what the daemon must be doing for any of it to
happen. Written once specs 360–363 have merged, from the code as merged.

## Scope

### In scope

- `apps/web/src/app/docs/checks/page.mdx` (new): the page "Scheduled checks".
- `apps/web/src/lib/docs-nav.ts`: the entry `{ href: '/docs/checks', label: 'docs.nav.checks' }`
  after `/docs/runner`; `apps/web/src/lib/docs-nav.test.mjs` if it lists the
  pages.
- `apps/web/src/i18n/en.ts`: `docs.nav.checks`.
- `apps/web/src/app/docs/config/page.mdx`: the `schedule` block in the config
  reference, linking to the new page.
- `apps/web/src/app/docs/cli/page.mdx`: `demoflow run --check` and
  `--exclude`; `demoflow runner status`'s schedule lines.
- `apps/web/src/app/docs/runner/page.mdx`: local mode (scheduled checks
  without an account) and "a check pass counts as the machine's one launch".

### Out of scope

- `apps/cli/README.md` (updated by specs 360 and 361).
- Any product code.

## Decisions

1. **One new page, three short additions.** The concept lives on
   `/docs/checks`; the reference pages say only what their reader needs and
   link to it.
2. **The page's sections**, in order:
   1. *What a check is* — `demoflow run --check`: the steps and the
      verifications, no video, no render; a check pass is every scenario of
      the project minus exclusions, one application start.
   2. *Schedule in the config* — the `schedule` block (cadence, weekday, at,
      exclude), machine-local time, the daemon runs it, works without an
      account; results in `demoflow runs`; shown read-only on the website
      when paired.
   3. *Schedule on the website* — the project page card; the project's machine
      runs it; time zone; what "paused" means for each reason.
   4. *Which wins* — the config; the website schedule is paused while a
      config schedule exists.
   5. *Missed checks* — one catch-up pass after the machine was off, asleep or
      offline.
   6. *Stale demos* — a scenario is stale when its last run failed, a check or
      not; the badge, the project list count and the `/app` block; it clears
      on the next passing run. No email.
   7. *What reaches the server* — the ADR-0021 §7 list in plain words.
3. **Examples are real.** Every command and JSON block on the page is run
   against the fixture app before merge, and its output pasted from that run.

## Acceptance criteria

- [ ] `/docs/checks` renders, is in the docs navigation after Runner, and
      every link on it resolves (the docs-nav test passes).
- [ ] The config reference documents `schedule` with each field, its values
      and a full example that `demoflow validate` accepts.
- [ ] The CLI page documents `--check` and `--exclude`, and says `--format`
      and `--headed` are refused with `--check`.
- [ ] The Runner page documents local mode.
- [ ] Nothing on the pages contradicts ADR-0021 or the merged specs 360–363
      (reviewer checks section by section).
- [ ] `bun run build` and `bun run check` pass for `apps/web`.

## Parallel plan

One slot: the pages are short and share the nav and i18n files.

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i364-docs | the checks docs | apps/web/src/app/docs/checks/**, apps/web/src/app/docs/config/page.mdx, apps/web/src/app/docs/cli/page.mdx, apps/web/src/app/docs/runner/page.mdx, apps/web/src/lib/docs-nav.ts, apps/web/src/lib/docs-nav.test.mjs, apps/web/src/i18n/en.ts | — | yes | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/src/lib/docs-nav.ts, apps/web/src/i18n/en.ts | i364-docs | the sharing (#352), editor (#359) and hold (#365) docs also add entries; keep every entry, in the order of the nav |
| apps/web/src/app/docs/config/page.mdx, apps/web/src/app/docs/cli/page.mdx | i364-docs | #352, #359, #365 also add sections; rebase and keep both |

## Risks

- **Low — docs written before behaviour settles.** Mitigation: this issue
  starts only after 361 and 363 merge (Depends on).

## Open questions

- None.

Depends on #361
Depends on #363

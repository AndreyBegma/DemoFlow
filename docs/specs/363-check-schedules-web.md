# Check schedules on the project page, and stale badges

Issue: [#363](https://github.com/AndreyBegma/DemoFlow/issues/363)
Depends on: #362 (the schedule and health routes). Decision record: [ADR-0021](../adr/0021-scheduled-checks.md).

## Summary

The person sets when a project's demos are checked, sees a schedule the
team committed in `demoflow.config.json` (read-only), and sees which demos are
broken: a **stale** badge on the project and on each scenario, and a block on
`/app` listing every stale scenario. Check runs appear in the run library
with a "Check" label and no video. Alerts live on the website only (owner,
2026-10-26).

## Scope

### In scope

- `apps/web/src/components/projects/check-schedule.tsx` (new): the schedule
  card of the project page.
- `apps/web/src/components/projects/scenario-health.tsx` (new): the
  per-scenario state list on the project page.
- `apps/web/src/components/projects/stale-badge.tsx` (new).
- `apps/web/src/components/dashboard/stale-demos.tsx` (new): the `/app` block.
- `apps/web/src/lib/schedule.ts` and `schedule.test.mjs` (new): form ↔ body,
  "next check" text, validation.
- `apps/web/src/app/app/projects/[id]/page.tsx`: the two new cards.
- `apps/web/src/app/app/projects/_data.ts`: fetch schedule and health.
- `apps/web/src/components/projects/project-list.tsx`: the badge with `staleCount`.
- `apps/web/src/components/projects/runs-table.tsx` and
  `apps/web/src/components/projects/run-details.tsx`: the "Check" label for
  `kind: 'check'` and "A check run records no video" in place of the player.
- `apps/web/src/app/app/page.tsx`: the stale block.
- `apps/web/src/i18n/en.ts`: `projects.schedule.*`, `projects.health.*`,
  `dashboard.stale.*`, `runs.kind.check`.

### Out of scope

- The API (spec 362), the CLI (specs 360, 361), the docs pages (spec 364).
- Email or push notifications.
- Editing a config schedule from the website: it is the repository's.

## Decisions

1. **The schedule card** (ADR-0021 §4–5). On the project page, under the
   project header and above Start run.
   - **No schedule:** "Not checked on a schedule" and a **Set schedule**
     button.
   - **Form:** cadence as a segmented control (Daily · Weekdays · Weekly),
     a weekday select shown for Weekly, a time input (`HH:MM`), the time zone
     (the machine's when the API knows it, else the browser's, shown as text
     with a **Change** link to a select), and **Leave out** — a checklist of
     the project's scenarios from `GET /projects/:id/scenarios` (needs the
     machine online; offline shows "Scenarios are listed when the machine is
     online" and keeps the saved list). Save is `PUT /projects/:id/schedule`;
     Remove is `DELETE` behind a confirm.
   - **Set:** "Checks every weekday at 09:30 (Europe/Berlin) on <machine>",
     next check (relative), last pass (relative, with passed/failed counts
     when known), Edit and Remove.
   - **Paused** (`pausedReason`): a warning banner with the reason —
     `config-schedule`: "The project's demoflow.config.json has its own
     schedule, which wins"; `no-machine`: "The machine was removed"; `cli-too-old`:
     "Update DemoFlow on <machine> to run scheduled checks".
   - **Config schedule:** the same summary, read-only, with "Set in
     demoflow.config.json" and a link to `/docs/checks` (spec 364); no form.
   - Offline machine: the next-check line says "when <machine> is online".
2. **Stale badge.** `Glass UI` `Badge` with tone `danger`, text "Stale"
   (one scenario) or "N stale" (project list). Shown only when the count is
   above zero; no "healthy" badge (an absent badge is the healthy state).
3. **Scenario health list** on the project page: one row per scenario the API
   has health for — name, state (Stale since <relative> / Passing), a link to
   the last run. Stale rows first. Hidden when the API returns none.
4. **The `/app` block** "Stale demos": up to 10 rows from `GET /checks/stale`
   (project, scenario, since, link to the run), and "All passing" when empty
   for a user who has at least one schedule; hidden for a user with no
   schedule and no stale scenario.
5. **Check runs in the library.** A run with `kind: 'check'` shows a "Check"
   label in `runs-table` and, on the run page, the stages and the failure as
   today, with "A check run records no video" instead of the player and no
   download or format controls.
6. **Content surfaces stay readable** (CLAUDE.md, vision §9): the cards are
   Glass UI `Card`s like the rest of the page; glass only on the existing
   chrome.

## UI

Copy (English, i18n keys under the namespaces of Scope):

| Key | Text |
|---|---|
| `projects.schedule.title` | Scheduled checks |
| `projects.schedule.none` | Not checked on a schedule |
| `projects.schedule.set` | Set schedule |
| `projects.schedule.summary` | Checks {cadence} at {at} ({zone}) on {machine} |
| `projects.schedule.next` | Next check {when} |
| `projects.schedule.nextOffline` | Next check when {machine} is online |
| `projects.schedule.fromConfig` | Set in demoflow.config.json |
| `projects.health.stale` | Stale since {when} |
| `dashboard.stale.title` | Stale demos |
| `dashboard.stale.allPassing` | All passing |
| `runs.kind.check` | Check |

## Acceptance criteria

- [ ] A project with no schedule shows "Not checked on a schedule"; setting
      Weekdays 09:30 saves and the card shows the summary and a next check.
- [ ] Weekly shows the weekday select; Daily and Weekdays hide it; an invalid
      time cannot be saved (`schedule.test.mjs` covers the form mapping).
- [ ] A project with a config schedule shows it read-only with no form and no
      Remove.
- [ ] Each `pausedReason` shows its banner text.
- [ ] A project with two failed scenarios shows "2 stale" in the project list
      and a Stale badge on both rows of the health list; `/app` lists both.
- [ ] A check run in the library shows "Check", and its run page shows no
      player, no download and the "records no video" line.
- [ ] Keyboard: the form is operable without a mouse; the badge has text, not
      only colour.
- [ ] `bun run build` and `bun run check` pass for `apps/web`.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i363-schedule | the schedule card and its lib | apps/web/src/components/projects/check-schedule.tsx, apps/web/src/lib/schedule.ts, apps/web/src/lib/schedule.test.mjs, apps/web/src/app/app/projects/[id]/page.tsx, apps/web/src/app/app/projects/_data.ts, apps/web/src/i18n/en.ts | — | yes | sonnet |
| i363-stale | badges, health list, `/app` block, check runs | apps/web/src/components/projects/stale-badge.tsx, apps/web/src/components/projects/scenario-health.tsx, apps/web/src/components/dashboard/stale-demos.tsx, apps/web/src/components/projects/project-list.tsx, apps/web/src/components/projects/runs-table.tsx, apps/web/src/components/projects/run-details.tsx, apps/web/src/app/app/page.tsx | i363-schedule | no | sonnet |

`i363-stale` waits for `i363-schedule` because the page file and `en.ts` have
one writer: `i363-schedule` adds every key of the UI table and mounts the
health list on the project page with a placeholder import that `i363-stale`
fills.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/src/i18n/en.ts | i363-schedule | other Phase 8 web issues (#350, #351, #357, #358) add their own namespaces; rebase and keep both |
| apps/web/src/components/projects/run-details.tsx | i363-stale | #350 and #357 also edit the run page; land in issue order |
| apps/web/src/app/app/projects/[id]/page.tsx | i363-schedule | — |

## Risks

- **Medium — time zone confusion.** A schedule in the machine's zone shown to
  a person in another. Mitigation: the zone is always printed next to the
  time; "next check" is relative.
- **Low — scenario list needs the machine online.** Mitigation: the saved
  exclusions are kept and shown by id when offline.

## Open questions

- Should the stale block also show on the project list page? Default: the
  badge there is enough.

Depends on #362

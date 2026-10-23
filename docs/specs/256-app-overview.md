# The `/app` overview: recent projects and machines

Issue: [#256](https://github.com/AndreyBegma/DemoFlow/issues/256)
Depends on: nothing. Projects (#178), machines (#135, #151) and their
endpoints have landed.

## Summary

`/app` is where sign-in lands. It still shows the placeholder from before
projects existed: a card "Your projects" with "Projects will appear here."
(`app.shell.title`, `app.shell.empty`), and links in the header. Projects,
machines and runs have all shipped since.

Vision §6, "Dashboard", asks for recent demos, running tasks and progress,
connected Runners, failed jobs and warnings, and a quick action to create a
demo. This slice replaces the placeholder with an overview of what the
existing endpoints already return: the most recent projects with their last
run, and the paired machines with their connection.

## Scope

### In scope

- `apps/web/src/app/app/page.tsx`: the overview, server-rendered.
- `apps/web/src/components/dashboard/**` (new): `RecentProjects` and
  `MachinesSummary`.
- `apps/web/src/i18n/en.ts`: a `dashboard` block; the unused
  `app.shell.title` and `app.shell.empty` are removed.

### Out of scope

- Any API change. Both lists come from `GET /projects` and `GET /runners`.
- Running tasks and progress. A launch is per project and lives in memory
  (spec 247, Decisions 1 and 9); listing every project's launch would be one
  request per project, and progress inside a run is out of scope in 247–249.
- A "create a demo" action. Per ADR-0008 (Consequences), creating a demo from
  the website means picking a committed scenario, which the project page
  already does (#249). The overview links to the project.
- Warnings: the `Run` row stores no warnings (spec 178, Decision 1).
- The header links and the email-verification banner: they stay as they are.

## Decisions

1. **Data.** The page loads, in parallel, `listProjects` and `listRunners`
   with the request's cookie, the way `app/app/projects/_data.ts` and
   `lib/session.ts` do. It reuses those helpers (`getProjects`,
   `getRunners`) instead of adding fetches.
2. **Recent projects.** The first **5** projects of `GET /projects`, which is
   already ordered by newest activity (spec 178, Decision 5). Each row shows
   the name (a link to `/app/projects/[id]`), the last run's scenario,
   `RunStatus`, and its time as `formatRelative` (falling back to
   `formatDate`), like the projects list. A project with no run shows "No
   runs yet". Below: "All projects" → `/app/projects`.
   - *Why 5:* an overview, not a second list; the full list is one click
     away.
   - A failed last run shows the existing failed `RunStatus`. That is the
     "failed jobs" of vision §6 with the data the site has; there is no
     separate failures list.
3. **Machines.** Every paired machine of `GET /runners`: name, an
   online/offline indicator from `online`, and "last seen" from `lastSeenAt`,
   with the same wording as the machines page (reuse its strings or its
   helper; do not duplicate the logic). Below: "Manage machines" →
   `/app/machines`.
   - *Why every machine:* a personal account has few machines, and the
     machines page has no paging either.
4. **Empty states** (Glass UI `EmptyState`):
   - no projects: "Run a scenario on a paired machine and its project
     appears here." with a link to `/docs`;
   - no machines: "Pair a machine to see its runs here." with a link to
     `/docs/runner`.
5. **Errors.** Each section fails alone: a `Banner tone="danger"` in that
   section ("Projects could not be loaded." / "Machines could not be
   loaded."), the other section still renders.
6. **Look.** Two content cards, readable, not glass (vision §9); the page
   keeps its current width and header. The title is "Overview".
7. **Strings.** Every new string goes in a `dashboard` block of `en.ts`.
   `app.shell.title` and `app.shell.empty` are removed once unused; the
   other `app.shell` keys stay.

## Acceptance criteria

- [ ] `/app` shows at most 5 projects in the API's order, each with its last
      run's status and time and a link to its library; "All projects" links
      to `/app/projects`.
- [ ] `/app` lists every machine with online/offline and last seen;
      "Manage machines" links to `/app/machines`.
- [ ] With no projects or no machines, the empty states of Decision 4 show
      with their docs links.
- [ ] A failing `GET /projects` or `GET /runners` shows that section's
      banner only.
- [ ] The placeholder text is gone; no API file changes.
- [ ] Light and dark both readable. `bun run check`, `bun run test` and
      `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/src/app/app/page.tsx`, `apps/web/src/components/dashboard/**` | #256 | No other open issue. |
| `apps/web/src/i18n/en.ts` | #256 (`dashboard` block, two `app.shell` keys removed) | #257 adds strings to the `projects.library` block. Each edits its own block; merge the base before opening the PR. |

## Open questions

None.

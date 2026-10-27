# Glass UI app shell: sidebar, breadcrumbs, account menu, light and dark theme, Overview

Issue: [#373](https://github.com/AndreyBegma/DemoFlow/issues/373)
Depends on: nothing

## Summary

Every `/app` page draws its own chrome today. `apps/web/src/app/app/page.tsx`
opens with a line of text ("Signed in as …") and four underlined links;
`projects/page.tsx` and `machines/page.tsx` have a single "back" link; each page
sets its own `mx-auto … max-w-*` column [Confirmed]. Glass UI is installed and
its primitives are used inside the pages (`Card`, `Banner`, `Button`,
`EmptyState`, …), but there is no navigation, no app frame and no theme choice:
`apps/web/src/app/layout.tsx` hard-codes `data-theme="dark"` [Confirmed].

`docs/product/vision.md` §9 asks for glass chrome — navigation, top bars,
summary cards, runner connection status — over readable content surfaces. This
slice builds that chrome once, in `apps/web/src/app/app/layout.tsx`, so every
present and future `/app/**` page sits inside it, and gives the website a light
theme next to the dark one. It also redesigns the Overview (`/app`), the first
page a signed-in person sees.

The reference design is the Nautelle web app
([AndreyBegma/Nautelle](https://github.com/AndreyBegma/Nautelle),
`apps/web/src/components/shell/**`, `apps/web/src/components/page-header/page-header.tsx`,
`apps/web/src/components/overview/dashboard.tsx`), which builds the same shell
from the same library.

## Scope

### In scope

- `apps/web/src/components/shell/**` (new): `app-shell.tsx`, `sidebar.tsx`,
  `top-bar.tsx`, `account-menu.tsx`, `machine-status.tsx`, `crumb-names.tsx`
  (the client context of Decision 5).
- `apps/web/src/components/brand/logo.tsx` (new): the DemoFlow mark and
  wordmark, used by the sidebar here and by #375 (auth pages) and #376
  (landing and docs headers).
- `apps/web/src/lib/` (new, pure, tested the way the existing `lib/*.test.mjs`
  are): `nav.ts`, `crumbs.ts` + `crumbs.test.mjs`, `theme.ts` +
  `theme.test.mjs`, `overview-stats.ts` + `overview-stats.test.mjs`.
- `apps/web/src/app/app/layout.tsx`: renders the shell around `children`; keeps
  the session guard unchanged (spec 124, decision 4; spec 135, decision 6).
- `apps/web/src/app/layout.tsx`: theme bootstrap script in `<head>`,
  `suppressHydrationWarning` on `<html>`, no hard-coded `data-theme`.
- `apps/web/src/app/app/page.tsx` and `apps/web/src/components/dashboard/**`:
  the Overview inside the shell (summary cards, recent projects, machines,
  empty states). The verify-email banner moves into the shell (shown on every
  `/app` page while the address is unverified).
- Every other `/app/**` page loses its own header row ("back" links, the
  signed-in line, the sign-out button): `projects/page.tsx`,
  `projects/[id]/page.tsx`, `projects/[id]/runs/[runId]/page.tsx`,
  `machines/page.tsx`, `settings/page.tsx`, `device/page.tsx`. Only the header
  rows and the outer `<main>` column change; the page bodies are #374 and #375.
- `apps/web/package.json`, `bun.lock`: `@andrewbehma/glass-ui` 0.34.0 → 0.37.0
  (Decision 7).
- `apps/web/src/i18n/en.ts`: `app.shell.*` keys (nav labels, account menu,
  theme names, machine status), `dashboard.*` for the new cards.
- `apps/web/package.json` `test` script: the two new `*.test.mjs`.

### Out of scope

- The bodies of projects, runs, the run page and machines (#374); auth pages,
  device approval and settings bodies (#375); landing and docs (#376).
- The Shares entry in the sidebar (Decision 3): #350 adds it.
- A command palette, notifications, keyboard shortcuts (Nautelle has them; no
  source asks for them here).
- Any API change. The Overview uses only `getProjects()` and `getRunners()`
  that `app/page.tsx` already calls [Confirmed].
- Glass UI's `material-light` module: it is a pointer-highlight effect for
  `.lit` surfaces, not the light theme [Confirmed: `dist/material-light.d.ts`].
  The light theme is `data-theme="light"` in `tokens.css` / `material.css`
  [Confirmed].

## Decisions

1. **Layout: a glass sidebar** — owner's choice in the 2026-10-26 interview
   (the left-sidebar preview). Desktop (≥ the library's `desktop` breakpoint):
   a fixed left `NavRail` (`@andrewbehma/glass-ui/nav-rail`) with the brand,
   the nav items and the machine status at the bottom; a top bar over the
   content with breadcrumbs on the left and the account menu on the right.
   Narrow screens: the sidebar becomes a `Sheet` drawer
   (`@andrewbehma/glass-ui/sheet`) opened from a menu button in the top bar.
   Same pairing as Nautelle's `rail.tsx` + `app-shell.tsx`
   (`useBreakpoint() === 'desktop'`).
2. **Nav items, in order**: Overview (`/app`), Projects (`/app/projects`),
   Machines (`/app/machines`), Settings (`/app/settings`). The active item is
   the longest matching prefix of the pathname. The list is one exported array
   in `nav.ts`, so later slices add an item with a one-line change.
3. **Shares is not shown until #350 lands.** A disabled item leads nowhere and
   reads as broken; #350 owns `/app/shares` and adds its entry to `nav.ts` in
   the same pull request. The owner's preview listed Shares — it arrives with
   its page, not before.
4. **Machine status at the bottom of the sidebar**: one row per paired machine
   (name, a dot: online = success tone, offline = muted), from `getRunners()`
   (`Runner.online`, `lastSeenAt` [Confirmed `apps/web/src/lib/api.ts`]); more
   than three machines collapse to "N machines · M online" linking to
   `/app/machines`. No machine: a "Pair a machine" link to `/docs/runner`.
   The data is read once per navigation on the server, like the Overview
   today; no polling in this slice.
5. **Breadcrumbs from the pathname, names from the page.** `crumbs.ts` maps a
   pathname to segments (`/app/projects/<id>/runs/<runId>` → Projects ›
   `<project>` › `<run>`); a page that knows a segment's display name passes it
   through a small client context (`useCrumbName(segment, name)`), as
   Nautelle's `use-crumb-names.ts` does. Until a name arrives the crumb shows a
   neutral placeholder, never a raw id. The existing
   `apps/web/src/components/projects/run-breadcrumbs.tsx` is replaced by this
   (its page is #374's; this slice removes only its use in the header row).
6. **Theme: system, dark, light.** `theme.ts` holds the modes, a
   `df-theme` localStorage key, and an inline bootstrap script that sets
   `data-theme` before first paint (Nautelle's `theme.ts`, spec D7 there). The
   default is the system preference. The account menu has a three-way
   `SegmentedControl` (System / Dark / Light). `data-scale="desk"` stays.
   Storage blocked → the choice lasts until reload; no flash of the wrong theme
   either way.
7. **Glass UI 0.37.0.** Nautelle pins it; 0.35–0.37 add `breakpoints`,
   `use-breakpoint`, `section`, `list-detail`, `launcher`, `date-field`,
   `time-field`, `floating-window`, `period-switcher`, `use-scroll-into-row`
   and remove nothing that DemoFlow imports today [Confirmed: export maps of
   0.34.0 and 0.37.0 compared; DemoFlow imports 18 subpaths, all present in
   0.37.0]. The shell needs `use-breakpoint`. The bump is pinned exactly
   (`bunfig.toml`) and lives in this slice only. 0.38.0 exists; not taken
   without a reason — the reference app runs 0.37.0.
8. **Account menu** (`Menu` + `Avatar`): the email, Account settings, the theme
   control, Sign out (the existing `SignOutButton` logic). It replaces the
   "Signed in as" line.
9. **Overview** — the owner's preview: a row of `StatTile`s, then Recent
   projects, then Machines.
   - Tiles: **Projects** (count), **Runs** (sum of `Project.runCount`),
     **Failing** (projects whose `lastRun.status` is `failed`). The preview's
     "Stale" tile is #363's: it becomes Stale when #362/#363 land. Until then
     Failing is the honest number the API already returns.
   - Recent projects and Machines keep their data and links
     (`recent-projects.tsx`, `machines-summary.tsx`), restyled as `Card`s with
     `EmptyState` for none.
   - A failed load shows a `Banner` per section, as today.
10. **Glass where vision §9 puts it.** Glass material on the sidebar, top bar,
    account menu, drawer and stat tiles. Lists and content cards use the solid
    card surface. No component of our own where Glass UI has one (CLAUDE.md).

## UI

```
┌──────────┬──────────────────────────────────┐
│ ◆DemoFlow│ Projects › landing         (A)▾  │  ← top bar (glass)
│░░░░░░░░░░├──────────────────────────────────┤
│ Overview │  ┌────────┐ ┌────────┐ ┌───────┐ │
│ Projects │  │Projects│ │ Runs   │ │Failing│ │  ← StatTile row
│ Machines │  └────────┘ └────────┘ └───────┘ │
│ Settings │  Recent projects                 │
│          │  │ landing   ● passed  2m ago │  │
│ ● devbox │  Machines                        │
└──────────┴──────────────────────────────────┘
  sidebar (glass), machine status at the bottom
```

Narrow: top bar with ☰ (opens the drawer) · crumbs · avatar; content full width.

## Acceptance criteria

- [ ] Every `/app/**` page (`/app`, `/app/projects`, `/app/projects/[id]`,
      `/app/projects/[id]/runs/[runId]`, `/app/machines`, `/app/settings`,
      `/app/device`) renders inside the shell; none renders its own back link,
      signed-in line or sign-out button.
- [ ] The active nav item matches the page, including nested routes (a run
      page highlights Projects).
- [ ] At 375 px wide there is no horizontal scroll on any `/app` page; the
      sidebar is a drawer that opens and closes from the top bar and with Esc.
- [ ] Theme: System follows `prefers-color-scheme` live; Dark and Light stick
      across reloads; no flash of the other theme on load (checked with a
      throttled reload in both modes); blocked storage still renders.
- [ ] Body text and secondary text meet WCAG AA contrast in both themes on
      the shell surfaces and the Overview (checked with the browser's contrast
      tool; values in the PR).
- [ ] Breadcrumbs never show a raw id: the run page shows the project name and
      the scenario name.
- [ ] The Overview tiles show the right numbers for a fixture of projects
      (`overview-stats.test.mjs`), and empty states
      appear for no projects and no machines.
- [ ] The unverified-email banner appears on every `/app` page while
      unverified, and never after verification.
- [ ] `bun run check`, `bun run build`, `bun run --filter web test` pass;
      `crumbs.test.mjs` covers every `/app` route and `theme.test.mjs` covers mode resolution and blocked storage.
- [ ] The PR has screenshots of `/app` and `/app/projects` in both themes, at
      desktop and 375 px.

## Parallel plan

Honestly one slot: the shell, the layout and the header-row removals are one
change — a page without its header but outside the shell would have no
navigation at all.

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i373-shell | shell, theme, Overview, Glass UI bump | apps/web/src/components/shell/**, apps/web/src/components/brand/**, apps/web/src/lib/nav.ts, apps/web/src/lib/crumbs*, apps/web/src/lib/theme*, apps/web/src/lib/overview-stats*, apps/web/src/components/dashboard/**, apps/web/src/app/layout.tsx, apps/web/src/app/app/layout.tsx, apps/web/src/app/app/page.tsx, apps/web/src/app/app/**/page.tsx, apps/web/src/i18n/en.ts, apps/web/package.json, bun.lock | — | yes | opus |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/package.json, bun.lock | i373-shell | no other slice of #373–#376 changes dependencies |
| apps/web/src/app/app/layout.tsx, apps/web/src/app/layout.tsx | i373-shell | #374–#376 do not open them |
| apps/web/src/components/brand/logo.tsx | i373-shell | #375 and #376 import it, never edit it |
| apps/web/src/lib/nav.ts | i373-shell | #350 adds the Shares item after this merges |
| apps/web/src/app/app/**/page.tsx | i373-shell (header rows) | #374/#375 rebase onto it for the page bodies |
| apps/web/src/i18n/en.ts | i373-shell | every web slice appends keys; whoever merges second rebases (append-only) |
| apps/web/src/app/app/page.tsx | i373-shell | #363 (stale tile, stale block on `/app`) and #350 build on the new Overview — they come after this |

Phase 8 web slices #350, #351, #357, #358 and #363 build on the shell and on
#374's pages; they are ordered after #373 (and #374 where they touch its
pages).

## Risks

- **Hydration warnings from the theme script** (medium). Mitigation:
  `suppressHydrationWarning` on `<html>` only, script is a constant string.
- **Luna Player's stylesheet in light theme** (medium): `luna-player/player.css`
  is imported globally [Confirmed `globals.css`]; its controls may assume a
  dark backdrop. The player sits on a black video surface either way; check it
  in light and note it in the PR. A fix belongs to #374.
- **Glass UI 0.37 behaviour changes** inside components DemoFlow already uses
  (low–medium): exports are a superset, but styles may move. Mitigation: the
  PR screenshots cover every page; a regression found there is fixed in this
  slice or the bump is dropped to 0.34.0 with `use-breakpoint` replaced by a
  CSS breakpoint.
- **Server data in a client shell** (low): the shell's machine list comes from
  the layout (server) and is passed down; no client fetch is added.

## Open questions

- **Logo.** [Unknown] whether a brand asset exists — `apps/web/public/` holds
  only the landing poster and video [Confirmed]. Default: a simple geometric
  SVG mark drawn with the accent token plus the "DemoFlow" wordmark in the UI
  font; the owner can replace the SVG later.

- **Collapse the sidebar on desktop?** Default: no — fixed width, no collapse
  control, as the owner's preview. Nautelle's `rail-collapse.ts` is the
  reference if it is wanted later.
- **Theme in the account settings page too?** Default: only the account menu;
  settings is #375's and can link to it.

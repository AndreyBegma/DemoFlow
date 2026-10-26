# Glass UI for projects, runs, the run page and machines

Issue: [#374](https://github.com/AndreyBegma/DemoFlow/issues/374)
Depends on: #373 (the shell, the theme, Glass UI 0.37.0)

## Summary

After #373 every `/app` page sits in the glass shell, but the page bodies are
still the first-version layouts: a single `Card` per page with an `h1`, hand
`<table>`s with fixed minimum widths (`runs-table.tsx` `min-w-[44rem]`,
`machine-list.tsx` `min-w-[48rem]` [Confirmed]), status as two `Badge`s
(`run-status.tsx`) and launch state as a `StatusPill` (`launch-status.tsx`)
[Confirmed]. Vision §9 asks for functional status indicators for running,
completed, failed and unavailable, a video page with a glass metadata panel,
and readable dense tables (no glass on them).

This slice redesigns the bodies of the projects list, the project page, the
runs table, the run page and the machines page on Glass UI primitives, with one
status vocabulary used everywhere. Behaviour, data and API calls stay as they
are.

## Scope

### In scope

- `apps/web/src/app/app/projects/page.tsx`, `projects/[id]/page.tsx`,
  `projects/[id]/runs/[runId]/page.tsx`, `machines/page.tsx`: page bodies.
- `apps/web/src/components/projects/**`: `project-list.tsx`, `runs-table.tsx`,
  `run-details.tsx`, `run-status.tsx`, `launch-status.tsx`, `start-run.tsx`,
  `format-choice.tsx`, `run-again.tsx`, `delete-run.tsx`; `run-breadcrumbs.tsx`
  is deleted (its job moved to the shell crumbs in #373).
- `apps/web/src/components/player/run-playback.tsx` (the frame around the
  player; the adapters `luna-video-player.tsx`, `native-video-player.tsx` and
  `video-player.ts` are not changed).
- `apps/web/src/components/machines/machine-list.tsx`.
- `apps/web/src/components/status/status-indicator.tsx` (new, Decision 2) and
  `apps/web/src/lib/status.ts` + `status.test.mjs` (the mapping).
- `apps/web/src/i18n/en.ts`: keys these pages add (status labels, empty states).

### Out of scope

- The shell, nav, breadcrumbs and theme (#373).
- Share (#350), the editor's Edit button and route (#357), schedule controls and
  stale badges (#363): they build on these pages after this merges.
- API changes, new data on any page.
- Luna Player's own controls and stylesheet.

## Decisions

1. **Page frame: `PageHeader` + sections.** Each page starts with
   `@andrewbehma/glass-ui/page-header` (title, one-line description, primary
   action on the right — e.g. Start run on the project page) and groups its
   content in `section-header` + solid `Card`s. No page renders a back link;
   the shell crumbs do that (#373 Decision 5). Same structure as Nautelle's
   `apps/web/src/components/page-header/page-header.tsx`.
2. **One status vocabulary.** `lib/status.ts` maps every state the pages show
   to one of five kinds — `running`, `passed`, `failed`, `unavailable`
   (artifacts deleted, machine offline for playback), `idle` (never run) — and
   `status-indicator.tsx` renders it with Glass UI `StatusPill` (dot + label,
   tone per kind). `RunStatus` and `LaunchStatus` use it; the runs table,
   project list, run page and machines page show the same pill for the same
   state. Colour is never the only signal: every pill has its text label.
3. **Tables stay solid and readable** (vision §9 "where not to overuse
   glass"). The runs table and machines list move to Glass UI
   `@andrewbehma/glass-ui/table` (or `data-table` where sorting is already
   offered — keep the existing behaviour, add none) on the solid card surface.
   On narrow screens they become stacked rows instead of a horizontal scroll
   (`responsive-rows` pattern in Nautelle's `apps/web/src/components/responsive-rows`),
   so the `min-w-[44rem]` / `min-w-[48rem]` go.
4. **Run page: player first, glass metadata panel beside it.** Desktop: the
   player (16:9, black surface) takes the main column; a glass side panel holds
   status, scenario, path, when, duration, machine, formats, stages and the
   failure message, plus the actions (Run again, Download, Delete). Narrow: the
   panel stacks under the player. The `KeyValueList` stays the content of the
   panel. Failure messages and stage details are code-like text: solid surface,
   monospace, never glass (vision §9).
5. **Project page**: header with the project name, root path (muted, truncated
   with a tooltip), machine pill; Start run as the header's primary action
   (`start-run.tsx` behaviour unchanged); the status filter
   (`SegmentedControl`) above the runs table.
6. **Projects list**: one row per project — name, machine, last run pill,
   relative time, run count — as a solid list card; `EmptyState` with a link to
   the first-run docs when there are none.
7. **Machines page**: one row per machine — name, OS, CLI version, online pill
   (online is a success-tone "Online" pill, offline the `unavailable` kind —
   not `running`, which means a run in progress), last seen; revoke stays a
   `ConfirmDialog`.

## UI

```
Run page (desktop)
┌─ crumbs: Projects › landing › Create a post ─────────────── (A)▾ ┐
│ Create a post                         ● Passed   [Run again][⋯]  │
│ ┌──────────────────────────────┐ ┌──────────────── glass ──────┐ │
│ │                              │ │ Scenario   Create a post    │ │
│ │          player 16:9         │ │ Path       demoflow/post…   │ │
│ │                              │ │ When       2 min ago        │ │
│ └──────────────────────────────┘ │ Duration   14 s · mp4, gif  │ │
│                                  │ Machine    ● devbox         │ │
│                                  │ Stages     ✓✓✓✓✓✓           │ │
│                                  └─────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

## Acceptance criteria

- [ ] The five status kinds render with the same pill (tone and label) on the
      projects list, the project page, the runs table, the run page and the
      machines page; `status.test.mjs` covers the mapping from every run,
      launch, artifact and machine state the API returns.
- [ ] At 375 px no page scrolls horizontally; the runs table and the machines
      list show stacked rows.
- [ ] The run page shows the player and the metadata panel side by side at
      ≥ 1024 px and stacked below; playback, download, run again and delete
      behave exactly as before (existing `lib/*.test.mjs` still pass).
- [ ] Failure messages and stage details are on a solid surface in a monospace
      font in both themes.
- [ ] Text meets WCAG AA contrast in both themes on every page in scope
      (values in the PR).
- [ ] No page renders its own back link; `run-breadcrumbs.tsx` is gone.
- [ ] `bun run check`, `bun run build`, `bun run --filter web test` pass.
- [ ] The PR has screenshots of each page in both themes at desktop and 375 px,
      including a failed run and an unavailable video.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i374-pages | the four page bodies and their components | apps/web/src/app/app/projects/**, apps/web/src/app/app/machines/**, apps/web/src/components/projects/**, apps/web/src/components/machines/**, apps/web/src/components/player/run-playback.tsx, apps/web/src/components/status/**, apps/web/src/lib/status.ts, apps/web/src/lib/status.test.mjs, apps/web/src/i18n/en.ts, apps/web/package.json | #373 | yes | sonnet |

One slot: the status vocabulary is shared by all four pages, and splitting the
pages would put `status-indicator.tsx` and `en.ts` in every branch.
`apps/web/package.json` is touched only to add `status.test.mjs` to the `test`
script — no dependency change.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx | i374-pages | #350 (Share button), #357 (Edit button), #358 come after this merges |
| apps/web/src/components/projects/run-details.tsx, runs-table.tsx | i374-pages | #363 (stale badges) comes after |
| apps/web/src/app/app/projects/[id]/page.tsx | i374-pages | #363 (schedule controls) comes after |
| apps/web/src/i18n/en.ts | i374-pages | append-only; whoever merges second rebases |
| apps/web/package.json (`test` script line only) | i374-pages | #373 owns the dependency bump and merges first |

## Risks

- **Stacked rows lose sorting cues** (low): the runs table has a status filter,
  not column sorting [Confirmed `runs-table.tsx` takes a filter]; nothing to
  lose. Re-check if a later slice adds sorting.
- **Player in light theme** (medium): the player stays on a black surface in
  both themes; if `luna-player/player.css` controls read poorly in light, the
  frame keeps a dark backdrop around the player only.
- **Behaviour regressions in actions** (medium): delete, run again and download
  have their own specs (281, 282, 300). The slice moves them into the panel
  without changing their logic; the PR lists each and how it was checked.

## Open questions

- **Run page side panel width.** Default: 22 rem at ≥ 1024 px; the player takes
  the rest.
- **Project root path on the project page** — full or truncated? Default:
  truncated from the left with the full path in a tooltip and a copy button.

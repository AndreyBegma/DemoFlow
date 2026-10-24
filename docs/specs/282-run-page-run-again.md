# Run again from the run page

Issue: [#282](https://github.com/AndreyBegma/DemoFlow/issues/282)
Depends on: #247 (the launch endpoints) and #249 (the project page's start
and cancel UI). Both have landed.

## Summary

A scenario can be started from the project page ([249](249-project-page-start-run.md)),
but not from a run's page, where the user most often wants "run this again".
Spec 249 put it out of scope. This slice adds a **Run again** action on
`/app/projects/[id]/runs/[runId]` that starts the run's own scenario on the
machine that recorded it, through the existing `POST /api/projects/:id/launch`
(ADR-0016 §4: the site chooses nothing but the scenario).

The state machine, polling, cancel and error messages of the project page's
card are extracted into shared code, so there is one implementation.

## What the run record carries (verified)

On `origin/develop`:

- **Scenario id: yes.** `ProjectRun.scenarioPath`
  (`apps/web/src/lib/api.ts:224`) is stored from `result.scenarioId`
  (`apps/cli/src/runs-report/report.ts:91`), which is the scenario's path
  relative to the project root, `/`-separated on every OS
  (`apps/cli/src/config/project.ts:70-85`). That is the form a launch takes
  (`apps/api/src/launches/scenario-id.ts:10-30`). One exception: a scenario
  staged inline by `demoflow mcp` is `inline/<file>`, which no launch can
  start.
- **Project: yes.** `RunDetail.project.id` (`api.ts:317-319`).
- **Machine: partly.** `RunDetail.machine` is the machine that recorded the
  run, with `online` (`api.ts:321`; `apps/api/src/videos/runs.service.ts:11-54`).
  But a launch goes to the project's *current* machine and `rootPath`
  (`apps/api/src/launches/launches.controller.ts:80-106`), and a project can
  be re-bound to another machine (`projects.service.ts:301-330`).
  `RunDetail` does not say which machine the project is bound to now.

So everything needed exists except the project's current machine. That is
already available to the page: `getProjects()` (`apps/web/src/app/app/projects/_data.ts:22`)
returns each project's `runner` and `rootPath`, as the project page uses it.

## Scope

### In scope

- `apps/web/src/lib/launch.ts` and `launch.test.mjs`: `canRunAgain(...)` and
  `isStartableScenario(path)`.
- `apps/web/src/lib/use-launch.ts` (new): the launch state shared by both
  cards (Decision 2).
- `apps/web/src/components/projects/launch-status.tsx` (new): the status row,
  extracted from `start-run.tsx:263-312`.
- `apps/web/src/components/projects/start-run.tsx`: use the two above;
  behaviour unchanged.
- `apps/web/src/components/projects/run-again.tsx` (new): the action.
- `apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx`: fetch the
  project, render the action.
- `apps/web/src/i18n/en.ts`: strings under `runPage.again.*`.

### Out of scope

- The API, the daemon, `packages/**`: no change. No field is added to
  `RunDetail`.
- Choosing a scenario, formats or any option (ADR-0016 §4).
- Progress inside a run; a "run again" in the library table or the projects
  list.
- Docs: #279 does not mention it; a later docs slice may.

## Decisions

1. **When it is shown** (`canRunAgain`, a pure function in `launch.ts`).
   All of:
   - `getProjects()` found the project, with `rootPath` not null;
   - the run's `machine` is not null, and `project.runner?.id === machine.id`;
   - `isStartableScenario(run.scenarioPath)`: starts with `demoflow/`, ends
     with `.demo.json`.

   Otherwise the action is **hidden**, with no message.
   - *Why:* each case means "the click could only fail": a project moved to
     another machine would start the scenario there, which is not "the same
     machine"; an `inline/` scenario never exists as a file. The issue allows
     hide-or-disable-with-reason; a reason for a case the user cannot fix
     from this page is noise. `getProjects()` returning `null` (API error)
     also hides it: the page already shows the run without it.
2. **Shared code, not a copy.** `use-launch.ts` holds what `start-run.tsx:71-189`
   does for one project: the launch state, `apply`, the poll (2 s, stops at a
   terminal state, on unmount and while the tab is hidden), the elapsed clock,
   `start(scenarioId)`, `cancel()`, and the error key. It calls `getLaunch`,
   `startLaunch`, `cancelLaunch` from `lib/api.ts`. `launch-status.tsx` renders
   the row: scenario name, `StatusPill`, elapsed, **Cancel run**, **Open the
   run**, the lost and no-report notes. `StartRun` keeps its picker, list and
   confirmation. Its tests and behaviour do not change.
   - *Why:* the issue says "same API, same states, same cancel"; two copies of
     a 2-second poll with a visibility rule would drift.
3. **Offline.** When the run's machine is not online, **Run again** is shown
   **disabled** with the hint "The machine is offline." beside it, as the
   delete button does (`run-playback.tsx:181-193`). `machine.online` comes
   with the page; it is not re-checked in the browser. The API still answers
   `runner-offline` if the machine dropped meanwhile, and the card shows
   that message.
   - *Why:* offline is the one case the user can fix (start the runner), so it
     gets a reason, and the hint reuses the same wording and layout as the
     delete button next to it.
4. **Reporting off.** Not hidden and not disabled. The site cannot know:
   `CI` and `DEMOFLOW_NO_REPORT` live in the daemon's environment. The click
   gets the API's 409 `reporting-off` and the card shows the existing message
   (`projects.launch.errors.reportingOff`).
   - *Why:* any pre-check would need a new protocol field (ADR-0016 §4 keeps
     the Runner's answer authoritative), and the project page already behaves
     this way.
5. **A launch already running.** On mount the action calls `getLaunch`
   (per project, in memory, spec 247 Decision 1).
   - A launch in `starting`, `running` or `cancelling` replaces the button
     with the status row (with **Cancel run** while running), whichever page
     started it. It is a launch of this project, so it is the one the user is
     waiting for.
   - A launch in a terminal state on mount is **not shown**: the run page
     is not the project page's log, and an old "Passed" next to the run
     would read as this run's result. A launch started here and finished
     shows its row, with **Open the run** to the new run.
   - `runner-busy` from another project's launch on the same machine shows the
     existing message in a danger `Banner`.
   - *Why:* one launch per machine and one visible per project, so the
     button must not offer a second start; showing only what the user
     started, or what is still going, keeps the card from lying.
6. **Confirmation.** **Run again** opens the same `ConfirmDialog` as the
   project page, with the same strings (`projects.launch.confirm.*`): title
   `Run {name} on {machine}?` with `run.scenarioName` and `machine.name`,
   verb **Run**, cancel **Not now**. Confirming sends `{ scenarioId:
   run.scenarioPath }` and nothing else.
   - *Why:* vision §11, explicit confirmation before a machine acts; the same
     strings keep one wording.
7. **Where.** A glass-free `Card` (a content surface, vision §9) between the
   metadata card and the playback card; the button is a Glass UI `Button`
   (`variant="solid"`), the row the `StatusPill`, `Banner`, `ConfirmDialog`
   already used in `start-run.tsx`. No new component library import.
   - *Why:* a primary action belongs with the run's facts, not under the
     delete button next to the player.
8. **Finish.** At a terminal state with a `runId`, **Open the run** links to
   `/app/projects/{projectId}/runs/{runId}`. This page does not navigate by
   itself and `router.refresh()` is not needed (the run shown does not
   change); the hook still calls it, as the project page does, so the
   library stays correct.
   - *Why:* the user may still be reading the old run to compare.
9. **Strings** live in `en.ts` under `runPage.again.*`: `title` ("Run this
   scenario again"), `button` ("Run again"), `offlineHint` ("The machine is
   offline."). Everything else reuses `projects.launch.*`. No literal UI text
   in components (spec 121).

## Acceptance criteria

- [ ] A run whose project is bound to the machine that recorded it, with a
      `demoflow/**/*.demo.json` path and that machine online, shows **Run
      again**.
- [ ] A run of an `inline/` scenario, a run whose machine was removed, a run
      whose project is bound to another machine, and an unbound project show
      no action and make no launch request.
- [ ] An offline machine shows the button disabled with "The machine is
      offline."
- [ ] Confirming sends `POST /api/projects/:id/launch` with `{ scenarioId }`
      equal to the run's `scenarioPath`, and nothing else; **Not now** sends
      nothing.
- [ ] A running launch of the project shows the status row with **Cancel
      run** instead of the button, polls every 2 s and stops at a terminal
      state, on unmount and while hidden; a terminal launch found on mount is
      not shown.
- [ ] A finished launch with a `runId` links to the new run.
- [ ] `reporting-off`, `runner-busy` and `runner-offline` show their existing
      messages.
- [ ] The project page's card behaves exactly as before.
- [ ] Unit tests in `apps/web/src/lib/launch.test.mjs` cover `canRunAgain`
      (each hide case, offline, the happy path) and `isStartableScenario`;
      `package.json` already runs that file.
- [ ] `bun run check` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/src/components/projects/start-run.tsx` | #282 (extraction only) | #279 is docs only. No other open issue. |
| `apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx`, `apps/web/src/components/player/run-playback.tsx` | #282 (page only; playback untouched) | #265 touched the page and has landed; rebase on `develop`. |
| `apps/web/src/i18n/en.ts`, `apps/web/src/lib/launch.ts` | #282 | Shared with any later web work; rebase on whichever merges first. |

## Open questions

None.

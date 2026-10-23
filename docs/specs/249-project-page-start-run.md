# Run a scenario from the project page

Issue: [#249](https://github.com/AndreyBegma/DemoFlow/issues/249)
Depends on: #247 (the scenarios and launch endpoints). It can be built
against [247](247-start-run-api.md)'s contract, then merged after it, the way
#235 was built against #233.

## Summary

With #247 and #248 the website can list a project's scenarios on its machine,
start one, follow it and cancel it
([ADR-0008](../adr/0008-cloud-boundary.md) §3,
[ADR-0016](../adr/0016-website-started-runs.md)). This slice puts that on the
project page, above the run library, and documents it on the Runner docs
page.

## Scope

### In scope

- `apps/web/src/lib/api.ts`: `ScenarioEntry`, `LaunchView`, and
  `listScenarios`, `startLaunch`, `getLaunch`, `cancelLaunch`.
- `apps/web/src/lib/launch.ts` (new) and `launch.test.mjs`: the error-code
  → message mapping and the "is it still going" rule.
- `apps/web/src/components/projects/start-run.tsx` (new): the picker, start,
  live status and cancel.
- `apps/web/src/app/app/projects/[id]/page.tsx`: render it.
- `apps/web/src/i18n/en.ts`: strings.
- `apps/web/src/app/docs/runner/page.mdx`: a "Runs started from the website"
  section.

### Out of scope

- The API (#247) and the daemon (#248).
- Starting from the run page or the projects list.
- Choosing formats or any other option (ADR-0016 §4).
- Progress inside a run: the page shows the launch's state only.

## Decisions

1. **Where.** A "Run a scenario" card on `/app/projects/[id]`, between the
   header card and the library. It is a content surface: readable, not glass
   (vision §9).
   - With no `rootPath`: only the hint "Bind this project to a folder on a
     machine to run its scenarios from here." No request is made.
   - With `rootPath` and no `runner`: "The machine of this project was
     removed." No request is made.
2. **Scenarios.** On mount the card calls `getLaunch` and `listScenarios`. A
   **Refresh** button reloads the list.
   - While loading: a Glass UI `Spinner`.
   - An empty list: `EmptyState`, "No scenarios in `demoflow/`".
   - `skipped > 0`: a note, "{n} files could not be read as scenarios.".
   - `truncated`: a note, "Showing the first 100 scenarios.".
3. **Picker and start.** A Glass UI `Select` of the scenarios, each shown by
   `name` with its `id` as secondary text, and a **Run** button. Run opens a
   `ConfirmDialog` (vision §11, explicit confirmation before a machine acts):
   - title: `Run {name} on {machine}?`;
   - body: `The machine starts the app with the project's devCommand, records
     the demo and reports the run here.`;
   - confirm: **Run**; cancel: **Not now**.

   Confirming calls `startLaunch` with the scenario id only. The confirm
   button shows its pending state until the answer. The picker and Run are
   disabled while a launch is `starting`, `running` or `cancelling`.
4. **Live status.** While the launch is `starting`, `running` or
   `cancelling`, the card polls `getLaunch` every **2 s**. It stops at a
   terminal state or `null`, on unmount, and while the tab is hidden
   (`visibilitychange`), resuming when it is visible. The status row shows
   the scenario name (the id when the name is null), a Glass UI `StatusPill`
   for the state, and the elapsed time while it is active.

   | State | Label |
   |---|---|
   | `starting` | Starting |
   | `running` | Running |
   | `cancelling` | Cancelling |
   | `passed` | Passed |
   | `failed` | Failed |
   | `cancelled` | Cancelled |
   | `timed-out` | Timed out (15 min) |
   | `lost` | Lost contact. The run may still finish and appear in the library. |
5. **Cancel.** A **Cancel run** button while the state is `running`. No
   confirmation: cancelling only stops work. It calls `cancelLaunch` and
   shows `cancelling`. A 409 `not-running` reloads the launch.
6. **Finish.** At a terminal state with a `runId`, an **Open the run** link
   to `/app/projects/{id}/runs/{runId}`, and `router.refresh()` so the library
   shows the new run. `passed` or `failed` without a `runId`: "The run
   finished, but its report did not reach the site.".
7. **Error messages**, for every call, from `launch.ts`:

   | Code | Message |
   |---|---|
   | `runner-offline` | The machine is offline. Start the runner on it (`demoflow runner start`) and try again. |
   | `runner-removed` | The machine of this project was removed. |
   | `project-unbound` | Bind this project to a folder on a machine first. |
   | `project-unknown` | This machine has not reported a run from this folder yet. Run `demoflow run` there once, then refresh. |
   | `runner-busy` | The machine is already running a scenario started from the website. |
   | `reporting-off` | Reporting is off on the machine (`CI` or `DEMOFLOW_NO_REPORT`), so it takes no runs from the website. |
   | `scenario-not-found` | This scenario is no longer in the project. Refresh the list. |
   | `scenario-invalid` | The scenario file is not valid. Run `demoflow validate` on the machine. |
   | `config-invalid` | `demoflow.config.json` on the machine is not valid. |
   | `runner-timeout` | The machine did not answer. Make sure it runs the latest `demoflow`, then try again. |
   | `runner-error` | The machine could not do it. Try again. |
   | anything else | The app's existing "Something went wrong. Try again." |

   Errors show in a danger `Banner` inside the card.
8. **Docs.** The Runner page gains "Runs started from the website":
   - only projects this machine has reported a run from can be run from the
     site; run `demoflow run` in the folder once to register it;
   - the site sends only the scenario id, and the app starts with the
     project's own `demoflow.config.json`;
   - one run at a time per machine, stopped after 15 minutes;
   - cancel stops the browser and the dev server; the partial files stay in
     the run directory;
   - `valueFrom.env` secrets come from the runner's environment, which an
     autostart unit may not share with the shell;
   - with `CI` or `DEMOFLOW_NO_REPORT=1`, the runner refuses these runs.
9. **Strings** live in `en.ts` under `projects.launch.*`. No literal UI text
   in components (spec 121).

## Acceptance criteria

- [ ] A bound project with an online machine lists its scenarios by name;
      Refresh reloads them; the empty, `skipped` and `truncated` notes show.
- [ ] An unbound project and a removed machine show their hint and make no
      request.
- [ ] Run opens the confirmation; confirming sends `POST
      /api/projects/:id/launch` with `{ scenarioId }` only; Not now sends
      nothing.
- [ ] A running launch polls every 2 s, shows its state and elapsed time,
      and stops polling at a terminal state, on unmount and while hidden.
- [ ] Reloading the page during a run shows the running launch (from
      `GET /api/projects/:id/launch`) and keeps polling.
- [ ] Cancel run sends `DELETE /api/projects/:id/launch` and shows
      Cancelling, then Cancelled.
- [ ] A finished launch with a `runId` links to its run page, and the
      library shows the run without a manual reload.
- [ ] Each code of Decision 7 shows its message.
- [ ] Unit tests in `apps/web/src/lib/launch.test.mjs` cover the code →
      message mapping and the active-state rule.
- [ ] The Runner docs page has the new section.
- [ ] `bun run check` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/**` | #249 | None of #247 and #248 touch it. No other open issue does today. |
| `apps/web/src/i18n/en.ts`, `apps/web/src/lib/api.ts` | #249 | Shared with any later web work; rebase on whichever merges first. |

## Open questions

None.

# Docs: starting, cancelling and deleting runs from the website

Issue: [#279](https://github.com/AndreyBegma/DemoFlow/issues/279)
Depends on: nothing. #247, #248, #249 (start and cancel) and #233, #234, #235
(delete) have landed.

## Summary

[Spec 249](249-project-page-start-run.md) gave `/docs/runner` a short "Runs
started from the website" section, and [spec 235](235-run-page-delete-artifacts.md)
left the docs out. Today the page (`apps/web/src/app/docs/runner/page.mdx` on
`origin/develop`) has three problems:

- Line 7 still says "No jobs run over the connection yet." The page
  contradicts its own section at lines 72-87.
- The section does not say which scenarios the site lists, that the machine
  must be online and reporting, what Cancel does while a run is starting, or
  what "lost contact" means.
- Nothing says that a run's files can be deleted from the run page, what is
  removed, and what stays.

[Spec 179](179-docs-section.md), Decision 2: every docs page is written from
the code. This spec lists the facts the page states and the code each one
comes from, so the worker copies facts, not memory.

## Scope

### In scope

- `apps/web/src/app/docs/runner/page.mdx` only: fix line 7, rewrite
  "Runs started from the website", add "Delete a run's files".

### Out of scope

- Any code, `en.ts`, the docs sidebar (`docs-nav`): no new page.
- Other docs pages. `/docs/cli` and `/docs/config` do not mention these
  features today and stay as they are.
- Run again (#282): not shipped; the page must not mention it.

## Decisions

1. **Where.** Keep the two sections on the Runner page, after "Start at
   login" and before "Status on the site". "Runs started from the website"
   is rewritten in place; "Delete a run's files" follows it.
   - *Why:* both depend on the runner being connected; one reader, one page.
     A new page would need a sidebar entry for four paragraphs.
2. **Facts only from the table below.** A sentence the table does not back is
   not written. Where the page and a spec disagree, the code wins.
   - *Why:* spec 179, Decision 2.
3. **Words used for the UI** are the dictionary's (`apps/web/src/i18n/en.ts`
   on `origin/develop`): **Run a scenario** (l.270), **Run** (l.277),
   **Cancel run** (l.288), **Open the run** (l.290), **Delete video files**
   (l.392), **Delete files** (l.397).
4. **Tone and shape.** Short sentences, bullet lists as in the page today, one
   table at most, no code block longer than one line. The `valueFrom.env`
   sentence stays.
5. **Line 7** becomes a statement that matches the section: with the runner
   connected, the site can also start runs on the machine and delete a run's
   files; every command still works without an account.
   - *Why:* "No jobs run over the connection yet" is false since #248.

## Facts the page states

Paths are on `origin/develop`. A fact marked *spec* has no single line of
code; the worker checks the code named next to it and states only the
behaviour.

### Starting a run

| # | Fact | Source |
|---|---|---|
| S1 | **Run a scenario** is a card on a project's page. It starts a scenario on the machine the project is bound to. | `apps/web/src/components/projects/start-run.tsx:209-211`; `apps/api/src/launches/launches.controller.ts:48-57,80-106` (project's own `runner` and `rootPath`) |
| S2 | The card makes no request when the project has no folder or its machine was removed. | `start-run.tsx:70,112-114,191-202` |
| S3 | A project is runnable from the site only after this machine has reported a run from its folder. Run `demoflow run` in the folder once. A folder bound by hand is not enough. | `apps/cli/src/runner/launch/checks.ts:83-102` (`knownRoots` registry); ADR-0016 §2 |
| S4 | The list holds every `*.demo.json` under the project's `demoflow/` folder (subfolders included), shown by name with its path. It is read from the machine when the card opens or **Refresh** is pressed, so a new file shows at once. | `apps/cli/src/runner/launch/list.ts:11-12,40-50`; `start-run.tsx:228-232` |
| S5 | Files that cannot be read as a scenario are skipped (the card counts them). The list stops at the first 100 scenarios, sorted by path, and the card says so. Links are not followed. | `list.ts:5-9` (`LIST_MAX_SCENARIOS`, depth 16, 10,000 entries); `en.ts:279-280` |
| S6 | **Run** asks for confirmation naming the scenario and the machine. | `start-run.tsx:314-327`; `en.ts:281-286` |
| S7 | The site sends only the scenario's path. The machine starts an ordinary `demoflow run` of that file with the project's own `demoflow.config.json`, its own `devCommand`, and the runner's environment. No flags, formats or environment come from the site. | `apps/cli/src/runner/launch/index.ts:275-287` (spawn arguments: `run <file> --json --run-id <id> --project <root>`); ADR-0016 §4 |
| S8 | `valueFrom.env` secrets come from the runner's environment, which an autostart unit may not share with the shell. | ADR-0016 Consequences (3rd bullet); `index.ts:275-287` (no environment override) |
| S9 | The machine must be online. If it is not, **Run** fails with a message to start the runner. | `launches.controller.ts:98-100`; `en.ts:304-305` |
| S10 | The runner refuses website runs when reporting is off: `CI` set to any non-empty value, or `DEMOFLOW_NO_REPORT=1` exactly. The run's result has to reach the site, so an opt-out wins. | `index.ts:221-228`; `apps/cli/src/runs-report/report.ts:65-70` |
| S11 | One website-started run at a time per machine. A second start is refused. A `demoflow run` started in a terminal does not count. | `index.ts:221-224`; `apps/api/src/launches/launches.service.ts:211-213,411` |
| S12 | The status row shows Starting, Running, Cancelling, Passed, Failed, Cancelled, Timed out (15 min) or Lost contact. | `start-run.tsx:33-53`; `en.ts:292-302` |
| S13 | A run still going after 15 minutes is stopped and ends **Timed out**. | `index.ts:31-32,295-297` |
| S14 | **Cancel run** shows only while the state is Running, and asks for no confirmation. It stops the browser and the dev server, giving them up to 15 seconds. | `start-run.tsx:280-289`; `index.ts:30,328-347` (`LAUNCH_KILL_GRACE_MS`) |
| S15 | A cancelled or timed-out run's folder is left as it was; the run is not reported, so it never appears in the library and cannot be deleted from the site. To remove it, delete `runs/<id>/` in the DemoFlow home on the machine. | Spec 248, Decision 8; `index.ts:298-314` (no deletion; the run id is looked up in the report index only); path layout `apps/cli/src/runner/artifacts/index.ts:10-11` |
| S16 | When a run passes or fails, **Open the run** links to its page and the library shows it. If the run finished but its report did not reach the site, the card says so. | `start-run.tsx:296-310`; `index.ts:301-314` |
| S17 | **Lost contact** means the site lost the machine's connection, or heard nothing for too long (20 minutes after start, 30 seconds after Cancel). The run may still finish and appear in the library. | `launches.service.ts:23-26,391-397`; `en.ts:301` |
| S18 | Stopping the runner (`demoflow runner stop`, a signal, a shutdown) cancels a run in progress. | `index.ts:170-177`; spec 248, Decision 11 |

### Deleting a run's files

| # | Fact | Source |
|---|---|---|
| D1 | On a run's page, **Delete video files** removes the run's files from the machine that recorded it. It asks for confirmation naming the machine. | `apps/web/src/components/player/run-playback.tsx:180-206`; `en.ts:391-398` |
| D2 | What is removed: the run's whole folder on the machine, `<home>/runs/<id>/`, recursively. That is everything the run wrote there, not only the videos. Links inside it are removed as links. | `apps/cli/src/runner/artifacts/index.ts:158-166,24-27`; `index.ts:68-92` (`candidateRunDir`) |
| D3 | What stays: the run's entry in the library (scenario, status, time, duration, formats, failed step, stages, files list, failure message). The library marks the run **Files deleted**. The run page shows "Video files deleted" with the date. | `apps/api/src/videos/artifacts.service.ts:47-51,95-99` (only `artifactsDeletedAt` is written); `runs-table.tsx:162`; `en.ts:405-408` |
| D4 | The machine must be online. The button is disabled with "The machine is offline." otherwise; a removed machine cannot delete. | `run-playback.tsx:111,181-193`; `artifacts.service.ts:157-163,168-178` |
| D5 | The machine deletes only a run it reported itself, and only a folder that is a DemoFlow run folder (`runs/<id>/` holding a `result.json` of that run). Anything else is refused and the page says the machine no longer has the files. | `artifacts/index.ts:145-157,168-179`; `en.ts:402` |
| D6 | Deleting cannot be undone. It is not recorded on the site until the machine confirms; if the machine does not answer within 15 seconds the page says so and the run can be tried again. | `artifacts.service.ts:23,129-145`; `en.ts:396,401`; `apps/api/src/videos/runs.controller.ts:84-101` |
| D7 | The button shows only while the run has video formats and is not deleted yet. | `run-playback.tsx:58-69` |

## Acceptance criteria

- [ ] Line 7 of the Runner page no longer says that no jobs run over the
      connection.
- [ ] "Runs started from the website" states S1-S18, in the page's own words,
      and no fact outside the table.
- [ ] "Delete a run's files" states D1-D7 and says what is removed and what
      stays.
- [ ] `DEMOFLOW_NO_REPORT=1` is written with the value `1`; `CI` is written
      as "set" (S10).
- [ ] The page never promises a feature that is not shipped (no Run again,
      no progress inside a run, no options for a website run).
- [ ] Only `apps/web/src/app/docs/runner/page.mdx` changes. `bun run check`
      and `bun run build` are green. The PR body lists any fact in the table
      that no longer matches the code at merge time.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/src/app/docs/runner/page.mdx` | #279 | No other open issue touches it. |

## Open questions

None.

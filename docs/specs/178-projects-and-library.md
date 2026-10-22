# Projects and the demo library

Issue: [#178](https://github.com/AndreyBegma/DemoFlow/issues/178)
Depends on: nothing. It follows Runner pairing (#135, #151), which has landed.

## Summary

Roadmap, Phase 5, in order: sign-in, Runner pairing, **projects, demo
library**. The site shows which projects you record demos in and the runs of
each project.

Videos stay on the machine (ADR-0008). The site stores **metadata only**.
Playback goes through the relay, which is Phase 6 and out of scope.

The owner decided on 2026-10-22:

- A project is created both ways:
  - **automatically**, when a paired machine runs a scenario in a folder;
  - **manually** on the site.
- There is **one project per folder**. The key is the Runner plus the
  absolute path of the project root. A manual project bound to a folder and
  the automatic project for that folder are the same project.
- A manual project with no folder bound stays empty until one is bound.

## Scope

### In scope

- `apps/api`: `Project` and `Run` models and their migration, the projects
  and runs endpoints, and the run report endpoint for Runners.
- `apps/cli`: after `demoflow run`, report the run's metadata when this
  machine is paired.
- `apps/web`: `/app/projects` (list, create, rename, bind, delete) and
  `/app/projects/[id]` (the run library).

### Out of scope

- Playback and download through the relay (Phase 6).
- Teams and sharing.
- Uploading video.
- Editing scenarios on the site.

## Decisions

1. **Models** (migration `<timestamp>_projects_and_runs`):
   - `Project { id, userId → User (Cascade), name, runnerId? → Runner (SetNull),
     rootPath?, createdAt, updatedAt }`. It has
     `@@unique([runnerId, rootPath])`.
   - `Run { id, projectId → Project (Cascade), runnerId? → Runner (SetNull),
     scenarioName, scenarioPath (relative to root), status: 'passed' | 'failed',
     startedAt, durationMs, formats: string[], failedStep: Int?,
     cliVersion }`.
   - Nothing else is stored: no video, no frames, no step values (values can
     hold secrets).
2. **Project root.** The directory holding the project config, as
   `apps/cli/src/config/project.ts` resolves it. Without a config file, the
   scenario file's directory. The absolute path is sent as is.
3. **Reporting.** At the end of `demoflow run` (CLI, not the daemon), when
   `credentials.json` exists, the CLI calls `POST /runner/runs` with the
   Runner token. The body carries `rootPath`, the project name (the config's
   `name`, else the folder's basename), and the `Run` fields.
   - The API upserts the project by `(runnerId, rootPath)` and inserts the run.
   - There is a 2 s timeout. Every failure is silent, and the run's own output
     and exit code are untouched (the same rule as #166).
   - It is off when `DEMOFLOW_NO_REPORT=1` or `CI` is set. It is also off in
     `demoflow mcp` unless that run belongs to a paired machine: same rule.
4. **Manual projects.**
   - `POST /projects { name }` creates a project with no folder.
   - `PATCH /projects/:id { name?, runnerId?, rootPath? }` renames and binds.
   - Binding to a `(runnerId, rootPath)` that already has an automatic project
     **merges**: the runs move to the manual project, which keeps its name, and
     the automatic one is deleted. This is one transaction.
   - `DELETE /projects/:id` deletes the project and its runs.
5. **Listing.**
   - `GET /projects` returns the projects with their last run and run count,
     newest activity first.
   - `GET /projects/:id/runs` is paged (cursor, 50 per page), newest first.
   - Every endpoint is scoped to the session user. A project or Runner of
     another user is a 404.
6. **Web.**
   - Projects: a list. Each item shows the name, machine, path, last run
     status and its time.
   - Library: a table with these columns: scenario, status, when, duration,
     formats, failed step. Videos show a "plays in Phase 6" hint; no play
     button yet.
   - Content surfaces are readable, and glass is used only for chrome (vision
     §9). All strings go in `en.ts`, in their own block.
7. **Runner revoke.** When a Runner is revoked, its projects stay. `runnerId`
   is set to null, and the project shows "machine removed".

## Acceptance criteria

- API integration tests cover:
  - a report upserts the project and adds a run;
  - a second report from the same folder reuses it;
  - another folder creates another project;
  - binding a manual project merges the automatic one;
  - deletion cascades;
  - another user's ids return 404;
  - a revoked Runner's report is rejected;
  - #177's account deletion removes projects and runs (cascade).
- CLI tests cover:
  - a paired run reports once, with the right root and fields;
  - an unpaired run, `CI` or `DEMOFLOW_NO_REPORT` sends no report;
  - a failing or slow API changes neither output nor exit code.
- Web: the projects list, create/rename/bind/delete and the library table
  render and work against the API.
- `bun run check`, `bun run test` and `bun run build` are green, and so is
  the execution-plane matrix.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i178-api | models, migration, endpoints, report endpoint | apps/api/** | — | yes | opus |
| i178-cli | report after `demoflow run` | apps/cli/src/runs-report/**, apps/cli/src/commands/run.ts, apps/cli/test/** | i178-api | no | sonnet |
| i178-web | projects and library pages | apps/web/src/app/app/projects/**, apps/web/src/i18n/en.ts, apps/web/src/app/app/layout.tsx | i178-api | no | sonnet |

## Contention

| Resource | Owner | Others |
|---|---|---|
| apps/api/prisma/schema.prisma, migrations | i178-api | #177 adds no table. If it needs a migration, it names it `_account_deletion` |
| apps/web/src/i18n/en.ts | i178-web, #177, #179 | each adds its own block; merge the base before opening the PR |

## Open questions

None.

# Add a project from the website (API): machine, local path, GitHub link

Issue: [#378](https://github.com/AndreyBegma/DemoFlow/issues/378)
Depends on: #377 (the Runner's half of the protocol). It can be built against
[that spec](377-runner-allowed-roots-inspect-init.md)'s message table and
merged after it. Decided by
[ADR-0022](../adr/0022-projects-added-from-the-website.md).

## Summary

Today `POST /projects` creates a project from a name only, and a folder is
attached by hand with `PATCH /projects/:id` (`runnerId` + `rootPath`, spec 178
Decision 4) — which ADR-0016 §2 never trusts. This slice adds the website's
inspect → (initialise) → register flow: the API relays three live requests to
the chosen online machine, and creates the project only with the canonical
`rootPath` the Runner answered. Projects gain an optional GitHub URL and a
marker of how they were added.

## Scope

### In scope

- `apps/api/prisma/schema.prisma` + migration
  `apps/api/prisma/migrations/20261027150000_project_github_url/` (Data).
- `apps/api/src/projects/folders/**` (new): `FoldersService` (pending
  requests keyed by `requestId`, timeouts) and `FoldersController`
  (endpoints below), registered in `ProjectsModule`
  [Confirmed: `ProjectsModule` imports `RunnerModule`].
- `apps/api/src/projects/projects.service.ts`, `projects.dto.ts`,
  `projects.controller.ts`: `githubUrl` and `source` in `ProjectView`;
  `PATCH` accepts `githubUrl` [Confirmed: `ProjectView`, `UpdateProjectDto`,
  `PATH_MAX = 4096`].
- `apps/api/src/runner/runner-socket.ts`: the server messages
  `project.inspect | project.init | project.register` and the client DTOs
  `project.inspected | project.initialised | project.registered |
  project.error` in `CLIENT_MESSAGES`; `features` accepted on
  `launches.sync` if no earlier slice added it [Confirmed: `CLIENT_MESSAGES`
  record, `scenarios.list` server message].
- `apps/api/src/runner/runner-connections.service.ts`: routing of the new
  replies to `FoldersService`, and the machine's `features` exposed for the
  UI [Confirmed: `isOnline(runnerId)`].
- `apps/api/src/projects/**/*.spec.ts`, `*.integration.spec.ts`: tests.

### Out of scope

- The Runner (#377), the dialog (#379), docs (#380).
- Removing the bind-by-hand `PATCH` path (ADR-0022, Consequences).

## Decisions

1. **Endpoints** (all behind `SessionGuard`, JSON, `ValidationPipe`):

   | Method | Path | Body | Answer |
   |---|---|---|---|
   | POST | `/projects/folders/inspect` | `{ runnerId, path }` | `{ inspection }` (#377 Decision 5) |
   | POST | `/projects/folders/init` | `{ runnerId, path }` | `{ created, kept, inspection }` |
   | POST | `/projects/folders/register` | `{ runnerId, path, name?, githubUrl? }` | `201 { project }` |

   `path` 1–4096 chars (`PATH_MAX`); `name` 1–200 (`PROJECT_NAME_MAX`),
   default the inspection's `name`; `githubUrl` must match
   `^https://github\.com/[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$`,
   default the inspection's `githubUrl`.
2. **Ownership first.** Every endpoint resolves `runnerId` to a Runner of the
   session's user that is not revoked; otherwise `404 runner-not-found` —
   the same answer for "another user's machine" and "no such machine".
   *Source:* ADR-0006 tenancy; ADR-0007.
3. **Online and capable.** A machine that is not `isOnline`, or that did not
   announce `'projects'` in `features`, answers `409 runner-offline` /
   `409 runner-outdated` without sending anything. *Source:* ADR-0022 §6.
4. **Relay.** Each call sends one message with a fresh `requestId` and waits
   for the matching reply, at most **10 s** (`FOLDER_TIMEOUT_MS`, like
   `LIST_TIMEOUT_MS` in `launches.service.ts`) → `504 runner-timeout`.
   `project.error` codes map to `422` (`path-not-allowed`, `config-missing`,
   `config-invalid`), `409 busy`, `502 internal`. A reply whose `requestId`
   is unknown or belongs to another machine is dropped.
5. **Register creates the row from the Runner's answer.** On
   `project.registered`, the API creates `Project { userId, runnerId,
   rootPath: <answered canonical path>, name, githubUrl, source: website }`.
   The path the browser sent is never stored. An existing project with the
   same `(runnerId, rootPath)` of this user answers `409 project-exists` with
   its `id`; the `@@unique([runnerId, rootPath])` constraint backs it.
6. **Nothing is stored by inspect or init.** The inspection lives only in the
   HTTP answer (ADR-0016 §1 already: lists are read live).
7. **GitHub URL editable.** `PATCH /projects/:id` accepts `githubUrl` (same
   pattern) or `null` to clear it.
8. **Throttle.** The three endpoints share a per-user limit of 30 requests per
   minute (the existing `ThrottlerGuard` setup), so a hijacked session cannot
   scan the home directory quickly.

## Data / Schema

```prisma
enum ProjectSource {
  reported
  website
}

model Project {
  // … existing fields
  // https://github.com/<owner>/<repo>; display only (ADR-0022 §5).
  githubUrl String?
  source    ProjectSource @default(reported)
}
```

Migration `20261027150000_project_github_url`: `CREATE TYPE "ProjectSource"`,
`ALTER TABLE "Project" ADD COLUMN "githubUrl" TEXT, ADD COLUMN "source"
"ProjectSource" NOT NULL DEFAULT 'reported'`. No backfill.

## API

`ProjectView` gains `githubUrl: string | null` and `source: 'reported' |
'website'`. The run page and project list keep their shapes otherwise.

## Acceptance criteria

- [ ] `inspect`, `init` and `register` relay to the right machine and answer
      what the Runner answered; with the machine offline, `409 runner-offline`
      and no socket message is sent.
- [ ] **Authorization:** with user B's session, every endpoint given user A's
      `runnerId` answers `404 runner-not-found` and sends nothing to A's
      machine; `PATCH` of A's project by B answers 404; `GET /projects` of B
      never lists A's website-added projects.
- [ ] `register` stores the canonical `rootPath` from `project.registered`,
      not the request's `path` (test: request `~/app/../app`, Runner answers
      `/home/u/app`, row holds `/home/u/app`).
- [ ] Registering the same folder twice answers `409 project-exists` with the
      first project's id.
- [ ] `githubUrl` with another host or with credentials is rejected with 400.
- [ ] A reply for an unknown `requestId` is ignored; a silent Runner gives
      `504 runner-timeout` after 10 s (fake clock).
- [ ] `ProjectView` exposes `githubUrl` and `source`; existing projects read
      `source: 'reported'`.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i378-api | schema, migration, folders module, socket messages, view fields | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261027150000_project_github_url/**, apps/api/src/projects/**, apps/api/src/runner/runner-socket.ts, apps/api/src/runner/runner-connections.service.ts, apps/api/src/runner/runner-socket.fixtures.ts | #377 merged | yes | sonnet |

One slot: the column, the relay and the view are one reviewable change.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i378-api (alters `Project`) | #347 adds `Share`, #360 adds `Run.kind`, #362 adds `CheckSchedule`/`ScenarioHealth`; distinct tables/columns — keep both on conflict; migrations have distinct timestamps |
| apps/api/src/runner/runner-socket.ts | i378-api | #347, #356, #362 add messages; rebase, keep every `CLIENT_MESSAGES` entry and the shared `features` array |
| apps/api/src/runner/runner-connections.service.ts | i378-api | #347, #356, #362 add routing |
| apps/api/src/projects/projects.service.ts / dto | i378-api | #362 adds `staleCount`; append both |

## Risks

- **Scanning by a hijacked session** (medium): mitigated by the Runner's
  allowed roots (#377) and the throttle (Decision 8).
- **Merge order of schema slices** (low): migrations carry distinct
  timestamps; the later slice rebases.

## Open questions

- Should a website-added project be deletable without touching the Runner's
  `website-projects.jsonl`? Default: yes, deleting the row is enough; the
  stale local line is harmless because the server never names it again.

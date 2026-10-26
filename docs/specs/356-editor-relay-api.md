# Editor relay (API): edit model, save, re-render, progress, update a share

Issue: [#356](https://github.com/AndreyBegma/DemoFlow/issues/356)
Depends on #355 (the Runner's `edits.*` and `render.*` frames) and #347
(the `Share` model and the upload through the runner socket).

## Summary

The browser never talks to a Runner. This slice gives the run page's editor
(#357, #358) its HTTP API: read the edit model live from the run's machine,
save or reset the edits, get the export, start a re-render and follow it, and
replace a share's file with the new render. Nothing about a run's edits is
stored on the server (ADR-0020 §4); the only rows that change are the run's
`renders` and `stages` after a re-render, and a share's file after an update.

## Scope

### In scope

- `apps/api/src/editor/` (new module): `editor.controller.ts`,
  `editor.service.ts`, `editor.dto.ts`, `editor.integration.spec.ts`,
  registered in `apps/api/src/app.module.ts`.
- `apps/api/src/runner/runner-socket.ts`: the frames of #355 (types and
  class-validator messages), `features` on `launches.sync`.
- `apps/api/src/runner/runner-connections.service.ts`: routing the new
  answers to the editor service; keeping each connection's `features`.
- `apps/api/src/runner/runner-socket.fixtures.ts`: a fake Runner that answers
  the new frames.
- `apps/api/src/shares/`: one endpoint, `POST /shares/:id/update`, in the
  module #347 creates.

### Out of scope

- The website (#357, #358).
- Storing the edit model, the edits or a render history (ADR-0020 §4, §6).
- Uploading the new render automatically after a re-render (ADR-0020 §6,
  ADR-0008 §5).

## API

All endpoints need a session; the run is looked up with
`RunsService.find(userId, id)`, which matches `project: { userId }`
[Confirmed: `apps/api/src/videos/runs.service.ts`]. Another user's run, a
missing run, and a malformed id are all **404**, and nothing is sent to any
Runner.

| Method and path | Body | Answer |
|---|---|---|
| `GET /runs/:id/editor` | — | 200 `model` of #355 |
| `PUT /runs/:id/edits` | `{ edits }` | 204 |
| `DELETE /runs/:id/edits` | — | 204 (reset: `edits.save` with `null`) |
| `GET /runs/:id/edits/export` | — | 200 `{ scenarioPatch, config, notExportable }` |
| `POST /runs/:id/render` | `{ formats? }` | 202 `{ state: 'rendering' }` |
| `GET /runs/:id/render` | — | 200 `{ state: 'idle' \| 'rendering' \| 'finished' \| 'failed', percent: number \| null, error: string \| null }` |
| `POST /shares/:id/update` | — | 202; the share keeps its token, expiry and view count |

Errors, common to the run endpoints:

| Status, `error` | When |
|---|---|
| 409 `runner-offline` | the run's machine has no socket |
| 409 `runner-outdated` | its `launches.sync` did not announce `'edits'` |
| 410 `artifacts-deleted` | `run.artifactsDeletedAt` is set [Confirmed: the field and the 410 pattern in `runs.controller.ts`] |
| 422 with the Runner's code | `edits-invalid`, `too-large`, `run-unfinished`, `no-recording`, `scenario-changed` |
| 409 `busy` | the machine is already re-rendering |
| 504 `runner-timeout` | no answer in time (Decision 4) |
| 404 `run-not-found` | the Runner does not know the run (as `artifacts.delete`, spec 233) |

## Decisions

1. **Validation.** `PUT /runs/:id/edits` takes an `EditsDto` with
   class-validator decorators that mirror `RunEditsSchema`'s shape and
   bounds (`ValidateNested`, `ArrayMaxSize`, `MaxLength`, `IsInt`, `Min`),
   under the global `whitelist` and `forbidNonWhitelisted` pipe (CLAUDE.md).
   The Runner is the authority on everything that needs the timeline
   (`checkRunEdits`); its `edits-invalid` comes back as 422. *Why not import
   `RunEditsSchema`:* `apps/api` depends only on `@demoflow/shared`
   [Confirmed: `apps/api/package.json`]; the API already keeps its own copy of
   the format enum (`RUN_FORMATS`, `projects.dto.ts`) for the same reason.
   The request body is capped at 256 KiB.
2. **`formats`** on `POST /runs/:id/render` is validated exactly as on a
   launch (`RUN_FORMATS`, 1–9, unique; spec 325).
3. **After `render.finished`** the service writes the new `renders` and the
   `rendering` stage into the run row (`Run.renders`, `Run.stages`), so the
   run page and the library show the new sizes and durations
   [Confirmed: both are `Json?` columns, spec 263]. No migration. A
   `render.finished` whose `rendering` is `failed` sets `state: 'failed'` and
   leaves `renders` as they were.
4. **Timeouts** on the injected clock, swept like `artifacts.service.ts`
   [Confirmed: `DELETE_TIMEOUT_MS` and its sweep]: 30 s for `edits.get`
   (the Runner probes the source video, #355 Decision 2), 15 s for
   `edits.save` and `edits.export`, 30 s until `render.started`, and
   20 minutes until `render.finished` (above the daemon's 15-minute cap,
   spec 248).
5. **Render state is in memory**, one entry per run, like a launch
   (spec 247): `idle` until a render starts; kept after `finished` or
   `failed` until the next start or 10 minutes. A socket replaced while
   rendering marks it `failed` with `runner-disconnected`.
6. **The model is relayed, not shaped.** The API validates the model's
   envelope (sizes: at most 10,000 events, as `MAX_PROGRESS_STEPS`
   [Confirmed: `runner-socket.ts`], 200 captions) and passes it through. It is
   never logged and never written.
7. **Update a share.** `POST /shares/:id/update` checks that the share
   belongs to the user (404 otherwise), that its run's machine is online, and
   asks the Runner to upload the run's current file of the share's format
   through #347's upload flow. The new file replaces the old one only once
   the upload is complete; until then the link serves the old one. Token,
   expiry, password and view count are unchanged. The quota of #347 applies
   to the difference in size. [Unknown: #347's upload frame names; this slot
   uses them as #347 lands them.]

## Acceptance criteria

API integration tests with the fake Runner socket and a fake clock:

- [ ] **Authorization:** for a run of user B, user A gets 404 from every
      endpoint in the table (`GET editor`, `PUT`/`DELETE edits`, `GET export`,
      `POST`/`GET render`), and the fake Runner of user B receives no frame;
      `POST /shares/:id/update` on B's share is 404 for A.
- [ ] `GET /runs/:id/editor` sends `edits.get { requestId, runId }` and
      returns the Runner's model unchanged; offline → 409 `runner-offline`; a
      machine without `features: ['edits']` → 409 `runner-outdated`; no
      answer in 30 s → 504.
- [ ] `PUT /runs/:id/edits` with a valid body sends `edits.save` with that
      object; an unknown key, 201 captions, a 121-character caption, or a
      body over 256 KiB is 400 and sends nothing; the Runner's
      `edits-invalid` is 422.
- [ ] `DELETE /runs/:id/edits` sends `edits.save` with `edits: null`.
- [ ] `POST /runs/:id/render` → 202, then `GET` shows `rendering` with the
      latest `percent`; `render.finished` updates `Run.renders` and
      `stages.rendering` and `GET` shows `finished`; the Runner's `busy` is
      409.
- [ ] A run with `artifactsDeletedAt` is 410 on every run endpoint.
- [ ] `POST /shares/:id/update` keeps the share's token, `expiresAt` and
      view count, and serves the new file only after the upload completed.
- [ ] `parseClientMessage` accepts the new answers and rejects malformed ones
      (`runner-socket.spec.ts`).
- [ ] Existing runner socket, launches, artifacts, video and share tests are
      green; `bun run check`, `bun run test`, `bun run build` are green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i356-editor | the editor module and the socket frames | apps/api/src/editor/**, apps/api/src/app.module.ts, apps/api/src/runner/runner-socket.ts, apps/api/src/runner/runner-socket.spec.ts, apps/api/src/runner/runner-connections.service.ts, apps/api/src/runner/runner-socket.fixtures.ts | #355 merged | yes | sonnet |
| i356-share-update | `POST /shares/:id/update` | apps/api/src/shares/** (the update endpoint and its test only) | i356-editor, #347 merged | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| `apps/api/src/runner/runner-socket.ts`, `runner-connections.service.ts`, `runner-socket.fixtures.ts` | i356-editor | #347 (share upload frames) and #362 (scheduled check runs) also add frames and routing: whichever lands second rebases. `features` on `launches.sync` is one shared array. |
| `apps/api/src/app.module.ts` | i356-editor | #347 and #362 add their modules: one line each. |
| `apps/api/src/shares/**` | #347 | i356-share-update adds one endpoint after it merges. |
| `apps/api/prisma/schema.prisma` | nobody here | #347 and #362 change it; this issue needs no migration. |

## Risks

- **Medium — the model is large for a long run.** Mitigation: the size caps
  of Decision 6; a run over 10,000 steps is refused by the Runner already
  (`MAX_PROGRESS_STEPS`).
- **Low — the DTO and `RunEditsSchema` drift.** Mitigation: an integration
  test sends the fixtures of `packages/core/test/edits.spec.ts`'s valid
  cases through the DTO.

## Open questions

- Should a re-render be possible while a website-started run of the same
  project is running? Default: yes; the daemon's `busy` covers only
  re-renders, and runs and renders are separate children.

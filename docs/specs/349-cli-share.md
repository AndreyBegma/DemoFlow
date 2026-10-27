# The runner uploads a render for a share; `demoflow share` and the MCP `share_demo` tool

Issue: [#349](https://github.com/AndreyBegma/DemoFlow/issues/349)
Depends on: #347. Implements [ADR-0019](../adr/0019-opt-in-share-links.md) §2, §3, §6, §7.

## Summary

#347 defines how the API pulls a shared file: `share.prepare`, then a
poster stream and the render's stream over the runner socket. This slice is
the machine's side. The daemon announces `share`, answers `share.prepare`
with the scenario's description, the render's chapters and a poster it makes
with FFmpeg, and serves the poster through the relay. The renderer starts
writing chapters into `result.json` so there is something to answer with.
On top of that, `demoflow share <runId>` creates a share from the terminal,
and the MCP server gains `share_demo`, refused unless the project's committed
config says `share.allowMcp: true`.

## Scope

### In scope

- `packages/core/src/run-result.ts`: optional `chapters` on
  `RenderOutputSchema`.
- `packages/core/src/project-config.ts`: the optional `share` block;
  `packages/core/schemas/project-config.schema.json` regenerated with
  `bun run --filter @demoflow/core schema` (`scripts/generate-schemas.ts`
  [Confirmed]).
- `packages/renderer/src/renderer.ts` (and the plan code that knows the
  placed scene cards): write `chapters` per render.
- `apps/cli/src/runner/connection.ts`: `features: ['share']` in
  `launches.sync`; route `share.prepare`.
- `apps/cli/src/runner/share/` (new): `prepare.ts` (description, chapters,
  poster), `poster.ts` (FFmpeg).
- `apps/cli/src/runner/relay/index.ts`: serve `asset: 'poster'`.
- `apps/cli/src/commands/share.ts` (new) and `apps/cli/src/main.ts`: the
  `share` command.
- `apps/cli/src/mcp/server.ts` (and `tasks.ts` / `project.ts` as needed):
  `share_demo`.
- `apps/cli/test/**`: tests, Vitest under Node.
- `apps/cli/README.md`: the command, the tool and `share.allowMcp`.

### Out of scope

- The API (#347, #348) and the website (#350–#352).
- Website docs pages (#352).
- Re-uploading after a re-render (#356).

## Decisions

1. **Chapters are written at render time.** `RenderOutputSchema` gains
   `chapters: z.array(z.strictObject({ title: NonEmptyString ≤ 200, atMs:
   int ≥ 0 })).max(100).optional()`. The renderer fills it for every render
   from the scene cards the plan placed — the scenario's `scene` markers and
   the page's scenes (ADR-0014) alike — with each card's start in **output**
   time. A run rendered before this slice has no `chapters`; its share has
   none. [Unknown: which plan value carries the placed cards to
   `recordRender`; `packages/renderer/src/plan/cards.ts` places them
   (`PlacedCard`, kind `scene` [Confirmed]).]
   - *Why in `result.json`:* the output time of a scene depends on cards,
     cuts and idle trimming; the renderer is the only place that knows it,
     and recomputing a plan at share time would use today's config, not the
     render's.
2. **`share.prepare` on the daemon.** `{ requestId, runId, format }`, with
   `runId` the server's id, looked up with `findReportedRun`
   (`apps/cli/src/runs-report/reported-runs.ts` [Confirmed]) exactly as the
   relay does. Then:
   - no entry, no `result.json` that parses, or no render of `format` whose
     file exists → `share.error { code: 'not-found' | 'no-render' }`;
   - `description`: the scenario's, read from `<entry.root>/<scenarioId>` the
     way `demoflow render` reads it (spec 255, Decision 3 [Confirmed:
     `apps/cli/src/commands/render.ts`]); absent when the file is gone or does
     not load;
   - `chapters`: the render's `chapters`, or `[]`;
   - the poster (Decision 3); its size is `posterSize`.
   - Answer `share.prepared { requestId, description?, chapters, posterSize }`.
     Only these fields; never a path. FFmpeg failing → `share.error { code:
     'io' }`.
3. **Poster.** One JPEG frame of the render at `min(1500, ⌊durationMs / 2⌋)`
   ms, scaled to at most 1280 px wide keeping the aspect, `-q:v 4`, written to
   `<runDir>/share/poster-<format>.jpg` and reused while it is newer than the
   render's file. FFmpeg is the renderer's (`resolveFfmpeg` / `runFfmpeg`,
   exported from `@demoflow/renderer` [Confirmed]). A poster over 1 MB is
   `io`. GIF renders get a poster too.
4. **`asset: 'poster'` on `video.open`.** The relay serves
   `<runDir>/share/poster-<format>.jpg` for it, with the same checks as a
   render (the run is reported, the format is a `RENDER_FORMATS` member) and
   the same chunking and credit. An unknown `asset` value is `not-found`.
5. **Capability.** `launches.sync` carries `features: ['share']` (#347,
   Decision 6).
6. **`demoflow share`.**

   ```
   demoflow share <runId> [--format <format>] [--expires <7|30|90>] [--password] [--json]
   ```

   plus a hidden `--project <dir>`, like `render`.
   - `<runId>` is the local run id, resolved to a run directory as `demoflow
     render` does (spec 255, Decisions 1–2 [Confirmed]); the server id comes
     from the reported-runs index by run directory
     (`readReportedRunsByDir` [Confirmed]).
   - `--format` defaults to the run's first render; `--expires` to 30.
   - `--password` asks for it without echo on a terminal; without a terminal
     it reads `DEMOFLOW_SHARE_PASSWORD`. A password is never a flag value
     (shell history).
   - It calls `POST /runner/shares` with the stored device token, then polls
     `GET /runner/shares/:id` every second for up to 10 minutes, printing
     progress on stderr, and prints the link (and the file link when there is
     no password). `--json` prints the `ShareView`.
   - Refusals are `CommandError`s, exit 2: `not-logged-in` (no credentials:
     "run demoflow login"), `run-not-found`, `run-not-reported` (the run was
     made signed out or with reporting off), `format-not-rendered`,
     `runner-offline` ("start the runner: demoflow runner start"),
     `runner-outdated` ("restart the runner"), `file-too-large`,
     `quota-exceeded` (with used and limit). `share-exists` is not an error:
     it prints the existing link and says so. An upload that ends `failed`
     exits 1 with its `failure`.
7. **`share_demo` (MCP).** Input `{ runId, format?, expiresInDays? }`, no
   password. It does what `demoflow share` does and returns `{ shareId, url,
   fileUrl, expiresAt }`. **Refused with `share-not-allowed`** unless the
   `demoflow.config.json` of the run's project root has `share.allowMcp:
   true`. The root is the reported run's `root` [Confirmed: `ReportedRun.root`];
   a run without one is refused the same way. [Source: owner, Q12; ADR-0019 §6]
8. **Config.** `share: z.strictObject({ allowMcp: z.boolean().default(false)
   }).optional()` on `ProjectConfigSchema`, with a description that says the
   MCP server may then publish videos outside the machine without asking.

## Acceptance criteria

- [ ] A fresh run's `result.json` has `chapters` on each render, one per scene
      card, in output milliseconds; a run with no scenes has `chapters: []`;
      an old `result.json` without the field still parses.
- [ ] The daemon's first frame carries `features: ['share']`.
- [ ] Given a reported run with an `mp4` render, `share.prepare` answers
      `share.prepared` with the scenario's description, the render's chapters
      and the poster's size; the poster is a JPEG ≤ 1280 px wide.
- [ ] `share.prepare` for an unreported run, a missing render file or an
      unrendered format answers `share.error` with `not-found` / `no-render`,
      and never reads outside the runs directory.
- [ ] `video.open` with `asset: 'poster'` streams exactly the poster file.
- [ ] `demoflow share <runId>` against a fake API prints the link once the
      share is `ready`; each refusal of Decision 6 exits 2 with its code;
      `--password` never appears in the process arguments of the request.
- [ ] `share_demo` answers `share-not-allowed` without `share.allowMcp: true`
      and creates the share with it.
- [ ] `project-config.schema.json` is regenerated and `share.allowMcp`
      validates in an editor.
- [ ] Tests pass under Node with Vitest on Linux, macOS and Windows
      (`execution-plane.yml`).

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i349-core | chapters and the config block | packages/core/src/run-result.ts, packages/core/src/project-config.ts, packages/core/schemas/project-config.schema.json, packages/core/test/**, packages/renderer/src/renderer.ts, packages/renderer/src/plan/**, packages/renderer/test/** | — | yes | opus |
| i349-cli | daemon, relay, command, MCP | apps/cli/src/runner/connection.ts, apps/cli/src/runner/share/**, apps/cli/src/runner/relay/index.ts, apps/cli/src/commands/share.ts, apps/cli/src/main.ts, apps/cli/src/mcp/**, apps/cli/test/**, apps/cli/README.md | i349-core | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/core/src/project-config.ts, packages/core/schemas/project-config.schema.json | i349-core | #361 (`schedule`) and #365 (`render.endHoldMs`) also add keys: one at a time, regenerate the schema each time |
| packages/core/src/run-result.ts | i349-core | #353/#354 or #360 may touch it; cut after this merges |
| packages/renderer/src/renderer.ts, packages/renderer/src/plan/** | i349-core | #353, #354, #365 edit the plan; serialize |
| apps/cli/src/runner/connection.ts | i349-cli | #355 and #361 route new messages; serialize |
| apps/cli/src/main.ts | i349-cli | #360 adds `--check`; serialize |
| apps/cli/src/mcp/server.ts | i349-cli | do not open it |

## Risks

- **Chapters wrong after idle trimming** (medium). A scene placed in a
  trimmed span. Mitigation: take the time after the time map, from the same
  placed card the compositor draws; a test with a trimmed pause.
- **FFmpeg seek on GIF** (low). Mitigation: decode from the start for GIF
  (`-ss` after `-i`); a test per container.
- **An agent shares a video with customer data** (medium). Mitigation: the
  config flag is off by default and lives in a reviewed commit (ADR-0019 §6).

## Open questions

- A password for `share_demo` — default: none; an agent should not hold one.
- Auto-starting the daemon when `demoflow share` finds it offline — default:
  no; print the command.

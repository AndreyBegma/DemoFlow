# The Runner serves and saves a run's edits, re-renders on request, and exports patches

Issue: [#355](https://github.com/AndreyBegma/DemoFlow/issues/355)
Depends on #353 (`RunEditsSchema`, `checkRunEdits`, the renderer applying
edits). Works with #354 when it has landed (trim and cuts are part of the
schema then); nothing here depends on it.

## Summary

[ADR-0020](../adr/0020-edits-from-the-website.md) §3 lets the website read and
write a reported run's edits and ask the Runner to re-render it; §4 says what
the edit model carries; §5 makes export a patch the person applies. This slice
is the machine side: four new socket requests in the daemon, a `--progress`
flag on `demoflow render`, and a new `demoflow edits apply <runId>` command.
The API relay is #356.

## Scope

### In scope

- `apps/cli/src/runner/edits/` (new): the handler of `edits.get`,
  `edits.save`, `edits.export` and `render.start`; the edit model builder; the
  patch builder.
- `apps/cli/src/runner/connection.ts`: routes the new message types to the
  handler; `launches.sync` announces `features: ['edits']`.
- `apps/cli/src/runner/daemon.ts`: wires the handler [Confirmed: the daemon
  builds `relay`, `artifacts` and `launches` deps for the connection].
- `apps/cli/src/commands/render.ts` and `apps/cli/src/main.ts`:
  `demoflow render --progress`.
- `apps/cli/src/commands/edits.ts` (new) and `apps/cli/src/main.ts`:
  `demoflow edits apply <runId> [--dry-run] [--config]`.
- `apps/cli/test/**`: tests (Vitest under Node).
- `apps/cli/README.md` and `apps/web/src/app/docs/cli/page.mdx`: the two
  command changes.

### Out of scope

- The API and the website (#356, #357, #358).
- Uploading a new render to a share (#356 asks; the upload itself is #349's
  `share` handler).
- An MCP tool for edits. No source asks for one.
- Cancelling a re-render. A render is bounded (Decision 7).

## Protocol

New frames on the runner socket (spec 247's framing). Times are timeline ms.

| Direction | Message | Answer |
|---|---|---|
| API → Runner | `{ type: 'edits.get', requestId, runId }` | `{ type: 'edits.model', requestId, model }` or `edits.error` |
| API → Runner | `{ type: 'edits.save', requestId, runId, edits: RunEdits \| null }` | `{ type: 'edits.saved', requestId }` or `edits.error` |
| API → Runner | `{ type: 'edits.export', requestId, runId }` | `{ type: 'edits.exported', requestId, scenarioPatch, config, notExportable }` or `edits.error` |
| API → Runner | `{ type: 'render.start', requestId, runId, formats? }` | `{ type: 'render.started', requestId }`, then any number of `{ type: 'render.progress', requestId, percent? }`, then `{ type: 'render.finished', requestId, rendering, renders }`; or `{ type: 'render.error', requestId, code }` instead of `render.started` |
| Runner → API | `{ type: 'edits.error', requestId, code }` | — |
| Runner → API | `launches.sync` gains `features?: string[]` | this daemon sends `['edits']` |

- **`model`** (ADR-0020 §4):
  ```ts
  {
    runId, scenarioName, description: string | null,
    failed: boolean, failedStepIndex: number | null,
    durationMs,                       // the timeline's range the editor may use
    events: Array<{ stepIndex, action, startMs, endMs,
                    box: Box | null, zoom: boolean | number | null,
                    caption: string | null, scene: string | null }>,
    pageCaptions: Array<{ atMs, title }>, pageScenes: Array<{ atMs, title }>,
    style: { background, frame, cards },   // the resolved render.* the next render uses, without edits
    edits: RunEdits | null,
    timeMap: Array<{ outputStartMs, outputEndMs, timelineStartMs, timelineEndMs }>,
    renders: Array<{ format, width, height, sizeBytes, durationMs }>,
  }
  ```
  `timeMap` is the current render's map from output time back to timeline
  time, so the browser can draw over the video it plays (#357). Segments with
  no timeline span are cards.
- **`edits: null`** on `edits.save` deletes `edits.json` (ADR-0020 §6,
  "reset").
- **`scenarioPatch`**: an RFC 6902 array of `add`, `replace` and `remove`
  operations whose paths are only `/steps/<n>/caption` and `/steps/<n>/zoom`
  (ADR-0020 §5). **`config`**: `{ render: { background?, frame?, cards? } }`,
  the style edits as a `demoflow.config.json` fragment. **`notExportable`**:
  `Array<{ kind: 'caption' | 'zoom' | 'trim' | 'cut' | 'card', at?: number, reason }>`.
- **`formats`** on `render.start`: as `run.start`'s (ADR-0017), 1 to 9
  members of `RENDER_FORMATS`; absent means the formats of the current render.
- **`rendering`** is the `rendering` stage status after the render;
  **`renders`** the new `renders[]` of `result.json`, in the run report's
  shape (spec 263) [Confirmed: the shape of `Run.renders`].
- **Error codes:** `run-not-found` (not in `reported-runs.jsonl`, or its
  directory is gone), `run-unfinished`, `no-recording` (as `demoflow render`,
  spec 255), `edits-invalid` (schema or `checkRunEdits` issues; the first
  issue's path in the message), `too-large` (an `edits` over 256 KiB),
  `busy` (a re-render is already running on this machine), `failed` (any
  other error, logged locally).

## Decisions

1. **A run is found as `artifacts.delete` finds it** (spec 233): by `runId`
   in the daemon's `reported-runs.jsonl`, which gives the canonical root and
   the run directory [Confirmed: `apps/cli/src/runner/artifacts/index.ts`
   reads `indexFile`]. A run id that fails `assertSafeRunId` is
   `run-not-found`. Nothing outside that run directory and its project's
   scenario file and config is read; nothing outside the run directory is
   written by a socket request.
2. **The model is built on request, never cached.** The daemon reads
   `timeline.json`, `result.json`, `edits.json`, the project's
   `demoflow.config.json` and the scenario's `description` (from the scenario
   file, as `demoflow render` reads it, spec 255 Decision 3), and builds the
   current plan with `buildRenderPlan` to get `timeMap` [Confirmed:
   `RenderPlan.timeMap` in `packages/renderer/src/plan/types.ts`]. Fields
   ADR-0008 §2 forbids are never in it: no `value`, no `screenshot`, no
   `pointer`, no `scroll`, no locator, no URL. The builder is a pure function
   of those inputs with a test that the model of a run with a masked `fill`
   contains neither its value nor `***`.
3. **Save validates, then writes atomically.** `edits.save` parses with
   `RunEditsSchema`, runs `checkRunEdits` against the run's timeline and
   result, writes `edits.json.tmp` and renames it over `edits.json`.
4. **Re-render is `demoflow render` as a child**, spawned like a website run
   (spec 248): `render <runId> --json --progress --project <root>`, plus a
   `--format` per entry of `formats`. Its progress lines become
   `render.progress`; its JSON result becomes `render.finished`.
   *Why a child:* the daemon never loads the renderer in its own process
   [Confirmed: the daemon does not import `@demoflow/renderer`; runs are
   children], and a crash stays in the child.
5. **`demoflow render --progress`** prints the progress lines of
   `demoflow run --progress` (spec 302) for the `rendering` phase only, with
   `percent` when the renderer can tell [Unknown: whether the FFmpeg
   renderer exposes frame progress; without it, one line at the start and
   one at the end].
6. **Export maps the timeline back to the authored scenario.**
   - A step's `zoom` edit becomes an op on `/steps/<n>/zoom` when expanded
     step `stepIndex` came from top-level step `n` with no `repeat` or
     `include` in between; otherwise `notExportable` with
     `reason: 'from-repeat'` or `'from-include'`. [Unknown: `ExpandedStep`
     carries `origin` for `repeat` only and no top-level index; the slot
     computes the index by walking the authored steps of `scenario.json` in
     the run directory.]
   - A caption becomes the `caption` of a step when its `startMs` is within
     100 ms of that step's event `startMs` and that step is exportable;
     a removed caption of an exportable step becomes `remove`; anything else
     (a free-timed caption, a page caption) is `notExportable`.
   - `trim` and `cuts` are always `notExportable` (`reason: 'not-in-scenario'`).
   - The patch is built against `scenario.json` of the run directory, and the
     daemon refuses with `edits-invalid` (message `scenario-changed`) when the
     scenario file on disk no longer has the same steps (compared by action
     and locator), so a patch never lands on the wrong step.
7. **Bounds.** One re-render at a time per machine (`busy`), the daemon's
   15-minute cap per child (spec 248, Decision 9), and the formats allowed by
   ADR-0017.
8. **`demoflow edits apply <runId>`** reads `edits.json` of the run in the
   resolved home, builds the same patch, and applies it to the scenario file
   under the project root; with `--config`, it also merges the `render`
   fragment into `demoflow.config.json`. It writes JSON with two-space
   indentation and a trailing newline, and prints a unified diff of each
   file. `--dry-run` prints the diffs and writes nothing. Exit 2 with
   `scenario-changed` under Decision 6's condition. It needs no account.

## Acceptance criteria

Vitest under Node, a fake socket and temporary run directories:

- [ ] `edits.get` for a reported run returns a model whose `events` match
      `timeline.json`, whose `edits` is `null` without a file, and that
      contains no `value`, `pointer`, `scroll`, `screenshot` or URL key
      anywhere (recursive key scan) for the fixture run with a masked fill.
- [ ] `edits.get` for an unknown id, a `../x` id, and a reported run whose
      directory is gone is `run-not-found`.
- [ ] `edits.save` with a valid object writes `edits.json`; with `null`
      deletes it; with an unknown key, a `zoom-no-target` entry, or 300 KiB is
      `edits-invalid` / `too-large` and leaves the previous file untouched.
- [ ] `render.start` spawns `render <runId> --json --progress --project <root>`
      (and `--format gif` for `formats: ['gif']`), sends `render.started`, at
      least one `render.progress`, and `render.finished` with the child's
      `renders`; a second `render.start` meanwhile is `busy`.
- [ ] `edits.export`: a zoom edit on a top-level step gives one `replace` (or
      `add`) at `/steps/<n>/zoom`; one on a step from a `repeat` is
      `notExportable` `from-repeat`; a cut is `not-in-scenario`; a changed
      scenario file is `scenario-changed`.
- [ ] `launches.sync` carries `features: ['edits']`.
- [ ] `demoflow edits apply <runId> --dry-run` prints a diff and changes no
      file; without `--dry-run` the scenario file has the new caption and
      zoom and still parses with `parseScenario`; `--config` adds the
      background to `demoflow.config.json`.
- [ ] `demoflow render <runId>` on a run with `edits.json` renders the
      edited plan (the plan builder receives the run directory; the edits are
      read by #353's code).
- [ ] `bun run check` and the CLI Vitest suite are green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i355-daemon | the socket handler, model and patch builders | apps/cli/src/runner/edits/**, apps/cli/src/runner/connection.ts, apps/cli/src/runner/daemon.ts, apps/cli/test/runner/edits/** | #353 | yes | opus |
| i355-commands | `render --progress`, `edits apply` | apps/cli/src/commands/render.ts, apps/cli/src/commands/edits.ts, apps/cli/src/main.ts, apps/cli/test/commands/**, apps/cli/README.md, apps/web/src/app/docs/cli/page.mdx | i355-daemon (the patch builder) | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| `apps/cli/src/runner/connection.ts` (message routing, `launches.sync`) | i355-daemon | #349 (share upload) adds `share.*` routing and likely a `features` entry; #361 (schedule) may add a frame too. Whichever lands second rebases; the `features` array is shared: each issue appends its own string. |
| `apps/cli/src/main.ts` | i355-commands | #349 (`demoflow share`) and #360 (`run --check`) add commands/flags: append-only, rebase. |
| `apps/web/src/app/docs/cli/page.mdx` | i355-commands | #352, #360 and #361 docs touch it: rebase. |

## Risks

- **High — a field that must not cross leaks into the model.** Mitigation:
  the model is built field by field from an allow-list (Decision 2), with
  the recursive key-scan test.
- **Medium — the patch lands on the wrong step.** Mitigation: the
  `scenario-changed` guard (Decision 6) and building against the run's own
  `scenario.json`.
- **Medium — `edits apply` reformats a hand-formatted scenario.**
  Mitigation: the diff is printed first and `--dry-run` exists; formatting
  preservation is an open question.

## Open questions

- Preserve the scenario file's formatting on `edits apply`? Default: no;
  rewrite with two-space JSON and say so in the docs.

# `demoflow render`: render an existing run again

Issue: [#255](https://github.com/AndreyBegma/DemoFlow/issues/255)
Depends on: nothing.

## Summary

[ADR-0004](../adr/0004-recording-is-separate-from-rendering.md) keeps
recording apart from rendering so that "the same source must be renderable
again in another style without rerunning the scenario". Its Consequences say
"Rendering can be retried or restyled from `runs/<runId>/` alone". Vision §12
asks the same: "allow rendering to be retried from existing source artifacts
without rerunning a successful browser scenario".

The pieces exist: `buildRenderPlan(runDir, options)` reads only the run
directory, and the renderer's `recordRender` replaces `renders[]` and the
`rendering` stage of `result.json`. No command calls them on an existing
run. Today a new background, a GIF after the fact, or a retry after a render
crash means running the scenario again, with the app, the browser and its
timing.

This slice adds `demoflow render <runId>`.

## Scope

### In scope

- `apps/cli/src/commands/render.ts` (new): `renderCommand`.
- `apps/cli/src/main.ts`: the `render` command and its flags.
- `apps/cli/src/config/project.ts` and `apps/cli/src/record/command.ts`:
  `projectRootAbove` moves from the second to the first (Decision 2).
- `apps/cli/test/**`: its tests (Vitest under Node).
- `apps/cli/README.md` and `apps/web/src/app/docs/cli/page.mdx`: the
  command.

### Out of scope

- An MCP tool for it. No source asks for one.
- Reporting the re-render to the website (Decision 7).
- Any change to `packages/**`: the plan and the renderer are used as they
  are.
- Deleting render files of formats the new render does not write
  (Decision 6).
- Re-rendering from the website: ADR-0008 §3 lists exactly what the website
  may make a Runner do, and this is not on it.

## Decisions

1. **Command.**
   `demoflow render <runId> [--format <format>]... [--out <dir>] [--json]`,
   plus a hidden `--project <dir>` like `run` and `record`.
   - `<runId>` is the run directory's name, the `runId` of `result.json` and
     of the MCP answers. It passes `assertSafeRunId` first.
   - *Why a run id, not a path:* runs live under the resolved home
     (ADR-0004 §7). A path would let the command write `result.json` in any
     directory; the id keeps it inside `<home>/runs/`.
2. **Project and home.** The project root is found upwards from the current
   directory, or is `projectRootAt(--project)`, exactly as `demoflow record`
   resolves it. Its private `projectRootAbove` moves to
   `apps/cli/src/config/project.ts`, exported, and both commands use it. The config is
   `loadProjectConfig(root)`. The home is `resolveHome` with the same inputs
   as `runCommand` (`--out`, `DEMOFLOW_HOME`, project config, global config,
   OS default). The run directory is `runDir(home, runId, platform)` from `../config`
   (imported as `runDirFor` in `run.ts`).
3. **Style.** The plan is built with the project's **current** `render.*`:
   the same options object `runCommand` passes to `buildRenderPlan`, with
   `formats: flags.format ?? config.render.formats`.
   - *Why:* restyling is the reason ADR-0004 gives. A render that copied the
     old settings would only be a retry, and a retry with unchanged config is
     the same call.
   - The intro card's subtitle is the scenario's `description`. It is read
     from `<root>/<result.scenarioId>` when that file exists and loads;
     otherwise the card has no subtitle. The card's title is
     `result.scenarioName`, which the plan already reads. An MCP inline
     scenario (deleted after its run) renders without a subtitle.
4. **Refusals.** Each is a `CommandError`, exit 2, before anything is
   written:
   - `invalid-run-id`: the id fails `assertSafeRunId`;
   - `run-not-found`: the run directory does not exist;
   - `invalid-result`: `result.json` is missing or fails `RunResultSchema`;
   - `run-unfinished`: any of `readiness`, `execution`, `verification`,
     `recording` is `pending` or `running`;
   - `no-recording`: `recording` is not `passed`, or the source video
     (`RUN_FILES.video`) is missing.
   - A `rendering` stage left `running` by a crashed render is **not**
     refused: retrying that render is the point of the command.
   - *Why no lock:* a second `render` of the same run at the same time is a
     person's own action on their own machine; the capture stages check stops
     the case that matters, a run still in progress.
5. **Verdict.** Only `renders[]` and the `rendering` stage change, through
   `ffmpegRenderer.render(runDir, plan)` (which calls `recordRender`); then
   `settleRun(runDir)` derives the status again. Readiness, execution,
   verification and recording are never touched, so a failed run stays
   `failed` and keeps its failure card and watermark (ADR-0004 §3–4).
6. **Old files.** `recordRender` replaces every earlier `renders[]` entry of
   the `ffmpeg` renderer. A file of a format this render does not write
   stays on disk but is no longer listed, so nothing claims it (vision §7);
   playback through the relay looks formats up in `renders[]` and answers
   `not-found` for it.
   - *Why not delete it:* deleting files is the riskier choice and no source
     asks for it; a later render that asks for the format writes it again.
7. **No website report.** `demoflow render` does not call `POST /runner/runs`.
   - *Why:* that endpoint inserts a run (spec 178, Decision 3), so a report
     would duplicate the run in the library. Updating a reported run needs a
     new endpoint no source asks for. The library row keeps the formats of
     the original run; the run page's playback reads `renders[]` on the
     machine and shows what exists.
8. **Output and exit code.** Like `demoflow run`: `Rendering` on stderr, then
   `formatSummary` or, with `--json`, `formatJson` on stdout, and
   `exitCodeFor(result)`. A render error is printed as
   `rendering failed: <reason>` and the exit code is 3 even if the derived
   status would give 0 (the same guard as `runCommand`).
9. **Testability.** `renderCommand(runId, flags, io, deps)` takes
   `RenderDeps { host, cwd, buildPlan, renderer }`, defaulting to
   `buildRenderPlan` and `ffmpegRenderer`, so tests use fakes and need no
   FFmpeg.
10. **Docs.** `apps/cli/README.md` and `/docs/cli` gain a `demoflow render`
    section: what it does, the flags, that the verdict never changes, that
    the website is not told (Decision 7).

## Acceptance criteria

Vitest under Node, a temporary home with a fixture run directory
(`result.json`, `timeline.json`, an empty source video file), fake
`buildPlan` and `renderer`:

- [ ] A finished run is re-rendered: `buildPlan` receives the run directory
      and the current config's options; `--format gif` replaces the formats;
      the fake renderer is called once; stdout has the summary (or one JSON
      object with `--json`); exit code follows `exitCodeFor`.
- [ ] A failed run (verification `failed`, recording `passed`) is
      re-rendered and keeps status `failed`; its other stages are byte-equal
      before and after.
- [ ] Each refusal of Decision 4 exits 2 with its code and leaves
      `result.json` unchanged; a run with `rendering: running` is accepted.
- [ ] A renderer that rejects gives exit 3 and `rendering failed:` on
      stderr.
- [ ] The scenario's `description` reaches the plan when the file exists,
      and is absent when it does not.
- [ ] No HTTP request is made (no report).
- [ ] `demoflow render --help` lists the flags; README and `/docs/cli`
      describe the command.
- [ ] `bun run check`, `bun run test`, `bun run build` and the
      execution-plane OS matrix are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/cli/src/commands/render.ts`, `apps/cli/test/**` (new tests) | #255 | No other open issue touches `apps/cli`. |
| `apps/cli/src/main.ts`, `apps/cli/src/config/project.ts`, `apps/cli/src/record/command.ts` | #255 | No other open issue. |
| `apps/web/src/app/docs/cli/page.mdx` | #254 (the `--format` row) | #255 adds a new section; different lines. Whichever merges second rebases. |

## Open questions

None.

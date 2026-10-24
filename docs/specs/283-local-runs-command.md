# `demoflow runs`: list, delete and prune local runs

Issue: [#283](https://github.com/AndreyBegma/DemoFlow/issues/283)
Depends on: nothing.

## Summary

Every `demoflow run`, MCP task and website-started run writes a directory
`<home>/runs/<runId>/` (ADR-0004 §7, `runDir` in
`apps/cli/src/config/home.ts`). Nothing removes them locally. Cancelled,
timed-out and crashed runs leave partial directories by design (spec
[248](248-runner-starts-runs.md), Decision 8: "the local user can remove
`<home>/runs/<id>/`"), and the website can only delete runs it was told about
(spec [234](234-runner-deletes-artifacts.md)). Today the only way to reclaim
the space is a file manager.

This slice adds `demoflow runs list`, `demoflow runs delete <id…>` and
`demoflow runs prune`, the first local command that removes files. It is
built to delete less rather than more.

## Scope

### In scope

- `apps/cli/src/commands/runs.ts` (new): `registerRunsCommands`,
  `runsListCommand`, `runsDeleteCommand`, `runsPruneCommand`.
- `apps/cli/src/commands/runs-scan.ts` (new): reading `<home>/runs/` into
  `LocalRun` records (Decision 3) and the duration parser (Decision 7).
- `apps/cli/src/main.ts`: `registerRunsCommands(program, …)`, next to
  `registerRunnerCommands`.
- `apps/cli/test/commands/runs.spec.ts` (new).
- `apps/cli/README.md`: rows in the command table (after `demoflow list`).
- `apps/web/src/app/docs/cli/page.mdx`: a table row and a `## runs` section
  after `## list`, with flags and exit codes as `## init` has them.

### Out of scope

- Removing or rewriting lines of `reported-runs.jsonl` (Decision 9).
- Telling the website a run was deleted locally. The run stays in the
  project's library; its video answers `not-found` (Decision 9).
- An MCP tool. Deleting the user's files on an agent's request is a separate
  decision; no source asks for it.
- Automatic pruning (on `run`, on a schedule, by the daemon), a size quota,
  `--keep <n>`.
- Changing `demoflow list`, `listDemos`, the engine, `run`, or the daemon's
  `ArtifactsDeleter`.
- A run marker or lock file written by `run` (Decision 5 explains why the
  activity window is enough for this slice).

## Decisions

1. **Commands.**
   - `demoflow runs list [--json]`
   - `demoflow runs delete <id...> [--dry-run]`
   - `demoflow runs prune [--older-than <duration>] [--partial-only] [--dry-run]`
   - All three take `--out <dir>` (as `run` and `render`) and the hidden
     `--project <dir>`. Registered as a command group like `runner`
     (`apps/cli/src/runner/command.ts`). *Why a group:* `demoflow list`
     already exists with the MCP's contract (spec 266); a sibling `runs`
     keeps that untouched and leaves room for the next local run verb.
2. **Home.** `resolveHome` from `apps/cli/src/config/home.ts`: `--out`,
   `DEMOFLOW_HOME`, the project's `artifactsDir`, the global `artifactsDir`,
   the OS data dir. The project is optional: `projectRootAt(--project)` or
   `projectRootAbove(cwd)`; a `no-project-config` error means "no project",
   and the project step is skipped. An invalid project or global config is
   exit 2, as for `render`. Every output starts with (human) or contains
   (`--json`) the resolved `<home>/runs`. *Why optional:* runs outlive
   projects, and website-started runs land in a home the user may not be
   standing in; refusing to clean up outside a project would strand them.
   Printing the home makes "which runs am I deleting" visible.
3. **What counts as a run.** A direct child of `<home>/runs` that:
   - `lstat`s as a directory, not a symbolic link (on Windows a junction
     `lstat`s as a link and is skipped too);
   - has a name that passes `assertSafeRunId` (`commands/run-id.ts`);
   - holds `result.json` or `scenario.json` (the engine writes
     `scenario.json` first, `RUN_FILES` in
     `packages/engine/src/capture/observer.ts`; the app-not-ready path in
     `run.ts` writes only `result.json`).

   Anything else under `runs/` is not listed and never deleted. Each run
   gets a state:
   - `settled`: `result.json` parses with `RunResultSchema`, its `runId`
     equals the directory name, and its `status` is not `running`
     (`settleRun` has run);
   - `partial`: anything else (no `result.json`, unreadable, another
     `runId`, status `running`);
   - `active`: Decision 5, whatever the above says.

   *Why:* the same "is this really a run directory" test spec 234 applies
   (`holdsItsRun`), relaxed only enough to see partial runs, which are the
   point of the issue.
4. **`list` output.** Newest first by date, where date is `startedAt` from
   `result.json` when it parses, else the run directory's `mtime`.
   - Human: the home line, then one line per run:
     `<status|partial|active>  <YYYY-MM-DD HH:mm local>  <size>  <scenarioName or ->  <id>`,
     the status column as `demoflow list` prints it. A reported run adds its
     page URL on the next line, indented two spaces, from
     `readReportedRunsByDir` + `pageUrlFor`. Last line:
     `<n> runs, <total size>`. No runs: `No runs in <home>/runs.`, exit 0.
     A missing `runs/` directory is "no runs".
   - Size: the sum of `lstat` sizes of every file under the directory,
     never following links, printed as `B`, `KB`, `MB`, `GB` (1024, one
     decimal).
   - `--json`: `{ "home": "<home>/runs", "runs": [ { id, state, status?,
     scenarioName?, scenarioId?, startedAt?, modifiedAt, sizeBytes,
     pageUrl? } ] }` and a newline, nothing else on stdout.
   - No `--limit`: the point is seeing everything that takes space.
5. **In progress.** A run is `active` when any file under it, or the
   directory itself, was modified less than `ACTIVE_WINDOW_MS` (5 minutes)
   ago. `delete` and `prune` never remove an active run, settled or not;
   `delete` reports `refused <id>: modified <n>s ago, it may still be
   running`. There is no `--force`. *Why:* nothing marks a running run on
   disk: `result.json` is written only when the engine finishes and is then
   rewritten by `settleRun` and the renders, and `runner.lock` is the
   daemon's, not a run's. A running run writes continuously (Playwright
   records `source.webm` into the run directory, `recording.ts`; FFmpeg
   writes renders there), so five quiet minutes means nothing is writing.
   `demoflow render` on a settled run writes there too, hence one rule for
   every state. A marker file would mean changing `run`, the engine and the
   daemon's child; out of scope.
6. **`delete <id...>`.** Each id is checked with `assertSafeRunId` first; an
   invalid one exits 2 before anything is removed. Then, per id, in the
   order given, each with one line:
   - `deleted <id> (<size>)`;
   - `not found <id>` (no such directory, or not a run per Decision 3);
   - `refused <id>: …` (active, Decision 5);
   - `failed <id>: <message>` (an I/O error).

   One id's failure does not stop the others. Exit 0 when every id is
   `deleted`, 1 otherwise. `--dry-run` prints `would delete <id> (<size>)`
   instead and removes nothing; refusals and `not found` still print and
   still exit 1. On Windows the id is matched against `readdir` entries
   case-insensitively. *Why exit 1 for not-found:* a script that deletes a
   named run should learn it did not happen.
7. **`prune`.** Selects runs that match every given filter:
   - `--older-than <duration>`: date (Decision 4) older than now minus the
     duration. Syntax: a positive integer and one unit, `m`, `h`, `d` or
     `w` (`90m`, `12h`, `30d`, `2w`), case-sensitive, nothing else.
     Anything else: `invalid-duration` on stderr, exit 2.
   - `--partial-only`: only `partial` runs.
   - Neither flag: `prune-needs-a-filter` on stderr, exit 2, nothing read.
     *Why:* a bare `prune` deleting every run is one typo away from losing
     everything.

   Active runs are never selected; they are counted in the summary
   (`skipped <n> active`). Output: one `deleted`/`would delete` line per
   run, oldest first, then `Freed <size>` (`Would free <size>` with
   `--dry-run`). Exit 0 when nothing failed (including nothing matched),
   1 when any removal failed.
8. **Removal and path safety.** For each run to remove:
   - `<home>/runs` is resolved once with `realpath`; the target is
     `join(realRuns, id)` and must have `dirname === realRuns`, so no id can
     lead elsewhere;
   - the target is `lstat`ed again just before removal and must still be a
     real directory (Decision 3), so a directory swapped for a link between
     scan and removal is refused;
   - removal is `fs.rm(target, { recursive: true, maxRetries: 3 })`. Node
     removes a link inside the directory as a link, never its target
     (as `nodeArtifactsFs` relies on). `maxRetries` covers Windows `EBUSY`
     and `EPERM` while a video is briefly open.
   - An error leaves whatever was removed removed; a retry finishes the job
     (spec 234). `<home>`, `<home>/runs` and anything outside it are never
     removed, even when empty.
9. **`reported-runs.jsonl` is not touched.** It lives next to
   `credentials.json` (`runnerPaths().reportedRuns`), not under `<home>`.
   Lines are neither removed nor rewritten; the file keeps its size cap
   (spec 192). *Why:* the same fail-safe as spec 234's Out of scope. A
   stale line is harmless: `video.open` for the run answers `not-found`
   because `result.json` is gone (as today), a later website delete answers
   `artifacts.deleted` (already gone), and the line still registers the
   project root for spec 248. Rewriting the file while the daemon appends
   to it would risk losing other runs' lines.
10. **No confirmation prompt.** The commands never ask. *Why:* the CLI is
    run from scripts and CI; `delete` removes only ids the user typed,
    `prune` requires a filter, and `--dry-run` is the preview. `runs --help`
    and `/docs/cli` recommend `--dry-run` first.
11. **Side effects.** No browser, no network, no daemon message, no write
    outside the removed directories. `list` writes nothing.
12. **Testability.** Each command takes `(args, flags, io, deps)` with
    `deps = { host, cwd, now, fs }`, where `fs` is an injectable
    `{ lstat, readdir, readFile, realpath, rm }` and `now` a clock, so tests
    fake `EBUSY`, the activity window and Windows paths (`pathFor('win32')`)
    without waiting.

## Acceptance criteria

Vitest under Node, a temporary home via `DEMOFLOW_HOME` with settled,
partial (only `scenario.json`; `result.json` with status `running`), active
and non-run entries (a file, a symbolic link to a directory outside the
home, a directory named `.hidden`), and a temporary `reported-runs.jsonl`:

- [ ] `runs list` shows settled and partial runs, newest first, with size
      and the page URL of a reported run; skips non-run entries; marks a run
      touched within 5 minutes `active`; `--json` has the documented shape;
      an empty or missing `runs/` prints the empty line, exit 0.
- [ ] `runs delete <id>` removes a settled and a partial run, exit 0; an
      unknown id and an active run exit 1 with their lines, and the other ids
      are still deleted; `../x` and `a/b` exit 2 with nothing removed;
      `--dry-run` removes nothing.
- [ ] The symbolic-link entry is never followed or removed; a link inside a
      deleted run is removed as a link and its target survives.
- [ ] `runs prune --older-than 30d` removes only older runs; `--partial-only`
      only partial ones; both together the intersection; active runs are
      skipped and counted; `--older-than 30x`, `--older-than 0d` and no
      filter exit 2; `--dry-run` removes nothing and prints `Would free`.
- [ ] An injected `EBUSY` from `rm` prints `failed <id>`, exit 1, and the
      next run in the batch is still processed.
- [ ] `reported-runs.jsonl` is byte-for-byte unchanged after `delete` and
      `prune`; `findReportedRun` still returns the line, and the relay's
      `video.open` for that run answers `not-found`.
- [ ] Works with no `demoflow.config.json` above the cwd (OS home or
      `DEMOFLOW_HOME`), and with `--out <relative dir>`.
- [ ] `demoflow runs --help` and each subcommand's `--help` list their
      flags; README and `/docs/cli` updated.
- [ ] `bun run check` and the execution-plane OS matrix are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/cli/src/main.ts` | #283 | No other open issue or PR touches it. |
| `apps/cli/src/commands/runs.ts`, `runs-scan.ts`, `apps/cli/test/commands/runs.spec.ts` | #283 | New files. |
| `apps/cli/README.md`, `apps/web/src/app/docs/cli/page.mdx` | #283 | No open PR touches them. #279 edits `/docs/runner`, not `/docs/cli`. |
| `apps/cli/src/runs-report/reported-runs.ts`, `runner/artifacts/index.ts`, `config/home.ts`, `commands/run-id.ts` | read only | Used, not edited. |
| `apps/cli/src/runner/**` | #285 | Not touched here. |

## Open questions

None.

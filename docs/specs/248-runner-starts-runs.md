# The runner daemon starts and cancels a run the website asked for

Issue: [#248](https://github.com/AndreyBegma/DemoFlow/issues/248)
Depends on: nothing to build. The protocol is in
[247](247-start-run-api.md#protocol). Merge after #247, so staging has both
ends.

## Summary

[ADR-0008](../adr/0008-cloud-boundary.md) §3 lets the website make a Runner
start a run of a scenario file in a registered project, and cancel it.
[ADR-0016](../adr/0016-website-started-runs.md) adds listing a project's
scenarios, and defines a registered project as a root this machine reported a
run from. This slice is the daemon's side.

- The daemon remembers the root of every run the CLI reports. That is the
  machine's registry of projects.
- On `scenarios.list`, it lists the project's `demoflow/**/*.demo.json` files
  that parse: ids and names only.
- On `run.start`, it checks the project and the scenario file, then runs
  `demoflow run` as a child process, the way `demoflow mcp` does. The child
  reports itself to the server through the existing report path (spec 178).
- On `run.cancel`, it stops the child, which stops the browser and the dev
  server.

This is the first message that **runs something** on the user's machine. The
checks of Decisions 2–4 are the heart of the slice.

## Scope

### In scope

- `apps/cli/src/runs-report/report.ts` and `reported-runs.ts`: a `root` on
  each new index line, and a lookup of known roots.
- `apps/cli/src/runner/launch/` (new): the scenario id rule, the listing, the
  checks and the launcher, pure where possible, with the filesystem, the
  spawn and the sender injected, like `artifacts/`.
- `apps/cli/src/runner/connection.ts`: route `scenarios.list`, `run.start`
  and `run.cancel` to it.
- `apps/cli/src/runner/daemon.ts`: wire it, and stop a running child when the
  daemon stops.
- `apps/cli/src/mcp/child.ts`: an optional kill grace on `spawnRun`
  (Decision 7). The MCP's own behaviour is unchanged.
- `apps/cli/test/**`: tests.

### Out of scope

- The API (#247) and the project page (#249).
- A local command to register or unregister projects. Registration is a
  reported run (ADR-0016 §2).
- Progress messages during a run, and queueing a second start.
- Deleting the partial files of a cancelled run (Decision 8).
- Re-announcing a running launch after a reconnect (spec 247, Decision 7).

## Decisions

1. **The registry.** `reportRun` writes the canonical root it sent as
   `rootPath` into the index line, as `root`. `parseLine` keeps it when it is
   a non-empty string. `knownRoots(indexFile): Promise<Set<string>>` reads the
   index once and never throws. Lines from before this change have no `root`;
   such a project is registered again by its next reported run.
2. **The project check**, for `scenarios.list` and `run.start`. Any failure
   answers `project-unknown`:
   - `rootPath` is a string that equals, exactly, a `root` in the index;
   - `realpathSync.native(rootPath)` still equals `rootPath` (the folder was
     not replaced by a link), and it is a directory;
   - it holds `demoflow.config.json`. A config that is present and does not
     load answers `config-invalid` for `run.start`, and `project-unknown` for
     `scenarios.list`.
3. **The scenario id rule** of spec 247 (Protocol), applied again here: the
   daemon never trusts the API's validation. An id that breaks it answers
   `scenario-not-found`.
4. **The scenario file.** The file is `path.resolve(root, ...id.split('/'))`.
   It must be a regular file, and its real path must equal that path, so no
   link anywhere below the root is followed. Otherwise `scenario-not-found`.
   It is read (at most 1 MiB) and parsed with `parseScenario` from
   `@demoflow/core`; a failure is `scenario-invalid`.
5. **Listing.** Walk `<root>/demoflow/` with `lstat`: never descend into a
   linked directory, skip linked files, stop at depth 16 or after 10,000
   entries (and set `truncated`). Each `*.demo.json` that passes Decision 4
   is listed as `{ id, name }`, with the id in `/` form and `name` cut to 200
   characters. Files that fail it count in `skipped`. Sort by id, keep the
   first 100, and drop more from the end until the encoded frame is at most
   60,000 bytes; `truncated` says whether anything was dropped. A missing
   `demoflow/` folder is an empty list. Any other read error is `io`.
6. **Starting.** One website-started run at a time: a second `run.start`
   while one runs answers `busy`. With `CI` or `DEMOFLOW_NO_REPORT=1` in the
   daemon's environment (`isReportOff`), the answer is `reporting-off`
   (ADR-0016 §4). Otherwise, after Decisions 2–4:
   - pick a local run id with `generateRunId`, and the run directory the way
     `demoflow mcp` does (`resolveProject`, `runDir`);
   - spawn `run <scenario file> --json --run-id <local id> --project <root>`
     with `spawnRun`, in the root, with the daemon's environment. Nothing from
     the message besides the checked id and root reaches the arguments;
   - answer `run.started { scenarioName }` once the child has a pid, or `io`
     when the spawn fails.
7. **Cancelling.** `run.cancel` with the running launch's `requestId` kills
   the child with `spawnRun`'s `kill()`: SIGTERM, then the tree. The child's
   own SIGTERM handler stops the dev server (`apps/cli/src/commands/run.ts`)
   and Playwright closes the browser. The dev server's stop can take up to
   10 s (`STOP_GRACE_MS` twice in `app/dev-server.ts`), and on POSIX it is in
   its own process group, which the tree kill does not reach. So
   `spawnRun` gains an optional `killGraceMs`, and the daemon passes
   **15 s**. The MCP keeps its 5 s. A `run.cancel` for any other id is logged
   and ignored.
8. **Partial files stay.** A cancelled or timed-out run's directory is left
   as the child left it, like a `demoflow run` stopped with Ctrl-C and a
   cancelled MCP task. The child does not report it, so the website never
   lists it and cannot delete it; the local user can remove
   `<home>/runs/<id>/`. *Why:* deleting files the user did not ask to delete
   is the riskier choice, and this keeps one behaviour for every stopped run.
9. **Time cap.** A run still going after **15 minutes** (the MCP's default)
   is killed as in Decision 7 and ends `timed-out`.
10. **Finishing.** When the child exits, the daemon sends `run.finished`:
    - `outcome`: `cancelled` or `timed-out` when the daemon killed it;
      otherwise `failed` when `result.json` is missing or its status is
      `failed`, and `passed` for any other status (the rule `buildReport`
      uses);
    - `runId`: the `id` of the index line whose `runDir` is this run's
      directory (`readReportedRunsByDir`), else `null`.

    It is sent on the socket that is current at that moment. With no socket,
    it is dropped; the run still reached the server through its report.
11. **Socket loss and daemon stop.** A lost socket does not stop the run
    (spec 247, Decision 7). `demoflow runner stop`, SIGTERM or SIGINT to the
    daemon cancels the run as in Decision 7 and waits for the child before the
    daemon exits.
12. **Malformed messages.** A `scenarios.list`, `run.start` or `run.cancel`
    without the string fields it needs is logged and ignored, the same as
    other malformed frames.
13. **Log.** One `info` line in `runner.log` per list request (request id,
    outcome, count) and per launch start and end (request id, outcome, run
    id). A refused check is logged as `refused` with the code. No path and no
    scenario id: the log may be pasted into an issue.

## Acceptance criteria

Vitest under Node, on the execution-plane matrix (Linux, macOS and Windows):

- [ ] A reported run writes `root` into its index line; `knownRoots` returns
      it, skips old lines without one, and returns an empty set for a missing
      index.
- [ ] `scenarios.list` for a registered root with valid, invalid and nested
      scenarios answers sorted ids and names, the right `skipped`, and no
      file outside `demoflow/`. More than 100 scenarios, or names that make
      the frame too large, set `truncated` and keep the frame ≤ 60,000 bytes.
- [ ] `project-unknown` for an unregistered root, a root that is now a link,
      and a root without `demoflow.config.json`; nothing is read below it.
- [ ] `run.start` with a valid scenario spawns exactly
      `run <file> --json --run-id <id> --project <root>` in the root
      (injected spawn) and answers `run.started` with the scenario's name.
- [ ] Each of these answers its code and spawns nothing:
  - [ ] an id with `..`, a backslash, an absolute path, or outside
        `demoflow/` → `scenario-not-found`;
  - [ ] a scenario file that is a link, or under a linked directory, to a
        real scenario → `scenario-not-found` (skipped on Windows if links need
        privileges, and the test says so);
  - [ ] an unparsable scenario → `scenario-invalid`; a broken config →
        `config-invalid`;
  - [ ] a second start while one runs → `busy`;
  - [ ] `CI` or `DEMOFLOW_NO_REPORT=1` in the daemon's environment →
        `reporting-off`.
- [ ] `run.cancel` kills the child and `run.finished` says `cancelled` with
      `runId: null`. With a real process tree (a stand-in child that starts a
      grandchild in its own process group on POSIX and stops it on SIGTERM),
      neither process is alive after the cancel.
- [ ] The 15-minute cap (fake clock) ends the run `timed-out`.
- [ ] A child that exits on its own sends `passed` or `failed` from its
      `result.json`, with the server run id from the index, or `null` when
      there is no line.
- [ ] Stopping the daemon while a run goes kills the child before exit.
- [ ] `demoflow mcp` cancel still uses a 5 s grace (its existing tests stay
      green).
- [ ] `bun run check` and `bun run build` are green, and so is the
      execution-plane matrix.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/cli/src/runner/**`, `apps/cli/test/runner/**` | #248 | None of #247 and #249 touch them. |
| `apps/cli/src/runs-report/**` | #248 | No other open issue. |
| `apps/cli/src/mcp/child.ts` | #248 | One optional parameter; no other open issue. |

## Open questions

None.

# MCP `get_task` and `list_demos` return the run's page URL

Issue: [#225](https://github.com/AndreyBegma/DemoFlow/issues/225)
Depends on: nothing. #178 (run reports), #192 (`reported-runs.jsonl`) and
#193 (the run page) have merged.

## Summary

[Vision](../product/vision.md) §3.3 lists, among the MCP operations,
"Retrieve the DemoFlow page reference for a video".
[Roadmap](../product/roadmap.md) Phase 3 deferred it: it "waits for Phase 5".
[Spec 69](69-mcp-read-only-tools.md) left "any website reference (Phase 5)"
out of scope.

Phase 5 has shipped:

- at the end of `demoflow run` on a paired machine, the CLI reports the run.
  `POST /runner/runs` answers `{ projectId, runId }` (spec 178, Decision 3);
- `reportRun` appends the run id and run directory to
  `reported-runs.jsonl` (spec 192, Decision 1);
- the website shows each run at `/app/projects/<projectId>/runs/<runId>`
  (spec 193).

Today the CLI discards `projectId`, so it cannot build that URL. This issue
keeps `projectId`, and returns the URL as `pageUrl` from `get_task` and
`list_demos`. An agent can then hand the person a link to the run on the
website.

## Scope

### In scope

- `apps/cli/src/runs-report/report.ts`: read `projectId` from the answer,
  and write it with the server origin into the index line.
- `apps/cli/src/runs-report/reported-runs.ts`:
  - the optional fields on `ReportedRun`, and their parsing;
  - a lookup by run directory that reads the file once and returns a map.
- `apps/cli/src/mcp/view.ts`, `readonly.ts` and `server.ts`: `pageUrl` on
  `TaskView` and `DemoSummary`. Wire the lookup in.
- `apps/cli/test/runs-report/**` and `apps/cli/test/mcp/**`.
- `apps/web/src/app/docs/mcp/page.mdx`: the `get_task` and `list_demos`
  sections.

### Out of scope

- Printing the URL from `demoflow run`. No source asks for it.
- Any change to `apps/api` or `apps/web` pages. The answer already carries
  `projectId`, and the page exists.
- Making the page public or shareable. The roadmap rules out public share
  links (Phase 5).
- `apps/cli/src/runner/**`, which #219 holds. The daemon's lookup by id
  (`findReportedRun`) keeps its behaviour.

## Decisions

1. **The index line gains two optional fields.**
   - The new line is
     `{"id":"<runId>","runDir":"<abs>","at":"<ISO>","projectId":"<id>","server":"<origin>"}`.
   - `server` is `credentials.server` at report time. That is the normalized
     origin-and-path that `resolveServer` produced, without a trailing slash.
     It is stored rather than read at lookup time: a later `demoflow login`
     against another server must not point old runs at the wrong site.
   - `projectId` comes from the same answer as `runId`. It must be a
     non-empty string. A missing or empty `projectId` still writes the line
     without it, so the daemon can still play the run (spec 192 is
     unaffected).
   - `parseLine` accepts lines without either field, as every line written
     before this change is. The new fields are optional on `ReportedRun`.
     Pruning (spec 192, Decision 2) is unchanged.
2. **The URL.** It is
   `` `${server}/app/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(id)}` ``,
   built only when the entry has both `server` and `projectId`. Build it in
   one exported function in `runs-report/`, so the route lives in one place
   in the CLI.
3. **Lookup by run directory.**
   - A new function reads the index once and returns a `Map` from
     `path.resolve(runDir)` to the last entry for it (the last line wins, as
     in spec 192, Decision 3).
   - The keys are compared as `path.resolve` strings. `reportRun` already
     stores `path.resolve(input.runDir)`, and the MCP server builds the run
     directory with the same `runDir(home, taskId, platform)`.
   - The index path is `runnerPaths(host).reportedRuns`.
   - The function never throws. A missing, unreadable or malformed file gives
     an empty map, and malformed lines are skipped.
4. **`get_task`.**
   - A terminal task (`isTerminal(status)`: `completed`, `failed`,
     `cancelled`, `timed_out`) gets `pageUrl` on the top level of
     `TaskView`, when the map has an entry with both fields for its run
     directory. In practice only runs that reached their report have one.
   - A queued or running task never has one: its report has not happened
     yet.
   - The index is read when the view is built, not cached. A run that just
     finished reports in its last 2 s, and the next `get_task` must see it.
5. **`list_demos`.**
   - Each `DemoSummary` gets `pageUrl` under the same rule.
   - The index is read once per call, before the loop over run directories.
6. **Absent, never null.** When there is no URL, the field is left out, as
   `video` is. An unpaired machine, `CI`, `DEMOFLOW_NO_REPORT=1` or a failed
   report all give no field. No tool fails or changes its other output
   because of the index.
7. **Boundary.** Nothing new is sent to the server: the URL is built from
   what the report already received
   ([ADR-0008](../adr/0008-cloud-boundary.md) §1). The page opens only for
   the signed-in owner of the run. The docs say so, so an agent does not
   present the link as public (vision §3.1).
8. **Docs.** In `apps/web/src/app/docs/mcp/page.mdx`:
   - append to the `get_task` paragraph:

     > When this machine is paired and the run was reported, the answer also
     > has `pageUrl`, the run's page on the DemoFlow website. It opens only
     > when you are signed in.

   - extend the `list_demos` field list with "and `pageUrl` when the run was
     reported".

## Acceptance criteria

- [ ] `report.spec.ts`: a 2xx answer `{ projectId, runId }` writes a line
      with `id`, `runDir`, `at`, `projectId` and `server`. An answer without
      `projectId` writes the line without it.
- [ ] `reported-runs`:
  - a line without `projectId`/`server` parses as before;
  - `findReportedRun` still finds it by id;
  - the by-directory map keeps the last line for a directory;
  - a garbage file gives an empty map.
- [ ] `mcp/`:
  - a finished task whose run directory has a full entry returns
    `pageUrl: "<server>/app/projects/<projectId>/runs/<runId>"`;
  - a finished task without one has no `pageUrl`;
  - a running task has none;
  - `list_demos` sets it per entry, with one index read per call;
  - a garbage index changes nothing else in either answer.
- [ ] No test reaches the network or the real home directory: use the
      existing injected host and fetch.
- [ ] `apps/web/src/app/docs/mcp/page.mdx` has the text from Decision 8.
- [ ] `bun run check` and `bun run build` are green, and so is the
      execution-plane matrix (Linux, macOS, Windows).

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i225 | index fields, lookup, MCP `pageUrl` | apps/cli/src/runs-report/**, apps/cli/src/mcp/{view,readonly,server}.ts, apps/cli/test/runs-report/**, apps/cli/test/mcp/**, apps/web/src/app/docs/mcp/page.mdx | — | yes | sonnet |

## Contention

- #224 works in `apps/cli/src/record/**`. There is no shared file.
- #219 (PR #222) edits `apps/cli/src/runner/control.ts`. This issue does not
  touch `apps/cli/src/runner/**`. `runnerPaths` is only imported.
- It does not touch `packages/**`, which #218, #221 and #209 hold.

## Open questions

None.

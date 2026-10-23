# The runner daemon deletes a reported run's artifacts

Issue: [#234](https://github.com/AndreyBegma/DemoFlow/issues/234)
Depends on: nothing to build. The protocol is in
[233](233-delete-run-artifacts-api.md#protocol). Merge after #233, so staging
has both ends.

## Summary

[ADR-0008](../adr/0008-cloud-boundary.md) §3 lets the website make a Runner
"delete a run's artifacts" and nothing beyond its four listed actions.
[Spec 192](192-runner-serves-video.md) built the daemon's side of streaming and
left deletion out of scope. This slice is the daemon's side of deletion.

- When the API sends `artifacts.delete` for a server run id, the daemon finds
  the run directory in `reported-runs.jsonl`, the same index playback uses.
- It checks that the directory really is a DemoFlow run directory, then
  removes it.
- The server only ever names a run by its server id. Paths stay on the
  machine. This is the first message that **removes** files on the user's
  machine, so the boundary check is the heart of the slice.

## Scope

### In scope

- `apps/cli/src/runner/artifacts/` (new): the handler, pure where possible,
  with the filesystem and the sender injected, like `relay/`.
- `apps/cli/src/runner/connection.ts`: route `artifacts.delete` to it.
- `apps/cli/src/runner/relay/`: a way to close the open streams of one run
  (Decision 4).
- `apps/cli/test/runner/**`: tests.

### Out of scope

- The API (#233) and the run page (#235).
- Removing or rewriting lines of `reported-runs.jsonl`. A deleted run's line
  stays; `video.open` for it answers `not-found` because `result.json` is
  gone, and a repeated `artifacts.delete` answers `artifacts.deleted`.
- A local `demoflow` command that deletes runs, and pruning old runs.

## Decisions

1. **Lookup.** `findReportedRun(indexFile, runId)` from
   `runs-report/reported-runs.ts`, the last line wins (spec 192 Decision 3).
   No line: `artifacts.error { code: 'not-found' }`.
2. **Already gone.** When `lstat(runDir)` fails with `ENOENT`, the daemon
   answers `artifacts.deleted`. The request is idempotent (spec 233,
   Protocol).
3. **What may be deleted.** Every check below runs on every request. Any
   failure answers `not-found` and deletes nothing.
   - The path comes from the index, never from the message.
   - `runDir` itself is a directory, not a symlink (`lstat`).
   - Its parent directory's name is `runs`, and its own name equals the
     `runId` of the `result.json` inside it (ADR-0004 §7:
     `<home>/runs/<runId>/`).
   - `result.json` parses with `RunResultSchema` from `@demoflow/core`.
   - The path is absolute after `path.resolve`, and it is not a filesystem
     root, the home directory, or the `runs` directory itself.
   - *Why:* the index is a local file that any process of the user can edit.
     These checks make sure a bad line can only ever remove something that
     looks exactly like a DemoFlow run, never an arbitrary directory.
4. **Open streams first.** Before deleting, the daemon closes every open
   video stream of that server run id. Each one ends with
   `video.error { code: 'io' }` to the API, and its file handle is closed.
   Windows cannot remove a file that is open. `VideoRelay` gains
   `closeRun(runId)`. A stream must remember its server run id for that.
5. **Deleting.** `fs.rm(runDir, { recursive: true })`. Node removes symlinks
   inside the directory as links and does not follow them.
   - Success, or `ENOENT` during the removal: `artifacts.deleted`.
   - Any other error: `artifacts.error { code: 'io' }`. Whatever was removed
     stays removed. A retry finishes the job.
6. **One at a time.** A second `artifacts.delete` for a run whose deletion is
   still running waits for the first, then answers with the same result. It
   never runs `rm` twice at once on one directory.
7. **Malformed messages.** An `artifacts.delete` without a string
   `requestId` and `runId` is logged and ignored, the same as other malformed
   frames.
8. **Log.** One `info` line per request in `runner.log`: the server run id
   and the outcome (`deleted`, `already-gone`, `not-found`, `refused`, `io`).
   A boundary refusal is logged as `refused`, while the API still gets
   `not-found`. No path is logged: the log may be pasted into an issue.

## Acceptance criteria

Vitest under Node, on the execution-plane matrix (Linux, macOS and Windows):

- [ ] A run directory under a temporary `<home>/runs/<runId>/` with a valid
      `result.json` and its render files is removed, and the sender gets
      `artifacts.deleted` with the same `requestId`.
- [ ] A missing directory answers `artifacts.deleted`; an unknown run id
      answers `not-found`.
- [ ] Each of these answers `not-found` and leaves every file in place:
  - [ ] a parent directory not named `runs`;
  - [ ] a directory name that differs from `result.json`'s `runId`;
  - [ ] a missing or invalid `result.json`;
  - [ ] `runDir` that is a symlink to a real run directory (skipped on
        Windows if symlinks need privileges, and the test says so);
  - [ ] `runDir` that is a file, not a directory.
- [ ] A symlink inside the run directory pointing outside it is removed as a
      link; its target survives (same Windows rule).
- [ ] An open stream of that run is closed with `video.error io` before the
      removal, and its handle is released (an injected `open`/`close`
      counter). Streams of other runs keep going.
- [ ] A removal error (injected `rm`) answers `io`.
- [ ] Two concurrent requests for one run call `rm` once and both answer.
- [ ] `bun run check` and `bun run build` are green, and so is the
      execution-plane matrix.

## Open questions

None.

# The runner daemon streams a reported run's video

Issue: [#192](https://github.com/AndreyBegma/DemoFlow/issues/192)
Depends on: nothing to build. The protocol is in
[191](191-video-relay-api.md#protocol). Merge after #191, so staging has
both ends.

## Summary

Roadmap, Phase 6. Under ADR-0008 §3, the website may make a Runner
"stream a video" and nothing else. This slice is the daemon's side of the
relay (ADR-0009 §1).

- The machine remembers which runs it reported.
- When the API sends `video.open` for one of them, the daemon streams the
  rendered file in range-sized chunks over its socket.
- The server only ever names a run by its server id. Paths stay on the
  machine.

## Scope

### In scope

- `apps/cli/src/runs-report/`: after a successful report, record the server
  run id with the local run directory.
- `apps/cli/src/runner/`: handle `video.open`, `video.ack` and
  `video.cancel`, and send `video.head`, binary chunks, `video.end` and
  `video.error`.
- `apps/cli/src/commands/run.ts`: pass the run directory to `reportRun`.

### Out of scope

- The API (#191) and the web page (#193).
- Deleting a run's artifacts from the website.
- Pruning old run directories.

## Decisions

1. **The index.** It is `reported-runs.jsonl` in `runnerPaths(host).dir`,
   next to `credentials.json`.
   - After `POST /runner/runs` answers 2xx with `{ runId }`, `reportRun`
     appends one line:
     `{"id":"<server run id>","runDir":"<absolute run dir>","at":"<ISO>"}`.
   - The response is now read for that id. Until now it was drained.
   - A non-2xx answer, a timeout, a missing id, or a report that is off
     (`CI`, `DEMOFLOW_NO_REPORT`, not paired) appends nothing.
   - Every failure stays silent, and the 2 s budget covers the read as well
     (#178 Decision 3).
   - **Why append-only JSONL:** two `demoflow run` processes can finish
     together. One `appendFileSync` of one short line does not interleave,
     where a read-modify-write of a JSON file can lose an entry.
2. **Pruning.** When the file is over **1 MiB** before an append, the writer
   rewrites it with its last 2,000 lines (temp file, then rename), then
   appends. A lost race costs one entry, which then plays as `not-found`.
   That is acceptable.
3. **Lookup.** The daemon reads the index on each `video.open`. The last
   line with that `id` wins. Malformed lines are skipped. There is no cache:
   the file is small, and a new run must be playable without restarting the
   daemon.
4. **What may be served.** This is the ADR-0008 boundary, and it is checked
   every time.
   - The run directory comes from the index, never from the message.
   - `result.json` in it is parsed with `RunResultSchema`. The render whose
     `format` matches gives `file`. No match means `not-found`.
   - The file is `path.resolve(runDir, render.file)`. Its `realpath` must be
     inside `realpath(runDir)`, using the platform's path rules (Windows is
     case-insensitive), and it must be a regular file. Otherwise the answer
     is `not-found`.
   - Nothing else on disk can be reached through a message.
5. **Ranges.** These follow HTTP semantics against the file's `size`:
   - `{ start, end? }`: `end` defaults to `size - 1` and is clamped to it;
     `start >= size` is unsatisfiable;
   - `{ suffix: n }`: the last `min(n, size)` bytes; `n = 0` is
     unsatisfiable;
   - `null`: the whole file;
   - an empty file with a range is unsatisfiable;
   - unsatisfiable gives `video.error { code: 'bad-range', size }`.
6. **Sending.**
   - The daemon sends `video.head { size, start, end }`, then reads the file
     in **32 KiB** chunks. Each chunk is framed as #191 specifies (`0x01`,
     16 raw bytes of `streamId`, data).
   - It stops sending when **512 KiB** are unacknowledged, and resumes as
     `video.ack` arrives.
   - When the last byte is sent, it sends `video.end` and closes the file.
   - A read error gives `video.error io` and closes the file.
   - `RunnerSocket` gains `sendBinary(data: Uint8Array)`, and the `ws`
     factory implements it.
7. **Limits and ends.**
   - At most **4** open streams per daemon. A fifth `video.open` gets
     `video.error busy`.
   - `video.cancel`, an unknown `streamId`, or the socket closing (any code,
     including reconnect and stop) closes the stream's file handle. No handle
     outlives its stream.
   - A `video.open` with a `streamId` that is already open is ignored and
     logged.
8. **Where it lives.**
   - `apps/cli/src/runner/relay/`: `index.ts`, `stream.ts`, `range.ts`.
     These are pure where possible, with the filesystem and the socket
     injected, like `ConnectionDeps`.
   - `connection.ts` routes `video.*` messages to the relay and tells it when
     the socket closes.
   - Invalid fields in a `video.*` message are logged and ignored, the same
     as other malformed frames today.
9. **Log.** One `info` line per stream in `runner.log`: the server run id,
   format, bytes sent and outcome. No path is logged. The log may be pasted
   into an issue.

## Acceptance criteria

Vitest under Node, on the execution-plane matrix (Linux, macOS and Windows):

- **Report and index:**
  - a paired run with a 2xx `{ runId }` appends exactly one line with the
    run directory;
  - a non-2xx answer, a timeout, `CI`, `DEMOFLOW_NO_REPORT` or an unpaired
    machine appends nothing;
  - output and exit code are unchanged in every case;
  - pruning keeps the last 2,000 lines once the file passes 1 MiB.
- **Lookup:** the last entry wins, a malformed line is skipped, and an
  unknown id gets `not-found`.
- **Boundary:** each of these gets `not-found`:
  - a format missing from `result.json`;
  - a `file` with `..`;
  - a symlink pointing outside the run directory (skipped on Windows if
    symlinks need privileges, and the test says so);
  - a directory;
  - a deleted file.
- **Ranges:** whole file, `a-b`, `a-`, `-n`, an `end` past the size, and the
  unsatisfiable cases. The bytes sent equal the file's bytes for that range.
- **Flow:**
  - chunks are at most 32 KiB of data, with a correct header;
  - unacknowledged bytes never exceed 512 KiB (a fake socket that withholds
    acks);
  - `video.end` comes after the last byte.
- **Ends:** `video.cancel` and a socket close each release every handle (an
  injected `open`/`close` counter), and a fifth stream gets `busy`.
- `bun run check` and `bun run build` are green, and so is the
  execution-plane matrix.

## Open questions

None.

# Play a run's video through the runner relay (API)

Issue: [#191](https://github.com/AndreyBegma/DemoFlow/issues/191)
Depends on: nothing. It follows #151 (runner socket) and #178 (runs), which
have landed.

## Summary

Roadmap, Phase 6. #178 left playback out of scope: "Playback goes through the
relay, which is Phase 6". ADR-0009 §1 settles the shape:

- the browser requests `GET /api/runs/:id/video/:format` with its session;
- the API checks that the run belongs to the user;
- the API asks the owning Runner over its WebSocket for the byte range;
- the API streams the bytes back with HTTP range semantics.

Nothing is stored on the server.

This spec is the API side. It also fixes the **protocol** that the daemon
(#192) and the web player (#193) build against.

## Scope

### In scope

- `apps/api`: `GET /runs/:id/video/:format`, `GET /runs/:id`, the relay over
  the runner socket, and the socket's new messages.

### Out of scope

- The daemon's handler and the local index of reported runs (#192).
- The run page and the player (#193).
- Downloads with `Content-Disposition: attachment`, deleting a run's
  artifacts (ADR-0008 §3), and a loopback shortcut (ADR-0009 Consequences).
- More than one API instance (Decision 10).

## Protocol

These messages are added to the runner socket. They are JSON text frames
unless marked binary. `streamId` is a UUID v4 that the API chooses. `runId`
is the **server's** run id (`Run.id`). No path is ever sent in either
direction (ADR-0008 §2).

| Direction | Message |
|---|---|
| API → Runner | `{ type: 'video.open', streamId, runId, format, range: { start, end } \| { suffix } \| null }` |
| API → Runner | `{ type: 'video.ack', streamId, bytes }` |
| API → Runner | `{ type: 'video.cancel', streamId }` |
| Runner → API | `{ type: 'video.head', streamId, size, start, end }` |
| Runner → API | binary chunk (below) |
| Runner → API | `{ type: 'video.end', streamId }` |
| Runner → API | `{ type: 'video.error', streamId, code, size? }` |

- **Fields of `video.open`:**
  - `format` is one of `RENDER_FORMATS` from `@demoflow/core`.
  - `range` is the parsed `Range` header. `{ start, end }` has an inclusive
    `end`, and `end` may be omitted for `bytes=a-`. `{ suffix }` is
    `bytes=-n`. `null` means the whole file.
  - The Runner checks the range against the file's size.
- **`video.head`:**
  - `start` and `end` are the inclusive bytes the Runner will send.
  - `size` is the whole file's size.
- **Binary chunk:**
  - byte 0 is `0x01` (the frame version);
  - bytes 1–16 are the `streamId` as 16 raw bytes;
  - the rest is up to **32 KiB** of the file, in order.
  - The frame stays under `RUNNER_SOCKET_MAX_PAYLOAD` (64 KiB).
- **Credit.**
  - The Runner keeps at most **512 KiB** sent and not yet acknowledged per
    stream.
  - The API sends `video.ack { bytes }` for a chunk once the HTTP response
    has taken it: right away if `res.write` returned `true`, otherwise on
    `drain`.
  - `bytes` is the size of that chunk, not a running total.
- **Error codes:**
  - `not-found`: the run is unknown to this machine, the format is not in its
    `result.json`, or the file is missing or outside the run directory;
  - `bad-range`: the range is unsatisfiable, and `size` is given;
  - `busy`: the machine already has 4 open streams;
  - `io`: a read failed.
- **Version skew.** A daemon that predates #192 logs `video.open` as unknown
  and never answers, so the API times out (Decision 5). A binary chunk for a
  `streamId` that is not open is dropped. The API logs that once per socket
  and does not close the socket.

## Decisions

1. **Endpoint.** `GET /runs/:id/video/:format`. The browser reaches it as
   `/api/runs/...` through the existing rewrite and Caddy.
   - It uses the same guards as `ProjectsController`.
   - `format` is validated against `RENDER_FORMATS`.
   - The run must belong to a project of the session user. Otherwise the
     answer is 404 `not-found`, the same as #178 Decision 5.
   - A `format` that is not in `run.formats` is also 404 `not-found`.
2. **Machine state**, checked before anything is sent:
   - `run.runnerId` is null: 503 `runner-removed`;
   - `RunnerConnections.isOnline()` is false: 503 `runner-offline`;
   - 4 streams are already open to that Runner: 503 `runner-busy`.
   - Error bodies are JSON `{ error }`, like the rest of the API.
3. **Range handling.**
   - The API parses one `bytes=` range. A multi-range or malformed header is
     treated as no range, so the whole file is sent with a 200, which RFC 9110
     allows.
   - A head that answers a range gives 206 with
     `Content-Range: bytes start-end/size`. Otherwise the answer is 200.
   - Both carry `Content-Length` and `Accept-Ranges: bytes`.
   - `bad-range` gives 416 with `Content-Range: bytes */size`.
   - Both carry `Cache-Control: private, no-store` and
     `Content-Disposition: inline`.
   - Content types: `mp4` and `mp4-vertical` → `video/mp4`, `webm` →
     `video/webm`, `gif` → `image/gif`.
4. **Runner error mapping before the head:**
   - `not-found` → 404 `video-missing`;
   - `busy` → 503 `runner-busy`;
   - `io` → 502 `runner-error`.
   - Any error after the head destroys the response. The status is already
     sent.
5. **Timeouts.**
   - No `video.head` within **10 s**: 504 `runner-timeout`, and the API sends
     `video.cancel`.
   - No chunk for **30 s** mid-stream: the response is destroyed, and the API
     sends `video.cancel`.
   - Both use the injected `Clock`, so tests use a fake clock.
6. **Ends.**
   - When the request closes before `video.end`, because the browser seeked
     or left, the API sends `video.cancel`.
   - When the Runner socket closes, every open stream on it ends. Before the
     head that is 503 `runner-offline`. After the head the response is
     destroyed.
   - Replacing or revoking a socket counts as closing it.
7. **Byte count.** The API counts the bytes it relays. A `video.end` that
   arrives before `end - start + 1` bytes, or bytes beyond that count, destroys
   the response. A short or long body must never pass as a complete one.
8. **Where it lives.**
   - A `VideosModule` (`apps/api/src/videos/`) owns the controller and the
     relay service.
   - `RunnerConnections` gets a narrow seam:
     - send a message to a Runner, which returns false when it is not online;
     - subscribe to a Runner's `video.*` messages and binary frames;
     - be told when a Runner's socket closes.
   - `parseClientMessage` learns the three new text messages. Binary frames
     are routed to the relay instead of being reported as a problem.
9. **`GET /runs/:id`** is for the run page (#193):
   `{ run: ProjectRun, project: { id, name }, machine: { id, name, online } | null }`.
   - `ProjectRun` is the item shape of `GET /projects/:id/runs`.
   - `machine` is null when the Runner was removed.
   - Another user's run is 404. It sits in `VideosModule`, or in
     `ProjectsModule` if that reads better. Either way it is under the
     Touches globs.
10. **One instance.** The relay works only on the instance that holds the
    Runner's socket. Staging runs one API container. More instances would need
    sticky routing or a broker, which is a later ADR. A code comment on the
    relay service says so.
11. **Logging.** One structured line per stream, `video.stream`, with the run
    id, format, bytes relayed, outcome and duration. It carries no user email
    and no path.
12. **No migration.** `Run.formats` already says what was rendered. Sizes come
    from the Runner's head.

## Acceptance criteria

API integration tests with a fake Runner socket. Extend
`runner-socket.fixtures.ts`. They cover:

- the whole file: 200, with `Content-Length`, `Accept-Ranges`, the right
  `Content-Type`, and the body byte-identical to what the fake sent;
- `bytes=a-b`, `bytes=a-` and `bytes=-n`: 206 with the right
  `Content-Range`, and the `range` the fake received matches;
- `bad-range`: 416 with `Content-Range: bytes */size`;
- 404 for another user's run, an unknown run, and a format not rendered;
- 503 `runner-removed`, `runner-offline`, and `runner-busy` (a fifth stream);
- 504 `runner-timeout` (fake clock), and the fake receives `video.cancel`;
- 404 `video-missing` and 502 `runner-error` from Runner errors;
- a client abort mid-stream: the fake receives `video.cancel`;
- a socket close mid-stream: the response is destroyed, not completed;
- a short body (`video.end` early) is destroyed, not completed;
- one `video.ack` per chunk, with the chunk's size;
- a binary frame for an unknown stream is dropped, and the socket stays open;
- `GET /runs/:id` returns the run, its project and the machine (online or
  offline), or `machine: null`, and returns 404 for another user's run.

The existing runner socket tests stay green. `bun run check`, `bun run test`
and `bun run build` are green.

## Open questions

None.

# Download a run's video through the relay (API)

Issue: [#<issue>](https://github.com/AndreyBegma/DemoFlow/issues/<issue>)
Depends on: nothing. It follows #191 (the relay) and #192 (the daemon's
handler), which have landed.

## Summary

[ADR-0009](../adr/0009-playback-relay-and-luna-player-adapter.md) streams a
run's video from the user's machine through the API. The roadmap (Phase 5)
rules out public share links: "Sharing is by file or through the GitHub
Action." Today the website can play the file but not save it, so a user on
another device has no way to get it. [Spec 191](191-video-relay-api.md) left
downloads out of scope.

A download is the same bytes as playback with a different
`Content-Disposition`. This slice adds an opt-in query flag to the existing
endpoint. No new protocol message, no daemon change, nothing stored on the
server.

## Scope

### In scope

- `apps/api/src/videos/runs.dto.ts`: `RunVideoQueryDto`.
- `apps/api/src/videos/runs.controller.ts`: read the query, pass the
  disposition to the relay.
- `apps/api/src/videos/video-relay.service.ts`: `OpenVideo` gains an optional
  `download: { fileName }`; `head()` writes `attachment` when it is set; the
  log line gains `download`.
- `apps/api/src/videos/download-name.ts` (new) and its spec.
- `apps/api/src/videos/videos.integration.spec.ts`: the new cases.

### Out of scope

- The run page's Download button (#300).
- The daemon (`apps/cli/src/runner/relay/**`): `video.open` with `range: null`
  already streams the whole file.
- **The loopback shortcut** (ADR-0009 Consequences, spec 191 Out of scope):
  the browser fetching the file straight from a local HTTP endpoint of the
  daemon when it runs on the same machine. It would need the daemon to listen
  on a port, a second auth path (a token the browser can present to the
  daemon), CORS, and Chrome's Private Network Access preflight from an HTTPS
  origin to `localhost`. That is a new attack surface on the user's machine
  for a speed-up only, so it needs its own ADR. Not part of this work.
- Downloading several formats at once (a zip), public or expiring links
  (roadmap: no share links), cloud upload (ADR-0008 §5).
- New size or time limits (Decision 5).

## Decisions

1. **The same endpoint with `?download=1`**, not a new route or a new socket
   message.
   - *Why:* a download is the playback stream with another header. Reusing
     `GET /runs/:id/video/:format` keeps one set of checks (ownership,
     format, `artifacts-deleted`, machine state, stream cap) and one relay
     path, so the two cannot drift. The Runner cannot tell the two apart and
     does not need to: ADR-0008 §3 already allows "stream a video".
2. **Query validation.** `RunVideoQueryDto` with
   `@IsOptional() @IsIn(['1']) download?: '1'`, bound with `@Query()`. The
   global `ValidationPipe` (`forbidNonWhitelisted`) then rejects any other
   value or any other query parameter with 400 (Nest's validation error), before anything is
   sent to the Runner.
   - *Why:* one accepted spelling is easy to test and cannot be confused with
     "false". The player sends no query string today
     (`apps/web/src/lib/playback.ts`, `videoUrl`), so rejecting unknown
     parameters breaks nothing.
3. **Headers.** With `download`, the head writes
   `Content-Disposition: attachment; filename="<name>"` instead of `inline`,
   on both 200 and 206. Every other header (`Content-Type`, `Content-Length`,
   `Accept-Ranges`, `Cache-Control: private, no-store`, `Content-Range`) is
   unchanged. Error answers before the head stay JSON, unchanged.
   - *Why:* keeping `Accept-Ranges` and 206 lets a browser resume a broken
     download with a `Range` request, which the relay already serves.
4. **File name** (`downloadName(run, format)`, a pure function in
   `download-name.ts`, computed in the controller from the owned run):
   - the base is `run.scenarioName`, NFKD-normalised, combining marks
     removed, lower-cased, every run of characters outside `[a-z0-9]`
     replaced by `-`, leading and trailing `-` trimmed, cut to 60 characters
     (then trailing `-` trimmed again);
   - if that is empty, the same rule on the last segment of
     `run.scenarioPath` without `.demo.json`;
   - if that is still empty, `demo`;
   - then `-<YYYY-MM-DD>` of `run.startedAt` in UTC, `-vertical` for the
     three vertical formats, and the extension `.mp4`, `.webm` or `.gif`.
   - Example: `Sign in & checkout` recorded 2026-10-24 as `mp4-vertical` →
     `sign-in-checkout-2026-10-24-vertical.mp4`.
   - *Why:* an ASCII-only name of `[a-z0-9-]` plus a fixed extension cannot
     break the header (no quotes, no CR/LF, no `;`) and needs no
     `filename*` encoding, which browsers handle unevenly. The date keeps
     downloads of repeated runs of one scenario apart. No local path or
     machine name crosses (ADR-0008 §2): only fields the server already has.
5. **Limits: none new.** A download counts as one of the
   `MAX_STREAMS_PER_RUNNER` (4) streams, takes the 10 s head and 30 s
   per-chunk timeouts, and the 512 KiB credit window, exactly as playback.
   There is no size cap and no overall time cap.
   - *Why:* the relay never buffers more than the credit window, so a large
     file costs the server no memory; the per-chunk timeout already ends a
     stalled transfer. An overall cap would only cut off a slow but healthy
     download. Demo videos are small (ADR-0009 Consequences).
6. **Logging.** The `video.stream` line gains `download: boolean`. Still no
   email, no path, no file name.
   - *Why:* tells downloads from playback when reading traffic, with nothing
     new that identifies the user.

## Acceptance criteria

API tests. Integration cases extend `videos.integration.spec.ts` with the
existing fake Runner socket (`runner-socket.fixtures.ts`):

- [ ] `?download=1`, no `Range`: 200, `Content-Disposition: attachment;
      filename="<name>"` with the name from Decision 4, the right
      `Content-Type` and `Content-Length`, the body byte-identical to what the
      fake sent; the fake received `video.open` with `range: null`.
- [ ] `?download=1` with `Range: bytes=10-`: 206, the same attachment header,
      the right `Content-Range`.
- [ ] No query: `Content-Disposition: inline`, as before.
- [ ] `?download=0`, `?download=true` and `?foo=1`: 400, and the
      fake receives nothing.
- [ ] `?download=1` on another user's run (404), a deleted run's artifacts
      (410 `artifacts-deleted`), an offline machine (503 `runner-offline`) and
      a fifth stream (503 `runner-busy`) answer as playback does.
- [ ] `download-name.spec.ts` covers: a Latin name; a name with accents
      (stripped); a name with no Latin letters (path stem used); both empty
      (`demo`); a 200-character name (cut to 60); each of the six formats'
      suffix and extension; and every output matches
      `^[a-z0-9-]+-\d{4}-\d{2}-\d{2}(-vertical)?\.(mp4|webm|gif)$`.
- [ ] The existing video, artifacts and runner socket tests stay green.
      `bun run check`, `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/api/src/videos/**` | this issue | No open issue touches it today. |
| `apps/web/**` | #300 | Not touched here. |

## Open questions

None.

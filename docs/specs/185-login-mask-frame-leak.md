# Login password field shown unmasked on one frame

Issue: [#185](https://github.com/AndreyBegma/DemoFlow/issues/185)
Depends on: nothing
Priority: critical. The 0.2.0 release (#184) is held for it.

## Summary

On Windows CI, a frame of the rendered `login.demo.json` run shows the password
field without its mask:

- test: `render.spec.ts` › "covers the password field on every frame it
  shows, and drops the box soon after the form leaves (login)";
- failure: frame 171;
- job: 119879176475.

Sign-in removes the form on the same document (React state), so no page-load
hold is involved (#150 ruled out). Frame 171 is in the click window: a live
source frame with the plan's mask spans.

## Decisions

1. **Diagnose first.** Show which of these it is. Record the evidence in the
   PR body.
   - **Edge timing.** The mask interval's `endMs`, mapped through the sync
     offset onto source time, ends before the last source frame that still
     shows the field. This is the #155 / #173 area: the watch stamps a frame
     time, and the screencast frame may lag behind it.
   - **Geometry.** The box no longer covers the field, for example after a
     layout shift on submit, a different device scale on Windows, or
     rounding.
   - **Both, or something else.**

   Instrument the spans against the source frames. A temporary CI loop on
   Windows and macOS is allowed and is removed before the PR.
2. **The guarantee to restore.** A masked field is never visible in any
   output frame. Errors must fall on the safe side: a mask that stays a frame
   too long is acceptable, but a field shown for a frame is not.
   - If the edge cannot be pinned exactly, end the mask on the first source
     frame that no longer shows the field, judged by the source frames the
     renderer composes. Do not end it on the watch's stamp alone.
3. **No quarantine.** No retries, and no loosening of the test.
4. **Both outputs.** Verify landscape and vertical. #176, vertical export,
   reuses `frameAt`'s mask logic.

## Acceptance criteria

- The PR names the root cause and gives the evidence for it.
- The login mask test and the other mask tests in `render.spec.ts` and
  `packages/engine/test/execute/mask.spec.ts` pass in 10 consecutive runs on
  `execution-plane (windows-latest)` and `(macos-latest)`.
- A new test reproduces the failing case deterministically, for example a
  delayed screencast frame against the watch stamp. It fails on the old code.
- `bun run check`, `bun run test` and `bun run build` are green, and so is the
  matrix.

## Contention

| Resource | Owner | Others |
|---|---|---|
| packages/renderer/src/plan/** | #176 (live) and this issue | coordinate through the orchestrator; this issue goes first |
| packages/renderer/test/ffmpeg/render.spec.ts | #150 (live) | #150 does not change it, so this issue may edit it |

## Open questions

None.

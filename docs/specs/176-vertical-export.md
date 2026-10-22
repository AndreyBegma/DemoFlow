# Vertical 9:16 export

Issue: [#176](https://github.com/AndreyBegma/DemoFlow/issues/176)
Depends on: nothing. Its renderer test file conflicts with #150; see Contention.

## Summary

This is the last open item of Phase 4 (roadmap: "vertical 9:16 … with a
follow camera and captions"). The same run renders a vertical video next to
the landscape one. The page is still recorded at its normal 16:9 viewport. A
9:16 crop window follows the current step's target, and captions get a larger
band at the bottom.

The owner decided on 2026-10-22: a crop with a follow camera. The page is not
letterboxed, and the run does not use a mobile viewport.

## Scope

### In scope

- `packages/core`: a new render format `mp4-vertical`, added to
  `RENDER_FORMATS` and `render.formats`, plus a `render.vertical` block (below).
  JSON schema regenerated.
- `packages/renderer`: plan and composition for the vertical output.
- `apps/cli`: `--format mp4-vertical` works, because `--format` already takes
  `RENDER_FORMATS`. Mention it in the help text and the README.

### Out of scope

- Vertical GIF/WebM. Add `gif-vertical` / `webm-vertical` later in the same way.
- Recording in a mobile viewport.
- Square 1:1.

## Decisions

1. **Output.** 1080×1920 at the run's fps, H.264 MP4, written as
   `<name>.vertical.mp4` beside the others and listed in `renders[]` like
   every format (spec 133).
2. **Crop.** The crop window has the full source height and a width of
   `height × 9/16`.
   - It never leaves the page: it clamps to the edges, and the area outside it
     is never filled.
   - The window frame and background of the landscape output are not used
     here. The crop fills the whole vertical frame.
   - The per-step `zoom` (#163) still applies inside the crop, on the same
     keyframes.
3. **Follow.** The crop's horizontal centre follows the current step's
   target centre. With no target, it keeps its last position. At the start of
   the run it is the page centre.
   - Moves ease (`easeInOut`) over 400 ms.
   - A move smaller than 10% of the crop width is skipped, so the camera
     does not jitter.
   - The cursor stays inside the crop when the target does. If the cursor is
     outside the crop, the camera does not chase it.
4. **Captions.** Same text and timing as the landscape output. They sit in a
   band over the bottom 22% of the frame. The font is scaled to the vertical
   width: at least 44 px at 1080 wide. Lines wrap, up to 3 lines.
5. **Cards and transitions** (#108, #114) render in the vertical layout:
   centred, with the same content. Masks (#18, #155) apply before the crop, as
   they do for every output.
6. **Config.** `render.vertical`, all optional:
   - `followMs` (400);
   - `deadZone` (0.1, as a share of the crop width);
   - `captionBand` (0.22).

## Acceptance criteria

- `render.formats: ["mp4", "mp4-vertical"]` writes both files, and both
  appear in `renders[]`. `--format mp4-vertical` alone writes only the
  vertical one.
- Plan-level tests:
  - the crop centre follows targets left, right and centre and clamps at the
    page edges;
  - moves under the dead zone are skipped;
  - the caption band and font size follow Decision 4;
  - `zoom` on a step composes with the crop.
- A real-run render test checks that the vertical MP4 is 1080×1920 and plays.
  Add it in a new spec file, not in `render.spec.ts` (#150 owns that file).
- Visual baselines: add a vertical scene.
- The JSON schema is regenerated, and the CLI help and README mention the
  format.
- `bun run check`, `bun run test` and `bun run build` are green, and so is
  the execution-plane matrix.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `packages/renderer/test/ffmpeg/render.spec.ts` | #150 | do not open |

## Open questions

None.

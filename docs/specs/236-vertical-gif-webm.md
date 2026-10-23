# Vertical GIF and WebM export

Issue: [#236](https://github.com/AndreyBegma/DemoFlow/issues/236)
Depends on: nothing. #176 (vertical MP4) and #133 (GIF and WebM) have landed.

## Summary

[Spec 176](176-vertical-export.md) added the vertical 9:16 MP4 and put
"Vertical GIF/WebM" out of scope with the note: "Add `gif-vertical` /
`webm-vertical` later in the same way." This is that slice. The renderer
already draws vertical frames (`frameAt(plan, frame, 'vertical')`) in their
own lane. Today that lane writes only `mp4-vertical`. After this issue it
also writes a vertical GIF and a vertical WebM, with the GIF and WebM encoder
settings of [spec 133](133-export-formats.md).

## Scope

### In scope

- `packages/core`: `gif-vertical` and `webm-vertical` in `RENDER_FORMATS`.
  The JSON schema is regenerated.
- `packages/renderer`: file names, the vertical lane writing any
  `*-vertical` format, the GIF size, and tests.
- `apps/cli/README.md`: the two formats.
- `apps/api/src/projects/projects.dto.ts` (`RUN_FORMATS`) and
  `apps/api/src/videos/video-relay.service.ts` (content types), so reports
  and playback accept them, with the matching cases in the existing tests.
- `apps/web/src/lib/playback.ts` (`FORMAT_ORDER`),
  `apps/web/src/components/player/run-playback.tsx` and
  `apps/web/src/i18n/en.ts`: play them on the run page.

### Out of scope

- Any change to the crop, the follow camera, captions, cards or masks of the
  vertical layout (spec 176).
- New config. `render.gif` and `render.vertical` are reused as they are.
- Square 1:1 and recording in a mobile viewport (spec 176, Out of scope).
- The website's docs pages.

## Decisions

1. **Names.** `gif-vertical` and `webm-vertical`, after `mp4-vertical`.
   Files: `render/<renderer>.vertical.gif` and
   `render/<renderer>.vertical.webm`, listed in `renders[]` like every format.
   `RENDER_FORMATS` becomes
   `['mp4', 'gif', 'webm', 'mp4-vertical', 'gif-vertical', 'webm-vertical']`.
   Appending keeps existing configs and results valid.
2. **Vertical WebM.** 1080×1920 at the run's fps, VP9 with the same options
   as the landscape WebM (spec 133). Only the size differs.
3. **Vertical GIF size.** The GIF's **height** is `render.gif.width`, and
   its width is `round(height × 9 / 16)`. With the default 800 that is
   450×800. Its fps is `render.gif.fps`.
   - *Why:* a vertical GIF then has the same pixel count per frame as the
     landscape one (800×450), so its size and the memory of its branch stay
     what spec 133 measured. Taking `gif.width` as the vertical GIF's width
     would give 800×1422, about 3.2 times the pixels, for a preview format.
   - It uses the same filter chain as the landscape GIF: `fps` → `scale`
     (lanczos) → `split` → `palettegen`/`paletteuse` per frame, looping
     forever.
4. **One vertical lane.** The vertical layout is still drawn once per frame.
   Every requested `*-vertical` file is a branch of that lane, the way the
   landscape lane feeds MP4, GIF and WebM today
   (`pipeline.ts`: `(file.format === 'mp4-vertical') === (layout ===
   'vertical')` becomes "the format ends in `-vertical`"). With no vertical
   format requested, the vertical lane does not run, as today.
5. **Encoder choice.** `webm-vertical` needs `libvpx-vp9` like `webm`. The
   check that picks a system FFmpeg over `ffmpeg-static` treats both the
   same (spec 133 Decision 8).
6. **API.** `RUN_FORMATS` gains the two names. Content types:
   `webm-vertical` → `video/webm`, `gif-vertical` → `image/gif`.
7. **Web.** `FORMAT_ORDER` becomes
   `['mp4', 'webm', 'mp4-vertical', 'webm-vertical', 'gif', 'gif-vertical']`.
   `gif-vertical` renders as an `<img>` like `gif`. `webm-vertical` passes
   `vertical` to the player like `mp4-vertical`. Labels: "Vertical WebM",
   "Vertical GIF".

## Acceptance criteria

- [ ] `render.formats: ["mp4", "gif-vertical", "webm-vertical"]` writes the
      three files in one render, and all three are in `renders[]`.
      `--format webm-vertical` alone writes only that file, and no landscape
      file.
- [ ] A real-run render test, in
      `packages/renderer/test/ffmpeg/vertical.spec.ts` or a new file beside
      it, probes the vertical WebM as 1080×1920 VP9 and the vertical GIF as
      450×800 at 12 fps, both with a duration within 100 ms of the vertical
      MP4.
- [ ] A plan-level test: `render.gif.width: 640` gives a 360×640 vertical
      GIF.
- [ ] `packages/core` tests accept the two names in `render.formats` and in
      `RunResult.renders[].format`. The JSON schema is regenerated.
- [ ] The API accepts a run report with the new formats and serves them with
      the right `Content-Type` (cases added to the existing integration
      tests).
- [ ] The run page offers both formats in `FORMAT_ORDER` order
      (`playback.test.mjs`).
- [ ] The CLI's `--format` help lists them (it reads `RENDER_FORMATS`), and
      the README names the two formats and their file names.
- [ ] `bun run check`, `bun run test` and `bun run build` are green, and so
      is the execution-plane matrix.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/api/src/projects/projects.dto.ts`, `apps/api/src/videos/video-relay.service.ts` | #236 (format lists only) | #233 works in `apps/api/**`. Rebase on whichever merges first. |
| `apps/web/src/i18n/en.ts`, `apps/web/src/components/player/run-playback.tsx` | #236 (two labels, two cases) | #235 adds the delete control there. Rebase on whichever merges first. |

## Open questions

None.

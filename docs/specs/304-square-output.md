# Square 1:1 export

Issue: #<issue>
Depends on: nothing. #176 (vertical MP4) and #236 (vertical GIF and WebM)
have landed.

## Summary

[Spec 176](176-vertical-export.md) and [spec 236](236-vertical-gif-webm.md)
put "Square 1:1" out of scope. Square is the feed format of LinkedIn, X and
Instagram posts. The renderer already draws a crop of the page that follows
each step's target (`verticalViewAt`, `followKeys`), and
`verticalCropSize(viewport, output)` already takes the output's aspect ratio.
This issue adds a second crop of that kind, 1:1, in its own lane, with the
same three encoders as the vertical lane.

## Scope

### In scope

- `packages/core`: `mp4-square`, `gif-square` and `webm-square` in
  `RENDER_FORMATS`; a `render.square` block. The JSON schema is regenerated.
- `packages/renderer`: file names, a square layout and lane, its follow keys,
  its caption band, the GIF size, and tests.
- `apps/cli/README.md`: the three formats and `render.square`.
- `apps/api`: `RUN_FORMATS` and content types, with matching test cases.
- `apps/web`: format order, labels, and a 1:1 player box on the run page.

### Out of scope

- Any change to the vertical or landscape output.
- Following on the vertical axis (a tall source, e.g. a phone viewport): that
  is #306. On a 16:9 source the square crop has the full
  height, so it only needs to move across, as the vertical crop does.
- Recording in a phone viewport (#305).
- The website's docs pages (#308).

## Decisions

1. **Names and files.** `mp4-square`, `gif-square`, `webm-square`, after the
   `-vertical` names. Files `render/<renderer>.square.mp4`, `.square.gif`,
   `.square.webm`. `RENDER_FORMATS` appends them, after the vertical ones.
   - *Why:* appending keeps every existing config and `RunResult` valid, and
     the suffix rule (`endsWith('-vertical')`) has a twin (`endsWith('-square')`).
2. **Size.** MP4 and WebM are 1080×1080 at the run's fps, with the encoder
   options of `mp4` and `webm` (spec 133). Only the size differs.
   - *Why:* 1080 is the side the feeds ask for and the vertical output's
     width, so captions and the crop scale the same.
3. **Square GIF size.** Side `round(render.gif.width × 3/4)`, rounded to an
   even number: 600×600 by default, 480×480 for `gif.width: 640`. Its fps is
   `render.gif.fps`; same filter chain as the other GIFs.
   - *Why:* the same pixel count per frame as the landscape GIF (800×450 =
     600×600), as spec 236 Decision 3 did for the vertical GIF, so GIF size
     and memory stay what spec 133 measured.
4. **Crop.** `verticalCropSize(viewport, { width: 1080, height: 1080 })`
   (rename it `cropSize`): the full source height and an equal width; on a
   source narrower than tall, its full width. It never leaves the page. No
   window frame and no background, like the vertical output. Per-step `zoom`
   (ADR-0012) applies inside the crop on the same keyframes.
   - *Why:* the 9:16 rules, unchanged, already give the right square crop; no
     new geometry to get wrong.
5. **Follow.** The square crop has its own follow keys: the same
   `followKeys` function, called with the square crop's width and
   `render.square`'s `followMs` and `deadZone`.
   - *Why:* the dead zone is a share of the crop width. A 1080-wide square
     crop and a 608-wide vertical one skip different moves; sharing keys
     would make one of them jitter or lag.
6. **Captions.** A band over the bottom `render.square.captionBand` of the
   frame (238 px at the default 0.22), the vertical caption's 48 px type,
   **at most 2 lines**, wrapped to the frame less the vertical margins.
   - *Why:* a 238 px band holds two 48 px lines with the panel's padding;
     three would overflow it. Same type size keeps the square and vertical
     videos of one run looking alike.
7. **Config.** `render.square`, all optional, the same fields, ranges and
   defaults as `render.vertical`: `followMs` (400), `deadZone` (0.1),
   `captionBand` (0.22). One schema in `project-config.ts`, exported as both
   `VerticalConfigSchema` and `SquareConfigSchema`. Used only when `formats`
   has a `*-square` format.
   - *Why:* a separate block means tuning the 9:16 band does not silently
     change the square one. Sharing the schema keeps one validation path and
     no new ranges to decide.
8. **Lanes.** The layout type becomes `'landscape' | 'vertical' | 'square'`.
   The pipeline runs one lane per layout that has a requested format; each
   requested file is a branch of its layout's lane. With no `*-square`
   format, the square lane does not run and nothing changes.
   `RenderPlan.square?: VerticalSpec` sits beside `RenderPlan.vertical`
   (rename the type `CropSpec`).
   - *Why:* this is spec 236 Decision 4 with one more lane; a run that asks
     for no square file pays nothing.
9. **Cards, transitions, masks** render in the square layout as in the
   vertical one (spec 176, Decision 5).
10. **API.** `RUN_FORMATS` gains the three names. Content types:
    `mp4-square` → `video/mp4`, `webm-square` → `video/webm`, `gif-square` →
    `image/gif`.
11. **Web.** `FORMAT_ORDER` (and `FORMAT_LABELS` in `run-details.tsx`)
    becomes `['mp4', 'webm', 'mp4-vertical', 'webm-vertical', 'mp4-square',
    'webm-square', 'gif', 'gif-vertical', 'gif-square']`. The player's
    `vertical: boolean` becomes `shape: 'landscape' | 'vertical' | 'square'`;
    square is `aspect-square max-w-md`. `gif-square` renders as an `<img>`.
    Labels: "Square MP4", "Square WebM", "Square GIF".
    - *Why:* a third boolean would allow "vertical and square"; one field
      cannot.

## Acceptance criteria

- [ ] `render.formats: ["mp4", "mp4-square", "gif-square", "webm-square"]`
      writes the four files in one render, all in `renders[]`.
      `--format mp4-square` alone writes only that file.
- [ ] `render.formats: ["mp4-vertical", "mp4-square"]` writes both; each crop
      follows with its own keys (Decision 5).
- [ ] Plan tests in `packages/renderer/test/plan/square.spec.ts`: a 1080×1080
      crop on a 1920×1080 viewport; follow left, right, centre and clamped;
      dead-zone skip; `zoom` composes; `gif.width: 640` → 480×480; a long
      caption is cut to 2 lines and its panel is inside the band.
- [ ] A real-run test in `packages/renderer/test/ffmpeg/square.spec.ts`
      probes 1080×1080 H.264, 1080×1080 VP9 and a 600×600 GIF at 12 fps, both
      within 100 ms of the square MP4's duration.
- [ ] A square scene in `packages/renderer/test/visual/scenes.ts` with its
      baseline.
- [ ] Core tests cover the names in `render.formats` and
      `RunResult.renders[].format`, and `render.square` defaults, ranges and
      unknown keys. The JSON schema is regenerated.
- [ ] API integration tests: a report with the new formats is accepted and
      served with the right `Content-Type`.
- [ ] The run page offers them in `FORMAT_ORDER` order (`playback.test.mjs`)
      and plays square ones in a 1:1 box.
- [ ] `--format` help lists them (it reads `RENDER_FORMATS`); the README
      names the formats, files and `render.square`.
- [ ] `bun run check`, `bun run test` and `bun run build` are green, and so
      is the execution-plane matrix.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `packages/renderer/src/plan/{plan,frame,types}.ts` | #304 | #306 depends on this issue and builds on its `cropSize`/`CropSpec`. |
| `packages/renderer/test/ffmpeg/render.spec.ts`, `vertical.spec.ts` | — | Do not open; new tests go in `square.spec.ts`. |
| `apps/web/src/i18n/en.ts`, `apps/api/src/projects/projects.dto.ts` | #304 (format lists only) | Any open api/web issue: rebase on whichever merges first. |

## Open questions

None.

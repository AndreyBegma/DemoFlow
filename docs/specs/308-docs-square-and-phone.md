# Docs: square formats and phone recording

Issue: #<issue>
Depends on: #304, #305, #306,
#307.

## Summary

[Spec 254](254-docs-vertical-formats.md) brought the docs pages in line with
the six formats of 176 and 236. After #304 there are nine, and a
`render.square` block; after #305 a scenario can be recorded as a
phone, and #306 and #307 change how such
a run looks. The code slices update `apps/cli/README.md` and the JSON schema
only, as 176 and 236 did. [Spec 179](179-docs-section.md), Decision 2, says
every docs page is written from the code; this issue does that.

## Scope

### In scope

- `apps/web/src/app/docs/config/page.mdx`: the render table, "Output
  formats", a `render.square` subsection.
- `apps/web/src/app/docs/cli/page.mdx`: the `--format` row.
- `apps/web/src/app/docs/mcp/page.mdx`: the `formats` row.
- `apps/web/src/app/docs/scenarios/page.mdx`: the `device` row and a "Record
  as a phone" section.
- `apps/web/src/app/docs/page.mdx` (Getting started): the sentence that
  mentions the vertical video.

### Out of scope

- Any change to behaviour, `packages/**`, `apps/cli/**`, `apps/api/**`.
- The docs sidebar and `en.ts`: no new page.
- `/docs/record` and `/docs/playwright`: `record --device` and test import
  are not part of this work.

## Decisions

1. **Formats list.** Every list names all nine, in `RENDER_FORMATS` order:
   `mp4`, `gif`, `webm`, `mp4-vertical`, `gif-vertical`, `webm-vertical`,
   `mp4-square`, `gif-square`, `webm-square`. Files
   `render/ffmpeg.square.{mp4,gif,webm}`.
   - *Why:* the order users see in `--format` help, which reads
     `RENDER_FORMATS`.
2. **Square sizes.** MP4 and WebM 1080×1080; the GIF's side is
   `round(render.gif.width × 3/4)` (600×600 by default, the landscape GIF's
   pixels). Captions: a band at the bottom, at most two lines.
3. **`render.square`.** Same three fields, ranges and defaults as
   `render.vertical` (`followMs` 400, 0–2000; `deadZone` 0.1, 0 ≤ x < 0.5;
   `captionBand` 0.22, 0 < x ≤ 0.5), separate from it; used only when
   `formats` has a `*-square` format. Copy the values from
   `SquareConfigSchema`, not from this spec.
4. **Phone section** on `/docs/scenarios`, short, in this order:
   - `device`: `"desktop"` (default) or `"phone"`;
   - a phone gets a 412×915 viewport unless `viewport` is set, touch, a
     mobile user agent, and the page's mobile `<meta name="viewport">`;
   - steps are the same; `click` taps;
   - the video shows taps (the click ring) and no cursor arrow;
   - the vertical and square crops follow targets up and down the page;
   - **softness:** the page is recorded at its CSS size, so a 412-wide page
     is upscaled about 2.6× to fill a 1080-wide vertical or square frame and
     looks softer than a desktop crop; the landscape video stays sharp.
   - *Why the softness note:* ADR-0010 is the reason, and a user who sees a
     soft phone video should find the answer in the docs, not file a bug.
5. **No example scenario beyond one snippet** (`device: "phone"` and one
   step), matching the page's existing style.

## Acceptance criteria

- [ ] `/docs/config` lists the nine formats with files and the square sizes,
      has a `square` row in the render table and a `render.square`
      subsection (Decision 3).
- [ ] `/docs/cli` (`--format`) and `/docs/mcp` (`formats`) list all nine.
- [ ] `/docs/scenarios` has the `device` row and the phone section
      (Decision 4), including the softness note.
- [ ] `/docs` mentions the square video beside the vertical one.
- [ ] Only the five `page.mdx` files change. `bun run check`,
      `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/src/app/docs/**/page.mdx` (five files) | #308 | Any open docs issue on the same pages: whichever merges second rebases. |

## Open questions

None.

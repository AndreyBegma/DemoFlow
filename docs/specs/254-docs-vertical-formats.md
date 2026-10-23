# Docs: the vertical formats and `render.vertical`

Issue: [#254](https://github.com/AndreyBegma/DemoFlow/issues/254)
Depends on: nothing. #176 (vertical MP4) and #236 (vertical GIF and WebM)
have landed.

## Summary

The site's documentation says a run renders `mp4`, `gif` and `webm`, "each at
most once". Since [176](176-vertical-export.md) and
[236](236-vertical-gif-webm.md), `RENDER_FORMATS`
(`packages/core/src/run-result.ts`) has six formats, and `render.vertical`
(`VerticalConfigSchema`, `packages/core/src/project-config.ts`) tunes the 9:16
crop. Both specs put the website's docs pages out of scope, and no page
mentions the vertical video. [Spec 179](179-docs-section.md), Decision 2,
says every docs page is written from the code. Today four pages disagree with
it. `apps/cli/README.md` already has correct text to start from.

## Scope

### In scope

- `apps/web/src/app/docs/config/page.mdx`: the "Output formats" section and a
  new `render.vertical` subsection.
- `apps/web/src/app/docs/cli/page.mdx`: the `--format` row.
- `apps/web/src/app/docs/mcp/page.mdx`: the `formats` row.
- `apps/web/src/app/docs/page.mdx` (Getting started): the sentence that
  mentions GIF and WebM.

### Out of scope

- Any change to behaviour, `packages/**`, `apps/cli/**` or `apps/api/**`.
- The docs sidebar and `en.ts`: no new page, so no new nav entry or string.
- A `demoflow render` section on the CLI page: that is #255's.
- Search, versioning and translations (spec 179).

## Decisions

1. **Formats list.** Every place that lists formats lists all six, in
   `RENDER_FORMATS` order: `mp4`, `gif`, `webm`, `mp4-vertical`,
   `gif-vertical`, `webm-vertical`. The config page gives each one's file:
   `render/ffmpeg.mp4`, `.gif`, `.webm`, `render/ffmpeg.vertical.mp4`,
   `.vertical.gif`, `.vertical.webm`.
   - *Why:* the CLI help builds its list from `RENDER_FORMATS`; the docs
     match it, so a reader sees one list everywhere.
2. **Vertical sizes**, from spec 176 and spec 236, Decisions 2–3: the
   vertical MP4 and WebM are 1080×1920; the vertical GIF's height is
   `render.gif.width` and its width is `round(height × 9 / 16)` (450×800 by
   default); its fps is `render.gif.fps`.
3. **`render.vertical`** gets a subsection under "Output formats" with a JSON
   example and one line per field, ranges and defaults taken from
   `VerticalConfigSchema`:
   - `followMs`: 0 to 2000, default 400;
   - `deadZone`: 0 up to (not including) 0.5, default 0.1;
   - `captionBand`: above 0, at most 0.5, default 0.22.

   It states that the page is still recorded at its normal size and that the
   section is used only when `formats` has a `*-vertical` format.
4. **Source of truth.** Where `apps/cli/README.md` and the code disagree,
   the code wins (spec 179, Decision 2). Note any README drift in the PR
   body; do not edit the README here.
5. **Tone and shape.** Match the surrounding sections: short sentences, one
   JSON example, no new components.

## Acceptance criteria

- [ ] `/docs/config` "Output formats" lists the six formats with their
      files, and no longer says only `mp4`, `gif` and `webm` exist.
- [ ] `/docs/config` has a `render.vertical` subsection with the three
      fields, their ranges and defaults (Decision 3) and the vertical sizes
      (Decision 2).
- [ ] `/docs/cli` (`--format`) and `/docs/mcp` (`formats`) list all six.
- [ ] `/docs` mentions the 9:16 video where it mentions GIF and WebM.
- [ ] Only the four `page.mdx` files change. `bun run check`,
      `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/src/app/docs/cli/page.mdx` | #254 (the `--format` row) | #255 adds a `demoflow render` section to the same page; different lines. Whichever merges second rebases. |
| `apps/web/src/app/docs/{page,config/page,mcp/page}.mdx` | #254 | No other open issue. |

## Open questions

None.

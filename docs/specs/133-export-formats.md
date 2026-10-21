# GIF and WebM export besides MP4

Issue: [#133](https://github.com/AndreyBegma/DemoFlow/issues/133) · Phase 4 ·
Roadmap: [Phase 4 — export formats](../product/roadmap.md#phase-4--video-quality)
· ADR-0004 (output defaults), ADR-0010 (source stays 1×)

## Summary

Today every run produces exactly one file: `render/ffmpeg.mp4`, H.264. The
roadmap's Phase 4 asks for GIF and WebM besides MP4. GIF is what the planned
GitHub Action posts as a preview in a pull request comment; WebM is the
open-web format. This slice adds both, chosen per project or per run, encoded
from the same compositor frames in one FFmpeg pass. The vertical 9:16
follow-camera is a later, separate slice.

## Scope

### In scope

- `render.formats` and `render.gif` in the project config (`packages/core`),
  and a `format` field on every entry of `RunResult.renders`.
- One FFmpeg encoder process per render with one output per requested format
  (`packages/renderer`).
- `demoflow run --format <f>` (repeatable) and an optional `formats` input on
  the MCP `generate` tool (`apps/cli`); every place that reads `renders[0]`
  shows every render instead.
- Tests and docs for all of the above.

### Out of scope

- Vertical 9:16 and the follow-camera (its own slice).
- The GitHub Action (`AndreyBegma/demoflow-action`, its own repository).
- Audio. Renders stay silent.
- Per-format size or fps for MP4 and WebM; they follow `render.width`,
  `render.height` and `render.fps`.

## Decisions

1. **Formats are an array in the config.** (owner, 2026-10-21)
   `render.formats: ("mp4" | "gif" | "webm")[]`, default `["mp4"]`, at least
   one, no duplicates. One run yields every requested file, which is what the
   GitHub Action needs (GIF preview plus MP4 artifact).
2. **One pass, several outputs.** (owner) The compositor's raw frames go into a
   single FFmpeg process that writes every requested output. No second render
   and no re-encoding of a finished MP4. An MP4 exists only when `mp4` is
   requested.
3. **GIF defaults: 800 px wide, 12 fps.** (owner) Configurable as
   `render.gif: { width, fps }`. Height follows the render's aspect ratio
   (rounded to an even number). The palette is generated and applied inside the
   same filtergraph (`split` → `palettegen` / `paletteuse`), so a GIF needs no
   second pass. GIFs loop forever.
4. **WebM is VP9.** (owner) Same width, height and fps as the MP4. No audio
   track.
5. **File names**: `render/ffmpeg.mp4`, `render/ffmpeg.gif`,
   `render/ffmpeg.webm`. (orchestrator) This keeps today's `<renderer>.<ext>`
   pattern from `renderPath` [Confirmed: `packages/renderer/src/renderer.ts`].
6. **Overrides.** (owner) `demoflow run --format gif --format mp4` and MCP
   `generate` with `formats: ["gif"]` replace `render.formats` for that run.
   Neither merges with the config.
7. **A format that fails to encode fails the run**, in the `rendering` stage,
   with an error naming the format and the reason. (owner) A partial set of
   files is never reported as success (vision: success is never "an MP4
   exists"; `deriveRunStatus` already fails the run on any failed stage
   [Confirmed: `packages/core/src/run-result.ts`]).
8. **System FFmpeg only when it has every encoder the run needs.** (orchestrator)
   `resolveFfmpeg` today accepts a system `ffmpeg` only if it lists `libx264`
   [Confirmed: `packages/renderer/src/plan/ffmpeg.ts`]. It must also require
   `libvpx-vp9` when `webm` is requested (GIF needs only built-in filters and
   the `gif` encoder); otherwise it falls back to `ffmpeg-static`.
9. **Every render is reported, in `formats` order.** (owner)
   `RunResult.renders[i].format` is `"mp4" | "gif" | "webm"`. The CLI's run
   summary and the MCP views list every file. The first entry is the primary
   one wherever a single file is needed.

ADR-0004 states "Output defaults: 1920×1080, 30 fps, H.264 in MP4. Size and
frame rate are configurable." This slice keeps that default (`["mp4"]`) and
adds optional formats. It needs no new ADR.

## Configuration

```jsonc
// demoflow.config.json
{
  "render": {
    "formats": ["mp4", "gif"],      // default ["mp4"]
    "gif": { "width": 800, "fps": 12 } // defaults shown; used only when "gif" is in formats
  }
}
```

- `formats`: non-empty, unique, each one of `mp4`, `gif`, `webm`.
- `gif.width`: integer, 160 to `render.width`. `gif.fps`: integer, 1 to
  `render.fps`.
- `RenderConfigSchema` is a `strictObject` [Confirmed], so both keys are added
  to it. The JSON schemas in `packages/core/schemas/` are regenerated.

## Data

`RenderOutputSchema` (`packages/core/src/run-result.ts`) gains
`format: "mp4" | "gif" | "webm"`. Existing fields (`file`, `durationMs`,
`sizeBytes`, `width`, `height`, `fps`) describe that file. For a GIF, `width`,
`height` and `fps` are the GIF's own values.

## Renderer

- `OutputSpec` (`packages/renderer/src/plan/types.ts`) carries a list of
  outputs, each with its format and settings, instead of the literal
  `codec: 'h264'` / `faststart: true` fields.
- `startEncoder` (`packages/renderer/src/ffmpeg/pipeline.ts`) builds one
  `-filter_complex` that splits the raw `rgb24` stream once per output:
  - **mp4**: today's settings, unchanged: `libx264 -preset medium -crf 18
    -pix_fmt yuv420p`, BT.709 tags, `+faststart`;
  - **webm**: `libvpx-vp9`, constant quality (`-crf` with `-b:v 0`),
    `yuv420p`, BT.709 tags, multithreaded (`-row-mt 1`). The exact CRF and
    speed are the slot's to pick and to state in the PR, with the measured file
    size and encode time on the fixture demo;
  - **gif**: `fps` → `scale` (lanczos) → `split` → `palettegen` /
    `paletteuse`, `-loop 0`.
- `recordRender` probes every output and writes one `renders` entry per file.
  A GIF is probed for width, height, duration and frame rate. Its codec is
  not compared.

## CLI and MCP

- `demoflow run --format <mp4|gif|webm>`, repeatable. An unknown value is a
  usage error before the run starts.
- MCP `generate` input: optional `formats` (same enum, non-empty, unique).
- The run summary, `--json` output and the MCP views (`apps/cli/src/mcp/view.ts`,
  `readonly.ts`) list every render's format and path in order. Today they read
  only `renders[0]` [Confirmed]. A view that shows one file shows the first.

## Acceptance criteria

- [ ] With no `formats` in the config, a run produces only
      `render/ffmpeg.mp4`, byte-for-byte the same encoder settings as today.
      The existing `render.spec` assertions (1920×1080, 30 fps, h264, yuv420p,
      BT.709, duration within 100 ms) still pass.
- [ ] `formats: ["mp4", "gif", "webm"]` produces all three files in one encoder
      process (one `ffmpeg` spawn for the render, asserted in a test). The MP4
      matches the previous criterion. The WebM probes as VP9, 1920×1080, 30 fps,
      duration within 100 ms of the MP4. The GIF probes as 800 px wide, height
      by aspect, 12 fps, duration within 150 ms.
- [ ] `formats: ["gif"]` produces only the GIF, with no MP4 on disk.
- [ ] The fixture demo's GIF at defaults is under 10 MB. The size is stated in
      the PR.
- [ ] `result.json` lists one `renders` entry per format, in `formats` order,
      each with its `format`. The schema rejects an entry without it.
- [ ] Config validation rejects `formats: []`, a duplicate, an unknown format,
      `gif.width` above `render.width`, and `gif.fps` above `render.fps`. Each
      error names the field.
- [ ] `demoflow run --format gif` renders only the GIF regardless of the config.
      `--format avi` exits with a usage error before Chromium starts.
- [ ] MCP `generate` with `formats: ["webm"]` renders only the WebM, and its
      result view lists the WebM path. The MCP result for a multi-format run
      lists every path.
- [ ] A failing format encode (simulated, e.g. an encoder the binary lacks)
      fails the `rendering` stage with a message naming the format. The run
      status is `failed`.
- [ ] `resolveFfmpeg` skips a system FFmpeg without `libvpx-vp9` when `webm` is
      requested, and uses `ffmpeg-static` (unit test with a stubbed
      `-encoders` listing).
- [ ] `execution-plane` is green on Linux, macOS and Windows. The VP9 and GIF
      outputs are exercised on all three, proving `ffmpeg-static` 5.3.0 ships
      `libvpx-vp9` on each `[Unknown]`.
- [ ] `README.md` no longer lists GIF/WebM as not built. The config docs show
      `formats` and `gif`.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i133 | export formats, end to end | packages/core/**, packages/renderer/**, apps/cli/**, README.md, docs/guides/** | — | yes | opus |

One slot. The core schema, the encoder and the CLI views form one contract,
and each part is small. Split, they would serialize on `packages/core` anyway.
`opus`, because the multi-output filtergraph is new here and VP9 availability
in `ffmpeg-static` on all three OSes is unverified.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/core/src/project-config.ts, packages/core/src/run-result.ts, packages/core/schemas/** | i133 | do not open |
| packages/renderer/src/ffmpeg/pipeline.ts, packages/renderer/src/plan/** | i133 | do not open (a 9:16 slice comes after this merges) |
| bun.lock | nobody: no new dependency | — |

## Risks

- **`ffmpeg-static` lacks `libvpx-vp9` on one OS** (medium). Mitigation: an
  acceptance criterion runs WebM on all three OSes. If one lacks it, the slot
  stops and reports the binary matrix. It does not add a dependency.
- **Encode time grows with three outputs** (low). VP9 is slower than x264.
  Mitigation: the PR states encode time for the fixture demo per format. The
  default stays MP4 only, so existing runs are unaffected.
- **One slow output stalls the shared pipe** (low). FFmpeg backpressures stdin
  across outputs. Mitigation: the existing stall handling in the pipeline
  applies unchanged. A test renders all three under the real-run suite.

## Open questions

- None. Default for an unsettled detail: keep today's MP4 behaviour exactly,
  and put new behaviour behind `formats`.

# ADR-0010: The source video is recorded at the viewport size (1×)

Status: accepted · Date: 2026-10-18 · Supersedes: [ADR-0004](0004-recording-is-separate-from-rendering.md) §1's premise that the recording has device pixels "so zoom has pixels to spend"

## Context

ADR-0004 §1 records the browser at `deviceScaleFactor: 2` "so zoom has pixels to
spend": the renderer's camera zooms into the source, and a source at device
pixels would keep text sharp at 1.6× zoom. Four ways to get such a source were
tried, on Linux, macOS and Windows CI:

- **`recordVideo` with a larger `size`** (#17) — Playwright pads the
  viewport-sized frame into a corner of the larger canvas instead of upscaling.
  Shipped by mistake and reverted (#47).
- **A CDP screencast** (#82) — frames are DIP-sized (1280×720 for a 1280×720
  viewport at DPR 2), with or without its own `Emulation.setDeviceMetricsOverride`
  (#85, candidate 0).
- **A screenshot loop** (#85, candidate 1) — screenshots are at device pixels,
  but at most ~15.7 distinct frames per second on Linux and Windows runners, and
  a device-scale clip from a second CDP session clears Playwright's DPR
  emulation (the page lays out at the doubled size).
- **A doubled viewport with CSS `zoom: 2`** (#85, candidate 2) — frames are
  2560×1440, but the layout is not equivalent (`100vw` doubles, a `2xl`
  breakpoint fires, scrollbars shift boxes) and `recordVideo` drops to 8–12 fps
  on a busy page.

Reports: [82](../research/82-cdp-capture-spike.md),
[85](../research/85-device-pixel-capture-spike.md).

## Decision

1. **The source video is recorded at the viewport size** (`recordVideo.size =
   viewport`), the 1× capture on `develop` since #47.
2. **The page still renders at `deviceScaleFactor: 2`** — screenshots
   (`screenshot` steps) keep device pixels, and the timeline records the factor.
3. **The renderer zooms the 1× source** with its existing rule (1.25× maximum on
   a 1× source).
4. **The question is reopened only by new evidence**: a Chromium or Playwright
   release that offers a device-pixel video or screencast. The screencast-size
   probe in `packages/engine/test/capture-spike/` fails when that happens.

## Consequences

- Zoomed text is softer than a 2× source would allow; the 9:16 follow-camera
  (roadmap, Phase 4) works on the 1× source and is softer still.
- Frame, background, cards, transitions and GIF/WebM export (Phase 4) are
  unaffected.
- No second capture path to maintain; the prototypes were removed before merge.

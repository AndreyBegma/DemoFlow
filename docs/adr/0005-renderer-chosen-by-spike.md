# ADR-0005: Renderer — Remotion or an FFmpeg compositor, chosen by a spike

Status: proposed · Date: 2026-10-17

## Context

Two credible ways to turn the source video and timeline of ADR-0004 into a
polished MP4:

- **Remotion** — the video is a React composition rendered frame by frame in
  headless Chromium. Zoom, pan, cursor and captions are components. Its
  licence is free for individuals and companies of up to three people and
  paid beyond that; the runner would ship it to every user.
- **An FFmpeg compositor of our own** — cursor, zoom and overlays computed
  from the timeline and applied with FFmpeg filters (or frames composited in
  Node and piped to FFmpeg). No licence, full control, more code.

The owner decided (2026-10-17) to build both on the same source and choose
after watching the results.

## Decision

Pending. The renderer spike produces both videos of the same fixture
scenario, a comparison (render time, output size, install footprint and
friction on Linux, macOS and Windows, licence terms read from the source,
visual quality), and a recommendation. **The owner chooses**; this record is
then amended to `accepted` with the choice and its reasons.

## Consequences

Until it is accepted, `@demoflow/renderer` exposes both behind one interface,
and nothing outside the package may depend on either implementation.

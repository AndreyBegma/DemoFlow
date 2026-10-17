# ADR-0005: Renderer — the FFmpeg compositor, chosen by a spike

Status: accepted · Date: 2026-10-17

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

**The FFmpeg compositor** (`packages/renderer/src/ffmpeg/`). The owner chose it
on 2026-10-17 after watching both renderers' videos of the four fixture runs
side by side ([#4](https://github.com/AndreyBegma/DemoFlow/issues/4)), for the
reasons of the spike's recommendation below: the licence, the install
footprint, and equal render time. Remotion is removed from
`@demoflow/renderer` ([#24](https://github.com/AndreyBegma/DemoFlow/issues/24)).

The compositor's text is the accepted weakness: an ASCII-only stroke font,
and sizes 1.4× too large. The sizes are fixed in #24; real font rendering
([#25](https://github.com/AndreyBegma/DemoFlow/issues/25)) lands before Phase 4.

## Consequences

- `@demoflow/renderer` ships one renderer. The `Renderer` interface stays, so
  a second implementation can return behind it if Phase 4 needs browser layout.
- `demoflow` installs no Remotion packages, downloads no browser to render and
  carries one FFmpeg (`ffmpeg-static`).
- We own the compositor (about 1 190 lines) and its text rendering.

## Recommendation (spike, 2026-10-17)

The spike recommends **the FFmpeg compositor**. The evidence is in
[the spike report](../research/renderer-spike.md). This is a recommendation,
not the decision: the status stays `proposed` until the owner has watched both
videos and chosen.

Reasons:

- **Licence.** Remotion's licence (4.0.532, quoted in the report) requires a
  Company License for any for-profit organisation of more than 3 employees.
  DemoFlow runs the renderer on its users' machines. Our reading, not a fact:
  the users' companies would need that licence too. The compositor has no
  third-party terms.
- **Install.**
  - Remotion adds 176 packages and 196 MB through npm (23 packages and 34 MB
    with a prebuilt bundle).
  - It also downloads Chrome Headless Shell (91.9 MB) on the first render, and
    ships a second FFmpeg.
  - The compositor adds nothing beyond `ffmpeg-static`, which the render plan
    needs anyway.
- **Render time.** Equal within noise: 3–8 s for 2–6 s videos on both. The
  compositor has no bundle step and no first-run download.
- **Quality.**
  - Both draw the same render plan, and their frames match apart from text
    (SSIM 0.95–0.998).
  - Remotion's text is a normal anti-aliased sans. The compositor's is a thin
    ASCII-only stroke font.
  - That is the compositor's one real weakness. Real font rendering in
    JavaScript is the next work for it.
- **Maintenance.** We own about 1 190 lines of compositor code. The render
  plan carries the hard part, so the cost is bounded.

This would change if Remotion confirms that a licence we buy covers our users.
It would also change if the owner rejects the compositor's text and real
fonts prove expensive, or if Phase 4 needs browser layout.

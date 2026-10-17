# ADR-0004: Recording is separate from rendering

Status: accepted · Date: 2026-10-17

## Context

The renderer is the product's differentiator (vision §5): animated cursor,
click emphasis, zoom and pan, transitions, captions, removal of pauses. The
same source must be renderable again in another style without rerunning the
scenario, and visual effects must never make a failure look like a success.

## Decision

1. **Capture = Playwright video + a timeline.** The engine records the
   browser with Playwright's `recordVideo` at a 1920×1080 viewport and
   `deviceScaleFactor: 2`, so zoom has pixels to spend. Alongside it, it
   writes `timeline.json`: for every step, start and end times relative to the
   video's first frame, the target's bounding box, pointer coordinates, scroll
   offsets, the assertion result and a masked flag; plus screenshots taken by
   `screenshot` steps and marker events.
2. **The real mouse moves.** Before `click` and `hover`, the engine moves the
   pointer to the target's centre in steps, so hover states and tooltips
   happen for real and are in the recording. The renderer draws the cursor
   along the same coordinates. The OS cursor is not in Playwright's video.
3. **Every stage has its own status**, reported separately in `result.json`:
   `readiness`, `execution`, `verification`, `recording`, `rendering`,
   `storage`. The run status is derived from them. A run is never `completed`
   because an MP4 exists.
4. **A failed run is still rendered, visibly failed.** The video runs to the
   moment of failure and ends on a card "Verification failed at step N: …",
   with a FAILED watermark throughout; the run status is `failed`.
5. **Pauses.** The renderer compresses idle stretches longer than 1 s to
   400 ms. Idle means no timeline event and no visual change in the frame;
   waiting on the network or a spinner is not idle. `result.json` keeps the
   real durations. Both thresholds are configurable.
6. **Output defaults**: 1920×1080, 30 fps, H.264 in MP4. Size and frame rate
   are configurable.
7. **Artifacts** go to `<home>/runs/<runId>/`, where `<home>` is resolved in
   this order: `--out` flag, `DEMOFLOW_HOME`, the project's
   `demoflow.config.json`, the global config, then the OS data directory
   (`$XDG_DATA_HOME/demoflow` or `~/.local/share/demoflow`;
   `~/Library/Application Support/demoflow`; `%LOCALAPPDATA%\demoflow`).

## Consequences

- Rendering can be retried or restyled from `runs/<runId>/` alone.
- The timeline contract in `@demoflow/core` is what both renderers and every
  later style depend on; changing it is a versioned change.
- Whether Playwright's video at `deviceScaleFactor: 2` is sharp enough for a
  2× zoom is verified by the renderer spike (ADR-0005).

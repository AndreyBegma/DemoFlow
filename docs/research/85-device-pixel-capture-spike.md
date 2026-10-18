# Device-pixel capture spike: screenshots, or a large viewport with CSS zoom

Issue: [#85](https://github.com/AndreyBegma/DemoFlow/issues/85) ·
Spec: [85-device-pixel-capture-spike](../specs/85-device-pixel-capture-spike.md) ·
Builds on: [82-cdp-capture-spike.md](82-cdp-capture-spike.md) ·
Decisions: [ADR-0004](../adr/0004-recording-is-separate-from-rendering.md) §1

**Outcome: no candidate passes. The source stays 1×, and a new ADR should say
so, superseding ADR-0004 §1's "so zoom has pixels to spend".**

The spike measured three ways to get a `viewport × 2` source against #82's
Decision 1, on Linux, macOS and Windows CI, in one measurement round each.
Every candidate failed at least one criterion clearly in round 1, so the time
box (Decision 1: at most two rounds, no tuning of a clear failure) ended it
there.

| Candidate | What fails it |
|---|---|
| 0. Screencast on a session with its own device metrics | Frames stay CSS-sized (1280×720) on every OS. Nothing else can be measured. |
| 1. Pipelined `Page.captureScreenshot` with a device-scale clip | The clip breaks the page under test: the page drops to `devicePixelRatio` 1 and lays out at 2560×1440 CSS px. Even on an undisturbed page, distinct frames stay ≤ 15.7 fps on Linux and Windows CI, however many requests are in flight. |
| 2. Viewport 2560×1440 at 1×, page zoomed 200% | Layout differs from 1× on every scenario, as the spec's risk predicted. `100vw` and `min-width` media queries see the doubled viewport, and the scrollbar does not zoom. Frame rate also falls to 7.9–12.5 fps on `customers`. |

## Method

- **Switch:** `DEMOFLOW_CAPTURE=screenshots | zoomed` (`RunOptions.capture`
  wins), engine-only. Without it, `recordingOptions` returns exactly what it
  did before, and every default suite is unchanged. `screenshots` needs
  `DEMOFLOW_FFMPEG`, an FFmpeg with libvpx, supplied by the caller. CI passes
  the renderer's `ffmpeg-static`. No dependency was added.
  - `screenshots` (`packages/engine/src/execute/screenshot-recorder.ts`): a
    second CDP session sends `Page.captureScreenshot` (JPEG q90, viewport
    clip at `scale: 2`, `captureBeyondViewport: false`) from
    `DEMOFLOW_CAPTURE_INFLIGHT` workers (default 3). Each frame is stamped at
    the request's midpoint, and byte-identical consecutive frames are
    dropped. After the run the frames are encoded to a 25 fps VP8 WebM with
    Playwright's own encoder settings, so encoding never competes with the
    steps. The session is reopened on every main-frame navigation: a
    navigation that swaps the renderer leaves it detached, and its
    screenshots then hang for about 2 minutes.
  - `zoomed` (`recording.ts`, `zoom.ts`): context viewport 2W×2H at
    `deviceScaleFactor: 1`, with `recordVideo` at 2W×2H. An adopted stylesheet
    `html { zoom: 2 !important }` is injected before any page script, on
    every document. The pointer starts at the zoomed centre. At the end,
    every box, point and scroll offset in the timeline is divided by 2, so
    the timeline is in the scenario's CSS pixels with `deviceScaleFactor: 2`,
    as for a native 2× source.
- **Harness** (`packages/engine/test/capture-spike/device-pixel.spec.ts`,
  skipped unless `DEMOFLOW_CAPTURE_SPIKE=1`): every fixture scenario
  (customers, login, tour, failing) is recorded at 1× (`video`) and in the
  mode, in the same job. An init script moves a 24 px block in the
  bottom-left corner every animation frame, so the page always has a new
  frame (#82's probe page, on the real fixture).
  - **Effective fps / longest gap during steps:** the WebM decoded to 320×180
    grey. A frame counts as new when the block's strip moved, with
    ≥ 4 pixels changed by > 24 levels; VP8 never repeats a frame byte for
    byte. Measured from step 0's start to the last step's end.
  - **Sharpness:** the mean Sobel magnitude of a fixed text region (heading,
    search row, first rows of `customers`, 740×260 CSS px), in the frame at
    step 4's start, scaled to 1.6× its CSS size with lanczos. The figure is
    the ratio of the mode's value to the 1× source's. Samples are uploaded
    as PNGs.
  - **Layout equivalence:** after every step, the target box from the
    timeline (already divided by the zoom) is compared with 1× within 1 px.
    So are `innerWidth`/`innerHeight`, root `scrollWidth`/`scrollHeight` and
    the width of a `100vw` element, each divided by the zoom. `matchMedia` is
    checked for every `@media` condition found in the page's stylesheets
    plus 640/768/1024/1280/1536 px, and must give the same answers. The
    check also ran for `screenshots`, because the recorder must not disturb
    the page.
  - **Sync mark, #19/#48 offset test, #73 layout check:** the renderer's own
    real-run suites (`build.spec`, `sync-mark.spec`, `render.spec`), run
    unchanged with `DEMOFLOW_CAPTURE` set. They record through `runScenario`.
  - **CI time:** that renderer step's duration, against the `video`
    dispatch.
- **Probe** (`screencast-size.spec.ts`, #82's, extended): on the animated
  probe page, a second session sets the metrics Playwright sets itself
  (viewport, screen, `deviceScaleFactor: 2`, orientation). Then:
  - candidate 0: a screencast for 3 s, with `devicePixelRatio` read while it
    runs;
  - candidate 1, raw: bare screenshots for 3 s each at 1, 2, 3 and 4 in
    flight, counting replies and distinct frames.
- **CI:** `execution-plane` dispatched with `cdp_spike: true` and the new
  `capture` input, on `ubuntu-latest` (4 vCPUs), `macos-latest` (arm64, 3)
  and `windows-latest` (4). Playwright 1.64.1. One round per candidate.

| Dispatch | Run |
|---|---|
| `screencast-probe` (candidates 0 and 1 raw) | [39157200582](https://github.com/AndreyBegma/DemoFlow/actions/runs/39157200582) |
| `video` (1× baseline, CI time) | [39157206354](https://github.com/AndreyBegma/DemoFlow/actions/runs/39157206354) |
| `screenshots` | [39157212351](https://github.com/AndreyBegma/DemoFlow/actions/runs/39157212351) |
| `zoomed` | [39157170643](https://github.com/AndreyBegma/DemoFlow/actions/runs/39157170643) |

Each job uploads `cdp-spike-<capture>-<os>`. It holds the harness JSON, the
renderer suites' JSON (Linux and macOS; Windows wrote none, so its results
come from the job log) and the sharpness sample PNGs.

## What a second CDP session's screenshot does (corrects #82)

#82 found that a bare `Page.captureScreenshot` is CSS-sized and that a
device-scale clip fixes it. The size is right. The mechanism, measured here,
is not what #82 suggested, and the fix has a cost:

1. A screenshot answers in the **calling session's** device metrics. Playwright
   sets `deviceScaleFactor: 2` on its own session. A second session has no
   metrics, so its bare shot is 1280×720 while the page reports
   `devicePixelRatio` 2.
2. With a clip at `scale: 2`, the shot is 2560×1440 and truly rasterised at
   that scale, not upscaled. But Chromium then **clears the page's device
   emulation**, which is Playwright's. The page falls to `devicePixelRatio` 1
   and lays out at the window size. On the fixture that was 2560×1440 CSS px,
   so every target box moved by 640 px (all 16 `screenshots` jobs' layout
   checks).
3. If the second session sets the same metrics itself, a bare shot is
   2560×1440 and the page stays at `devicePixelRatio` 2. But Playwright's
   clicks then fail: `<header> intercepts pointer events`, every time,
   locally, whether the context was at 1× or 2×. The cause was not chased,
   because the rate below already decides candidate 1.

`page.screenshot()` avoids all three because it runs on Playwright's own
session. But Playwright serialises a page's screenshots, so it cannot be
pipelined: 5.3–15 fps on CI (probe).

A note "Correction (#85)" in #82's report points here.

## Candidate 0: the screencast with its own device metrics

| OS | Mode | Frame | fps · longest gap | `devicePixelRatio` while casting |
|---|---|---|---|---|
| Linux | headless shell / new headless | **1280×720** | 59.7 · 17 ms | 2 |
| macOS | headless shell | **1280×720** | 25.3 · 67 ms | 2 |
| macOS | new headless | **1280×633** | 19.7 · 500 ms | 2 |
| Windows | headless shell / new headless | **1280×720** | 60.0 · 17 ms | 2 |

The screencast is sized in DIPs whatever the session's metrics, and the page
was at 2× throughout. #82's central result stands. **Fails Decision 1's first
criterion by construction**, as #82's did.

## Candidate 1: pipelined screenshots

### Raw rate on an undisturbed page (probe, the session's own metrics)

Distinct frames per second (replies per second), and the longest gap between
distinct frames. All frames were 2560×1440, and the page stayed at
`devicePixelRatio` 2.

| OS · mode | 1 in flight | 2 | 3 | 4 |
|---|---|---|---|---|
| Linux · shell | 15.7 (15.7) · 68 ms | 15.0 (30.0) · 77 | 12.3 (36.0) · 93 | 10.3 (41.0) · 102 |
| Linux · new | 15.3 (15.3) · 68 | 15.0 (30.0) · 76 | 12.0 (36.0) · 94 | 9.7 (38.7) · 118 |
| macOS · shell | 12.3 (12.3) · 146 | 23.7 (24.7) · 147 | 27.0 (35.0) · 158 | 26.0 (44.7) · 95 |
| macOS · new | 9.7 (9.7) · 180 | 13.0 (15.3) · 175 | 15.3 (22.3) · 179 | 8.3 (20.0) · 283 |
| Windows · shell | 14.7 (14.7) · 95 | 14.0 (28.0) · 92 | 10.3 (29.3) · 124 | 9.0 (29.3) · 151 |
| Windows · new | 15.0 (15.0) · 75 | 13.3 (26.3) · 85 | 10.3 (30.3) · 110 | 8.0 (32.0) · 136 |

#82's open question was whether the extra replies are distinct frames or the
same frame repeated. **On Linux and Windows they are repeats.** More requests
in flight raise the replies and lower the distinct rate, which tops out at
about 15 fps, the one-at-a-time rate. Only macOS's headless shell passes
25 fps (27.0 at 3 in flight). That is on a probe page with nothing else
running, and 25 fps has to hold on every OS.

### On the fixture (engine prototype, clip at `scale: 2`, 3 in flight)

| OS | Replies/s per scenario (cust/login/tour/failing) | Steps vs 1× | Renderer suites |
|---|---|---|---|
| Linux | 17.4 / 29.3 / 27.1 / 24.7 | 1.38 / 1.76 / 1.17 / 1.01 | 20 of 22; #73 layout check fails on `customers` |
| macOS | 15.7 / 40.4 / 35.9 / 38.7 | 1.78 / 1.35 / 0.98 / 1.01 | 19 of 22; #73 fails; the frozen-wait compression test fails (2668 ms > 2000) |
| Windows | 12.2 / 20.5 / 21.9 / 20.8 | 2.03 / 1.99 / 1.49 / 1.03 | #73 fails on `customers`; the frozen-wait test fails (from the log) |

Here the page under test is the one in §"What a second CDP session's
screenshot does", point 2. It runs at `devicePixelRatio` 1 with a 2560×1440
layout, the clip shows its top-left quarter, and the harness's animated
block falls outside the frame. So effective-fps figures from the video are
meaningless for this mode, and the table gives reply rates instead.
Sharpness ratios of 0.22–0.29 measure the wrong picture, not the capture.
The sync mark was found on every run: it fills the frame.

## Candidate 2: large viewport + CSS zoom

| OS | Effective fps (cust/login/tour/failing) | Longest gap, ms | Same at 1× | Steps vs 1× | Sharpness ratio |
|---|---|---|---|---|---|
| Linux | **7.9** / 23.7 / 23.6 / 24.6 | **400** / 120 / **240** / 120 | 18.8 / 24.5 / 23.6 / 24.8 · 240 / 80 / 200 / 80 | **3.18** / 1.33 / 1.41 / 1.00 | 1.30 (frames not aligned, see below) |
| macOS | **9.7** / 22.2 / 19.5 / 23.3 | **640** / 120 / **280** / **240** | 23.2 / 21.4 / 20.9 / 22.2 · 120 / 120 / 200 / 120 | 1.95 / 1.02 / 1.14 / 1.01 | 1.30 |
| Windows | **12.5** / 24.3 / 24.1 / 24.8 | **280** / 80 / 120 / 80 | 23.3 / 24.6 / 24.4 / 24.9 · 240 / 80 / 120 / 80 | **2.11** / 1.72 / 1.35 / 1.03 | **1.01** |

- **Source:** 2560×1440 on every OS. The renderer's #73 layout check passes
  on the rendered `customers` and `failing` runs on all three OSes.
- **Sync mark and #19/#48 offset test:** pass on all three OSes. In the
  renderer suites the one failure everywhere is
  `records the source at the viewport size (1×), so the zoom is 1.25`,
  which asserts the current 1× contract and is expected to fail on a 2×
  source.
- **Layout equivalence: fails on every scenario and OS** (14–59 differences
  per scenario). Breaking them down, from Linux `customers`:
  - `100vw` is 2560 CSS px instead of 1280, so `scrollWidth` changes with
    it;
  - `matchMedia('(min-width: 96rem)')` and `(min-width: 1536px)` answer
    true instead of false: the fixture's Tailwind `2xl` breakpoint fires;
  - every centred box moves by 3.75 px. The classic scrollbar keeps its
    15 device pixels instead of zooming to 30, so the layout is 7.5 CSS px
    wider.
  - `devicePixelRatio` is 1, so `srcset` and canvas content are picked for
    1× and then shown at 2×.
- **Frame rate:** at 2560×1440, Playwright's own recorder falls to 7.9–12.5
  effective fps on `customers`, the glass-heavy scenario, and the steps take
  up to 3.2× longer there.
- **Sharpness:** the metric did not settle it. On Windows the two samples
  show the same state, and the ratio is 1.01 although the zoomed text looks
  crisper. On Linux and macOS the 1× frame at step 4's start still shows the
  search text "Ada" while the zoomed one has already cleared it, so 1.30
  compares different pictures. Mean Sobel magnitude also rewards the
  ringing that lanczos upscaling and VP8 add to the 1× source. A better
  metric was not built, because the candidate already fails three other
  criteria.

## Against Decision 1 (and the spec's layout check)

| Criterion | 0 · screencast | 1 · screenshots | 2 · zoomed |
|---|---|---|---|
| `viewport × 2` source, content in every quadrant (#73) | **Fails**: 1280×720 frames | **Fails**: 2560×1440, but #73 fails on `customers` on every OS because the page is disturbed | Passes on all three OSes |
| Text sharper at 1.6× zoom, ≥ 1.5× the 1× value | Fails by construction (no extra pixels) | Not measurable (wrong picture) | **Not shown**: 1.01 on aligned frames (Windows); 1.30 on misaligned ones |
| 25 fps, no gap > 200 ms during steps, every run | Not measured | **Fails**: ≤ 15.7 distinct fps on Linux and Windows even undisturbed; reply gaps 105–435 ms on the fixture | **Fails**: 7.9–12.5 fps and 280–640 ms gaps on `customers` |
| Renderer finds the sync mark; #19/#48 offset test passes | Not measured | Passes, but on a disturbed page | **Passes** on all three OSes |
| Real-run CI time ≤ 2× the 1× baseline | Not measured | **Fails** on Linux and Windows: 177 / 157 / 247 s vs 71 / 105 / 82 s (2.49× / 1.50× / 3.01×) | Passes: 123 / 166 / 113 s vs 71 / 105 / 82 s (1.73× / 1.58× / 1.38×) |
| Layout equivalent to 1× (spec 85, candidate 2) | — | **Fails**: 16–86 differences per scenario | **Fails**: 14–59 differences per scenario; `100vw`, a breakpoint, the scrollbar |
| Playwright's actions still work | — | Fail with the session's own metrics (clicks intercepted) | Pass |

CI times are the renderer real-run step (Linux / macOS / Windows), from the
runs above.

**No candidate meets every criterion. The source stays 1×.**

## Findings worth keeping

- **The 1× source already misses the frame-rate bar on a glass-heavy page.**
  The animated block's measure gives `customers` at 1×, Playwright's
  `recordVideo` at 1280×720, 18.1–23.6 effective fps, with 200–240 ms gaps
  on Linux and Windows CI. Decision 1's "25 fps, no gap > 200 ms" is not met
  by today's capture either. Any future candidate should be compared with
  that figure, not with a nominal 25.
- **A second CDP session's screenshot clears Playwright's emulation** when it
  uses a clip (above). Anything that takes screenshots behind Playwright's
  back has to account for it. The engine does not do that today.
- **A CDP session dies with the renderer.** A navigation that swaps the
  renderer process leaves a `newCDPSession(page)` session detached. Its
  calls do not reject; they hang for about 2 minutes. Reopen it on
  main-frame navigation.
- **CSS zoom is not layout-neutral.** Viewport units, media queries and
  classic scrollbars see the real viewport, not the zoomed one. That holds
  for any "render big, zoom the page" approach.

## What follows

- **A new ADR, the next free number, superseding ADR-0004 §1's "so zoom has
  pixels to spend".** The source is recorded at the viewport size (1×). The
  context keeps `deviceScaleFactor: 2`, so the page renders as on a
  high-density display, but the video carries CSS pixels. The renderer's
  zoom upscales, and no capture path tried so far gives a 2× source on all
  three OSes. Per the spec, its text goes in a separate docs pull request
  after this one merges.
- **What stays:** the `DEMOFLOW_CAPTURE` switch, both prototypes, the
  harness and the `capture` input of the `cdp-spike` job, all opt-in, as a
  cheap re-check on a future Chromium or Playwright. Remove the prototypes
  instead if the ADR prefers no dormant code in `packages/engine/src`.
  Nothing on the default path changed.

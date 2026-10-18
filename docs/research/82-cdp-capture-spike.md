# CDP capture spike: a screencast at device pixels

Issue: [#82](https://github.com/AndreyBegma/DemoFlow/issues/82) ·
Spec: [82-cdp-capture-spike](../specs/82-cdp-capture-spike.md) ·
Decisions: [ADR-0004](../adr/0004-recording-is-separate-from-rendering.md) §1

**Outcome: rejected. The source stays 1×: a CDP screencast is DIP-capped.**

ADR-0004 §1 records at `deviceScaleFactor: 2` so zoom has pixels to spend.
Playwright's `recordVideo` delivers CSS-pixel frames (#47). The spike was to
replace it with a Chrome DevTools Protocol screencast (`Page.startScreencast`)
on the premise that a screencast delivers frames at device pixels.

It does not. On Linux, macOS and Windows CI, a page emulated at
`deviceScaleFactor: 2` (the page reports `devicePixelRatio` 2) gets screencast
frames no larger than its CSS viewport — 1280×720 for the 1280×720 viewport —
while a screenshot of the same page is 2560×1440. A 2× `source.webm` built from
the screencast could only be the 1× frame upscaled, which is what Decision 1's
sharpness criterion exists to reject. No prototype was built, and there is no
`DEMOFLOW_CAPTURE` switch: Decision 1 fails on its first criterion before any
of the others can be measured.

## Method

- **Probe:** `packages/engine/test/capture-spike/screencast-size.spec.ts`,
  skipped unless `DEMOFLOW_CDP_SPIKE=1`. It opens a 1280×720 context at the
  engine's `DEVICE_SCALE_FACTOR` (2) on a page that moves a block every
  animation frame, so the page always has a new frame to send. Then, on one
  CDP session:
  - `Page.startScreencast({ format: 'jpeg', quality: 90, maxWidth: 2560, maxHeight: 1440 })`
    for 3 s, acking every frame on receipt. It records the first frame's JPEG
    size and metadata, the frame count and the longest gap between frame
    timestamps.
  - `page.screenshot({ type: 'jpeg', quality: 90 })` in a loop for 3 s, one at
    a time. It records the size, the rate and the longest gap.
  Both run under the default headless shell and under new headless
  (`channel: 'chromium'`). The probe asserts that the page is at DPR 2, that
  the screencast frame is no larger than the CSS viewport, and that the
  screenshot is at device pixels.
- **CI:** the execution-plane workflow's `cdp-spike` job, dispatched by hand
  (`cdp_spike: true`) on `ubuntu-latest`, `macos-latest` and
  `windows-latest`. Pull request and push runs skip it. Each OS uploads its
  JSON report as an artifact (`cdp-spike-<os>`).
- **Versions:** Playwright 1.64.1, Chromium revision 1248.
- **Local exploration (Linux, 16 threads), outside the probe:** the same
  screencast with no `maxWidth`/`maxHeight`, and with
  `Emulation.setDeviceMetricsOverride({ deviceScaleFactor: 2, scale: 2 })`.
  Both sent 1280×720 frames.

## Evidence

Runs: [39151683172](https://github.com/AndreyBegma/DemoFlow/actions/runs/39151683172)
(first dispatch; the probe logged the screencast size without asserting it) and
[39151951252](https://github.com/AndreyBegma/DemoFlow/actions/runs/39151951252)
(the committed probe, which asserts it; green on all three OSes). Frame sizes
were identical in both runs. Rates are given as first run / second run.

| OS (vCPUs) | Mode | Screencast frame | Screencast fps · longest gap | Screenshot | Screenshot fps · longest gap |
|---|---|---|---|---|---|
| Linux x64 (4) | headless shell | **1280×720** | 60.0 / 59.7 · 17 / 17 ms | 2560×1440 | 20.3 / 15.0 · 52 / 69 ms |
| Linux x64 (4) | new headless | **1280×720** | 60.0 / 59.7 · 17 / 17 ms | 2560×1440 | 20.0 / 15.0 · 65 / 79 ms |
| macOS arm64 (3) | headless shell | **1280×720** | 26.7 / 42.0 · 67 / 67 ms | 2560×1440 | 7.3 / 10.3 · 316 / 190 ms |
| macOS arm64 (3) | new headless | **1280×633** | 4.0 / 4.7 · 700 / 783 ms | 2560×1440 | 8.7 / 10.0 · 309 / 274 ms |
| Windows x64 (4) | headless shell | **1280×720** | 59.7 / 60.0 · 33 / 17 ms | 2560×1440 | 15.0 / 15.0 · 77 / 81 ms |
| Windows x64 (4) | new headless | **1280×720** | 60.0 / 60.0 · 17 / 17 ms | 2560×1440 | 14.7 / 15.0 · 100 / 101 ms |
| Linux x64 (16, local) | both | **1280×720** | 60 · 17 ms | 2560×1440 | 13.7 · 87 ms |

The frame metadata says the same on every OS: `deviceWidth: 1280`,
`pageScaleFactor: 1`. `maxWidth` and `maxHeight` only ever scale a screencast
**down**. Chromium sizes screencast frames in DIPs, not in physical pixels.

New headless on macOS sent 1280×633 frames at 4–4.7 fps. That is a smaller frame
than the viewport (the window's own chrome, most likely) and far below 25 fps.
It is another reason the screencast is no use there.

## Against Decision 1

| Criterion | Result |
|---|---|
| Text measurably sharper at 1.6× zoom than the 1× source upscaled (≥ 1.5×) | **Fails by construction.** The screencast has no more pixels than the 1× source. Its sharpness can at best equal the 1× value (ratio ≤ 1.0), so the metric was not run. |
| 25 fps, no frame gap > 200 ms during steps, every run | Not measured: no 2× source exists to measure. The screencast alone reaches 60 fps on Linux and Windows, but only 26.7–42 fps (headless shell) and 4–4.7 fps (new headless) on macOS CI. |
| Renderer finds the sync mark; #19/#48 offset test passes on the CDP source | Not measured: no 2× source. |
| Real-run CI time ≤ 2× the 1× baseline | Not measured: no 2× source. |

All four criteria have to hold, and the first cannot. **The source stays 1×.**

## Findings worth keeping

- **`monotonicTimestamp`.** Screencast frame metadata carries a monotonic
  `monotonicTimestamp` next to the wall-clock `timestamp`. Locally, a frame's
  wall-clock arrival in Node minus its `timestamp` ranged −8 … +11 ms. The
  wall clocks of the two processes disagree by that much, and a frame cannot
  arrive before it was produced. A capture that maps frames onto the engine
  clock should use `monotonicTimestamp`, against an anchor taken in the page.
  The sync mark's page-clock exchanges (#48) are that kind of anchor.
- > **Correction (#85).** The size below holds, but not the reason, and the
  > fix it names harms the page. A screenshot answers in the *calling*
  > session's device metrics; a second CDP session has none, so its bare
  > shot is CSS-sized. A device-scale clip does return device pixels, but
  > Chromium then clears the page's emulation, which is Playwright's: the
  > page drops to `devicePixelRatio` 1 and lays out at the window size.
  > The screencast is capped either way. See
  > [85-device-pixel-capture-spike.md](85-device-pixel-capture-spike.md).

  **A bare `Page.captureScreenshot` is CSS-sized too.** Without a clip at the
  device scale, it returned 1280×720 here. Playwright's `page.screenshot()`
  passes that clip and gets 2560×1440. A capture pulling screenshots over CDP
  has to do the same.

## Candidates for a 2× source

### B. A screenshot loop — a separate spike

Pull frames with screenshots instead of receiving a screencast. Screenshots
are at device pixels (2560×1440 on every OS above). The open question is rate:

- One at a time, they reached 15–20.3 fps (Linux CI), 14.7–15 fps (Windows
  CI), 7.3–10.3 fps (macOS CI) and 13.7 fps (16 threads, local). The longest
  gaps were 52–316 ms. Every OS falls short of the 25 fps bar this way, and
  macOS also misses the 200 ms gap bar.
- Several requests in flight might raise the rate. Untested: whether the extra
  replies are distinct frames or the same frame repeated.
- A screenshot has no frame timestamp. Its time would be the request's
  midpoint on the engine clock, with half the round-trip as the error, as for
  the sync mark's clock exchanges.
- Every grab forces a composite and a JPEG encode at 4× the pixels. This
  costs CPU on the same 3–4 vCPU runner that runs the page.

The owner made this a separate spike. Its bar would be Decision 1 unchanged.

### C. `HeadlessExperimental.beginFrame` — ruled out

Deterministic frame control: the engine drives each frame and takes a
screenshot with it, at device pixels and at an exact rate. It works only in
the headless shell launched with BeginFrameControl, and BeginFrameControl is
not supported on macOS. It fails the "Linux, macOS and Windows" requirement by
construction.

## What the spike leaves behind

- The opt-in probe and the `cdp-spike` job. They stay as a cheap re-check: if a
  future Chromium sends device-pixel screencast frames, the probe's size
  assertion fails and says so.
- Nothing in `packages/engine/src`. The default capture is unchanged, and so
  is every default suite.
- The spec carries the outcome at the top.

## FFmpeg, had the prototype been built

The approved plan was to encode through Playwright's own bundled FFmpeg
(`ms-playwright/ffmpeg-<revision>`, which has `libvpx-vp9` and `image2pipe`
MJPEG input). That needs no new dependency. The engine cannot use the
renderer's resolution: the renderer dev-depends on the engine. Finding that
binary means reading Playwright's browser-cache layout and `browsers.json`,
neither of which is a public API. A production capture should not do that. It
should take the FFmpeg path from its caller (the CLI already resolves one for
the renderer), or move FFmpeg resolution into a small package both the engine
and the renderer depend on. That note carries over to B.

# Specifications

One file per issue, named `<issue>-<slug>.md`. The issue body summarises and
links here; the file is what the orchestrator's agents execute. Product-wide
decisions live in [../adr/](../adr/README.md).

## Phase 1 — validate the core technical risk

| Issue | Spec | Depends on |
|---|---|---|
| [#1](https://github.com/AndreyBegma/DemoFlow/issues/1) | [Core contracts](1-core-contracts.md) | — |
| [#2](https://github.com/AndreyBegma/DemoFlow/issues/2) | [Fixture app](2-fixture-app.md) | — |
| [#3](https://github.com/AndreyBegma/DemoFlow/issues/3) | [Engine](3-engine.md) | #1, #2 |
| [#4](https://github.com/AndreyBegma/DemoFlow/issues/4) | [Renderer spike](4-renderer-spike.md) — the owner chose the FFmpeg compositor (ADR-0005) | #3 |
| [#24](https://github.com/AndreyBegma/DemoFlow/issues/24) | [FFmpeg compositor only](24-renderer-ffmpeg-only.md) | — |
| [#5](https://github.com/AndreyBegma/DemoFlow/issues/5) | [CLI run](5-cli-run.md) | #3, #4 |
| [#6](https://github.com/AndreyBegma/DemoFlow/issues/6) | [OS matrix](6-os-matrix.md) | #5 |

## Before Phase 4

| Issue | Spec | Depends on |
|---|---|---|
| [#25](https://github.com/AndreyBegma/DemoFlow/issues/25) | [Real font rendering](25-compositor-fonts.md) | #24 |
| [#17](https://github.com/AndreyBegma/DemoFlow/issues/17) | [Source video at device pixels](17-source-video-device-pixels.md) | — |
| [#18](https://github.com/AndreyBegma/DemoFlow/issues/18) | [Masked field visibility](18-mask-visibility.md) | #31 |
| [#31](https://github.com/AndreyBegma/DemoFlow/issues/31) | [Process exits after a run](31-process-exits-after-run.md) | — |
| [#19](https://github.com/AndreyBegma/DemoFlow/issues/19) | [Clock sync mark](19-clock-sync-mark.md) | #18 |
| [#47](https://github.com/AndreyBegma/DemoFlow/issues/47) | [Restore viewport-sized recording](47-restore-viewport-recording.md) — supersedes spec 17's premise | — |
| [#42](https://github.com/AndreyBegma/DemoFlow/issues/42) | [Masked fill failure still masks](42-masked-fill-failure.md) | #47 |
| [#44](https://github.com/AndreyBegma/DemoFlow/issues/44) | [Stable real-run tests on CI](44-ci-real-run-stability.md) | #47 |
| [#48](https://github.com/AndreyBegma/DemoFlow/issues/48) | [Sync mark: always recorded, unbiased](48-sync-mark-reliability.md) | #42, #44 |
| [#56](https://github.com/AndreyBegma/DemoFlow/issues/56) | [Container scroll settles (macOS)](56-macos-container-scroll.md) | — |
| [#40](https://github.com/AndreyBegma/DemoFlow/issues/40) | [Screencast stalls: re-measure, un-quarantine](40-screencast-stalls.md) | — |
| [#62](https://github.com/AndreyBegma/DemoFlow/issues/62) | [Drift reference on the page clock](62-drift-reference-page-clock.md) | #40 |
| [#64](https://github.com/AndreyBegma/DemoFlow/issues/64) | [Sync mark hold invariant](64-sync-mark-hold-invariant.md) | — |

## Phase 3 — MCP integration

| Issue | Spec | Depends on |
|---|---|---|
| [#68](https://github.com/AndreyBegma/DemoFlow/issues/68) | [Generate, poll and cancel a demo](68-mcp-generate-poll-cancel.md) | — |
| [#69](https://github.com/AndreyBegma/DemoFlow/issues/69) | [Validate scenarios, list demos, check the project](69-mcp-read-only-tools.md) | #68 |
| [#75](https://github.com/AndreyBegma/DemoFlow/issues/75) | [Publish to npm through Woodpecker](75-npm-release.md) | #68, #69 |
| [#79](https://github.com/AndreyBegma/DemoFlow/issues/79) | [`demoflow record`](79-demoflow-record.md) | #75 |

## Before Phase 4 (roadmap)

| Issue | Spec | Depends on |
|---|---|---|
| [#73](https://github.com/AndreyBegma/DemoFlow/issues/73) | [Visual baselines](73-visual-baselines.md) | — |

## Phase 4 — Video quality

| Issue | Spec | Depends on |
|---|---|---|
| [#82](https://github.com/AndreyBegma/DemoFlow/issues/82) | [Spike: CDP capture at device pixels](82-cdp-capture-spike.md) | — |

Phase 2 onwards is specified now that the renderer spike has decided the
renderer.

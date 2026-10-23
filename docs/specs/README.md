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
| [#90](https://github.com/AndreyBegma/DemoFlow/issues/90) | [`run` starts the app from `devCommand`](90-run-starts-app.md) | — |
| [#92](https://github.com/AndreyBegma/DemoFlow/issues/92) | [MCP: terminal only after cleanup](92-mcp-staged-cleanup.md) | — |
| [#91](https://github.com/AndreyBegma/DemoFlow/issues/91) | [A `press` step](91-press-step.md) | #85 |
| [#103](https://github.com/AndreyBegma/DemoFlow/issues/103) | [`record`: no extra step on a slow runner](103-record-extra-step.md) | — |
| [#105](https://github.com/AndreyBegma/DemoFlow/issues/105) | [`npx demoflow` inside the monorepo](105-workspace-package-name.md) | — |

## Before Phase 4 (roadmap)

| Issue | Spec | Depends on |
|---|---|---|
| [#73](https://github.com/AndreyBegma/DemoFlow/issues/73) | [Visual baselines](73-visual-baselines.md) | — |

## Phase 4 — Video quality

| Issue | Spec | Depends on |
|---|---|---|
| [#82](https://github.com/AndreyBegma/DemoFlow/issues/82) | [Spike: CDP capture at device pixels](82-cdp-capture-spike.md) — rejected | — |
| [#85](https://github.com/AndreyBegma/DemoFlow/issues/85) | [Spike: pipelined screenshots or a zoomed large viewport](85-device-pixel-capture-spike.md) | #82 |
| [#100](https://github.com/AndreyBegma/DemoFlow/issues/100) | [The page in a rounded window on a background](100-window-frame-background.md) | #91 |
| [#108](https://github.com/AndreyBegma/DemoFlow/issues/108) | [Intro, scene and outro cards](108-cards.md) | #100 |
| [#114](https://github.com/AndreyBegma/DemoFlow/issues/114) | [Fade transitions](114-transitions.md) | #108 |
| [#133](https://github.com/AndreyBegma/DemoFlow/issues/133) | [GIF and WebM export](133-export-formats.md) | — |

## Phase 5 — Website and Runner pairing

| Issue | Spec | Depends on |
|---|---|---|
| [#120](https://github.com/AndreyBegma/DemoFlow/issues/120) | [Accounts API](120-accounts-api.md) | — |
| [#121](https://github.com/AndreyBegma/DemoFlow/issues/121) | [i18n dictionary](121-i18n-dictionary.md) | — |
| [#124](https://github.com/AndreyBegma/DemoFlow/issues/124) | [Sign-in pages](124-sign-in-pages.md) | #120, #121 |
| [#126](https://github.com/AndreyBegma/DemoFlow/issues/126) | [GitHub sign-in](126-github-sign-in.md) | #120, #124 |
| [#135](https://github.com/AndreyBegma/DemoFlow/issues/135) | [Runner pairing, slice 1](135-runner-pairing.md) | #133 (cli slot) |
| [#137](https://github.com/AndreyBegma/DemoFlow/issues/137) | [Public landing page](137-landing-page.md) | — |
| [#151](https://github.com/AndreyBegma/DemoFlow/issues/151) | [Runner daemon and live connection](151-runner-daemon.md) | #135 |

Phase 2 onwards is specified now that the renderer spike has decided the
renderer.

## Camera

| Issue | Spec | Depends on |
|---|---|---|
| [#163](https://github.com/AndreyBegma/DemoFlow/issues/163) | [Zoom set per step, no automatic zoom](163-step-zoom.md) | — |
| [#165](https://github.com/AndreyBegma/DemoFlow/issues/165) | [Scenario data and `repeat`](165-scenario-data-repeat.md) | #163 |
| [#173](https://github.com/AndreyBegma/DemoFlow/issues/173) | [Mask timing test flakes on macOS](173-mask-timing-flake.md) | — |
| [#218](https://github.com/AndreyBegma/DemoFlow/issues/218) | [waitForReady timing test flakes on macOS](218-ready-timing-flake.md) | — |
| [#219](https://github.com/AndreyBegma/DemoFlow/issues/219) | [Runner log rotation test flakes on Windows](219-log-rotation-flake.md) | — |

## Phase 4–5 remainder

| Issue | Spec | Depends on |
|---|---|---|
| [#150](https://github.com/AndreyBegma/DemoFlow/issues/150) | [Real-run hold test flake](150-real-run-hold-flake.md) | — |
| [#176](https://github.com/AndreyBegma/DemoFlow/issues/176) | [Vertical 9:16 export](176-vertical-export.md) | — |
| [#177](https://github.com/AndreyBegma/DemoFlow/issues/177) | [Delete my account](177-account-deletion.md) | — |
| [#178](https://github.com/AndreyBegma/DemoFlow/issues/178) | [Projects and the demo library](178-projects-and-library.md) | — |
| [#179](https://github.com/AndreyBegma/DemoFlow/issues/179) | [Documentation section](179-docs-section.md) | — |

## Phase 6 — Playback through the relay

| Issue | Spec | Depends on |
|---|---|---|
| [#191](https://github.com/AndreyBegma/DemoFlow/issues/191) | [Video relay (API) and its protocol](191-video-relay-api.md) | — |
| [#192](https://github.com/AndreyBegma/DemoFlow/issues/192) | [The runner daemon streams a reported run's video](192-runner-serves-video.md) | #191 (merge order) |
| [#193](https://github.com/AndreyBegma/DemoFlow/issues/193) | [Run page and the `VideoPlayer` adapter](193-run-video-page.md) | #191 |

## Phase 7 — Optional SDK

The page-side contract is [ADR-0013](../adr/0013-page-side-contract.md),
extended for annotations by [ADR-0014](../adr/0014-page-annotations.md).
Reuse of Playwright tests is [ADR-0015](../adr/0015-playwright-tests-become-scenarios.md),
from the [#202 spike report](../research/202-playwright-reuse-spike.md).

| Issue | Spec | Depends on |
|---|---|---|
| [#197](https://github.com/AndreyBegma/DemoFlow/issues/197) | [`data-demoflow-mask` masks a marked element](197-mask-attribute.md) | — |
| [#221](https://github.com/AndreyBegma/DemoFlow/issues/221) | [A marked element drawn unblurred on one frame](221-marked-mask-frame-leak.md) | — |
| [#198](https://github.com/AndreyBegma/DemoFlow/issues/198) | [`window.demoflow.ready(name)` and `waitForReady`](198-ready-signal.md) | #197 (merge order) |
| [#201](https://github.com/AndreyBegma/DemoFlow/issues/201) | [Scenes and captions from the page](201-page-annotations.md) | #198 |
| [#202](https://github.com/AndreyBegma/DemoFlow/issues/202) | [Spike: reuse Playwright tests as scenarios](202-playwright-reuse-spike.md) | — |
| [#203](https://github.com/AndreyBegma/DemoFlow/issues/203) | [Docs: the Application SDK page](203-sdk-docs.md) | #197, #198, #201 |
| [#208](https://github.com/AndreyBegma/DemoFlow/issues/208) | [`demoflow/playwright`: a fixture that records a scenario](208-playwright-fixture.md) | — |
| [#209](https://github.com/AndreyBegma/DemoFlow/issues/209) | [Fixture: container scrolls, `caption` and `scene` helpers](209-playwright-scrolls-captions.md) | #208 |
| [#210](https://github.com/AndreyBegma/DemoFlow/issues/210) | [Docs: reuse Playwright tests](210-playwright-docs.md) | #208; after #209; not beside #203 |

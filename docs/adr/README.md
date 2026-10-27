# Architecture decision records

One decision per record, numbered in order. A record is never rewritten after
it is accepted: a later record supersedes it and says so.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-control-plane-execution-plane-one-package.md) | Control plane and execution plane; one `demoflow` package on Node; module layout | accepted; amended by 0015 |
| [0002](0002-develop-integration-staging-and-os-matrix.md) | `develop` integration, staging on merge, GitHub Actions OS matrix | accepted |
| [0003](0003-scenario-format-and-project-config.md) | Scenario format, locators, secrets, project config | accepted |
| [0004](0004-recording-is-separate-from-rendering.md) | Capture model, stage statuses, failure rendering, output defaults, artifact location | accepted; §1's 2× premise superseded by 0010 |
| [0005](0005-renderer-chosen-by-spike.md) | Renderer: the FFmpeg compositor, chosen by a spike | accepted |
| [0006](0006-accounts-github-oauth-and-email-password.md) | Multi-user accounts: GitHub OAuth and email/password | accepted |
| [0007](0007-runner-pairing-and-connection.md) | Runner pairing (device code), WebSocket connection, device token | accepted |
| [0008](0008-cloud-boundary.md) | What crosses to the cloud, and what the website may make a runner do | accepted; §3 extended by 0016 |
| [0009](0009-playback-relay-and-luna-player-adapter.md) | Playback through an API relay; Luna Player behind an adapter | accepted |
| [0010](0010-source-video-at-viewport-size.md) | The source video is recorded at the viewport size (1×) | accepted |
| [0011](0011-no-docker-socket-or-host-cache-on-pull-requests.md) | No Docker socket and no host cache on a pull request | accepted |
| [0012](0012-camera-directed-by-the-scenario.md) | The camera zooms only where a step asks for it (`zoom`); no automatic zoom | accepted |
| [0013](0013-page-side-contract.md) | The page-side contract: `data-demoflow-mask` and `window.demoflow` (`ready`, `waitForReady`) | accepted; extended by 0014 |
| [0014](0014-page-annotations.md) | Scenes and captions from the page: `window.demoflow.scene` and `caption` | accepted |
| [0015](0015-playwright-tests-become-scenarios.md) | Playwright tests become scenarios: a `demoflow/playwright` fixture records a `.demo.json`, the engine replays it; new module `packages/playwright`, optional peer `@playwright/test` | accepted |
| [0016](0016-website-started-runs.md) | Runs started from the website: scenario listing (ids and names), a registered project is a root the machine reported a run from | accepted; §4 superseded by 0017; §2 superseded by 0022 |
| [0017](0017-website-run-options.md) | The website may choose the output formats of a run it starts (formats only; always headless) | accepted |
| [0018](0018-fragments-and-off-camera-steps.md) | Step fragments (`include`) are inlined at load time; off-camera steps (`setup`, `record: false`) are an unrecorded prefix run in its own context | accepted |
| [0019](0019-opt-in-share-links.md) | Opt-in share links: one render uploaded to the server on an explicit share, unlisted link with an optional password | accepted; supersedes the roadmap's Phase 5 "no public share links", extends 0008 §2–§3 |
| [0020](0020-edits-from-the-website.md) | The website may send a run's edits as data and ask its runner to re-render it; edits live in the run directory | accepted; extends 0008 §3 |
| [0021](0021-scheduled-checks.md) | Scheduled checks from the website and the project config; check mode runs without recording | accepted; extends 0017 |
| [0022](0022-projects-added-from-the-website.md) | A project may be added from the website: a folder inside the machine's allowed roots, inspected and optionally initialised by the runner; GitHub link as metadata, no cloning | accepted; supersedes 0016 §2, extends 0008 §3 |

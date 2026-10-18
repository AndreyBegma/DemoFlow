# Roadmap

The order of work after Phase 2, and what was decided for each phase before it
was specified. [vision.md](vision.md) stays the product concept; this file is
the plan the orchestrator cuts issues from. Decisions here were taken by the
owner in an interview on 2026-10-18 unless marked otherwise; a spec or an ADR
that contradicts this file wins, and this file is updated with it.

## Order

1. **Phase 3 — MCP integration** (in progress: #68, #69).
2. **Before Phase 4 — visual baselines** for rendered output (below).
3. **Phase 4 — Video quality.**
4. **Phase 5 — Website and Runner pairing.**
5. **Phase 6 — Luna Player.**
6. **Phase 7 — Optional SDK.**

Cross-cutting, scheduled between phases when the queue allows: the npm release
pipeline, the release branch flow, the GitHub Action, `demoflow record`.

## Phase 3 — MCP integration

- `demoflow mcp` is local and works without an account or the website
  ([ADR-0001](../adr/0001-control-plane-execution-plane-one-package.md),
  [ADR-0008](../adr/0008-cloud-boundary.md) §1).
- Specs: [68](../specs/68-mcp-generate-poll-cancel.md) (generate, poll, cancel),
  [69](../specs/69-mcp-read-only-tools.md) (validate, list, check).
- The "DemoFlow page reference for a video" (vision §3.3) waits for Phase 5.

## Before Phase 4 — visual baselines

- Renderer tests compare frames of the rendered output against committed
  reference images with a tolerance. The #47 regression (the page in a quarter
  of the frame) would have failed such a test.
- An intended change to the look regenerates the baselines in the same pull
  request (a `test:update-baselines` script), with a before/after comparison in
  the PR body; the orchestrator reviews it at merge.

## Phase 4 — Video quality

- **Style**: Screen Studio-like — the page in a window with rounded corners and
  a shadow on a background, a smooth camera, a large cursor.
- **Frame**: rounded, **no browser chrome** — no URL bar, so hosts and query
  strings never appear in the video.
- **Background**: 5–6 gradient presets plus a custom colour or gradient in
  `demoflow.config.json`; no image backgrounds.
- **Cards**: an intro card from the scenario's `name` / `description`; scene
  cards on `scene` markers; an outro card with the project name and an optional
  call to action from `demoflow.config.json`. Each can be turned off.
- **Transitions**: a short (~300 ms) fade between scenes and on navigation,
  hiding the blank-page flash. No menu of transition styles.
- **Export formats**: GIF, WebM and vertical 9:16, besides MP4. In 9:16 the
  camera follows the current step's target in a narrow frame, with captions
  above and below.
- **Order inside the phase**:
  1. real 2× capture through a CDP screencast in device pixels, starting with a
     spike like #4 — `recordVideo.size` cannot upscale (#47);
  2. frame and background;
  3. cards and transitions;
  4. export formats.

## Phase 5 — Website and Runner pairing

- **Personal accounts only**
  ([ADR-0006](../adr/0006-accounts-github-oauth-and-email-password.md)
  unchanged). Teams are a later phase with a new ADR.
- **Order**: sign-in → Runner pairing
  ([ADR-0007](../adr/0007-runner-pairing-and-connection.md)) → projects → demo
  library.
- **No public share links.** Videos stay on the user's machine (ADR-0008) and
  play through the relay
  ([ADR-0009](../adr/0009-playback-relay-and-luna-player-adapter.md)). Sharing
  is by file or through the GitHub Action.
- **Language**: English UI, with strings in an i18n dictionary from the start.

## Phase 6 — Luna Player

- `luna-player` is published (npm `0.1.2`,
  https://github.com/AndreyBegma/luna-player), so ADR-0009 §2's trigger ("ships
  under a tag that can be pinned") has fired. No ADR change.
- The work is the Luna implementation of the `VideoPlayer` adapter, pinned
  exactly, keeping the native `<video>` fallback.

## Phase 7 — Optional SDK

All four, in this order:

1. a `data-demoflow-mask` attribute that masks an element automatically — no JS
   package needed;
2. a ready signal, `window.demoflow.ready('<name>')`, that scenarios can wait
   on;
3. annotations — the application sets scenes and captions through a JS API;
4. reuse of existing Playwright tests as demo scenarios.

## Cross-cutting

- **npm release**: Changesets. Pull requests carry a changeset and a bot keeps a
  Version PR. Merging the Version PR publishes `demoflow` with npm provenance
  and a generated changelog. The orchestrator merges it when CI is green — the
  owner chose no person gate.
- **Release branch flow**: when a phase is complete and staging is green, the
  orchestrator opens `develop` → `main` with the change list and merges it once
  CI is green (owner's choice).
- **GitHub Action**: runs every `demoflow/**/*.demo.json` of a project on each
  pull request, posts GIF previews in a PR comment and uploads the MP4s as
  artifacts. A failed verification fails the check.
- **`demoflow record`**: opens the app in a browser with a step panel. Clicks and
  typing become steps with stable role/name locators. The panel adds captions,
  scenes and assertions. Password fields become `valueFrom.env` automatically.

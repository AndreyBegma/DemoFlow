# Roadmap

The order of work after Phase 2, and what was decided for each phase before it
was specified. [vision.md](vision.md) stays the product concept; this file is
the plan the orchestrator cuts issues from. Decisions here were taken by the
owner in an interview on 2026-10-18 unless marked otherwise; a spec or an ADR
that contradicts this file wins, and this file is updated with it.

## Order

1. **Phase 3 — MCP integration** (in progress: #68, #69).
2. **npm release** of `demoflow` — right after MCP: without a published
   package nobody can run `npx demoflow mcp`. The name is free on npm today.
3. **`demoflow record`** — before Phase 4: a first demo without hand-written
   JSON matters more than polish.
4. **Before Phase 4 — visual baselines** for rendered output (below).
5. **Phase 4 — Video quality.**
6. **Phase 5 — Website and Runner pairing.**
7. **Phase 6 — Luna Player.**
8. **Phase 7 — Optional SDK.**

The release branch flow applies from the first phase completed after this file
lands; the GitHub Action follows the npm release whenever the queue allows.

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
  1. ~~real 2× capture~~ — closed: no capture path gives a device-pixel source
     ([ADR-0010](../adr/0010-source-video-at-viewport-size.md), #82, #85); the
     source stays 1×;
  2. frame and background — these, the cards, transitions and GIF/WebM do
     not depend on source sharpness and proceed on the 1× source while the
     capture question is open; #82 rejected the CDP screencast (frames are
     CSS-sized), #85 measures pipelined screenshots and a zoomed large
     viewport, and if both fail a new ADR keeps the source at 1×. Only the
     9:16 follow-camera waits for that answer;
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
- **A simple public landing page**: what DemoFlow is, a demo video made with
  DemoFlow, "Install" (`npx demoflow`) and "Sign in"; documentation as its own
  section.
- **No pricing or plans**: everything is free; billing is a later phase once
  there are users, and the schema does not anticipate it.
- **Production at the end of Phase 5**, deployed from `main`, once sign-in, the
  Runner and the library exist. The person sets up the domain and the server;
  until then only staging exists.
- **Account deletion** (all metadata deleted, every Runner token revoked) is in
  Phase 5; data export comes later — the videos are already on the user's
  machine.

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

- The page-side contract of items 1–2 is
  [ADR-0013](../adr/0013-page-side-contract.md).
- Specs: [197](../specs/197-mask-attribute.md) (`data-demoflow-mask`),
  [198](../specs/198-ready-signal.md) (`window.demoflow.ready`, `waitForReady`).

## Cross-cutting

- **npm release** — the luna-player pattern
  (https://github.com/AndreyBegma/luna-player/blob/main/.woodpecker/release.yml),
  not Changesets: a Woodpecker `release` workflow. A push to `main` (the merge
  of the `develop` → `main` release pull request that bumps the version in
  `apps/cli/package.json`) builds, smoke-tests the packed tarball and publishes
  `demoflow` when that version is not on npm yet, then pushes the tag
  `vX.Y.Z`. A manual run is a dry run. Secrets on the DemoFlow repository in
  Woodpecker: `npm_token` (events push, tag, manual) and `github_token` (a
  fine-grained token with contents:write on DemoFlow only, event push). The
  person adds both. The orchestrator merges the release pull request when CI is
  green, so publishing needs no person gate (owner's choice).
- **Release branch flow**: when a phase is complete and staging is green, the
  orchestrator opens `develop` → `main` with the change list and merges it once
  CI is green (owner's choice).
- **GitHub Action** (its own repository, `AndreyBegma/demoflow-action`,
  published to the Marketplace, using `npx demoflow`): runs every
  `demoflow/**/*.demo.json` of a project on each
  pull request, posts GIF previews in a PR comment and uploads the MP4s as
  artifacts. A failed verification fails the check.
- **`demoflow record`**: opens the app in a browser with a step panel. Clicks and
  typing become steps with stable role/name locators. The panel adds captions,
  scenes and assertions. Password fields become `valueFrom.env` automatically.

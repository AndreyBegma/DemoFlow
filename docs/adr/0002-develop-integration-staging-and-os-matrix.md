# ADR-0002: `develop` integration, staging on merge, GitHub Actions OS matrix

Status: accepted · Date: 2026-10-17

## Context

The project was set up on 2026-10-17 with the CI and staging arrangement of
AgentDock: Woodpecker agents on the staging host build the images and replace
the stack on every push to `develop` ([deploy/README.md](../../deploy/README.md)).
Woodpecker's agents are Linux only, while the runner must work on Linux,
macOS and Windows (ADR-0001).

## Decision

1. **`develop` is the integration branch.** Every pull request targets
   `develop`. `main` holds releases. The orchestrator's base is `develop`.
2. **A merge into `develop` deploys staging** at
   https://demoflow-app.luna-realm.com through `.woodpecker/pipeline.yml`.
3. **Woodpecker is the main CI**: check, build and test on every pull request.
4. **GitHub Actions runs the execution plane on three operating systems**
   (`ubuntu-latest`, `macos-latest`, `windows-latest`): install, build, and a
   real demo of the fixture app through the CLI. It runs on pull requests that
   touch `packages/core`, `packages/engine`, `packages/renderer`, `apps/cli`,
   `apps/fixture`, the root manifests or the workflow itself. The repository
   is public, so the minutes are free. It needs no secrets.

## Consequences

- Two CI systems. Woodpecker stays the required status for merging; the
  matrix is required for pull requests that touch the execution plane.
- Woodpecker's CI image must carry Chromium's system libraries and FFmpeg once
  the engine and renderer have tests.

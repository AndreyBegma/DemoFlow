# Architecture decision records

One decision per record, numbered in order. A record is never rewritten after
it is accepted: a later record supersedes it and says so.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-control-plane-execution-plane-one-package.md) | Control plane and execution plane; one `demoflow` package on Node; module layout | accepted |
| [0002](0002-develop-integration-staging-and-os-matrix.md) | `develop` integration, staging on merge, GitHub Actions OS matrix | accepted |
| [0003](0003-scenario-format-and-project-config.md) | Scenario format, locators, secrets, project config | accepted |
| [0004](0004-recording-is-separate-from-rendering.md) | Capture model, stage statuses, failure rendering, output defaults, artifact location | accepted |
| [0005](0005-renderer-chosen-by-spike.md) | Renderer: Remotion or an FFmpeg compositor, chosen by a spike | proposed |
| [0006](0006-accounts-github-oauth-and-email-password.md) | Multi-user accounts: GitHub OAuth and email/password | accepted |
| [0007](0007-runner-pairing-and-connection.md) | Runner pairing (device code), WebSocket connection, device token | accepted |
| [0008](0008-cloud-boundary.md) | What crosses to the cloud, and what the website may make a runner do | accepted |
| [0009](0009-playback-relay-and-luna-player-adapter.md) | Playback through an API relay; Luna Player behind an adapter | accepted |

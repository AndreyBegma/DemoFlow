# ADR-0011: No Docker socket and no host cache on a pull request

Status: accepted · Date: 2026-10-20

## Context

`.woodpecker/pipeline.yml` runs on `pull_request`. The repository is public;
Woodpecker gates only fork pull requests (`require_approval: forks`) and the
repository is trusted for volumes. An audit on 2026-10-20 found that, once a
fork pull request was approved, its code ran with:

1. the `ci-image` step mounting `/var/run/docker.sock` on every event — root on
   the CI host, which is also the staging host;
2. `install`, `build` and `test` mounting the host caches
   `/home/archi/ci-cache/demoflow/{bun,turbo,playwright}` read-write. A pull
   request could plant a bun package, a turbo cache entry (turbo replays a
   cached task's logs and outputs without running it) or a Chromium build that
   later pushes, manual runs and the staging deploy would reuse.

AgentDock closed the same hole the same way (its ADR-0053).

## Decision

1. **No step that can run on a pull request mounts the Docker socket.**
   `ci-image`, `build-staging` and `deploy-staging` run on push and manual
   events only.
2. **Pull requests run on the CI image the last push built.**
   `demoflow-ci:node-bun` is a local tag on the agent host; a change to
   `deploy/ci-image/` reaches pull requests once it is merged. An agent without
   the tag fails the pull request at image pull (there is no
   `docker.io/library/demoflow-ci`); a manual run on `develop` builds it.
3. **No host cache on a pull request.** `install`, `build` and `test` are split
   into push/manual steps that keep the host caches unchanged and `-pr` steps
   that mount nothing. In a `-pr` step bun's install cache lives in the
   container, turbo's cache in the workspace (`.turbo/cache`) and Chromium in
   `node_modules` (`PLAYWRIGHT_BROWSERS_PATH=0`); all of it dies with the
   pipeline. A separate pull-request-only cache directory was rejected: one
   pull request could still poison the next one's turbo replay and turn its
   status green without running its tests.
4. The required status context `ci/woodpecker/pr/pipeline` is unchanged.

## Consequences

- Pull requests are slower: a cold `bun install`, a full turbo build and a
  Chromium download on every run. Push and manual runs are as fast as before.
- A pull request that changes `deploy/ci-image/` is tested on the old image.
- "Trusted → volumes" is still needed: push steps mount the socket, the stack
  directory and the caches, and the postgres service uses tmpfs. Woodpecker's
  trust is per repository, not per event.
- Woodpecker reads the pipeline from the pull request's branch, so a
  same-repository pull request that edits it can still add a mount: only forks
  wait for approval. Closing that needs `require_approval: pull_requests` (or a
  pull-request-only agent without the socket); it is not done here.

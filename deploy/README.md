# Deployment

Modelled on AgentDock's CI and staging: the Woodpecker agents run on the
staging host, build the images on its Docker daemon and replace the containers.
No registry, no ssh.

## Branches

`main` holds releases. All work lands in `develop` through pull requests; every
merge into `develop` deploys staging.

## CI — what each pipeline runs

`.woodpecker/pipeline.yml` runs `check` (Biome) and `build` in full every time.
Which tests run depends on the event:

| Event | `test` |
|---|---|
| pull request | the packages changed since the merge base with the target branch, plus their dependents |
| pull request touching a root file: `package.json`, `bun.lock`, `turbo.json`, `tsconfig.json`, `biome.json`, `.woodpecker/**`, `deploy/ci-image/**` | the full suite |
| pull request touching only `docs/**`, `*.md`, `.github/**` | none, and `build` is skipped too; `check` still gives the status |
| push to `develop` | none: the pull request already tested it |
| push to `main`, manual run | the full suite |

A push to `main`, a `v*` tag and a manual run with `[demoflow-release]` in its
message also run `.woodpecker/release.yml` — see *Releasing `demoflow` to npm*.
Pull requests and pushes to `develop` never do.

Browser tests run in the `test` step with no extra setup. The CI image carries
FFmpeg and Chromium's system libraries. The `install` step runs
`bunx playwright install chromium` with the repository's own `playwright`
(skipped while no workspace depends on it), so the browser always matches the
pin in `packages/engine`. `PLAYWRIGHT_BROWSERS_PATH` is `/ci-cache/playwright`
in every step that mounts the caches; the host directory is
`/home/archi/ci-cache/demoflow/playwright`.

Pull requests get no Docker socket and no host cache (ADR-0011). `ci-image`,
`build-staging` and `deploy-staging` run on push and manual events only; a pull
request runs on the `demoflow-ci:node-bun` image the last push built, so a
change to `deploy/ci-image/` reaches pull requests once it is merged. If an
agent has never built the image, the pull request fails at image pull: start a
manual run on `develop`. `install-pr`, `build-pr` and `test-pr` mount nothing —
bun, turbo and Chromium are downloaded or rebuilt inside the pipeline every
run — while `install`, `build` and `test` (push, manual) keep the host caches.

The CI PostgreSQL is throwaway: tmpfs, with `fsync`, `synchronous_commit` and
`full_page_writes` off.

## CI — the execution plane on three OS (GitHub Actions)

Woodpecker only has Linux agents, and the runner must work on Linux, macOS and
Windows. `.github/workflows/execution-plane.yml` is a second CI that proves it;
it does not replace the Woodpecker pipeline.

- **When:** pull requests and pushes to `develop` that touch `packages/core`,
  `packages/engine`, `packages/renderer`, `apps/cli`, `apps/fixture`,
  `package.json`, `bun.lock` or the workflow itself, and manual runs
  (*Actions → execution-plane → Run workflow*). A change that only touches
  `apps/web/**` does not start it. A newer run of the same ref cancels the
  older one.
- **What, on `ubuntu-latest`, `macos-latest` and `windows-latest`:** installs
  with `bun install --frozen-lockfile` (Node 24, Bun 1.4.0), installs
  Chromium, builds the CLI and the fixture, runs the tests of
  `@demoflow/core`, `@demoflow/engine`, `@demoflow/renderer` and `demoflow`,
  starts the fixture preview, then runs `demoflow run` on the `customers`,
  `login` and `failing` scenarios. Exit codes must be 0, 0 and 1.
- **Permissions:** read-only token, no secrets. `FIXTURE_PASSWORD` is
  generated per run.

### Downloading the demos

Each job uploads `demos-<os>` (`demos-ubuntu-latest`, `demos-macos-latest`,
`demos-windows-latest`), kept 14 days, even when a job fails. Each holds, per
scenario, `runs/<runId>/render/ffmpeg.mp4` and `runs/<runId>/result.json`.

- Web: open the workflow run, then *Artifacts* at the bottom of the summary.
- CLI: `gh run download <run-id> -n demos-windows-latest`; omit `-n` to get
  all three. Find the run with `gh run list --workflow execution-plane.yml`.

## CI — the npm package on three OS (GitHub Actions)

`.github/workflows/package-smoke.yml` tests `demoflow` the way a user gets it.

- **When:** the paths of `execution-plane.yml`, plus `scripts/release/**` and
  `.woodpecker/release.yml`; pull requests, pushes to `develop`, manual runs.
- **What, on `ubuntu-latest`, `macos-latest` and `windows-latest`:** builds the
  CLI, which stages the publishable package in `apps/cli/dist/npm`; starts the
  fixture preview; then, on Node 20 (the package's `engines` floor), runs
  `apps/cli/scripts/smoke.mjs --browsers`: `npm pack` of `apps/cli/dist/npm`,
  `npm install` of the tarball into an empty directory, and through the
  installed bin `demoflow --version`, `demoflow validate`, an MCP `tools/list`
  against `demoflow mcp`, a `demoflow run` of the fixture's `customers`
  scenario from an empty `PLAYWRIGHT_BROWSERS_PATH` (it installs Chromium, then
  runs and renders), and `demoflow setup` from another empty one. On Linux the
  workflow installs Chromium's system libraries first, never the browser. Ubuntu
  also runs the release scripts' tests (`bun run test:release`).

Locally: `bun run build --filter=@demoflow/cli`, then
`node apps/cli/scripts/smoke.mjs` (add `--browsers` with the fixture preview up:
`node .github/scripts/serve-fixture.mjs start`).

## Releasing `demoflow` to npm

`.woodpecker/release.yml` publishes the package, luna-player's pattern.
What it publishes is `apps/cli/dist/npm`: the package
`apps/cli/scripts/stage.ts` stages during the CLI's build — the workspace
packages `@demoflow/core`, `engine` and `renderer` bundled into
`dist/bin/main.js` by esbuild, the renderer's Inter fonts and their licence in
`fonts/`, and a generated `package.json` whose `dependencies` are the
third-party runtime dependencies of those packages, pinned exactly.
`apps/cli/package.json` itself stays `private` and is never published: it holds
`workspace:*` references. Chromium is not part of the package; it is downloaded
on first use (`demoflow run`, the first `generate_demo` of `demoflow mcp`) or by
`demoflow setup`.

### The procedure

1. On `develop`, in a pull request: bump `version` in `apps/cli/package.json`
   (semver; the first release is `0.1.0`). Merge it.
2. Open the release pull request `develop` → `main`. CI must be green: the
   Woodpecker pipeline and both GitHub workflows (`execution-plane`,
   `package-smoke`).
3. The orchestrator merges it.
4. The push to `main` runs `release.yml`: check, build, smoke, then
   `npm publish` of `apps/cli/dist/npm` when the version is not on npm yet, then
   the tag `vX.Y.Z`. A push without a version bump publishes nothing and
   passes. The tag starts a tag pipeline that finds the version published and
   passes.

The dist-tag is decided by `scripts/release/decide.sh`: `latest`, or
`v<major>.<minor>` for a `maint/*` branch or a version below the current
`latest`, so a patch to an old line never moves `latest` back.

### Rehearsing a release

Start a manual pipeline in Woodpecker on any branch with `[demoflow-release]`
in its message. It runs every step and ends in `npm publish --dry-run` of
`apps/cli/dist/npm`; nothing is published and no tag is pushed. A manual run
without that text does not start this workflow.

### Secrets (Woodpecker, DemoFlow repository)

| Secret | Events | Used by |
|---|---|---|
| `npm_token` | manual, push, tag | `publish`: an npm automation token allowed to publish `demoflow` |
| `github_token` | push | `tag`: a token with `contents: write` on the repository |

Without `npm_token` a push says so and passes; without `github_token` the tag
is skipped. No provenance is attached: npm accepts it only from GitHub Actions
and GitLab CI.

### When something goes wrong

- **A broken version is on npm.** npm versions cannot be reused. Deprecate it
  (`npm deprecate demoflow@X.Y.Z "<why>"`), fix on `develop`, bump the patch
  version and release again.
- **The publish succeeded but the tag did not.** Re-run the push pipeline: the
  publish step finds the version on npm and `tag` creates the missing tag.
- **The tag disagrees with the version.** The tag pipeline fails in
  `check-version` before anything is built; delete the tag.

## Staging — https://demoflow-app.luna-realm.com

Every push to `develop` runs the pipeline. Once `check` and `build` pass,
`build-staging` builds `demoflow-api:staging` and `demoflow-web:staging` on the
agent host. `deploy-staging` then replaces the containers in
`/home/archi/stacks/demoflow-staging`.

```
Cloudflare ──tunnel──▶ cloudflared ──▶ proxy (Caddy :80) ─┬─ /api/* ─▶ api :8370 ─▶ postgres
                                                          └─ /*     ─▶ web :3670
```

Nothing is published on the host. The stack runs on its own compose network
(`demoflow-staging`).

### One-time setup

1. **Cloudflare.** Create the tunnel `demoflow-app` in Zero Trust. Give it
   the public hostname `demoflow-app.luna-realm.com` → `HTTP` `proxy:80`.
   Save the token as `~/.demoflow/cloudflared.env`, mode 600, with one
   line: `TUNNEL_TOKEN=...`.
2. **Woodpecker.** Activate `AndreyBegma/DemoFlow` and apply these settings:
   - *Trusted → volumes*: on. The push and manual steps mount the Docker
     socket, the stack directory and the caches, and the postgres service
     mounts a tmpfs. Pull request steps mount nothing (ADR-0011).
   - *Require approval*: forks. The repository is public.
   - *Cancel previous pipelines*: push, pull_request.
   - Timeout: 60 min.
3. **The first run.** Push to `develop`, or run the pipeline by hand on
   `develop`. `refresh.sh` creates the stack directory, copies the examples in
   and generates `POSTGRES_PASSWORD`. It then stops, because the tunnel token
   is missing.
4. **Add the token and start the stack:**
   ```sh
   cp ~/.demoflow/cloudflared.env /home/archi/stacks/demoflow-staging/env/cloudflared.env
   /home/archi/stacks/demoflow-staging/up.sh
   ```

### Operating

| Command (on the host) | What it does |
|---|---|
| `/home/archi/stacks/demoflow-staging/status.sh` | the deployed commit, containers, image revisions, and the public `/` and `/api/health` |
| `/home/archi/stacks/demoflow-staging/up.sh` | starts the stack from the images already built |
| `/home/archi/stacks/demoflow-staging/down.sh` | stops it; the volumes are kept |
| `sh deploy/staging/refresh.sh` (from a checkout) | what `deploy-staging` runs |

- **Secrets** live only in `/home/archi/stacks/demoflow-staging/.env` and
  `env/*.env`, all mode 600. `refresh.sh` never overwrites them. When an
  example gains a key, `refresh.sh` appends it with the example's value.
- **Migrations and the seed** run in the API's entrypoint, so a failed
  migration keeps the API unhealthy. The deploy fails after 240 s and prints
  the API log.
- **A deploy does not drop requests.** `refresh.sh` restarts `api` and waits
  for it to be healthy before it touches `web`. Caddy holds a request that
  arrives meanwhile and retries it for up to 60 s instead of answering 502.
- **`530` / error 1033** from the public URL means the hostname exists but no
  cloudflared connector is running. Check that `TUNNEL_TOKEN` is set and look
  at `docker logs demoflow-staging-cloudflared`.

### The runner socket on staging

Paired machines hold one WebSocket each, `wss://demoflow-app.luna-realm.com/api/runner`
(spec #151). It needs no configuration of its own: Cloudflare and the tunnel
pass WebSocket upgrades, and Caddy's `/api/*` route strips the prefix and
proxies the upgrade to `api:8370/runner` like any request. Both sides ping
every 25 s, well under Cloudflare's 100 s idle limit.

- **A deploy drops every socket.** The API says `bye` and closes with `1001`;
  daemons reconnect with backoff and Caddy holds the upgrade until the new
  API answers. Machines show Offline for those seconds.
- **To check it**, with a paired machine: `demoflow runner start`, then
  `/app/machines` shows it Online within 15 s. Without a CLI,
  `curl -si --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket'
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='
  https://demoflow-app.luna-realm.com/api/runner` must answer `401`: the
  upgrade reached the API, which refused the missing token. A `404` or `502`
  means the upgrade did not get through.
- Online state lives in the API's memory, so it is right only while staging
  runs one API container (#120).

### Mail on staging

Account emails (verification, password reset) go through Resend. The key and
the verified sender domain are the owner's to add, in `env/api.env`:
`RESEND_API_KEY`, `MAIL_FROM`, and empty `MAIL_TRANSPORT=` (empty, not
deleted: `refresh.sh` would append a deleted key again). Until then
staging runs `MAIL_TRANSPORT=log`: each email — recipient, subject and link —
is written to the API log instead of sent
(`docker logs demoflow-staging-api 2>&1 | grep Mail`).

Staging runs `APP_ENV=production`, which refuses to start with neither a
Resend key nor `MAIL_TRANSPORT=log` — the error names `RESEND_API_KEY`.

### GitHub sign-in on staging

"Continue with GitHub" stays hidden until both `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` are set; while either is empty `/api/auth/providers`
answers `{ "github": false }` and `/api/auth/github/start` is a 404. To turn it
on, the owner:

1. Creates an OAuth App (GitHub → Settings → Developer settings → OAuth Apps):
   homepage `https://demoflow-app.luna-realm.com`, authorization callback URL
   `https://demoflow-app.luna-realm.com/api/auth/github/callback`. A second
   app for local development uses `http://localhost:3670/api/auth/github/callback`.
2. Puts the client id and a generated client secret in `env/api.env` on the
   host, and restarts the API container.

The app asks for `read:user user:email` only, and keeps no GitHub token. The
client secret also signs the short-lived `df_oauth` cookie, so rotating it
only fails sign-ins that are in flight.

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

Browser tests run in the `test` step with no extra setup. The CI image carries
FFmpeg and Chromium's system libraries. The `install` step runs
`bunx playwright install chromium` with the repository's own `playwright`
(skipped while no workspace depends on it), so the browser always matches the
pin in `packages/engine`. `PLAYWRIGHT_BROWSERS_PATH` is `/ci-cache/playwright`
in every step that mounts the caches; the host directory is
`/home/archi/ci-cache/demoflow/playwright`.

The CI PostgreSQL is throwaway: tmpfs, with `fsync`, `synchronous_commit` and
`full_page_writes` off.

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
   - *Trusted → volumes*: on. The steps mount the Docker socket, the stack
     directory and the caches, and the postgres service mounts a tmpfs.
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

# Prompt: bring DemoFlow staging online

Hand this to an agent running on the Woodpecker agent host (the machine that
already serves AgentDock staging).

---

Bring the DemoFlow staging site online at **https://staging-demoflow.luna-realm.com**
so that every push to `develop` of `AndreyBegma/DemoFlow` deploys it.

Everything on the repository side already exists and was verified locally
(images build, the stack answers `/` and `/api/health` through Caddy). Read
`deploy/README.md` and `.woodpecker/pipeline.yml` in `~/dev/DemoFlow` first:
they are the source of truth. The setup copies AgentDock's
(`~/dev/AgentDock/deploy/README.md`) one-to-one, so use that as the reference
for anything unclear.

Do, in order, and stop to report at the first failure:

1. **Cloudflare tunnel.** In Cloudflare Zero Trust, create a new
   remote-managed tunnel `demoflow-staging` (its own tunnel, not a connector on
   `agentdock-staging` or `denitsa`). Add the public hostname
   `staging-demoflow.luna-realm.com` → service `HTTP` → `proxy:80`. Save the
   token as `~/.demoflow/cloudflared-staging.env`, mode 600, one line:
   `TUNNEL_TOKEN=...`. If you cannot reach the Cloudflare dashboard or API,
   stop and tell me exactly which clicks I have to do, then continue from
   step 2 once I give you the token file.
2. **Woodpecker.** Activate `AndreyBegma/DemoFlow` (Woodpecker MCP:
   `activate_repository`, then `update_repository`) with:
   trusted → volumes **on**, require approval → **forks** (the repository is
   public — an unapproved fork must never reach the Docker socket), cancel
   previous pipelines on push and pull_request, timeout 60 min. Confirm the
   repository's GitHub webhook exists afterwards.
3. **Host directories.** Make sure `/home/archi/ci-cache/demoflow/{bun,turbo}`
   exist and belong to uid 1000.
4. **First run.** Trigger the pipeline manually on `develop`. `deploy-staging`
   runs `deploy/staging/refresh.sh`, which creates
   `/home/archi/stacks/demoflow-staging`, generates `POSTGRES_PASSWORD` and
   stops because the tunnel token is missing. That stop is expected.
5. **Start the stack.**
   ```sh
   cp ~/.demoflow/cloudflared-staging.env /home/archi/stacks/demoflow-staging/env/cloudflared.env
   chmod 600 /home/archi/stacks/demoflow-staging/env/cloudflared.env
   /home/archi/stacks/demoflow-staging/up.sh
   ```
6. **Verify.** `/home/archi/stacks/demoflow-staging/status.sh` must show all
   containers healthy, and `/` → 200 and `/api/health` → 200 from the public
   URL. Then prove the loop: push a trivial docs-free change to a branch, open
   a PR into `develop`, merge it, and confirm the new commit SHA appears in
   `deployed.env` and the site still answers.

Rules:

- Never print or commit `TUNNEL_TOKEN` or `POSTGRES_PASSWORD`.
- Do not touch the other stacks in `/home/archi/stacks` or other repositories'
  Woodpecker settings. Never `docker compose down -v` or prune volumes.
- If a repository file has to change (a bug in `refresh.sh`, the pipeline,
  the Dockerfiles), make it on a branch with a pull request into `develop` —
  never push to `main` or `develop` directly.
- Report at the end: the tunnel ID, the Woodpecker repository settings as
  applied, the first green pipeline URL, and the `status.sh` output.

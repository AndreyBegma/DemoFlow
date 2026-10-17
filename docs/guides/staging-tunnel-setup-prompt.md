# Prompt: create the Cloudflare tunnel for DemoFlow staging

Hand this to an agent (or a person) with access to the Cloudflare Zero Trust
dashboard of the `luna-realm.com` account. Everything else — Woodpecker, the
pipeline, the stack on the host — is already done or is done afterwards by the
agent working in the DemoFlow repository.

---

Create a Cloudflare tunnel for **DemoFlow staging** and leave its token on the
staging host. Do only what is listed here.

## Context

- Staging host: the machine that runs the Woodpecker agents and the existing
  stacks in `/home/archi/stacks/` (`agentdock-staging`, `denitsa-staging`).
- The stack `/home/archi/stacks/demoflow-staging` runs a `cloudflared`
  container on its own compose network; it reaches Caddy at `http://proxy:80`.
  Its compose file reads `TUNNEL_TOKEN` from `env/cloudflared.env`.
- The setup mirrors AgentDock's staging exactly. If anything is unclear, look
  at how the `agentdock-staging` tunnel is configured in the dashboard and do
  the same — but **do not touch it**.

## Do

1. In Zero Trust → Networks → Tunnels, create a new tunnel:
   - type **Cloudflared** (remote-managed, token-based),
   - name **`demoflow-staging`** — a tunnel of its own, not a connector on
     `agentdock-staging` or `denitsa`.
   - Skip the connector install step: the connector runs in Docker on the host.
2. Add the public hostname:
   - subdomain `staging-demoflow`, domain `luna-realm.com`, no path,
   - service type **HTTP**, URL **`proxy:80`**.
   - Confirm a proxied CNAME `staging-demoflow` → `<tunnel-id>.cfargotunnel.com`
     exists in the DNS of `luna-realm.com` afterwards.
3. Copy the tunnel token (the long string after `--token` in the install
   command) and write it on the staging host:
   ```sh
   mkdir -p ~/.demoflow && chmod 700 ~/.demoflow
   ( umask 177; printf 'TUNNEL_TOKEN=%s\n' '<token>' > ~/.demoflow/cloudflared-staging.env )
   ls -l ~/.demoflow/cloudflared-staging.env   # must be -rw-------
   ```

## Never

- Print, paste, log or commit the token anywhere except that one file — not in
  chat, not in your report, not in a shell history line you leave behind
  (clear it if you typed it).
- Change or delete any other tunnel, public hostname, DNS record or Access
  policy.
- Put a Cloudflare Access policy in front of the hostname (the site has its own
  sign-in; the runner must reach `/api/runner` without an Access login).

## Report back — exactly this, nothing secret

```
tunnel name:      demoflow-staging
tunnel id:        <uuid>
public hostname:  staging-demoflow.luna-realm.com → HTTP proxy:80
dns record:       CNAME staging-demoflow → <uuid>.cfargotunnel.com (proxied: yes/no)
token file:       ~/.demoflow/cloudflared-staging.env  <output of ls -l>
token check:      <output of: grep -c '^TUNNEL_TOKEN=.\{100,\}$' ~/.demoflow/cloudflared-staging.env>   (must be 1)
anything unusual: <none | what and why>
```

If a step cannot be done (no dashboard access, the name is taken, the domain
is not on this account), stop and report which step and the exact message —
do not improvise an alternative.

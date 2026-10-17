# The Cloudflare tunnel of the develop environment

Done on 2026-10-17. Kept as the record of what exists and how to recreate it.

| | |
|---|---|
| Tunnel | `demoflow-app`, id `3b476de8-2a3f-4a1e-bd8b-f0f504b64dbd`, remote-managed, its own tunnel |
| Public hostname | `demoflow-app.luna-realm.com` → `HTTP` `proxy:80`, no path, no Access policy |
| DNS | proxied CNAME `demoflow-app` → `3b476de8-2a3f-4a1e-bd8b-f0f504b64dbd.cfargotunnel.com` |
| Token | on the host in `~/.demoflow/cloudflared.env` (`TUNNEL_TOKEN=…`, mode 600, directory 700) |

The stack reads the token from `/home/archi/stacks/demoflow-staging/env/cloudflared.env`;
see [deploy/README.md](../../deploy/README.md) for copying it in.

## Recreating it

In Zero Trust → Networks → Tunnels, create a Cloudflared tunnel (do not
install a connector — it runs in Docker in the stack), add the public hostname
above, and write its token to `~/.demoflow/cloudflared.env` with mode 600.
Never put an Access policy in front of the hostname: the runner reaches
`/api/runner` without an Access login. Never paste the token anywhere else.

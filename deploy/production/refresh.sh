#!/bin/sh
# Deploys production: the pipeline's `deploy-production` step, after
# build-production.sh, or by hand from the repository root. POSIX sh: it runs
# in the busybox `docker:28-cli` image with the Docker socket and
# PRODUCTION_DIR bind-mounted at the same path as on the host, so the compose
# file's relative paths mean the same thing to the daemon.
#
# The first run creates PRODUCTION_DIR, copies the examples in, generates every
# secret that is pure randomness, and stops without starting anything until
# the one hand-made value — the tunnel token — is in place.
set -eu

PRODUCTION_DIR="${PRODUCTION_DIR:-/home/archi/stacks/demoflow-production}"
SRC="$(cd "$(dirname "$0")" && pwd)"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"

branch="${CI_COMMIT_BRANCH:-}"
if [ -n "$branch" ] && [ "$branch" != main ]; then
  echo "refresh.sh deploys main only, got '$branch'" >&2
  exit 1
fi

mkdir -p "$PRODUCTION_DIR/env"

# ── env files: copied once, never overwritten ───────────────────────────────
copy_once() {
  if [ ! -f "$2" ]; then
    cp "$1" "$2"
    echo "created $2"
  fi
  chmod 600 "$2"
}
copy_once "$SRC/.env.example" "$PRODUCTION_DIR/.env"
for example in "$SRC"/env/*.env.example; do
  copy_once "$example" "$PRODUCTION_DIR/env/$(basename "$example" .example)"
done

# Missing keys a newer example added are appended with the example's value: a
# plain setting arrives as its default, and a secret — empty in every example —
# gets generated below or reported as missing.
add_missing_keys() {
  grep -E '^[A-Z_]+=' "$1" | while IFS= read -r line; do
    key="${line%%=*}"
    grep -qE "^$key=" "$2" || printf '%s\n' "$line" >>"$2"
  done
}
add_missing_keys "$SRC/.env.example" "$PRODUCTION_DIR/.env"
for example in "$SRC"/env/*.env.example; do
  add_missing_keys "$example" "$PRODUCTION_DIR/env/$(basename "$example" .example)"
done

value_of() { grep -E "^$1=" "$2" | tail -n1 | cut -d= -f2-; }

fill_if_empty() {
  if [ -z "$(value_of "$1" "$3")" ]; then
    sed -i "s|^$1=.*|$1=$2|" "$3"
    echo "generated $1 in $3"
  fi
}
hex() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }
fill_if_empty POSTGRES_PASSWORD "$(hex)" "$PRODUCTION_DIR/.env"

# ── stack files: always the commit's own ────────────────────────────────────
caddy_changed=false
cmp -s "$SRC/Caddyfile" "$PRODUCTION_DIR/Caddyfile" || caddy_changed=true
for file in docker-compose.yml Caddyfile up.sh down.sh status.sh; do
  cp "$SRC/$file" "$PRODUCTION_DIR/$file"
done
chmod +x "$PRODUCTION_DIR"/*.sh
# The step runs as root through the socket; the operator is uid 1000.
chown -R 1000:1000 "$PRODUCTION_DIR"

if [ -z "$(value_of TUNNEL_TOKEN "$PRODUCTION_DIR/env/cloudflared.env")" ]; then
  cat >&2 <<EOF
Production is prepared but not started: TUNNEL_TOKEN is empty.
  cp ~/.demoflow/production/cloudflared.env $PRODUCTION_DIR/env/cloudflared.env
then re-run the pipeline or $PRODUCTION_DIR/up.sh (deploy/README.md).
EOF
  exit 0
fi

# ── deploy ──────────────────────────────────────────────────────────────────
cd "$PRODUCTION_DIR"
# The API first, and wait for it, so api and web are never down together; the
# proxy holds requests meanwhile. The rest follows once it is healthy.
echo "Restarting the API and waiting for it (up to ${HEALTH_TIMEOUT}s)..."
if ! docker compose up -d --remove-orphans --wait --wait-timeout "$HEALTH_TIMEOUT" api; then
  echo "demoflow-production-api did not become healthy within ${HEALTH_TIMEOUT}s" >&2
  docker logs --tail 60 demoflow-production-api >&2 || true
  exit 1
fi
docker compose up -d --remove-orphans
if [ "$caddy_changed" = true ]; then
  docker compose restart proxy
fi

echo "Waiting for the API to report healthy (up to ${HEALTH_TIMEOUT}s)..."
waited=0
while :; do
  status="$(docker inspect -f '{{.State.Health.Status}}' demoflow-production-api 2>/dev/null || echo missing)"
  [ "$status" = healthy ] && break
  if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
    echo "demoflow-production-api is '$status' after ${HEALTH_TIMEOUT}s" >&2
    docker logs --tail 60 demoflow-production-api >&2 || true
    exit 1
  fi
  sleep 5
  waited=$((waited + 5))
done

# The web image must serve apps/web/public; the poster stands for all of it.
# Asked from inside the container, so it does not depend on the tunnel.
echo "Waiting for the web app to serve /demo/landing-poster.png (up to ${HEALTH_TIMEOUT}s)..."
waited=0
until docker exec demoflow-production-web node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3670)+'/demo/landing-poster.png').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
    echo "demoflow-production-web does not serve /demo/landing-poster.png after ${HEALTH_TIMEOUT}s" >&2
    docker logs --tail 60 demoflow-production-web >&2 || true
    exit 1
  fi
  sleep 5
  waited=$((waited + 5))
done

{
  echo "DEPLOYED_SHA=${CI_COMMIT_SHA:-unknown}"
  echo "DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "PIPELINE=${CI_PIPELINE_URL:-by hand}"
} >"$PRODUCTION_DIR/deployed.env"
chown 1000:1000 "$PRODUCTION_DIR/deployed.env"

docker compose ps

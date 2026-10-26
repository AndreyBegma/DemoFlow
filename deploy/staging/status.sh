#!/bin/sh
# What is deployed and whether it answers. Run on the host from
# /home/archi/stacks/demoflow-staging.
set -u
cd "$(dirname "$0")"

HOST="https://demoflow-app.luna-realm.com"

echo "── deployed"
cat deployed.env 2>/dev/null || echo "(no deployed.env — never deployed by refresh.sh)"

echo
echo "── containers"
docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Image}}'

echo
echo "── images"
for image in demoflow-api:staging demoflow-web:staging; do
  docker image inspect -f "$image  {{.Created}}  {{index .Config.Labels \"org.opencontainers.image.revision\"}}" "$image" 2>/dev/null \
    || echo "$image  (missing)"
done

echo
echo "── public"
# The poster stands for apps/web/public: a 404 there means the web image was
# built without it.
failed=0
for path in / /api/health /demo/landing-poster.png; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HOST$path")"
  printf '%-26s %s\n' "$path" "$code"
  [ "$code" = 200 ] || failed=1
done
echo "(530 / error 1033: the hostname exists but no tunnel connector is running)"
exit "$failed"

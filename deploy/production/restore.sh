#!/bin/sh
# Restores a dump written by backup.sh into the production database, replacing
# what is there. Run on the host:
#
#   restore.sh <dump> --yes-replace-production-database
#
# Without the flag it only says what it would do. The API is stopped during the
# restore so nothing writes into a half-restored database, and started again
# afterwards whether the restore worked or not.
set -eu

CONTAINER="${CONTAINER:-demoflow-production-postgres}"
API_CONTAINER="${API_CONTAINER:-demoflow-production-api}"
DB_NAME="${DB_NAME:-demoflow}"
DB_USER="${DB_USER:-postgres}"
CONFIRM=--yes-replace-production-database

usage() {
  echo "usage: $0 <dump> $CONFIRM" >&2
  exit 2
}

[ $# -ge 1 ] || usage
dump="$1"
[ -f "$dump" ] || { echo "no such dump: $dump" >&2; exit 1; }

if [ "${2:-}" != "$CONFIRM" ]; then
  echo "This replaces database '$DB_NAME' in $CONTAINER with $dump." >&2
  echo "Re-run with $CONFIRM to do it." >&2
  exit 2
fi

docker exec -i "$CONTAINER" pg_restore --list >/dev/null <"$dump" \
  || { echo "$dump is not a dump pg_restore can read" >&2; exit 1; }

api_stopped=false
if [ "$(docker inspect -f '{{.State.Running}}' "$API_CONTAINER" 2>/dev/null || echo false)" = true ]; then
  echo "stopping $API_CONTAINER"
  docker stop "$API_CONTAINER" >/dev/null
  api_stopped=true
fi
restart_api() {
  if [ "$api_stopped" = true ]; then
    echo "starting $API_CONTAINER"
    docker start "$API_CONTAINER" >/dev/null
  fi
}
trap restart_api EXIT

# One transaction: a failed restore leaves the database as it was.
docker exec -i "$CONTAINER" pg_restore -U "$DB_USER" -d "$DB_NAME" \
  --clean --if-exists --no-owner --single-transaction --exit-on-error <"$dump"

echo "restored $dump into $DB_NAME"

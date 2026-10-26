#!/bin/sh
# Checks backup.sh and restore.sh against two throwaway Postgres containers —
# never the production one. Run from a checkout on a host with Docker:
#
#   sh deploy/production/test-backup.sh
#
# 1. A dump of a seeded database restores into an empty one with the same row
#    counts; the directory is 700 and the dump 600.
# 2. With more than 14 dumps, the oldest are deleted.
# 3. A failed dump exits non-zero and leaves the existing dumps untouched.
# 4. restore.sh refuses without its confirmation flag.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
TAG="demoflow-backup-test-${NAUTELLE_CARD:-$$}"
SRC_DB="$TAG-src"
DST_DB="$TAG-dst"
API="$TAG-api"
WORK="$(mktemp -d)"
BACKUP_DIR="$WORK/backups"

cleanup() {
  docker rm -f "$SRC_DB" "$DST_DB" "$API" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

start_db() {
  docker run -d --name "$1" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=demoflow postgres:16.5-alpine >/dev/null
}
wait_db() {
  tries=0
  until docker exec "$1" psql -U postgres -d demoflow -c 'select 1' >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || fail "$1 did not start"
    sleep 1
  done
}
psql_in() {
  container="$1"
  shift
  docker exec -i "$container" psql -U postgres -d demoflow -v ON_ERROR_STOP=1 -tA "$@"
}
counts() {
  psql_in "$1" -c "select (select count(*) from account) || ' ' || (select count(*) from run)" | sed -n '1p'
}

start_db "$SRC_DB"
start_db "$DST_DB"
wait_db "$SRC_DB"
wait_db "$DST_DB"

psql_in "$SRC_DB" >/dev/null <<'SQL'
create table account (id serial primary key, email text not null unique);
create table run (id serial primary key, account_id int not null references account(id), name text);
insert into account (email) select 'user' || g || '@example.test' from generate_series(1, 137) g;
insert into run (account_id, name) select 1 + g % 137, 'run ' || g from generate_series(1, 1009) g;
SQL

export BACKUP_DIR CONTAINER="$SRC_DB"

echo "── 1. backup and restore"
sh "$HERE/backup.sh"
dump="$(ls -1 "$BACKUP_DIR"/demoflow-production-*.dump)"
[ "$(stat -c %a "$BACKUP_DIR")" = 700 ] || fail "backup dir is not 700"
[ "$(stat -c %a "$dump")" = 600 ] || fail "dump is not 600"
grep -q "^LAST_BACKUP=$dump$" "$BACKUP_DIR/last-backup.env" || fail "last-backup.env does not name the dump"

CONTAINER="$DST_DB" API_CONTAINER="$TAG-no-api" sh "$HERE/restore.sh" "$dump" --yes-replace-production-database
want="$(counts "$SRC_DB")"
got="$(counts "$DST_DB")"
[ "$want" = "137 1009" ] || fail "source counts are '$want'"
[ "$got" = "$want" ] || fail "restored counts '$got', want '$want'"
echo "row counts match: $got"

# Again over a database that has drifted, with a stand-in API container that
# must be running again afterwards.
psql_in "$DST_DB" -c "insert into account (email) values ('late@example.test')" >/dev/null
docker run -d --name "$API" alpine:3.20 sleep 600 >/dev/null
CONTAINER="$DST_DB" API_CONTAINER="$API" sh "$HERE/restore.sh" "$dump" --yes-replace-production-database
got="$(counts "$DST_DB")"
[ "$got" = "$want" ] || fail "second restore counts '$got', want '$want'"
[ "$(docker inspect -f '{{.State.Running}}' "$API")" = true ] || fail "the API was not started again"
echo "restore over existing data matches, API running again"

echo "── 2. retention"
i=10
while [ "$i" -le 24 ]; do
  touch "$BACKUP_DIR/demoflow-production-200001${i}T000000Z.dump"
  i=$((i + 1))
done
sh "$HERE/backup.sh"
left="$(ls -1 "$BACKUP_DIR"/demoflow-production-*.dump | wc -l | tr -d ' ')"
[ "$left" = 14 ] || fail "$left dumps left, want 14"
[ ! -e "$BACKUP_DIR/demoflow-production-20000110T000000Z.dump" ] || fail "the oldest dump was kept"
[ -e "$dump" ] || fail "the first real dump was deleted"
echo "14 dumps kept, oldest removed"

echo "── 3. a failed dump"
before="$(ls -1a "$BACKUP_DIR")"
if DB_NAME=no_such_database sh "$HERE/backup.sh"; then
  fail "backup.sh succeeded against a missing database"
fi
[ "$(ls -1a "$BACKUP_DIR")" = "$before" ] || fail "a failed dump changed the backup directory"
echo "failed dump exited non-zero, dumps untouched"

echo "── 4. restore without confirmation"
if CONTAINER="$DST_DB" sh "$HERE/restore.sh" "$dump"; then
  fail "restore.sh ran without the confirmation flag"
fi
echo "restore refused"

echo "OK"

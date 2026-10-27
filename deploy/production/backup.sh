#!/bin/sh
# Dumps the production database (pg_dump -Fc) into BACKUP_DIR and keeps the
# newest KEEP dumps. Run daily on the host by the systemd user timer
# demoflow-production-backup.timer (deploy/README.md), or by hand.
#
# A failed dump exits non-zero, removes its partial file and deletes nothing
# else: old dumps are pruned only after a new one is written and verified.
set -eu

CONTAINER="${CONTAINER:-demoflow-production-postgres}"
DB_NAME="${DB_NAME:-demoflow}"
DB_USER="${DB_USER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-/home/archi/backups/demoflow-production}"
KEEP="${KEEP:-14}"

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="$BACKUP_DIR/demoflow-production-$stamp.dump"
partial="$BACKUP_DIR/.partial-$stamp.dump"
trap 'rm -f "$partial"' EXIT

if ! docker exec "$CONTAINER" pg_dump -U "$DB_USER" -Fc "$DB_NAME" >"$partial"; then
  echo "backup failed: pg_dump in $CONTAINER exited non-zero; previous dumps kept" >&2
  exit 1
fi
# A dump pg_restore cannot list is no backup.
if ! docker exec -i "$CONTAINER" pg_restore --list >/dev/null <"$partial"; then
  echo "backup failed: pg_restore cannot read the new dump; previous dumps kept" >&2
  exit 1
fi

chmod 600 "$partial"
mv "$partial" "$dump"

# Timestamps sort lexically, so the newest come first in reverse order.
ls -1 "$BACKUP_DIR"/demoflow-production-*.dump | sort -r | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
  rm -f "$old"
  echo "removed $old"
done

{
  echo "LAST_BACKUP=$dump"
  echo "LAST_BACKUP_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "LAST_BACKUP_BYTES=$(wc -c <"$dump" | tr -d ' ')"
} >"$BACKUP_DIR/last-backup.env"

echo "wrote $dump"

#!/bin/sh
# Deploying is "replace the containers": there is no migration step in the
# pipeline. The API migrates and seeds before it listens, and refuses to start
# when either fails. The seed must stay idempotent.
set -eu

prisma migrate deploy
prisma db seed

exec "$@"

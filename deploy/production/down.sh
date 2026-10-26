#!/bin/sh
# Stops production. Never `-v` (the database lives in the volumes) and never
# `--remove-orphans`: staging and other stacks share this Docker daemon.
set -eu
cd "$(dirname "$0")"
docker compose down

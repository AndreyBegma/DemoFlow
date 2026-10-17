#!/bin/sh
# Builds the staging images on the agent host's Docker daemon. Run from the
# repository root; the pipeline's `build-staging` step calls it. The mutable
# tag `:staging` is the boundary: refresh.sh starts whatever it points at.
set -eu

HOST="https://staging-demoflow.luna-realm.com"
REVISION="${CI_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"

echo "Building demoflow-api:staging ($REVISION)"
docker build \
  --label "org.opencontainers.image.revision=$REVISION" \
  --label demoflow.stage=staging \
  -t demoflow-api:staging \
  -f apps/api/Dockerfile .

echo "Building demoflow-web:staging ($REVISION)"
docker build \
  --label "org.opencontainers.image.revision=$REVISION" \
  --label demoflow.stage=staging \
  --build-arg "NEXT_PUBLIC_API_URL=$HOST/api" \
  -t demoflow-web:staging \
  -f apps/web/Dockerfile .

# The previous :staging images are now dangling. Only ours: other stacks share
# this daemon. The build cache stays.
docker image prune -f --filter label=demoflow.stage=staging >/dev/null

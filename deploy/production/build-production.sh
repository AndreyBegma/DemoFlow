#!/bin/sh
# Builds the production images on the agent host's Docker daemon. Run from the
# repository root; the pipeline's `build-production` step calls it. The mutable
# tag `:production` is the boundary: refresh.sh starts whatever it points at.
set -eu

HOST="https://demoflow.luna-realm.com"
REVISION="${CI_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"

echo "Building demoflow-api:production ($REVISION)"
docker build \
  --label "org.opencontainers.image.revision=$REVISION" \
  --label demoflow.stage=production \
  -t demoflow-api:production \
  -f apps/api/Dockerfile .

echo "Building demoflow-web:production ($REVISION)"
docker build \
  --label "org.opencontainers.image.revision=$REVISION" \
  --label demoflow.stage=production \
  --build-arg "NEXT_PUBLIC_API_URL=$HOST/api" \
  -t demoflow-web:production \
  -f apps/web/Dockerfile .

# The previous :production images are now dangling. Only ours: staging and
# other stacks share this daemon. The build cache stays.
docker image prune -f --filter label=demoflow.stage=production >/dev/null

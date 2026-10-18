#!/bin/sh
# Runs `npm publish` for .woodpecker/release.yml, kept out of the YAML so it
# can be tested (publish.test.mjs). From luna-player's release scripts.
#
#   publish.sh <package-dir> <npm-dist-tag>
#
# The package directory is the staged apps/cli/dist/npm: the one
# apps/cli/scripts/smoke.mjs packs and tests.
#
# A version the registry already holds is not an error. The publish step asks
# `npm view` first, but a moment after a publish the registry can still answer
# "not found" (propagation). The tag pipeline, which the push pipeline's own
# tag starts within seconds, can then try to publish again and fail with
# E409 "Cannot publish over previously staged version". The 409 is the
# registry saying the version is there, so it passes. Any other failure fails.
#
# NPM overrides the npm binary (the test points it at a stub).
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: publish.sh <package-dir> <npm-dist-tag>" >&2
  exit 2
fi

npm_bin=${NPM:-npm}
out=$(mktemp)
trap 'rm -f "$out"' EXIT

status=0
"$npm_bin" publish "$1" --ignore-scripts --access public --tag "$2" >"$out" 2>&1 || status=$?
cat "$out"

if [ "$status" -eq 0 ]; then
  exit 0
fi

if grep -qiE 'E409|EPUBLISHCONFLICT|cannot publish over' "$out"; then
  echo "the registry already holds this version (409): treating it as published"
  exit 0
fi

exit "$status"

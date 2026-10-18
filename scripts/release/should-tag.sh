#!/bin/sh
# The tag decision for .woodpecker/release.yml, kept out of the YAML so
# it can be tested (should-tag.test.mjs). From luna-player's release scripts.
#
#   should-tag.sh <decision-file> <tag-exists: yes|no>
#
# The decision file is what the publish step recorded after it finished
# (.release/decision: publish=yes|no, version=X.Y.Z). The tag step reads it
# instead of asking `npm view`, which can still say "not found" a moment after
# a publish (registry propagation).
#
# Prints tag=yes|no:
#   publish=yes           the version was published now: tag it.
#   publish=no            the version was already on npm. With no tag yet this
#                         is a re-run after a publish whose tag failed: tag it
#                         (idempotent). With the tag present it is a push
#                         without a version bump: nothing to do.
#   no decision file      the publish step did not get to decide (no npm_token,
#                         a manual dry run): no tag.
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: should-tag.sh <decision-file> <tag-exists: yes|no>" >&2
  exit 2
fi

file=$1
tag_exists=$2

if [ ! -f "$file" ]; then
  echo "tag=no"
  exit 0
fi

publish=
version=
while IFS='=' read -r key value; do
  case "$key" in
    publish) publish=$value ;;
    version) version=$value ;;
  esac
done < "$file"

case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "no version in $file" >&2; exit 2 ;;
esac

if [ "$publish" = yes ]; then
  echo "tag=yes"
elif [ "$publish" = no ] && [ "$tag_exists" = no ]; then
  echo "tag=yes"
elif [ "$publish" = no ]; then
  echo "tag=no"
else
  echo "no publish decision in $file" >&2
  exit 2
fi

#!/bin/sh
# Release decisions for .woodpecker/release.yml, kept out of the YAML so
# they can be tested (decide.test.mjs). From luna-player's release scripts.
#
#   decide.sh <version> <published: yes|no> <latest-on-npm|""> <branch|"">
#
# Prints three key=value lines:
#   publish=yes|no   no when the version is already on npm: a merge to main
#                    without a version bump publishes nothing, and a re-run of a
#                    tag that published passes.
#   npm_tag=...      `latest`, or v<major>.<minor> for a maint line. A branch
#                    named maint/* or a version below the current `latest` is a
#                    maint line, so publishing 0.1.9 can never move `latest`
#                    back from 0.2.0.
#   git_tag=v<version>
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: decide.sh <version> <published: yes|no> <latest> <branch>" >&2
  exit 2
fi

version=$1
published=$2
latest=$3
branch=$4

case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "not a version: $version" >&2; exit 2 ;;
esac

maint=no
case "$branch" in
  maint/*) maint=yes ;;
esac
if [ -n "$latest" ] && [ "$version" != "$latest" ]; then
  lowest=$(printf '%s\n%s\n' "$version" "$latest" | sort -V | head -n 1)
  if [ "$lowest" = "$version" ]; then
    maint=yes
  fi
fi

if [ "$maint" = yes ]; then
  npm_tag="v${version%.*}"
else
  npm_tag=latest
fi

if [ "$published" = yes ]; then
  echo "publish=no"
else
  echo "publish=yes"
fi
echo "npm_tag=$npm_tag"
echo "git_tag=v$version"

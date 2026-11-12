#!/usr/bin/env bash
#
# Release a new version: bump the version -> commit -> tag -> push.
# Pushing the tag triggers GitHub Actions (.github/workflows/publish.yml) to
# publish to npm. CI uses OIDC trusted publishing, so no npm token is needed.
#
# Usage:
#   ./scripts/release.sh patch    # 0.1.0 -> 0.1.1
#   ./scripts/release.sh minor    # 0.1.1 -> 0.2.0
#   ./scripts/release.sh major    # 0.2.0 -> 1.0.0
#   ./scripts/release.sh 1.2.3    # explicit version
#
set -euo pipefail

cd "$(dirname "$0")/.."

BUMP="${1:-}"
if [ -z "$BUMP" ]; then
  echo "Usage: $0 <patch|minor|major|X.Y.Z>" >&2
  exit 1
fi

# The working tree must be clean so unrelated changes do not enter the release commit.
if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has uncommitted changes; commit or stash them first:" >&2
  git status --short >&2
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Current branch is $CURRENT_BRANCH; release from main" >&2
  exit 1
fi

# Tests must pass before a release.
echo "Running tests..."
bun test

# Do not create the tag yet; npm computes the version bump.
case "$BUMP" in
  patch|minor|major)
    npm version "$BUMP" --no-git-tag-version >/dev/null
    ;;
  *)
    if ! printf '%s' "$BUMP" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "Version must be X.Y.Z; got: $BUMP" >&2
      exit 1
    fi
    npm version "$BUMP" --no-git-tag-version >/dev/null
    ;;
esac

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

echo "Preparing release $VERSION (tag: $TAG)"

git add package.json
git -c core.hooksPath=/dev/null commit -m "chore: release $TAG"
git tag -a "$TAG" -m "release $TAG"

echo "Pushing to origin..."
git push origin "$CURRENT_BRANCH"
git push origin "$TAG"

echo
echo "Pushed $TAG; GitHub Actions is publishing to npm."
echo "Watch progress: gh run watch \$(gh run list --limit 1 --json databaseId -q '.[0].databaseId')"
echo "Package:       https://www.npmjs.com/package/opencode-wait-for-v2"

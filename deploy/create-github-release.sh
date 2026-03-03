#!/usr/bin/env bash
set -euo pipefail

#
# create-github-release.sh — Create a GitHub Release from CHANGELOG.md
#
# Usage: bash deploy/create-github-release.sh v1.1.0
# Run this AFTER the release PR has been merged to main.
#

VERSION="${1:-}"

# ── Validate argument ─────────────────────────────────────────────────
if [[ -z "$VERSION" ]]; then
  echo "Usage: bash deploy/create-github-release.sh <version>"
  echo "  e.g. bash deploy/create-github-release.sh v1.1.0"
  exit 1
fi

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Version must match vX.Y.Z (e.g. v1.1.0)"
  exit 1
fi

# ── Verify PR is merged ──────────────────────────────────────────────
MAIN_VERSION=$(git log origin/main -1 --pretty=format:"%s" 2>/dev/null || "")
echo "==> Latest main commit: ${MAIN_VERSION}"

# ── Extract release notes from CHANGELOG.md ───────────────────────────
if [[ ! -f "CHANGELOG.md" ]]; then
  echo "Error: CHANGELOG.md not found"
  exit 1
fi

# Extract the section for this version (between "## vX.Y.Z" and next "## v")
NOTES=$(sed -n "/^## ${VERSION} /,/^## v/{/^## v[0-9]/!p;}" CHANGELOG.md | sed '/^$/d')

if [[ -z "$NOTES" ]]; then
  echo "Error: No CHANGELOG entry found for ${VERSION}"
  exit 1
fi

echo "==> Release notes:"
echo "$NOTES"
echo ""

# ── Create GitHub Release (also creates the tag) ─────────────────────
echo "==> Creating GitHub Release ${VERSION}..."

gh release create "${VERSION}" \
  --target main \
  --title "${VERSION}" \
  --notes "$NOTES"

echo ""
echo "========================================"
echo "  Release ${VERSION} created!"
echo "========================================"

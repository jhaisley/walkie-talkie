#!/usr/bin/env bash
set -euo pipefail

#
# create-release-pr.sh — Automate version bump, CHANGELOG, and PR creation
#
# Usage: bash deploy/create-release-pr.sh v1.1.0
#

VERSION="${1:-}"

# ── 1. Validate argument ──────────────────────────────────────────────
if [[ -z "$VERSION" ]]; then
  echo "Usage: bash deploy/create-release-pr.sh <version>"
  echo "  e.g. bash deploy/create-release-pr.sh v1.1.0"
  exit 1
fi

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Version must match vX.Y.Z (e.g. v1.1.0)"
  exit 1
fi

SEMVER="${VERSION#v}"  # strip leading 'v' for package.json etc.

# ── 2. Ensure we are on develop ───────────────────────────────────────
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "develop" ]]; then
  echo "Error: Must be on 'develop' branch (currently on '$BRANCH')"
  exit 1
fi

echo "==> Releasing $VERSION (semver: $SEMVER)"

# ── 3. Bump version in package files ──────────────────────────────────
bump_json_version() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "Warning: $file not found, skipping"
    return
  fi
  sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$SEMVER\"/" "$file"
  echo "  Updated $file"
}

echo "==> Bumping versions..."
bump_json_version "package.json"
bump_json_version "hub/package.json"
bump_json_version "mcp-server/package.json"
bump_json_version "plugin/.claude-plugin/plugin.json"
bump_json_version ".claude-plugin/marketplace.json"

# ── 4. Generate CHANGELOG from merge commits ──────────────────────────
echo "==> Generating CHANGELOG..."

TODAY=$(date +%Y-%m-%d)

FEATURES=""
FIXES=""
OTHER=""

while IFS= read -r line; do
  [[ -z "$line" ]] && continue

  # Extract PR number and branch name from merge commit message
  # Format: "Merge pull request #N from owner/type/..."
  if [[ "$line" =~ Merge\ pull\ request\ \#([0-9]+)\ from\ [^/]+/(.+) ]]; then
    PR_NUM="${BASH_REMATCH[1]}"
    BRANCH_NAME="${BASH_REMATCH[2]}"

    # Get the PR title via gh
    PR_TITLE=$(gh pr view "$PR_NUM" --json title --jq '.title' 2>/dev/null || echo "")
    if [[ -z "$PR_TITLE" ]]; then
      PR_TITLE="$BRANCH_NAME"
    fi

    ENTRY="- ${PR_TITLE} (#${PR_NUM})"

    # Classify by branch prefix
    if [[ "$BRANCH_NAME" =~ ^feature/ ]]; then
      FEATURES="${FEATURES}${ENTRY}\n"
    elif [[ "$BRANCH_NAME" =~ ^fix/ ]]; then
      FIXES="${FIXES}${ENTRY}\n"
    else
      OTHER="${OTHER}${ENTRY}\n"
    fi
  fi
done < <(git log main..develop --merges --pretty=format:"%s" --reverse)

# Build new changelog section
NEW_SECTION="## ${VERSION} (${TODAY})"

if [[ -n "$FEATURES" ]]; then
  NEW_SECTION="${NEW_SECTION}\n\n### Features\n${FEATURES}"
fi
if [[ -n "$FIXES" ]]; then
  NEW_SECTION="${NEW_SECTION}\n### Fixes\n${FIXES}"
fi
if [[ -n "$OTHER" ]]; then
  NEW_SECTION="${NEW_SECTION}\n### Other\n${OTHER}"
fi

# Write CHANGELOG.md (prepend to existing or create new)
if [[ -f "CHANGELOG.md" ]]; then
  # Insert after the "# Changelog" header
  EXISTING=$(tail -n +2 "CHANGELOG.md")  # everything after first line
  printf "# Changelog\n\n%b\n%s\n" "$NEW_SECTION" "$EXISTING" > CHANGELOG.md
else
  printf "# Changelog\n\n%b" "$NEW_SECTION" > CHANGELOG.md
fi

echo "  Generated CHANGELOG.md"

# ── 5. Commit and push ───────────────────────────────────────────────
echo "==> Committing changes..."
git add \
  package.json \
  hub/package.json \
  mcp-server/package.json \
  plugin/.claude-plugin/plugin.json \
  .claude-plugin/marketplace.json \
  CHANGELOG.md

git commit -m "Bump version to ${VERSION}"

echo "==> Pushing to develop..."
git push origin develop

# ── 6. Create PR develop → main ──────────────────────────────────────
echo "==> Creating pull request..."

# Build PR body from changelog section
PR_BODY=$(printf "## Release ${VERSION}\n\n%b" "$NEW_SECTION")

PR_URL=$(gh pr create \
  --base main \
  --head develop \
  --title "Release ${VERSION}" \
  --body "$PR_BODY")

echo ""
echo "========================================"
echo "  PR created: ${PR_URL}"
echo "========================================"
echo ""
echo "Next steps:"
echo "  1. Review and merge the PR above"
echo "  2. Then create the GitHub Release:"
echo ""
echo "    bash deploy/create-github-release.sh ${VERSION}"
echo ""

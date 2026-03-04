---
name: create-pr
description: Create a GitHub issue, feature branch from develop, and a PR targeting develop. All in English.
argument-hint: [issue title]
---

Create a GitHub issue, feature branch, commit, and pull request for the current changes.
All output (issue, commit message, PR) MUST be written in **English**.

## Steps

### 1. Create a GitHub Issue

```
gh issue create --title "<title>" --body "<body>"
```

- Summarize the purpose of the changes
- Extract the issue number from the output

### 2. Create a branch from `develop`

```
git checkout develop
git checkout -b <prefix>/<issue-number>_<short-kebab-description>
```

- Choose the prefix based on the nature of the changes:
  - `feature/` — new functionality or enhancements
  - `fix/` — bug fixes
  - `refactor/` — code restructuring without behavior change
  - `docs/` — documentation only
  - `chore/` — maintenance, dependency updates, etc.
- Examples: `feature/45_persist-conversation-data`, `fix/50_polling-timeout`

### 3. Stage and commit

- Stage only the relevant files (do NOT use `git add -A`)
- Commit message format:

```
<imperative summary>

<details if needed>

Closes #<issue-number>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

### 4. Push and create PR targeting `develop`

```
git push -u origin <branch-name>
gh pr create --base develop --title "<title>" --body "<body>"
```

PR body format:

```
## Summary
- <bullet points>

## Test plan
- [ ] <checklist items>

Closes #<issue-number>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

### 5. Report the issue URL and PR URL to the user

## Rules

- All text MUST be in **English**
- Always branch from and merge into `develop` (never `main`)
- Always include the issue number in the branch name
- If `$ARGUMENTS` is provided, use it as the issue title

#!/usr/bin/env bash
# Looks for an open draft fix that Benny already opened for a report. If there is one, it starts CI
# on it, since an earlier run may have stopped before that, and marks the report as having a fix.
# Usage: existing-fix.sh ISSUE_NUMBER
# Prints the pull request URL when it found one, and nothing otherwise. Needs GH_TOKEN and GH_REPO.
set -euo pipefail

issue="$1"
# A fork can open a pull request from a branch with any name, so only this repository's count.
found=$(gh pr list --state open --limit 1000 --json url,headRefName,isCrossRepository \
	--jq "[.[] | select(.isCrossRepository == false and (.headRefName | startswith(\"benny/issue-$issue-\")))][0]
		| select(. != null) | \"\(.headRefName) \(.url)\"")
[[ -n "$found" ]] || exit 0
read -r branch url <<< "$found"

gh workflow run ci.yml --ref "$branch" >&2
printf '<!-- benny:pr -->\nA draft fix for this report is already open, so Benny did not start another: %s\n' "$url" |
	gh issue comment "$issue" --body-file - >&2
gh issue edit "$issue" --remove-label benny:fixing --add-label benny:pr >&2
echo "$url"

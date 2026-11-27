#!/usr/bin/env bash
# Fails when the staged changes or the given files look like they hold a secret.
# Usage: scan-secrets.sh [FILE...]
# Run it from the repository root. It prints nothing, so a log never repeats a match.
# It uses scripts/check-secrets.mjs as it was on GITHUB_SHA, because the change may edit it.
set -euo pipefail

scan=$(mktemp -d)
trap 'rm -rf "$scan"' EXIT
git show "$GITHUB_SHA:scripts/check-secrets.mjs" > "$scan/check-secrets.mjs"
git init --quiet "$scan/tree"

# The scanner skips a file that holds a NUL byte, so NUL bytes are removed before it reads one.
git diff --cached --raw -z --no-renames --no-abbrev --diff-filter=d |
	while IFS= read -r -d '' meta && IFS= read -r -d '' path; do
		blob=$(cut -d' ' -f4 <<< "$meta")
		mkdir -p "$scan/tree/change/$(dirname -- "$path")"
		git cat-file blob "$blob" | LC_ALL=C tr -d '\0' > "$scan/tree/change/$path"
	done
mkdir -p "$scan/tree/given"
n=0
for file in "$@"; do
	LC_ALL=C tr -d '\0' < "$file" > "$scan/tree/given/$n"
	n=$((n + 1))
done

git -C "$scan/tree" add -A
(cd "$scan/tree" && node "$scan/check-secrets.mjs") > /dev/null 2>&1

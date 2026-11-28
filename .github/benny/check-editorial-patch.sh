#!/usr/bin/env bash
set -euo pipefail

today=$(TZ=Asia/Kolkata date +%F)

if ! {
	IFS= read -r -d '' change &&
	IFS= read -r -d '' path &&
	[[ "$change" =~ ^:100644\ 100644\ [0-9a-f]+\ [0-9a-f]+\ M$ ]] &&
	[[ "$path" =~ ^content/messages/[0-9]{4}-[0-9]{2}-[0-9]{2}\.txt$ ]] &&
	[[ "${path##*/}" > "$today.txt" ]] &&
	! IFS= read -r -d '' extra
} < <(git diff --cached --raw --no-renames -z); then
	echo 'An editorial draft must modify exactly one existing future message file.' >&2
	exit 1
fi

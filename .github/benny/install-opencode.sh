#!/usr/bin/env bash
set -euo pipefail

dir="$RUNNER_TEMP/benny-opencode"
mkdir -p "$dir"
archive="$dir/opencode.tar.gz"
curl -fsSL --retry 3 -o "$archive" \
  https://github.com/anomalyco/opencode/releases/download/v2.3.0/opencode-linux-x64.tar.gz
printf '%s  %s\n' fc0f81522aceeabac47693d88389efa2bc517ce74c2c38fd6967819fcc6e4d3b "$archive" |
  sha256sum -c > /dev/null
tar -xzf "$archive" -C "$dir"
"$dir/opencode" --version
printf '%s\n' "$dir" >> "$GITHUB_PATH"

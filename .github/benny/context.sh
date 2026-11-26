#!/usr/bin/env bash
# Writes one Benny report and its context as Markdown, for Claude to read as data.
# Usage: context.sh ISSUE_NUMBER OUTPUT_DIR
# Writes OUTPUT_DIR/report.md, and OUTPUT_DIR/open-reports.txt with the other open report numbers.
# Needs GH_TOKEN and GITHUB_REPOSITORY.
set -euo pipefail

issue="$1"
out="$2"
owner=chrislazar25
mkdir -p "$out"

gh api "repos/$GITHUB_REPOSITORY/issues/$issue" > "$out/issue.json"
gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$issue/comments?per_page=100" | jq -s 'add // []' > "$out/comments.json"
gh api --paginate "repos/$GITHUB_REPOSITORY/issues?state=open&labels=benny%3Areport&creator=$owner&per_page=100" |
	jq -s --argjson n "$issue" '[add // [] | .[] | select(.pull_request == null and .number != $n)]' > "$out/open.json"

jq -r '.[].number' "$out/open.json" > "$out/open-reports.txt"

# Only the owner's account writes reports and follow-ups. Anyone can comment on a public
# issue, so other people's comments never reach Claude.
jq -r -n --arg owner "$owner" \
	--slurpfile issue "$out/issue.json" --slurpfile comments "$out/comments.json" --slurpfile open "$out/open.json" '
	def ist: fromdateiso8601 + 19800 | strftime("%Y-%m-%d %H:%M IST");
	def labels: [.labels[].name] | join(", ");
	def none_or(f): if length == 0 then "(none)" else .[] | f end;
	$issue[0] as $i |
	"# Report #\($i.number)", "",
	"- Opened: \($i.created_at | ist)",
	"- Labels: \($i | labels)",
	"- Title: \($i.title)", "",
	"## Report text", "", ($i.body // "(empty)"), "",
	"## Follow-ups and earlier Benny notes", "",
	([$comments[0][] | select(.user.login == $owner or (.user.login == "github-actions[bot]" and (.body | contains("<!-- benny:"))))] |
		none_or("### \(if .user.login == $owner then "Follow-up" else "Earlier Benny note" end), \(.created_at | ist)", "", .body, "")),
	"## Other open reports", "",
	($open[0] | none_or("### #\(.number), opened \(.created_at | ist)", "", "- Labels: \(labels)", "- Title: \(.title)", "", ((.body // "") | .[0:800]), ""))
' > "$out/report.md"

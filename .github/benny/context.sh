#!/usr/bin/env bash
# Writes one Benny report and its context as Markdown, for Claude to read as data.
# Usage: context.sh ISSUE_NUMBER OUTPUT_DIR [triage|fix]
# Writes OUTPUT_DIR/report.md, and OUTPUT_DIR/photos/ with the photos the reporter sent.
# Needs GH_TOKEN and GITHUB_REPOSITORY.
set -euo pipefail

issue="$1"
out="$2"
stage="${3:-triage}"
owner=chrislazar25
mkdir -p "$out"

gh api "repos/$GITHUB_REPOSITORY/issues/$issue" > "$out/issue.json"
# Only the owner's account writes reports and follow-ups. Anyone can comment on a public
# issue, so other people's comments never reach Claude, as text, as photos or as a file here.
# Only the fix stage uses previous Benny verdicts as evidence.
gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$issue/comments?per_page=100" |
	jq -s --arg owner "$owner" --arg stage "$stage" \
		'[add // [] | .[] | select(.user.login == $owner or ($stage == "fix" and .user.login == "github-actions[bot]" and (.body | contains("<!-- benny:"))))]' \
		> "$out/notes.json"
gh api --paginate "repos/$GITHUB_REPOSITORY/issues?state=open&labels=benny%3Areport&creator=$owner&per_page=100" |
	jq -s --argjson n "$issue" '[add // [] | .[] | select(.pull_request == null and .number != $n)]' > "$out/open.json"

# Photos the bridge uploaded. Claude can open a local image but not a URL, so fetch them here.
# A missing photo leaves Claude with the text alone, which beats no triage.
mkdir -p "$out/photos"
{ jq -r '.body // ""' "$out/issue.json"; jq -r '.[].body // ""' "$out/notes.json"; } |
	{ grep -oE "https://raw\.githubusercontent\.com/$GITHUB_REPOSITORY/benny-media/reports/[A-Za-z0-9_]+\.(jpg|png|webp|gif)" || true; } |
	sort -u | while read -r url; do
		photo="$out/photos/${url##*/}"
		curl -fsSL --max-filesize 10485760 -o "$photo" "$url" ||
			{ rm -f "$photo"; echo "::warning::Could not download $url, so Claude goes on without it."; }
	done

jq -r -n --arg owner "$owner" --arg stage "$stage" \
	--slurpfile issue "$out/issue.json" --slurpfile notes "$out/notes.json" --slurpfile open "$out/open.json" '
	def ist: fromdateiso8601 + 19800 | strftime("%Y-%m-%d %H:%M IST");
	def labels: [.labels[].name] | join(", ");
	def none_or(f): if length == 0 then "(none)" else .[] | f end;
	$issue[0] as $i |
	"# Report #\($i.number)", "",
	"- Opened: \($i.created_at | ist)",
	"- Labels: \($i | labels)",
	"- Title: \($i.title)", "",
	"## Report text", "", ($i.body // "(empty)"), "",
	(if $stage == "fix" then "## Follow-ups and earlier Benny notes" else "## Follow-ups" end), "",
	($notes[0] | none_or("### \(if .user.login == $owner then "Follow-up" else "Earlier Benny note" end), \(.created_at | ist)", "", .body, "")),
	"## Other open reports", "",
	($open[0] | none_or("### #\(.number), opened \(.created_at | ist)", "", "- Labels: \(labels)", "- Title: \(.title)", "", ((.body // "") | .[0:800]), ""))
' > "$out/report.md"

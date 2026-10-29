# Approved daily content

Synthetic lab messages are not approved Gospel content.

Each file `messages/YYYY-MM-DD.txt` holds the exact message for that date in Asia/Kolkata. Merging a PR that adds files publishes them.

The **Content batch** workflow runs daily at 09:00 IST. When fewer than 21 days of messages remain and no batch PR is open, it drafts the next 14 days from the archive and opens a PR labelled `content-batch`. The PR body lists dates that need a message and headings to check. Edit or add files in the PR, then merge it. A date missing in the middle fails CI. A missing last date moves into the next batch. If the workflow could not start CI on an open batch PR, the next daily run starts it. Closing a batch PR keeps its branch and edits, and the workflow stops with an error until you reopen the PR or delete the branch. The image build runs `scripts/index-content.mjs`, which writes `schedule.json` with hashes of the exact UTF-8 bytes. The runtime checks those hashes. Run it locally only to test the runtime against this directory.

Production releases require fourteen consecutive dates starting on the release's IST date. Missing content blocks sending. Runtime never generates a fallback message. Git review and the protected release workflow establish approval. A manifest entry alone does not establish approval.

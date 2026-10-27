# Approved daily content

This directory starts empty. Synthetic lab messages are not approved Gospel content.

Add exact reviewed message text as `messages/YYYY-MM-DD.txt`, with the date interpreted in Asia/Kolkata. Run `node scripts/index-content.mjs` from the repository root to rebuild `schedule.json` with hashes of the exact UTF-8 bytes. Open a content PR for review.

Production releases require fourteen consecutive dates starting on the release's IST date. Missing content blocks sending. Runtime never generates a fallback message. Git review and the protected release workflow establish approval. A manifest entry alone does not establish approval.

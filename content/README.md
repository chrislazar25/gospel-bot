# Approved daily content

This directory starts empty. Synthetic lab messages are not approved Gospel content.

Add exact reviewed message text as `messages/YYYY-MM-DD.txt`, with the date interpreted in Asia/Kolkata. Open a content PR for review. The image build runs `scripts/index-content.mjs`, which writes `schedule.json` with hashes of the exact UTF-8 bytes. The runtime checks those hashes. Run it locally only to test the runtime against this directory.

Production releases require fourteen consecutive dates starting on the release's IST date. Missing content blocks sending. Runtime never generates a fallback message. Git review and the protected release workflow establish approval. A manifest entry alone does not establish approval.

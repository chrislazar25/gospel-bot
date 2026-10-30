# Content pipeline

## Sub-features

- Import a WhatsApp export into an archive with `parse_gospel.js`.
- Match archive citations to the day's reading with `gospel_matcher.js`.
- Draft a 14-day batch and open a review PR with `scripts/open-batch.js` and `scripts/draft-content.js`.
- Build the image's message index with `scripts/index-content.mjs`.

## How to get to it (user POV)

The **Content batch** workflow runs daily at 09:00 IST. When fewer than 21 approved days remain and no batch PR is open, it opens a PR labelled `content-batch`. A person reviews and merges it. A later release puts the files in the image.

## Driving it

```sh
node --test tests/content.test.js
```

The suite makes no network requests and does not change `content/` or the archive. `tests/fixtures/review-packet/` holds a saved packet, and one test requires the generator to reproduce it byte for byte. If you change the generator's output on purpose, regenerate that fixture.

To see a real batch without opening a PR, run the workflow's script in a scratch copy of the repository. It writes message files and needs network access to the readings feed.

```sh
node scripts/open-batch.js --body-file /tmp/batch.md --today 2026-11-06
```

## Gotchas

No test covers the `gh` and `git` steps in `content-batch.yml`, or `scripts/index-content.mjs` directly. The image build runs the indexer, and `build.sh` runs `content-check` on the result. Pull requests that the workflow opens use `GITHUB_TOKEN`, so their CI needs a manual approval in the PR.

A release needs 14 consecutive approved days from the release's IST date. `check` logs `content_warning` when fewer than seven days remain.

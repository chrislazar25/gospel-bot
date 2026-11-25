# Review a fourteen-day content batch

Every batch requires human review. The draft tool never approves or sends a message. The **Content batch** workflow opens a PR when fewer than 21 approved days remain, as `content/README.md` describes. After you merge a batch, follow the release steps in [Run production](operations.md). Merging alone does not change what production sends.

The generator can miss valid messages and can propose a message with a wrong citation. Read each proposal against the day's reading, and edit the files in the PR when you find a better message.

The November 3 record quotes the feeding of five thousand but cites `LK(14:19)`. [USCCB's Luke 14](https://bible.usccb.org/bible/luke/14) places verse 19 in the parable of the great feast and describes an invited guest testing oxen. The record remains unchanged in the archive. Findings in [draft-content.findings.json](../scripts/draft-content.findings.json) use SHA-256 of whitespace-collapsed, trimmed text, so export separators and line wrapping preserve the warning. The separate payload hash still covers the exact original bytes. The tool does not automatically verify other quotations.

## Import a new source export

Use an explicit UTF-8 chat export and the exact sender name.

```sh
node parse_gospel.js --input /path/to/chat.txt --output /path/to/new-archive.json --sender 'Exact sender name'
```

The output path must be new. The importer refuses to overwrite any existing file. Importing `parse_gospel.js` as a module performs no file operations and produces no console output.

The parser supports square-bracketed day/month/year headers with a 12-hour time, such as `[30/10/26, 9:00 AM] Exact sender name: ...`. Two-digit years mean 2000 through 2099. Sender comparison is exact and runs before Gospel detection. Other export formats require a parser change and fixtures before use.

Each occurrence records the export SHA-256, ordinal across all parsed messages, sender as recorded in the header, raw timestamp, exact body, and raw message including its header. Timestamps have no inferred timezone. Exact duplicate bodies share one archive entry while every source occurrence remains available. `fullText` and `originalText` retain the original body substring, including line endings and message separator whitespace. Extracted display fields are separate.

A matching sender header establishes who posted the message according to the export. It does not establish who composed it, authenticate the export, or verify a quotation. The existing 1,202-record `gospel_messages.json` has no original sender identity. No original export was available during this work. The importer fixes future imports and cannot repair missing legacy provenance.

## Generate a new review packet

Start with an explicit IST date, archive, and output directory outside `content/`.

```sh
node scripts/draft-content.js --start-date 2026-10-30 --archive gospel_messages.json --output /tmp/new-review --fetch-readings
```

The tool requests the existing Roman Catholic public readings and liturgical-calendar feeds. Each request is a GET with a ten-second timeout, no redirects, and a 256 KiB response limit. A batch makes at most twenty-eight requests. Only fixed public paths containing dates leave the machine. Archive payloads are never sent to an API.

Readings must contain the requested date, season, and Gospel reference. Calendar responses must contain the requested date and celebration name. An unavailable calendar adds a visible hold. A malformed or mismatched snapshot stops generation. The feed does not establish a specific local diocesan calendar, so review the calendar for the intended recipients.

The output contains three files.

- `draft-batch.json` stores fourteen explicit `candidate`, `gap`, or `unsupported` date states. Every state remains `DRAFT_REQUIRES_REVIEW`.
- `preview.md` displays exact proposed text, up to two alternatives, and held records with their findings.
- `readings-snapshot.json` preserves the complete fetched reference and calendar metadata for offline replay.

The batch records the archive hash, record count, source indices, payload hashes, available occurrence identities, and provenance holds. Its dates are calendar dates in `Asia/Kolkata`. The proposed messages in the first packet contain 42 through 68 words. The tool preserves the old titles, labels, closings, and quotations. Several labels refer to a different Sunday or feast. Review those explicitly before approving any edited payload.

Replay the saved snapshot without network requests.

```sh
node scripts/draft-content.js --start-date 2026-10-30 --archive gospel_messages.json --output /tmp/replayed-review --snapshot tests/fixtures/review-packet/readings-snapshot.json
```

Identical inputs produce identical output bytes. Repeating against an identical output succeeds without changes. Missing files from a partial run are recreated only when existing files match. Different existing output bytes cause an error and require a new directory. Output paths inside the repository's approved `content/` directory are rejected, including symlink aliases.

## Review the proposals and resolve holds

Preserve the existing message format. Select an actual Scripture excerpt from the day's reading, then include its citation and the usual title and closing. Do not replace the excerpt with an original reflection, summary, or paraphrase. Preserve quotation wording and identify its source. Keep selection explanations outside the outgoing payload. When a different verse conveys the reading more clearly, propose that verse for review.

Read the complete daily passage and every proposed message. Compare the actual quotation with its citation. Decide whether the excerpt makes sense on its own, whether its title and closing fit, and whether its feast label matches the current calendar. Check recent reuse separately. This tool has no approved reuse history.

Candidate order uses whole-verse coverage, the presence of title, verse, and closing fields, an exact normalized calendar-label match, archive date, and source index. Field presence does not prove complete context. Coverage does not establish the best devotional excerpt. The legacy `scoreMessage` export remains a recency and formatting heuristic for existing callers and is not used by the draft tool.

Resolve gaps and unsupported readings with a specific editorial decision. The tool supplies no generated text and no replacement Bible translation. Format acceptance does not approve the messages. Follow [the approved content workflow](../content/README.md) only after the entire batch has received review. Draft generation never changes `gospel_messages.json`, `content/messages/`, or `content/schedule.json`.

## Reference parser and bounds

`parseReference` in `gospel_matcher.js` is the shared parser for existing matcher exports and the draft tool. `parseApiRef`, `parseDadCitation`, and `citationMatchesReading` keep their exported names. Compatibility fields remain available, while matching uses canonical disjoint `{ chapter, start, end }` intervals.

The parser consumes the complete reference. It accepts comma and semicolon unions, repeated chapter prefixes, cross-chapter ranges, familiar Gospel abbreviations, and the legacy chapter-hyphen-verse citation form. It rejects trailing text, alternatives, reversed ranges, unsupported books, and invalid chapter or verse bounds. Every cited interval must fit the reading union. Any overlap alone is insufficient. Partial verses such as `12a` remain unsupported and are never widened to verse 12.

The chapter maxima come directly from the publisher's [World English Bible Classic USFX download](https://ebible.org/Scriptures/eng-web_usfx.zip), linked by [eBible.org's edition page](https://www.ebible.org/find/details.php?id=eng-web). The zip retrieved on October 29, 2026 has SHA-256 `d4166234bcdf74f32b41aa99a57fa14fccb6b415c0f28444faedd23eda5f64ae`. Its `eng-web_usfx.xml` supplies 28 Matthew chapters, 16 Mark chapters, 24 Luke chapters, and 21 John chapters. Only numeric verse bounds enter the code. This is a numbering check, not a claim that the source text or translation matches an archived quotation or the Catholic lectionary.

To reproduce the extraction, download that zip as `/tmp/gospel-eng-web-usfx.zip` and run this command. A later publisher update can change the zip hash.

```sh
python3 - <<'PY'
import hashlib
import xml.etree.ElementTree as ET
import zipfile
source = '/tmp/gospel-eng-web-usfx.zip'
root = ET.fromstring(zipfile.ZipFile(source).read('eng-web_usfx.xml'))
for book in root.findall('book'):
    if book.get('id') not in ['MAT', 'MRK', 'LUK', 'JHN']:
        continue
    chapters = {}
    chapter = None
    for element in book.iter():
        if element.tag == 'c':
            chapter = int(element.get('id'))
            chapters[chapter] = 0
        if element.tag == 'v' and chapter:
            chapters[chapter] = max(chapters[chapter], int(element.get('id')))
    print(book.get('id'), list(chapters.values()))
print(hashlib.sha256(open(source, 'rb').read()).hexdigest())
PY
```

Run the offline behavior checks from the repository root.

```sh
node --test tests/content.test.js
```

These checks cover complete containment, disjoint and cross-chapter references, canonical endpoints, unsupported partial verses and alternatives, exact sender filtering, source occurrences, import without file operations, overwrite refusal, deterministic replay, invalid dates, public GET boundaries, protected output paths, and known editorial holds across reordered exports. They do not verify authorship, semantic quality, or every archived quotation.

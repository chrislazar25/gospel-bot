/**
 * Archive citation matcher. Sender identity and original authorship are unverified.
 * Strict whole-verse containment supplies a shortlist for editorial review.
 */

// Whole-verse bounds from eBible.org's World English Bible USFX numbering.
// Source and extraction details are in docs/content-review.md. No Bible text is copied.
const GOSPEL_VERSE_COUNTS = Object.freeze({
  mt: [25,23,17,25,48,34,29,34,38,42,30,50,58,36,39,28,27,35,30,34,46,46,39,51,46,75,66,20],
  mk: [45,28,35,41,43,56,37,38,50,52,33,44,37,72,47,20],
  lk: [80,52,38,44,39,49,50,56,62,42,54,59,35,35,32,31,37,43,48,47,38,71,56,53],
  jh: [51,25,36,54,47,71,53,59,41,42,57,50,38,31,27,33,26,40,42,31,25],
});
const BOOK_MAP = Object.freeze({
  matthew: 'mt', matt: 'mt', mt: 'mt', mark: 'mk', mar: 'mk', mr: 'mk', mk: 'mk',
  luke: 'lk', luk: 'lk', lk: 'lk', john: 'jh', jhn: 'jh', jn: 'jh', jh: 'jh',
});

function normalizeBook(raw) {
  const key = raw.toLowerCase().replace(/[.\s]/g, '');
  return Object.hasOwn(BOOK_MAP, key) ? BOOK_MAP[key] : null;
}

function parseReference(raw, format = 'api') {
  if (typeof raw !== 'string' || !raw.trim()) return { state: 'unsupported', reason: 'missing-reference' };
  const text = raw.trim().replace(/[–—]/g, '-');
  const match = format === 'archive'
    ? text.match(/^([A-Za-z.]+)\s*\(([^()]+)\)$/)
    : text.match(/^([A-Za-z.]+)\s+(\d.*)$/);
  if (!match) return { state: 'unsupported', reason: 'unsupported-reference-syntax' };
  const book = normalizeBook(match[1]);
  if (!book) return { state: 'unsupported', reason: 'unsupported-book' };
  let body = match[2].trim();
  if (format === 'archive' && /^\d+-\d+(?:-\d+)?$/.test(body)) body = body.replace('-', ':');
  if (/\d[a-z]/i.test(body)) return { state: 'unsupported', reason: 'partial-verses-unsupported' };
  let chapter = null;
  const intervals = [];
  for (const part of body.split(/[,;]/)) {
    const segment = part.trim().match(/^(?:(\d+)\s*:\s*)?(\d+)(?:\s*-\s*(?:(\d+):)?(\d+))?$/);
    if (!segment) return { state: 'unsupported', reason: 'unsupported-reference-syntax' };
    const startChapter = segment[1] ? Number(segment[1]) : chapter;
    const start = Number(segment[2]);
    const endChapter = segment[3] ? Number(segment[3]) : startChapter;
    const end = segment[4] ? Number(segment[4]) : start;
    const counts = GOSPEL_VERSE_COUNTS[book];
    if (!startChapter || startChapter > counts.length || !endChapter || endChapter > counts.length ||
        start < 1 || start > counts[startChapter - 1] || end < 1 || end > counts[endChapter - 1] ||
        endChapter < startChapter || (startChapter === endChapter && end < start)) {
      return { state: 'unsupported', reason: 'invalid-chapter-or-verse-bounds' };
    }
    for (let ch = startChapter; ch <= endChapter; ch++) {
      intervals.push({ chapter: ch, start: ch === startChapter ? start : 1, end: ch === endChapter ? end : counts[ch - 1] });
    }
    chapter = endChapter;
  }
  intervals.sort((a, b) => a.chapter - b.chapter || a.start - b.start);
  const union = [];
  for (const interval of intervals) {
    const previous = union[union.length - 1];
    if (previous && previous.chapter === interval.chapter && interval.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, interval.end);
    } else union.push({ ...interval });
  }
  const first = union[0];
  const last = union[union.length - 1];
  return { state: 'supported', reference: {
    book, intervals: union,
    chapter: first.chapter, verseStart: first.start, verseEnd: last.end,
    endChapter: last.chapter, multiChapter: first.chapter !== last.chapter,
    verses: union.filter(i => i.chapter === first.chapter).flatMap(i =>
      Array.from({ length: i.end - i.start + 1 }, (_, n) => i.start + n)),
  } };
}

function parseApiRef(raw) {
  return parseReference(raw).reference || null;
}

function parseDadCitation(raw) {
  return parseReference(raw, 'archive').reference || null;
}

function citationMatchesReading(citation, reading) {
  const parsed = parseDadCitation(citation);
  if (!parsed || !reading?.intervals || parsed.book !== reading.book) return false;
  return parsed.intervals.every(cited => reading.intervals.some(allowed =>
    cited.chapter === allowed.chapter && cited.start >= allowed.start && cited.end <= allowed.end));
}

module.exports = { parseReference, GOSPEL_VERSE_COUNTS, parseApiRef, parseDadCitation, citationMatchesReading };

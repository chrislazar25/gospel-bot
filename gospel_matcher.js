/**
 * Legacy archive matcher. Sender identity and original authorship are unverified.
 * Strict whole-verse containment supplies a shortlist for editorial review.
 */

const fs = require('fs');

const MESSAGES_FILE = require('path').join(__dirname, 'gospel_messages.json');

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
    const segment = part.trim().match(/^(?:(\d+):)?(\d+)(?:\s*-\s*(?:(\d+):)?(\d+))?$/);
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

// ─────────────────────────────────────────────
// Legacy recency and formatting heuristic. It does not measure pastoral quality.
// ─────────────────────────────────────────────
function scoreMessage(msg) {
  let score = 0;
  // Prefer more recent messages (normalized 0-1 over 7 year span)
  const year = parseInt(msg.isoDate.slice(0, 4));
  score += (year - 2019) * 10;
  // Prefer an extracted citation field. This does not verify its accuracy.
  if (msg.citation) score += 5;
  // Prefer longer verse text (more complete)
  score += Math.min(msg.verse?.length || 0, 200) / 20;
  // Prefer messages with a closing phrase
  if (msg.closing && msg.closing.length > 5) score += 3;
  // Penalise very short messages (probably drafts/fragments)
  if ((msg.fullText?.length || 0) < 80) score -= 10;
  return score;
}

// ─────────────────────────────────────────────
// Find mechanically matching messages in the legacy archive
// ─────────────────────────────────────────────
function findMatches(apiRef, messages) {
  return messages.filter(msg => citationMatchesReading(msg.citation, apiRef));
}

// ─────────────────────────────────────────────
// Legacy tie breaker using recency and formatting only
// ─────────────────────────────────────────────
function pickBest(matches) {
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];

  // Sort by score descending
  const scored = matches
    .map(m => ({ msg: m, score: scoreMessage(m) }))
    .sort((a, b) => b.score - a.score);

  return scored[0].msg;
}

// ─────────────────────────────────────────────
// Fetch today's gospel from the API
// ─────────────────────────────────────────────
async function fetchTodaysGospel(date) {
  const d = date || new Date();
  const year = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');

  // Fetch both endpoints in parallel — readings for gospel ref, calendar for celebration name
  const readingsUrl  = `https://cpbjr.github.io/catholic-readings-api/readings/${year}/${mm}-${dd}.json`;
  const calendarUrl  = `https://cpbjr.github.io/catholic-readings-api/liturgical-calendar/${year}/${mm}-${dd}.json`;

  const [readingsRes, calendarRes] = await Promise.all([
    fetch(readingsUrl),
    fetch(calendarUrl),
  ]);

  if (!readingsRes.ok) throw new Error(`Readings API returned ${readingsRes.status}`);

  const readings = await readingsRes.json();
  // Calendar endpoint may not exist for every date — fail gracefully
  const calendar = calendarRes.ok ? await calendarRes.json() : null;

  return {
    date:        readings.date,
    season:      readings.season,
    celebration: calendar?.celebration || null,
    gospelRaw:   readings.readings?.gospel,
    apiRef:      parseApiRef(readings.readings?.gospel),
    fullData:    readings,
  };
}

// ─────────────────────────────────────────────
// MAIN: get today's message to send
// ─────────────────────────────────────────────
async function getTodaysMessage(date) {
  const data = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));

  // 1. Get today's gospel from API
  let todayReading;
  try {
    todayReading = await fetchTodaysGospel(date);
    console.log(`📖 Today's gospel: ${todayReading.gospelRaw} (${todayReading.season})`);
    console.log(`   Parsed: book=${todayReading.apiRef?.book} ch=${todayReading.apiRef?.chapter} v${todayReading.apiRef?.verseStart}-${todayReading.apiRef?.verseEnd}`);
  } catch (err) {
    console.error('⚠️  API failed:', err.message);
    todayReading = null;
  }

  // 2. Find matches in dad's archive
  let matches = [];
  if (todayReading?.apiRef) {
    matches = findMatches(todayReading.apiRef, data.messages);
    console.log(`\n🔍 Found ${matches.length} matching message(s) in dad's archive:`);
    matches.forEach(m => console.log(`   [${m.isoDate}] ${m.citation} — ${m.title}`));
  }

  // 3. Pick the best one
  const best = pickBest(matches);

  if (best) {
    console.log(`\n✅ Selected: [${best.isoDate}] ${best.citation}`);
    console.log(`   "${best.fullText.slice(0, 100)}..."`);
    return { source: 'archive', message: best, todayReading };
  }

  // 4. No match — signal fallback needed
  console.log(`\n⚠️  No match found in archive for ${todayReading?.gospelRaw || 'unknown reading'}`);
  return { source: 'fallback_needed', message: null, todayReading };
}

module.exports = { getTodaysMessage, parseReference, GOSPEL_VERSE_COUNTS, parseApiRef, parseDadCitation, citationMatchesReading, scoreMessage, findMatches, pickBest };

// ─────────────────────────────────────────────
// Run standalone test
// ─────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    console.log('=== Testing Gospel Matcher ===\n');

    // Test today
    console.log('--- TODAY (April 17, 2026) ---');
    await getTodaysMessage(new Date('2026-04-17'));

    // Test a known Sunday
    console.log('\n--- 1st Sunday of Lent (Mar 7, 2026) ---');
    await getTodaysMessage(new Date('2026-03-07'));

    // Test a feast day
    console.log('\n--- Good Friday (Apr 2, 2026) ---');
    await getTodaysMessage(new Date('2026-04-02'));

    // Test citation parser
    console.log('\n--- Citation Parser Tests ---');
    const tests = [
      ['JH(6:11)', 'John 6:1-15'],
      ['LK(4:4,8,12)', 'Luke 4:1-13'],
      ['MT(18:34-35)', 'Matthew 18:21-35'],
      ['MK(12:32-33)', 'Mark 12:28-34'],
      ['JH(6:11)', 'Luke 4:1-13'],   // should NOT match
    ];
    tests.forEach(([dad, api]) => {
      const apiRef = parseApiRef(api);
      const match = citationMatchesReading(dad, apiRef);
      console.log(`  ${dad} in "${api}" → ${match ? '✅ match' : '❌ no match'}`);
    });
  })();
}
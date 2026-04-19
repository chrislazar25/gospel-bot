/**
 * Gospel Matcher
 * 1. Fetches today's gospel reading from the Catholic Readings API
 * 2. Finds all of dad's messages whose citation falls within that reading's verse range
 * 3. Consolidates duplicates (same reading, different wording/spelling)
 * 4. Returns the best match to send
 */

const fs = require('fs');

const MESSAGES_FILE = require('path').join(__dirname, 'gospel_messages.json');

// ─────────────────────────────────────────────
// Book name normalizer
// API returns full names: "John", "Luke", "Matthew", "Mark"
// Dad uses abbreviations: JH, LK, MT, MK, MR etc.
// ─────────────────────────────────────────────
const BOOK_MAP = {
  // Full name → normalized key
  'matthew': 'mt', 'matt': 'mt', 'mt': 'mt',
  'mark': 'mk', 'mar': 'mk', 'mr': 'mk', 'mk': 'mk',
  'luke': 'lk', 'luk': 'lk', 'lk': 'lk',
  'john': 'jh', 'jhn': 'jh', 'jh': 'jh',
  // With numbers (e.g. 1 John, 2 Corinthians etc — dad rarely uses but handle)
  '1john': '1jh', '1jhn': '1jh', '1jh': '1jh',
  '2john': '2jh', '3john': '3jh',
  'acts': 'ac',
};

function normalizeBook(raw) {
  if (!raw) return null;
  const cleaned = raw.toLowerCase()
    .replace(/\s+/g, '')       // "1 John" → "1john"
    .replace(/\./g, '');       // "Mt." → "mt"
  return BOOK_MAP[cleaned] || cleaned;
}

// ─────────────────────────────────────────────
// Parse a citation string into structured form
// Handles: "John 6:1-15", "Luke 14:25-33", "Matthew 5:1"
// ─────────────────────────────────────────────
function parseApiRef(refString) {
  if (!refString) return null;

  // Multi-chapter: "John 18:1-19:42" → treat as ch18 v1 to ch19 v42
  // For matching purposes we expand to a flat verse space: ch*1000 + verse
  const multiChap = refString.match(/^([1-3]?\s*[A-Za-z]+)\s+(\d+):(\d+)[–\-](\d+):(\d+)/);
  if (multiChap) {
    return {
      book: normalizeBook(multiChap[1]),
      chapter: parseInt(multiChap[2]),          // start chapter
      verseStart: parseInt(multiChap[3]),
      endChapter: parseInt(multiChap[4]),        // end chapter
      verseEnd: parseInt(multiChap[5]),
      multiChapter: true,
    };
  }

  // Single chapter: "Luke 14:25-33"
  const match = refString.match(/^([1-3]?\s*[A-Za-z]+)\s+(\d+):(\d+)(?:[–\-](\d+))?/);
  if (!match) return null;
  return {
    book: normalizeBook(match[1]),
    chapter: parseInt(match[2]),
    verseStart: parseInt(match[3]),
    verseEnd: match[4] ? parseInt(match[4]) : parseInt(match[3]),
    multiChapter: false,
  };
}

// ─────────────────────────────────────────────
// Parse dad's citation format
// Handles: JH(6:11), LK(4:4,8,12), MT(18:34-35), MK(12:32-33)
// ─────────────────────────────────────────────
function parseDadCitation(citation) {
  if (!citation) return null;

  // Standard format: JH(6:19-20), LK(4:4,8,12)
  let match = citation.match(/^([1-3]?[A-Za-z]+)\((\d+):([^)]+)\)$/);

  // Non-standard: JH(19-28-30) → chapter 19, verses 28-30
  //               MT(26-23-24) → chapter 26, verses 23-24
  //               JH(13-12-14) → chapter 13, verses 12-14
  if (!match) {
    const altMatch = citation.match(/^([1-3]?[A-Za-z]+)\((\d+)-(\d+)(?:-(\d+))?\)$/);
    if (altMatch) {
      // First number = chapter, remaining = verses
      const book = normalizeBook(altMatch[1]);
      const chapter = parseInt(altMatch[2]);
      const v1 = parseInt(altMatch[3]);
      const v2 = altMatch[4] ? parseInt(altMatch[4]) : v1;
      const verses = [];
      for (let v = v1; v <= v2; v++) verses.push(v);
      return { book, chapter, verses };
    }
    return null;
  }

  const book = normalizeBook(match[1]);
  const chapter = parseInt(match[2]);
  const versePart = match[3]; // "11", "4,8,12", "34-35"

  // Extract all verse numbers mentioned
  const verses = [];
  for (const part of versePart.split(',')) {
    const rangeParts = part.trim().split(/[-–]/);
    const start = parseInt(rangeParts[0]);
    const end = rangeParts[1] ? parseInt(rangeParts[1]) : start;
    for (let v = start; v <= end; v++) verses.push(v);
  }

  return { book, chapter, verses };
}

// ─────────────────────────────────────────────
// Check if dad's citation falls within the API reading range
// ─────────────────────────────────────────────
function citationMatchesReading(dadCitation, apiRef) {
  const dad = parseDadCitation(dadCitation);
  if (!dad || !apiRef) return false;
  if (dad.book !== apiRef.book) return false;

  if (apiRef.multiChapter) {
    // Dad's chapter must fall between start and end chapter
    if (dad.chapter < apiRef.chapter || dad.chapter > apiRef.endChapter) return false;
    // If same as start chapter, verse must be >= verseStart
    if (dad.chapter === apiRef.chapter) return dad.verses.some(v => v >= apiRef.verseStart);
    // If same as end chapter, verse must be <= verseEnd
    if (dad.chapter === apiRef.endChapter) return dad.verses.some(v => v <= apiRef.verseEnd);
    // Middle chapter — all verses qualify
    return true;
  }

  // Single chapter
  if (dad.chapter !== apiRef.chapter) return false;
  return dad.verses.some(v => v >= apiRef.verseStart && v <= apiRef.verseEnd);
}

// ─────────────────────────────────────────────
// Score a message for quality (higher = better to send)
// ─────────────────────────────────────────────
function scoreMessage(msg) {
  let score = 0;
  // Prefer more recent messages (normalized 0-1 over 7 year span)
  const year = parseInt(msg.isoDate.slice(0, 4));
  score += (year - 2019) * 10;
  // Prefer messages with a proper citation
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
// Find matching messages from dad's archive
// ─────────────────────────────────────────────
function findMatches(apiRef, messages) {
  return messages.filter(msg => citationMatchesReading(msg.citation, apiRef));
}

// ─────────────────────────────────────────────
// Consolidate: pick the best message when multiple match
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

module.exports = { getTodaysMessage, parseApiRef, parseDadCitation, citationMatchesReading, scoreMessage, findMatches, pickBest };

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
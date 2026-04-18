/**
 * Gospel Message Tester — Full Chain Validation
 *
 * Validates every step:
 *   1. API call → raw response
 *   2. Gospel reference parsing
 *   3. Archive matching + scoring
 *   4. Final message
 *
 * Usage:
 *   node test.js today
 *   node test.js 2026-04-17
 *   node test.js 2026-04-17 2026-04-02 2026-03-07   ← multiple dates at once
 */

const { parseApiRef, findMatches, pickBest, scoreMessage } = require('./gospel_matcher');
const fs = require('fs');

const DEFAULT_CLOSING = 'Jesus is Lord, spread the living word of God.';

function buildMessage(pickedMsg, todayReading) {
  const dayLabel = todayReading?.celebration?.name
                || todayReading?.season
                || "Today's";
  const title    = pickedMsg.title?.trim()   ? `(${pickedMsg.title}) ` : '';
  const verse    = pickedMsg.verse?.trim()   || '';
  const citation = pickedMsg.citation        || '';
  const closing  = pickedMsg.closing?.trim() || DEFAULT_CLOSING;
  return `${dayLabel} Gospel Msg ${title}${verse} ${citation} ${closing}`.trim();
}

function box(text) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > 56) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
  }
  if (line) lines.push(line);
  const w = 58;
  console.log('┌' + '─'.repeat(w) + '┐');
  lines.forEach(l => console.log('│ ' + l.padEnd(w - 2) + ' │'));
  console.log('└' + '─'.repeat(w) + '┘');
}

// ─────────────────────────────────────────────
// FETCH FROM API — always called, never skipped
// ─────────────────────────────────────────────
async function fetchReading(dateArg) {
  // Split directly — avoids JS timezone bug (new Date treats as UTC midnight)
  const [year, mm, dd] = dateArg.split('-');
  const url  = `https://cpbjr.github.io/catholic-readings-api/readings/${year}/${mm}-${dd}.json`;

  console.log(`\n📡 API CALL`);
  console.log(`   URL : ${url}`);

  const res = await fetch(url);
  console.log(`   HTTP: ${res.status} ${res.statusText}`);

  if (!res.ok) throw new Error(`API returned ${res.status}`);

  const raw = await res.json();

  console.log(`\n   RAW RESPONSE:`);
  console.log(`   ├─ date         : ${raw.date}`);
  console.log(`   ├─ season       : ${raw.season}`);
  console.log(`   ├─ celebration  : ${raw.celebration?.name ?? 'none'} ${raw.celebration ? '(' + raw.celebration.type + ')' : ''}`);
  console.log(`   ├─ firstReading : ${raw.readings?.firstReading}`);
  console.log(`   ├─ psalm        : ${raw.readings?.psalm}`);
  if (raw.readings?.secondReading) {
  console.log(`   ├─ 2ndReading   : ${raw.readings.secondReading}`);
  }
  console.log(`   └─ gospel       : ${raw.readings?.gospel}`);

  return {
    date:        raw.date,
    season:      raw.season,
    celebration: raw.celebration,
    gospelRaw:   raw.readings?.gospel,
    apiRef:      parseApiRef(raw.readings?.gospel),
    url,
  };
}

// ─────────────────────────────────────────────
// TEST ONE DATE
// ─────────────────────────────────────────────
async function testDate(dateArg, archive) {
  console.log('\n' + '═'.repeat(62));
  console.log(`  TESTING ${dateArg}`);
  console.log('═'.repeat(62));

  // ── Step 1: API call ────────────────────────────────────────
  let reading;
  try {
    reading = await fetchReading(dateArg);
  } catch (err) {
    console.log(`\n❌ API FAILED: ${err.message}`);
    console.log(`   Check your internet connection and try again.`);
    return;
  }

  // ── Step 2: Parse the gospel reference ──────────────────────
  console.log(`\n📖 PARSING`);
  console.log(`   Input  : "${reading.gospelRaw}"`);

  if (!reading.apiRef) {
    console.log(`   Result : ❌ Could not parse — check API response above`);
    return;
  }

  const r = reading.apiRef;
  if (r.multiChapter) {
    console.log(`   Result : book=${r.book.toUpperCase()}  ch${r.chapter}:${r.verseStart} → ch${r.endChapter}:${r.verseEnd}  (multi-chapter)`);
  } else {
    console.log(`   Result : book=${r.book.toUpperCase()}  ch${r.chapter}  verses ${r.verseStart}–${r.verseEnd}`);
  }

  // ── Step 3: Archive matching ─────────────────────────────────
  const matches = findMatches(reading.apiRef, archive.messages);

  console.log(`\n🔍 ARCHIVE MATCHES  (${matches.length} found)`);

  if (!matches.length) {
    console.log(`   None — bot will fall back to Bible API for this date`);
  } else {
    matches
      .map(m => ({ msg: m, score: scoreMessage(m) }))
      .sort((a, b) => b.score - a.score)
      .forEach(({ msg, score }, i) => {
        const tag = i === 0 ? '✅ PICK' : '      ';
        console.log(`   ${tag}  [${msg.isoDate}]  ${msg.citation}  score=${score.toFixed(0)}`);
        console.log(`           "${msg.verse?.slice(0, 65)}..."`);
      });
  }

  // ── Step 4: Final message ────────────────────────────────────
  const best = pickBest(matches);

  console.log(`\n💬 FINAL MESSAGE`);
  if (best) {
    console.log(`   Source : Dad's archive  [${best.isoDate}]\n`);
    box(buildMessage(best, reading));
  } else {
    console.log(`   Source : Bible API fallback`);
    console.log(`   [Will fetch a verse from ${reading.gospelRaw} via bible-api.com]\n`);
  }

  console.log(`\n   → Show this to dad. Does the verse and wording look right?`);
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  let args = process.argv.slice(2);

  if (!args.length) {
    console.log('\nUsage:');
    console.log('  node test.js today');
    console.log('  node test.js 2026-04-17');
    console.log('  node test.js 2026-04-17 2026-04-02 2026-03-07');
    process.exit(0);
  }

  // Expand "today" shortcut
  args = args.map(a => a === 'today' ? new Date().toISOString().slice(0, 10) : a);

  // Validate all dates upfront — use regex not new Date() to avoid timezone issues
  for (const a of args) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a)) {
      console.error(`❌ Invalid date: "${a}". Use YYYY-MM-DD format.`);
      process.exit(1);
    }
  }

  // Load archive once
  if (!fs.existsSync('./gospel_messages.json')) {
    console.error('❌ gospel_messages.json not found in current directory');
    process.exit(1);
  }
  const archive = JSON.parse(fs.readFileSync('./gospel_messages.json', 'utf8'));
  console.log(`\n📂 Archive loaded: ${archive.messages.length} messages`);

  // Test each date
  for (const dateArg of args) {
    await testDate(dateArg, archive);
  }

  console.log('\n' + '═'.repeat(62));
  console.log('  Done. If anything looks wrong, note the date and');
  console.log('  what dad says it should be — we can debug from there.');
  console.log('═'.repeat(62) + '\n');
}

main().catch(err => {
  console.error('\n❌ Unexpected error:', err.message);
  process.exit(1);
});

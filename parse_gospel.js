const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const INPUT_FILE = '/mnt/user-data/uploads/_chat.txt';
const OUTPUT_FILE = '/mnt/user-data/outputs/gospel_messages.json';
const SENDER_NAME = 'Agnel Lazar';          // dad's name — NOT "Agnel Lazar 2"

// ─────────────────────────────────────────────
// STEP 1: Parse raw chat into messages
// ─────────────────────────────────────────────
function parseChat(text) {
  const messages = [];
  const lineRegex = /^\[(\d{2}\/\d{2}\/\d{2,4}),\s*([\d:]+\s*[AP]M)\]\s+(.+?):\s+([\s\S]*)$/;

  const lines = text.split('\n');
  let current = null;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '').replace(/\u200e/g, '').trim();
    const match = line.match(/^\[(\d{2}\/\d{2}\/\d{2,4}),\s*([\d:]+\s*[AP]M)\]\s+(.+?):\s+([\s\S]*)$/);

    if (match) {
      if (current) messages.push(current);
      current = {
        date: match[1],
        time: match[2],
        sender: match[3].trim(),
        text: match[4].trim(),
      };
    } else if (current && line.length > 0) {
      // continuation of previous message
      current.text += '\n' + line;
    }
  }
  if (current) messages.push(current);
  return messages;
}

// ─────────────────────────────────────────────
// STEP 2: Filter to dad's gospel messages only
// ─────────────────────────────────────────────
const SKIP_PATTERNS = [
  /you deleted this message/i,
  /‎?(image|video|audio|document|contact card|sticker|GIF) omitted/i,
  /voice call/i,
  /missed voice call/i,
  /^https?:\/\//,
  /^<This message was edited>$/,
  /<This message was edited>$/,  // will handle via strip
];

const GOSPEL_INDICATORS = [
  /gospel msg/i,
  /feast (day |of |gospel)/i,
  /sunday.*gospel/i,
  /solemnity/i,
  /ash wednesday/i,
  /palm sunday/i,
  /holy (thursday|saturday|friday|week)/i,
  /maundy thursday/i,
  /good friday/i,
  /easter (sunday|monday|tuesday|wednesday|thursday|friday|saturday|vigil|octave)/i,
  /octave of easter/i,
  /christmas (day|gospel)/i,
  /divine mercy sunday/i,
  /pentecost/i,
];

function isGospelMessage(msg) {
  const t = msg.text;
  if (SKIP_PATTERNS.some(p => p.test(t))) return false;
  if (t.split(' ').length < 8) return false;  // too short to be a verse
  return GOSPEL_INDICATORS.some(p => p.test(t));
}

// ─────────────────────────────────────────────
// STEP 3: Extract structured fields
// ─────────────────────────────────────────────
function extractFields(msg) {
  let text = msg.text
    .replace(/<This message was edited>/g, '')
    .replace(/\n+/g, ' ')
    .trim();

  // Scripture citation: MT(1:2), JH(3:16), LK(4:1-5), MK(12:32-33), 1Jh(1:3) etc.
  const citationMatch = text.match(/([1-3]?[A-Z]{1,3})\(([^)]+)\)/);
  const citation = citationMatch ? `${citationMatch[1]}(${citationMatch[2]})` : null;

  // Closing phrase: everything after the citation
  let closing = '';
  if (citationMatch) {
    const afterCitation = text.slice(text.indexOf(citationMatch[0]) + citationMatch[0].length).trim();
    closing = afterCitation;
  }

  // Liturgical label: text before "Gospel Msg" OR the whole prefix for special days
  let liturgicalLabel = '';
  const gospelMsgIdx = text.search(/gospel msg/i);
  if (gospelMsgIdx > 0) {
    liturgicalLabel = text.slice(0, gospelMsgIdx).trim().replace(/[:\-]+$/, '').trim();
  } else {
    // Feast/Solemnity messages that don't say "Gospel Msg"
    const prefixMatch = text.match(/^(Feast[^(]+|Solemnity[^(]+|.*Sunday[^(]+)/i);
    liturgicalLabel = prefixMatch ? prefixMatch[1].trim() : '';
  }

  // Topic title: inside parentheses after "Gospel Msg"
  let title = '';
  const titleMatch = text.match(/gospel msg\s*\(([^)]+)\)/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  } else {
    const featTitleMatch = text.match(/\(([^)]+)\)/);
    title = featTitleMatch ? featTitleMatch[1].trim() : '';
  }

  // Verse body: between title/label area and the citation
  let verse = text;
  if (citationMatch) {
    verse = text.slice(0, text.indexOf(citationMatch[0])).trim();
    // Strip the liturgical prefix and title
    const bodyStart = titleMatch
      ? text.indexOf(titleMatch[0]) + titleMatch[0].length
      : (gospelMsgIdx > 0 ? gospelMsgIdx + 'Gospel Msg'.length : 0);
    verse = text.slice(bodyStart, text.indexOf(citationMatch[0])).trim();
  }

  // Parse date → ISO
  const [d, m, y] = msg.date.split('/');
  const fullYear = y.length === 2 ? '20' + y : y;
  const isoDate = `${fullYear}-${m}-${d}`;
  const monthDay = `${m}-${d}`;  // for seasonal matching

  // Normalize liturgical label for keying
  const labelKey = liturgicalLabel
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    isoDate,
    monthDay,
    liturgicalLabel: liturgicalLabel || 'Ordinary Day',
    labelKey,
    title,
    verse,
    citation,
    closing: closing.replace(/‎/g, '').trim(),
    fullText: text.replace(/‎/g, '').trim(),
  };
}

// ─────────────────────────────────────────────
// STEP 4: Deduplicate
// ─────────────────────────────────────────────
function deduplicate(entries) {
  // By exact fullText → keep latest date
  const byText = new Map();
  for (const e of entries) {
    const existing = byText.get(e.fullText);
    if (!existing || e.isoDate > existing.isoDate) {
      byText.set(e.fullText, e);
    }
  }
  return Array.from(byText.values()).sort((a, b) => a.isoDate.localeCompare(b.isoDate));
}

// ─────────────────────────────────────────────
// STEP 5: Build lookup indexes
// ─────────────────────────────────────────────
function buildIndexes(entries) {
  // Index by MM-DD (month-day) → array of entries (multiple years)
  const byMonthDay = {};
  // Index by normalized label key → latest entry
  const byLabelKey = {};

  for (const e of entries) {
    // Month-day index
    if (!byMonthDay[e.monthDay]) byMonthDay[e.monthDay] = [];
    byMonthDay[e.monthDay].push(e);

    // Label key index — keep latest
    if (!byLabelKey[e.labelKey] || e.isoDate > byLabelKey[e.labelKey].isoDate) {
      byLabelKey[e.labelKey] = e;
    }
  }

  return { byMonthDay, byLabelKey };
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
const raw = fs.readFileSync(INPUT_FILE, 'utf8');
const allMessages = parseChat(raw);

console.log(`Total messages parsed: ${allMessages.length}`);
console.log(`From dad (${SENDER_NAME}): ${allMessages.filter(m => m.sender === SENDER_NAME).length}`);

const gospelMessages = allMessages.filter(isGospelMessage);
console.log(`Gospel messages identified: ${gospelMessages.length}`);

const entries = gospelMessages.map(extractFields);
const deduped = deduplicate(entries);
console.log(`After deduplication: ${deduped.length} unique messages`);

const { byMonthDay, byLabelKey } = buildIndexes(deduped);

const output = {
  meta: {
    generatedAt: new Date().toISOString(),
    totalMessages: deduped.length,
    dateRange: {
      from: deduped[0]?.isoDate,
      to: deduped[deduped.length - 1]?.isoDate,
    },
    uniqueLabelKeys: Object.keys(byLabelKey).length,
    uniqueMonthDays: Object.keys(byMonthDay).length,
  },
  messages: deduped,
  byMonthDay,
  byLabelKey,
};

fs.mkdirSync('/mnt/user-data/outputs', { recursive: true });
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
console.log(`\n✅ Written to: ${OUTPUT_FILE}`);

// ─── Quick quality check ───
console.log('\n=== SAMPLE ENTRIES ===');
deduped.slice(0, 3).forEach(e => {
  console.log(`\n[${e.isoDate}] ${e.liturgicalLabel}`);
  console.log(`  Title: ${e.title}`);
  console.log(`  Citation: ${e.citation}`);
  console.log(`  Verse (first 80): ${e.verse.slice(0, 80)}...`);
  console.log(`  Closing: ${e.closing.slice(0, 60)}`);
});

console.log('\n=== LABEL KEY SAMPLES ===');
Object.keys(byLabelKey).slice(0, 10).forEach(k => {
  console.log(`  "${k}" → ${byLabelKey[k].isoDate}`);
});

console.log('\n=== MONTH-DAY COVERAGE SAMPLE ===');
Object.entries(byMonthDay).slice(0, 5).forEach(([md, entries]) => {
  console.log(`  ${md}: ${entries.length} message(s) across years`);
});

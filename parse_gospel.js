const { createHash } = require('node:crypto');

const sha256 = text => createHash('sha256').update(text).digest('hex');

function parseChat(text) {
  if (typeof text !== 'string') throw new TypeError('Chat export must be UTF-8 text');
  const sourceSha256 = sha256(text);
  const header = /^[\u200e\ufeff]?\[(\d{2}\/\d{2}\/\d{2,4}),\s*([\d:]+\s*[AP]M)\]\s+(.+?): ?/gm;
  const headers = [...text.matchAll(header)];
  return headers.map((match, index) => {
    const end = headers[index + 1]?.index ?? text.length;
    const ordinal = index + 1;
    return {
      date: match[1], time: match[2], sender: match[3], timestamp: `${match[1]}, ${match[2]}`,
      text: text.slice(match.index + match[0].length, end),
      source: { sourceSha256, messageOrdinal: ordinal, id: `${sourceSha256}:${ordinal}`, rawMessage: text.slice(match.index, end) },
    };
  });
}

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
  const t = msg.text.replace(/\s+/gu, ' ').trim();
  if (SKIP_PATTERNS.some(p => p.test(t))) return false;
  if (t.split(' ').length < 8) return false;  // too short to be a verse
  return GOSPEL_INDICATORS.some(p => p.test(t));
}

// Archive citations appear as MT(1:2), Lk(14:33), LK (14:23-24), hearMT(13:41-42),
// or without book brackets as (Matthew 22:37-39), (LK13:12-13), MK14:24-25.
const VERSES = String.raw`\d+\s*:\s*\d+[a-z]?(?:\s*[,;-]\s*(?:\d+\s*:\s*)?\d+[a-z]?)*`;
const CITATION_PATTERNS = [
  /(?<book>(?<![A-Za-z])[1-3]?(?:[A-Z]{1,3}|[A-Za-z][a-z]{0,6}|[a-z][A-Z])|(?<=[a-z])[A-Z]{2,3})\s*\((?<verses>\d+(?:\s*[:-][^)]*)?)\)/,
  new RegExp(String.raw`(?<![A-Za-z])\(?(?<book>Matthew|Mark|Luke|John|MT|MK|LK|JH|JN)\s*(?<verses>${VERSES})\s*\)?\.?`, 'i'),
];

function extractFields(msg) {
  let text = msg.text
    .replace(/<This message was edited>/g, '')
    .replace(/\n+/g, ' ')
    .trim();

  const citationMatch = CITATION_PATTERNS.map(pattern => text.match(pattern)).find(Boolean);
  const citation = citationMatch ? `${citationMatch.groups.book}(${citationMatch.groups.verses})` : null;

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
  if (!Number.isFinite(Date.parse(isoDate)) || new Date(isoDate).toISOString().slice(0, 10) !== isoDate) throw new Error(`Invalid source date ${msg.date}`);
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
    fullText: msg.text,
    normalizedText: text,
    originalText: msg.text,
    sourceOccurrences: [{ ...msg.source, sender: msg.sender, timestamp: msg.timestamp, originalText: msg.text }],
    provenance: { senderMatchedExactly: true, authorshipVerified: false, note: 'Posted by the exact configured sender. Original composition is not verified.' },
  };
}


function deduplicate(entries) {
  const byText = new Map();
  for (const entry of entries) {
    const previous = byText.get(entry.fullText);
    if (!previous) byText.set(entry.fullText, { ...entry, sourceOccurrences: [...entry.sourceOccurrences] });
    else {
      const occurrences = [...previous.sourceOccurrences, ...entry.sourceOccurrences];
      byText.set(entry.fullText, { ...(entry.isoDate > previous.isoDate ? entry : previous), sourceOccurrences: occurrences });
    }
  }
  return [...byText.values()].sort((a, b) => a.isoDate.localeCompare(b.isoDate));
}

function buildIndexes(entries) {
  const byMonthDay = Object.create(null);
  const byLabelKey = Object.create(null);
  for (const entry of entries) {
    (byMonthDay[entry.monthDay] ||= []).push(entry);
    if (!byLabelKey[entry.labelKey] || entry.isoDate > byLabelKey[entry.labelKey].isoDate) byLabelKey[entry.labelKey] = entry;
  }
  return { byMonthDay, byLabelKey };
}

function collectMessages(text, exactSender) {
  if (typeof exactSender !== 'string' || !exactSender) throw new Error('An exact sender is required');
  const all = parseChat(text);
  if (!all.length) throw new Error('No supported chat message headers found');
  const posted = all.filter(message => message.sender === exactSender);
  const entries = posted.filter(isGospelMessage).map(extractFields);
  const messages = deduplicate(entries);
  return {
    meta: {
      schemaVersion: 2, sourceSha256: sha256(text), exactSender,
      senderMeaning: 'Posted by this exact sender. Composition and quotation accuracy are not verified.',
      parsedMessages: all.length, senderMessages: posted.length, gospelOccurrences: entries.length, totalMessages: messages.length,
    },
    messages, ...buildIndexes(messages),
  };
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--input', '--output', '--sender'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
      throw new Error('Usage: node parse_gospel.js --input chat.txt --output new-archive.json --sender "Exact sender"');
    }
    options[args[i]] = args[i + 1];
  }
  if (!options['--input'] || !options['--output'] || !options['--sender']) throw new Error('Explicit input, new output path, and exact sender are required');
  const fs = require('node:fs');
  const input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(options['--input']));
  const output = collectMessages(input, options['--sender']);
  fs.writeFileSync(options['--output'], JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  console.log(`Wrote ${output.messages.length} messages to ${options['--output']}. Authorship remains unverified.`);
}

module.exports = { parseChat, isGospelMessage, extractFields, deduplicate, buildIndexes, collectMessages, main };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

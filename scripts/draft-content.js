const { createHash } = require('node:crypto');
const path = require('node:path');
const { parseReference, citationMatchesReading } = require('../gospel_matcher');
const EDITORIAL_FINDINGS = require('./draft-content.findings.json');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const editorialKey = text => sha256(text.replace(/\s+/gu, ' ').trim());
const REPOSITORY = path.resolve(__dirname, '..');
const FEED = 'https://cpbjr.github.io/catholic-readings-api';

function validateDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error(`Invalid date ${date}`);
  return date;
}

function batchDates(startDate) {
  validateDate(startDate);
  return Array.from({ length: 14 }, (_, index) => new Date(Date.parse(`${startDate}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10));
}

function feedUrl(kind, date) {
  return `${FEED}/${kind}/${date.slice(0, 4)}/${date.slice(5)}.json`;
}

function validateSnapshot(snapshot, dates) {
  if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.days) || snapshot.days.length !== 14) throw new Error('Snapshot must contain exactly fourteen days');
  for (let index = 0; index < dates.length; index++) {
    const row = snapshot.days[index];
    const date = dates[index];
    if (row?.date !== date || row.readings?.date !== date || typeof row.readings?.readings?.gospel !== 'string' || !row.readings.readings.gospel.trim() ||
        typeof row.readings?.season !== 'string' || row.readingsUrl !== feedUrl('readings', date)) throw new Error(`Invalid readings snapshot for ${date}`);
    if (row.calendar !== null && (row.calendar?.date !== date || typeof row.calendar?.celebration?.name !== 'string')) throw new Error(`Invalid calendar snapshot for ${date}`);
    if (row.calendarUrl !== feedUrl('liturgical-calendar', date)) throw new Error(`Invalid calendar source for ${date}`);
    if (row.calendar === null && typeof row.calendarHold !== 'string') throw new Error(`Missing calendar hold for ${date}`);
  }
  return snapshot;
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Public readings request failed with HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > 262144) throw new Error('Public readings response exceeds 256 KiB');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 262144) { await response.body.cancel().catch(() => {}); throw new Error('Public readings response exceeds 256 KiB'); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fetchSnapshot(startDate, fetchImpl = fetch) {
  const dates = batchDates(startDate);
  const days = [];
  for (const date of dates) {
    const readingsUrl = feedUrl('readings', date);
    const calendarUrl = feedUrl('liturgical-calendar', date);
    const readings = await fetchJson(readingsUrl, fetchImpl);
    let calendar = null;
    let calendarHold = null;
    try { calendar = await fetchJson(calendarUrl, fetchImpl); }
    catch (error) { calendarHold = error.message; }
    days.push({ date, readingsUrl, calendarUrl, readings, calendar, calendarHold });
  }
  return validateSnapshot({ schemaVersion: 1, days }, dates);
}

function validateArchive(archive) {
  if (!Array.isArray(archive?.messages) || !archive.messages.length) throw new Error('Archive must contain messages');
  for (const message of archive.messages) {
    if (!message || typeof message.fullText !== 'string' || !message.fullText.trim()) throw new Error('Archive message lacks exact fullText');
    validateDate(message.isoDate);
    if (message.citation !== null && message.citation !== undefined && typeof message.citation !== 'string') throw new Error('Archive citation must be text or null');
  }
  return archive;
}

// The feed follows the US calendar, which replaces the weekday Gospel on Thanksgiving, the fourth Thursday of November.
// India keeps the weekday Gospel. That Thursday falls in the 34th week when Advent starts three days later, else the 33rd.
function localGospel(date, feedGospel) {
  const [year, month, day] = date.split('-').map(Number);
  if (month !== 11 || day !== 22 + (11 - new Date(Date.UTC(year, 10, 1)).getUTCDay()) % 7) return feedGospel;
  return day >= 24 ? 'Luke 21:20-28' : 'Luke 19:41-44';
}

const normalized = text => (text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const verseCount = reference => reference.intervals.reduce((sum, range) => sum + range.end - range.start + 1, 0);

function candidateFor(message, index, archiveHash, reading, calendar) {
  const reference = parseReference(message.citation, 'archive').reference;
  const coverage = verseCount(reference);
  const contextFields = ['title', 'verse', 'closing'].filter(field => typeof message[field] === 'string' && message[field].trim());
  const calendarLabelExact = Boolean(calendar && normalized(message.liturgicalLabel) === normalized(calendar.celebration.name));
  const sourceOccurrences = Array.isArray(message.sourceOccurrences) ? message.sourceOccurrences : [];
  const editorialFindings = EDITORIAL_FINDINGS[editorialKey(message.fullText)] || [];
  return {
    sourceId: `${archiveHash}:${index}`, archiveIndex: index, archiveDate: message.isoDate,
    citation: message.citation, originalLabel: message.liturgicalLabel || null,
    payload: message.fullText, payloadSha256: sha256(message.fullText), wordCount: message.fullText.trim().split(/\s+/).length,
    sourceOccurrences, editorialFindings,
    provenance: {
      sourceIdentityAvailable: sourceOccurrences.length > 0,
      senderClaim: sourceOccurrences.length ? 'Archive records source senders. Inspect the original export to verify.' : 'Legacy archive omits sender and original-message identity.',
      authorshipVerified: false, quotationAccuracyVerified: false,
    },
    ranking: {
      coveredWholeVerses: coverage, readingWholeVerses: verseCount(reading), contextFields,
      calendarLabelExact,
      reasons: [
        `All ${coverage} cited whole verse(s) are contained in the reading union.`,
        `Archive has ${contextFields.length} of 3 context fields. This does not establish clarity or completeness of meaning.`,
        calendarLabelExact ? 'Archive label matches the feed celebration exactly after punctuation normalization.' : 'Archive label requires review against the current calendar.',
        'Archive date breaks ties only. Ranking does not establish pastoral quality.',
      ],
    },
    holds: [
      ...editorialFindings.map(finding => finding.finding),
      'Review every message in this batch. No message is approved.',
      'Authorship and the exact Scripture quotation remain unverified.',
      'Review the original dated or feast label. The exact archived payload is preserved without a label rewrite.',
      'Check meaning in the complete reading, local Roman Catholic calendar, and recent reuse before approval.',
      ...(sourceOccurrences.length ? [] : ['Legacy sender provenance is unavailable. Do not attribute composition to the father.']),
      ...(message.fullText.trim().split(/\s+/).length > 100 ? ['Message exceeds 100 words. Review length without silently editing the quotation.'] : []),
    ],
  };
}

function draftBatch({ startDate, archiveBytes, archivePath, snapshot }) {
  const dates = batchDates(startDate);
  validateSnapshot(snapshot, dates);
  const archive = validateArchive(JSON.parse(archiveBytes.toString('utf8')));
  const archiveSha256 = sha256(archiveBytes);
  const unsupportedArchive = [];
  archive.messages.forEach((message, index) => {
    const parsed = parseReference(message.citation, 'archive');
    if (parsed.state === 'unsupported') unsupportedArchive.push({ archiveIndex: index, citation: message.citation || null, reason: parsed.reason });
  });
  const days = snapshot.days.map(row => {
    const feedGospel = row.readings.readings.gospel;
    const gospel = localGospel(row.date, feedGospel);
    const reading = parseReference(gospel);
    const base = {
      date: row.date, state: 'unsupported', approval: 'DRAFT_REQUIRES_REVIEW',
      gospel, ...(gospel === feedGospel ? {} : { feedGospel }), season: row.readings.season, celebration: row.calendar?.celebration.name || null,
      readingsUrl: row.readingsUrl, calendarUrl: row.calendarUrl,
      calendarHold: row.calendarHold, proposed: null, alternatives: [], heldCandidates: [],
    };
    if (reading.state === 'unsupported') return { ...base, reason: reading.reason, holds: ['Reading cannot be matched safely. Resolve the full reference before choosing a message.'] };
    const eligible = archive.messages.flatMap((message, index) => citationMatchesReading(message.citation, reading.reference)
      ? [candidateFor(message, index, archiveSha256, reading.reference, row.calendar)] : []);
    eligible.sort((a, b) => b.ranking.coveredWholeVerses - a.ranking.coveredWholeVerses ||
      b.ranking.contextFields.length - a.ranking.contextFields.length ||
      Number(b.ranking.calendarLabelExact) - Number(a.ranking.calendarLabelExact) ||
      b.archiveDate.localeCompare(a.archiveDate) || a.archiveIndex - b.archiveIndex);
    if (!eligible.length) return { ...base, state: 'gap', reason: 'no-fully-contained-archive-citation', holds: ['Specific editorial review must supply or select a message. No generated or Bible fallback text is supplied.'] };
    const available = eligible.filter(candidate => !candidate.editorialFindings.length);
    const heldCandidates = eligible.filter(candidate => candidate.editorialFindings.length);
    if (!available.length) return { ...base, reason: 'known-quote-citation-mismatch', eligibleCount: eligible.length, heldCandidates,
      holds: heldCandidates.flatMap(candidate => candidate.editorialFindings.map(finding => finding.finding)) };
    return { ...base, state: 'candidate', reason: 'archive-shortlist-requires-human-review', eligibleCount: eligible.length, heldCandidates, proposed: available[0], alternatives: available.slice(1, 3) };

  });
  return {
    kind: 'DraftBatch', schemaVersion: 1, approval: 'DRAFT_REQUIRES_REVIEW', reviewPolicy: 'REVIEW_EVERY_BATCH',
    startDate, endDate: dates[13], timezone: 'Asia/Kolkata', rite: 'Roman Catholic',
    sourceSnapshot: { archivePath, archiveSha256, archiveRecords: archive.messages.length, readingsSha256: sha256(JSON.stringify(snapshot)),
      legacyRecordsWithoutSourceIdentity: archive.messages.filter(message => !message.sourceOccurrences?.length).length },
    rankingPolicy: 'Lexicographic shortlist by whole-verse coverage, presence of title/verse/closing, exact calendar label, archive date, and archive index. No semantic or pastoral quality claim.',
    summary: { mechanicalCandidateDates: days.filter(day => day.eligibleCount > 0).length, candidates: days.filter(day => day.state === 'candidate').length, gaps: days.filter(day => day.state === 'gap').length, unsupported: days.filter(day => day.state === 'unsupported').length },
    unsupportedArchive,
    days,
  };
}

function formatPreview(batch) {
  const commonHolds = new Set([
    'Review every message in this batch. No message is approved.',
    'Authorship and the exact Scripture quotation remain unverified.',
    'Review the original dated or feast label. The exact archived payload is preserved without a label rewrite.',
    'Check meaning in the complete reading, local Roman Catholic calendar, and recent reuse before approval.',
    'Legacy sender provenance is unavailable. Do not attribute composition to the father.',
  ]);
  const lines = [
    '# DRAFT. Requires review of every message.', '',
    `${batch.startDate} through ${batch.endDate}. Roman Catholic feed. Dates use Asia/Kolkata.`, '',
    `${batch.summary.candidates} candidate dates. ${batch.summary.unsupported} dates held as unsupported. Archive gaps: ${batch.summary.gaps}. Nothing is approved.`, '',
    `${batch.summary.mechanicalCandidateDates} dates have mechanically contained archive citations. Known quotation defects can still hold a date.`, '',
    'Authorship and quotation accuracy remain unverified. Check each quotation against its citation, the complete reading, the local calendar, and recent reuse before approval.', '',
    `${batch.sourceSnapshot.legacyRecordsWithoutSourceIdentity} archive records lack original sender identity. Do not attribute composition to the father without verified provenance.`, '',
    `Archive SHA-256: ${batch.sourceSnapshot.archiveSha256}`, '',
    '[Full metadata and payload hashes](draft-batch.json). Source numbers below are zero-based archive indices. All payloads preserve the archived wording and labels. JSON preserves every character and all whitespace.', '',
    batch.rankingPolicy, '',
  ];
  for (const day of batch.days) {
    lines.push(`## ${day.date}. ${day.state}.`, '', `${day.gospel}. ${day.celebration || 'Calendar unavailable'}.`, '',
      `[Reading source](${day.readingsUrl}). [Calendar source](${day.calendarUrl}).`, '');
    if (day.calendarHold) lines.push(`Calendar hold: ${day.calendarHold}`, '');
    if (!day.proposed) lines.push(`Hold: ${day.reason}.`, '', ...day.holds.map(hold => `- ${hold}`), '');
    for (const held of day.heldCandidates) {
      lines.push('### Held archive record. Do not send.', '', `Source #${held.archiveIndex}. Archive date ${held.archiveDate}. Citation ${held.citation}.`, '',
        '<pre>' + held.payload.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>', '',
        ...held.editorialFindings.map(finding => `${finding.finding} [Evidence](${finding.evidenceUrl}).`),
        ...held.holds.filter(hold => !commonHolds.has(hold) && !held.editorialFindings.some(finding => finding.finding === hold)).map(hold => `- ${hold}`), '');
    }
    if (!day.proposed) continue;
    for (const [index, candidate] of [day.proposed, ...day.alternatives].entries()) {
      const name = index === 0 ? 'Proposed' : `Alternative ${index}`;
      if (!candidate.ranking.calendarLabelExact) lines.push(`- Label review required. ${name} source #${candidate.archiveIndex} uses "${candidate.originalLabel || '(none)'}". Compare with "${day.celebration || 'Calendar unavailable'}".`);
      if (candidate.ranking.contextFields.length < 3) lines.push(`- ${name} source #${candidate.archiveIndex} has ${candidate.ranking.contextFields.length} of 3 context fields. Review completeness.`);
      lines.push(...candidate.holds.filter(hold => !commonHolds.has(hold)).map(hold => `- ${name} source #${candidate.archiveIndex}. ${hold}`));
    }
    lines.push('');
    for (const [index, candidate] of [day.proposed, ...day.alternatives].entries()) {
      if (index === 1) lines.push('<details>', `<summary>Alternative archived messages. ${day.alternatives.length} available. Unapproved.</summary>`, '');
      lines.push(index === 0 ? '### Proposed exact archived message. Unapproved.' : `### Alternative ${index}. Unapproved.`, '',
        `Source #${candidate.archiveIndex}. Archive date ${candidate.archiveDate}. Citation ${candidate.citation}.`, '',
        `Original label: ${candidate.originalLabel || '(none)'}. Words: ${candidate.wordCount}.`, '',
        '<pre>' + candidate.payload.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>', '');
    }
    if (day.alternatives.length) lines.push('</details>', '');
  }
  return lines.join('\n') + '\n';
}

function writeDraft(outputPath, batch, snapshot) {
  const fs = require('node:fs');
  const output = path.resolve(outputPath);
  let ancestor = output;
  const suffix = [];
  while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  const canonicalOutput = path.join(fs.realpathSync(ancestor), ...suffix);
  const approved = fs.realpathSync(path.join(REPOSITORY, 'content'));
  if (canonicalOutput === approved || canonicalOutput.startsWith(approved + path.sep)) throw new Error('Draft output cannot be inside approved content');
  const files = {
    'draft-batch.json': JSON.stringify(batch, null, 2) + '\n',
    'preview.md': formatPreview(batch),
    'readings-snapshot.json': JSON.stringify(snapshot, null, 2) + '\n',
  };
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(output, name);
    if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || fs.readFileSync(target, 'utf8') !== bytes)) throw new Error(`Refusing to overwrite different output ${target}. Choose a new output directory.`);
  }
  fs.mkdirSync(output, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(output, name);
    if (fs.existsSync(target)) continue;
    const temporary = fs.mkdtempSync(path.join(output, '.draft-'));
    try {
      const staged = path.join(temporary, name);
      fs.writeFileSync(staged, bytes, { flag: 'wx' });
      fs.linkSync(staged, target);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--start-date', '--archive', '--output', '--snapshot', '--fetch-readings'].includes(key) || options[key]) throw new Error(`Unknown or repeated option ${key}`);
    if (key === '--fetch-readings') options[key] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[key] = args[++index];
    }
  }
  if (!options['--start-date'] || !options['--archive'] || !options['--output'] || Boolean(options['--snapshot']) === Boolean(options['--fetch-readings'])) {
    throw new Error('Use --start-date YYYY-MM-DD --archive archive.json --output new-directory and exactly one of --snapshot readings.json or --fetch-readings');
  }
  const fs = require('node:fs');
  batchDates(options['--start-date']);
  const archiveBytes = fs.readFileSync(options['--archive']);
  validateArchive(JSON.parse(archiveBytes.toString('utf8')));
  const snapshot = options['--snapshot'] ? JSON.parse(fs.readFileSync(options['--snapshot'], 'utf8')) : await fetchSnapshot(options['--start-date']);
  const batch = draftBatch({ startDate: options['--start-date'], archiveBytes, archivePath: options['--archive'], snapshot });
  writeDraft(options['--output'], batch, snapshot);
  console.log(JSON.stringify({ approval: batch.approval, startDate: batch.startDate, endDate: batch.endDate, ...batch.summary, output: options['--output'] }));
}

module.exports = { validateDate, batchDates, validateSnapshot, fetchSnapshot, draftBatch, formatPreview, writeDraft, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

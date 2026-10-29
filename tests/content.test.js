const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { parseApiRef, parseDadCitation, citationMatchesReading, parseReference, GOSPEL_VERSE_COUNTS } = require('../gospel_matcher');
const { parseChat, collectMessages, extractFields } = require('../parse_gospel');
const { batchDates, draftBatch, writeDraft, fetchSnapshot, formatPreview, main } = require('../scripts/draft-content');

const root = path.resolve(__dirname, '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = t => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gospel-content-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; };
const message = { isoDate: '2025-10-30', citation: 'LK(14:5)', title: 'Fixture', verse: 'Synthetic fixture body', closing: 'Synthetic fixture closing', liturgicalLabel: 'Old feast label', fullText: 'Synthetic review fixture. Gospel Msg (Fixture) LK(14:5). Synthetic closing.' };
const archiveBytes = Buffer.from(JSON.stringify({ messages: [message] }));
function snapshot(start = '2026-10-30') {
  return { schemaVersion: 1, days: batchDates(start).map(date => ({ date,
    readingsUrl: `https://cpbjr.github.io/catholic-readings-api/readings/${date.slice(0,4)}/${date.slice(5)}.json`,
    calendarUrl: `https://cpbjr.github.io/catholic-readings-api/liturgical-calendar/${date.slice(0,4)}/${date.slice(5)}.json`,
    readings: { date, season: 'Ordinary Time', readings: { gospel: 'Luke 14:1-6' } },
    calendar: { date, celebration: { name: 'Current calendar label' } }, calendarHold: null,
  })) };
}
const messagesDirectory = path.join(root, 'content/messages');
const approvedState = () => sha256(JSON.stringify([sha256(fs.readFileSync(path.join(root, 'gospel_messages.json'))),
  ...fs.readdirSync(messagesDirectory).sort().map(file => [file, sha256(fs.readFileSync(path.join(messagesDirectory, file)))])]));
function draft(feed = snapshot()) { return draftBatch({ startDate: '2026-10-30', archiveBytes, archivePath: 'fixture.json', snapshot: feed }); }

test('whole citation must fit the complete disjoint union', () => {
  assert.equal(citationMatchesReading('LK(4:4,8,12)', parseApiRef('Luke 4:1-5')), false);
  assert.equal(citationMatchesReading('LK(4:4,8,12)', parseApiRef('Luke 4:1-5, 8, 12')), true);
  assert.equal(citationMatchesReading('JH(1:9-14)', parseApiRef('John 1:1-5, 9-14')), true);
  assert.equal(citationMatchesReading('JH(1:4-10)', parseApiRef('John 1:1-5, 9-14')), false);
  assert.equal(citationMatchesReading('JH(1:5-9)', parseApiRef('John 1:1-5, 9-14')), false);
  assert.equal(citationMatchesReading('LK(14:11)', parseApiRef('Luke 14:1, 7-11')), true);
  assert.equal(citationMatchesReading('LK(14:5)', parseApiRef('Luke 14:1, 7-11')), false);
  assert.equal(citationMatchesReading('MK(1:1)', parseApiRef('Matthew 1:1-25')), false);
});

test('cross-chapter and explicit subsequent chapters retain all bounds', () => {
  const reading = parseApiRef('John 18:39-19:3, 19:7-9; 20:1-2');
  assert.deepEqual(reading.intervals, [{ chapter: 18, start: 39, end: 40 }, { chapter: 19, start: 1, end: 3 }, { chapter: 19, start: 7, end: 9 }, { chapter: 20, start: 1, end: 2 }]);
  assert.equal(citationMatchesReading('JH(18:40-19:2)', reading), true);
  assert.equal(citationMatchesReading('JH(18:38-19:2)', reading), false);
  assert.equal(citationMatchesReading('JH(19:3-7)', reading), false);
  assert.equal(citationMatchesReading('JH(19:7,9;20:2)', reading), true);
  assert.equal(citationMatchesReading('JH(19:9-20:1)', reading), false);
  assert.equal(citationMatchesReading('JH(19-28-30)', parseApiRef('John 19:25-30')), true);
  assert.equal(citationMatchesReading('LK (14:5)', parseApiRef('Luke 14:1-6')), true);
});

test('partial verses, alternatives, trailing junk, and invalid ranges are held', () => {
  for (const reference of ['Matthew 5:1-12a', 'John 1:1-5 or 9-14', 'John 1:1-5 junk', 'John 1:1-5,', 'Luke 4:8-4', 'Luke 0:1', 'Luke 25:1', 'Luke 1:0', 'Luke 1:81', 'Mark 1:1-17:1', 'John 19:2-18:40', 'Acts 1:1', 'constructor 1:1', 'toString 1:1', 'John 1:1/2', 'John 1:1:2']) assert.equal(parseApiRef(reference), null, reference);
  for (const citation of ['MT(5:12a)', 'LK(4:4,8junk)', 'LK(4:8-4)', 'LK(4:4) junk', 'LK(4:4) or LK(4:8)', 'LK(4:4,)', 'LK(4:0)', 'LK(99:1)']) assert.equal(parseDadCitation(citation), null, citation);
  assert.equal(parseReference('Matthew 5:1-12a').reason, 'partial-verses-unsupported');
  assert.equal(citationMatchesReading('MT(5:12)', parseApiRef('Matthew 5:1-12a')), false);
});

test('all canonical chapter endpoints accept bounds and reject the next verse', () => {
  const books = { mt: 'Matthew', mk: 'Mark', lk: 'Luke', jh: 'John' };
  for (const [book, counts] of Object.entries(GOSPEL_VERSE_COUNTS)) {
    counts.forEach((end, index) => {
      assert.ok(parseApiRef(`${books[book]} ${index + 1}:1-${end}`));
      assert.equal(parseApiRef(`${books[book]} ${index + 1}:${end + 1}`), null);
    });
    assert.equal(parseApiRef(`${books[book]} ${counts.length + 1}:1`), null);
  }
});

test('import filters exact sender before detection and preserves duplicate source occurrences', () => {
  const body = 'Gospel Msg (Synthetic fixture) These are synthetic words for a parser fixture LK(14:5) Closing words.\r\n';
  const text = `[29/10/26, 9:00 AM] Dad 2: ${body}[30/10/26, 9:00 AM] Dad: ${body}[31/10/26, 9:00 AM] Dad: ${body}`;
  const output = collectMessages(text, 'Dad');
  assert.equal(output.meta.parsedMessages, 3);
  assert.equal(output.meta.senderMessages, 2);
  assert.equal(output.messages.length, 1);
  assert.equal(output.meta.gospelOccurrences, 2);
  assert.equal(output.messages[0].isoDate, '2026-10-31');
  assert.equal(output.messages[0].fullText, body);
  assert.equal(output.messages[0].originalText, body);
  assert.deepEqual(output.messages[0].sourceOccurrences.map(source => source.messageOrdinal), [2, 3]);
  for (const occurrence of output.messages[0].sourceOccurrences) {
    assert.equal(occurrence.sender, 'Dad');
    assert.equal(occurrence.originalText, body);
    assert.equal(occurrence.sourceSha256, sha256(text));
    assert.ok(occurrence.rawMessage.includes('] Dad: '));
    assert.ok(occurrence.timestamp.endsWith('9:00 AM'));
  }
  assert.equal(output.messages[0].provenance.authorshipVerified, false);
  assert.equal(parseChat(text)[0].sender, 'Dad 2');
  assert.throws(() => collectMessages(text, ''), /exact sender/);
  assert.throws(() => collectMessages('unsupported export', 'Dad'), /No supported/);
});

const importFixture = written => collectMessages(`[30/10/26, 9:00 AM] Dad: Gospel Msg (Fixture) Synthetic words for a parser fixture. ${written} Closing words.`, 'Dad').messages;

test('import reads citations written in mixed case or with spaces', () => {
  for (const [written, stored, reading] of [
    ['Lk(14:33)', 'Lk(14:33)', 'Luke 14:25-33'],
    ['LK (14:23-24)', 'LK(14:23-24)', 'Luke 14:15-24'],
    ['MT (17: 25-26)', 'MT(17: 25-26)', 'Matthew 17:22-27'],
    ['(Matthew 22:37-39).', 'Matthew(22:37-39)', 'Matthew 22:34-40'],
    ['(LK13:12-13)', 'LK(13:12-13)', 'Luke 13:10-17'],
    ['MK14:24-25', 'MK(14:24-25)', 'Mark 14:12-26'],
    ['LK14:5', 'LK(14:5)', 'Luke 14:1-6'],
    ['(Luke 14:5)', 'Luke(14:5)', 'Luke 14:1-6'],
    ['lk(14:33)', 'lk(14:33)', 'Luke 14:25-33'],
    ['lK(14:33)', 'lK(14:33)', 'Luke 14:25-33'],
  ]) {
    const [entry] = importFixture(written);
    assert.equal(entry.citation, stored);
    assert.equal(entry.title, 'Fixture');
    assert.equal(entry.verse, 'Synthetic words for a parser fixture.');
    assert.equal(entry.closing, 'Closing words.');
    assert.equal(citationMatchesReading(entry.citation, parseApiRef(reading)), true, written);
  }
});

test('import keeps partial-verse letters so the matcher holds them', () => {
  for (const [written, stored] of [['(Matthew 5:1-12a)', 'Matthew(5:1-12a)'], ['MT(5:12a)', 'MT(5:12a)']]) {
    const [entry] = importFixture(written);
    assert.equal(entry.citation, stored);
    assert.equal(entry.closing, 'Closing words.');
    assert.equal(parseReference(entry.citation, 'archive').reason, 'partial-verses-unsupported');
  }
});

test('import ignores bracketed numbers that are not citations', () => {
  const [entry] = importFixture('We walk (2 miles) daily. LK(14:5)');
  assert.equal(entry.citation, 'LK(14:5)');
});

test('importing parser executes no filesystem reads or writes and emits no logs', () => {
  const code = `const fs = require('node:fs'); const Module = require('node:module'); require('node:crypto');
    const filename = require('node:path').resolve('parse_gospel.js'); const source = fs.readFileSync(filename, 'utf8');
    for (const key of ['readFileSync','writeFileSync','mkdirSync','appendFileSync']) fs[key] = () => { throw new Error('Unexpected import IO ' + key); };
    const m = new Module(filename); m.filename = filename; m.paths = Module._nodeModulePaths(process.cwd()); m._compile(source, filename);
    if (typeof m.exports.collectMessages !== 'function') throw new Error('Missing exports');`;
  const run = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
});

test('import CLI writes a new archive and refuses to overwrite it', t => {
  const directory = temporary(t);
  const input = path.join(directory, 'chat.txt');
  const output = path.join(directory, 'archive.json');
  fs.writeFileSync(input, '[30/10/26, 9:00 AM] Dad: Gospel Msg (Synthetic fixture) These are synthetic parser test words LK(14:5) Closing words.');
  const args = [path.join(root, 'parse_gospel.js'), '--input', input, '--output', output, '--sender', 'Dad'];
  assert.equal(spawnSync(process.execPath, args).status, 0);
  const before = fs.readFileSync(output);
  assert.notEqual(spawnSync(process.execPath, args).status, 0);
  assert.deepEqual(fs.readFileSync(output), before);
});

test('draft is deterministic and preserves exact payloads, provenance holds, alternatives, and gaps', () => {
  const feed = snapshot();
  feed.days[1].readings.readings.gospel = 'Matthew 5:1-12a';
  feed.days[2].readings.readings.gospel = 'Luke 16:1-8';
  const first = draft(feed);
  assert.deepEqual(first, draft(JSON.parse(JSON.stringify(feed))));
  assert.deepEqual(first.summary, { mechanicalCandidateDates: 12, candidates: 12, gaps: 1, unsupported: 1 });
  assert.equal(first.approval, 'DRAFT_REQUIRES_REVIEW');
  assert.equal(first.days[0].proposed.payload, message.fullText);
  assert.equal(first.days[0].proposed.payloadSha256, sha256(message.fullText));
  assert.equal(first.days[0].proposed.provenance.authorshipVerified, false);
  assert.equal(first.days[0].proposed.provenance.sourceIdentityAvailable, false);
  assert.equal(first.days[0].proposed.originalLabel, 'Old feast label');
  assert.equal(first.days[0].proposed.ranking.calendarLabelExact, false);
  assert.equal(first.days[1].state, 'unsupported');
  assert.equal(first.days[1].proposed, null);
  assert.equal(first.days[2].state, 'gap');
  assert.equal(first.days[2].proposed, null);
  assert.ok(formatPreview(first).includes(message.fullText));
  const many = { messages: [message, { ...message, citation: 'LK(14:4-5)' }, { ...message, citation: 'LK(14:5-7)' }, message, message, message] };
  const ranked = draftBatch({ startDate: '2026-10-30', archiveBytes: Buffer.from(JSON.stringify(many)), archivePath: 'fixture', snapshot: snapshot() });
  assert.equal(ranked.days[0].proposed.citation, 'LK(14:4-5)');
  assert.equal(ranked.days[0].eligibleCount, 5);
  assert.equal(ranked.days[0].alternatives.length, 2);
});

test('invalid dates and malformed or mismatched snapshots fail before output', async t => {
  const directory = temporary(t);
  for (const date of ['2026-02-29', '2026-13-01', '2026-10-32', '10/30/2026', '2026-1-01', '2026-10-30T00:00:00Z']) assert.throws(() => batchDates(date), /Invalid date/);
  for (const mutate of [feed => feed.days.pop(), feed => feed.days[0].readings.date = '2025-10-30', feed => feed.days[0].calendar.date = '2025-10-30', feed => feed.days[0].readings.readings.gospel = null, feed => feed.days[0].readingsUrl = 'https://example.com']) {
    const feed = snapshot(); mutate(feed); assert.throws(() => draft(feed), /snapshot/i);
  }
  const archive = path.join(directory, 'source.json');
  fs.writeFileSync(archive, archiveBytes);
  await assert.rejects(main(['--start-date','2026-02-29','--archive',archive,'--output',path.join(directory, 'draft'),'--fetch-readings']), /Invalid date/);
  assert.equal(fs.existsSync(path.join(directory, 'draft')), false);
});

test('snapshot fetch sends only bounded public date GETs and validates dates', async () => {
  const requests = [];
  const feed = snapshot();
  const fakeFetch = async (url, options) => {
    requests.push({ url, options });
    const row = feed.days.find(day => day.readingsUrl === url || day.calendarUrl === url);
    return new Response(JSON.stringify(url.includes('/readings/') ? row.readings : row.calendar), { status: 200 });
  };
  assert.deepEqual(await fetchSnapshot('2026-10-30', fakeFetch), feed);
  assert.equal(requests.length, 28);
  for (const request of requests) {
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.body, undefined);
    assert.equal(request.options.redirect, 'error');
    assert.ok(request.options.signal);
    assert.ok(request.url.startsWith('https://cpbjr.github.io/catholic-readings-api/'));
  }
  await assert.rejects(fetchSnapshot('2026-10-30', async () => new Response('x'.repeat(262145))), /exceeds/);
  await assert.rejects(fetchSnapshot('2026-10-30', async () => new Response('{}', { status: 503 })), /HTTP 503/);
});

test('draft output repeats safely, refuses different bytes, and cannot write approved content', t => {
  const directory = temporary(t);
  const output = path.join(directory, 'draft');
  const batch = draft();
  const before = approvedState();
  writeDraft(output, batch, snapshot());
  writeDraft(output, batch, snapshot());
  const stored = JSON.parse(fs.readFileSync(path.join(output, 'draft-batch.json')));
  assert.deepEqual(stored, batch);
  fs.unlinkSync(path.join(output, 'preview.md'));
  writeDraft(output, batch, snapshot());
  assert.equal(fs.readFileSync(path.join(output, 'preview.md'), 'utf8'), formatPreview(batch));
  assert.throws(() => writeDraft(output, { ...batch, rite: 'different' }, snapshot()), /Refusing to overwrite/);
  assert.throws(() => writeDraft(path.join(root, 'content', 'review-test'), batch, snapshot()), /approved content/);
  const link = path.join(directory, 'linked-content');
  fs.symlinkSync(path.join(root, 'content'), link);
  assert.throws(() => writeDraft(path.join(link, 'review-test'), batch, snapshot()), /approved content/);
  assert.equal(approvedState(), before);
});

test('offline CLI creates fourteen review dates without changing approved files', t => {
  const directory = temporary(t);
  const source = path.join(directory, 'source.json');
  const feed = path.join(directory, 'readings.json');
  const output = path.join(directory, 'packet');
  fs.writeFileSync(source, archiveBytes);
  fs.writeFileSync(feed, JSON.stringify(snapshot()));
  const run = spawnSync(process.execPath, [path.join(root, 'scripts/draft-content.js'), '--start-date','2026-10-30','--archive',source,'--output',output,'--snapshot',feed], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const packet = JSON.parse(fs.readFileSync(path.join(output, 'draft-batch.json')));
  assert.equal(packet.days.length, 14);
  assert.equal(packet.days[13].date, '2026-11-12');
  assert.equal(packet.approval, 'DRAFT_REQUIRES_REVIEW');
});


test('annotated payload remains held after moving records or exporting another archive', () => {
  const feed = snapshot();
  feed.days[0].readings.readings.gospel = 'Luke 14:15-24';
  const original = fs.readFileSync(path.join(root, 'gospel_messages.json'));
  const before = sha256(original);
  const knownPayload = JSON.parse(original).messages.find(record => record.title.includes('Feeding Five Thousand') && record.citation === 'LK(14:19)').fullText;
  const moved = { ...message, citation: 'LK(14:19)', fullText: knownPayload };
  for (const records of [[moved], [message, moved], [message, message, moved]]) {
    const bytes = Buffer.from(JSON.stringify({ messages: records }));
    const batch = draftBatch({ startDate: '2026-10-30', archiveBytes: bytes, archivePath: 'synthetic-reexport.json', snapshot: feed });
    assert.equal(batch.days[0].state, 'unsupported');
    assert.equal(batch.days[0].reason, 'known-quote-citation-mismatch');
    assert.equal(batch.days[0].proposed, null);
    assert.equal(batch.days[0].heldCandidates.length, 1);
    assert.equal(batch.days[0].heldCandidates[0].payload, knownPayload);
    assert.ok(formatPreview(batch).includes('Held archive record. Do not send.'));
  }
  assert.equal(sha256(fs.readFileSync(path.join(root, 'gospel_messages.json'))), before);
});

test('quotation hold survives collecting exports with changed whitespace and exact payload bytes', () => {
  const original = JSON.parse(fs.readFileSync(path.join(root, 'gospel_messages.json')));
  const payload = original.messages.find(record => record.title.includes('Feeding Five Thousand') && record.citation === 'LK(14:19)').fullText;
  const feed = snapshot();
  feed.days[0].readings.readings.gospel = 'Luke 14:15-24';
  for (const variant of [payload + '\n', payload.replace(/ /g, '\t ') + '\r\n']) {
    const collected = collectMessages('[03/11/26, 9:00 AM] Dad: ' + variant, 'Dad');
    assert.equal(collected.messages[0].fullText, variant);
    const batch = draftBatch({ startDate: '2026-10-30', archiveBytes: Buffer.from(JSON.stringify(collected)), archivePath: 'collected.json', snapshot: feed });
    const held = batch.days[0];
    assert.equal(held.reason, 'known-quote-citation-mismatch');
    assert.equal(held.proposed, null);
    assert.equal(held.heldCandidates[0].payload, variant);
    assert.equal(held.heldCandidates[0].payloadSha256, sha256(variant));
  }
});

test('committed review packet replays exactly and every displayed payload matches its archive source', () => {
  const directory = path.join(root, 'drafts/2026-10-30_2026-11-12');
  const stored = JSON.parse(fs.readFileSync(path.join(directory, 'draft-batch.json')));
  const feed = JSON.parse(fs.readFileSync(path.join(directory, 'readings-snapshot.json')));
  const bytes = fs.readFileSync(path.join(root, stored.sourceSnapshot.archivePath));
  const archive = JSON.parse(bytes);
  const replayed = draftBatch({ startDate: stored.startDate, archiveBytes: bytes, archivePath: stored.sourceSnapshot.archivePath, snapshot: feed });
  assert.deepEqual(replayed, stored);
  const preview = formatPreview(replayed);
  assert.equal(preview, fs.readFileSync(path.join(directory, 'preview.md'), 'utf8'));
  assert.equal(preview.split(stored.sourceSnapshot.archiveSha256).length - 1, 1);
  assert.equal(preview.split('Authorship and quotation accuracy remain unverified.').length - 1, 1);
  assert.ok(preview.includes('[Full metadata and payload hashes](draft-batch.json)'));
  assert.deepEqual(stored.summary, { mechanicalCandidateDates: 13, candidates: 13, gaps: 0, unsupported: 1 });
  assert.equal(stored.days.length, 14);
  for (const day of stored.days) {
    assert.equal(day.approval, 'DRAFT_REQUIRES_REVIEW');
    const section = preview.split(`## ${day.date}. ${day.state}.`)[1].split('\n## ')[0];
    const visible = section.split('<details>')[0];
    assert.ok(visible.includes(day.gospel));
    assert.ok(visible.includes(day.celebration));
    if (!day.proposed) assert.ok(visible.includes(`Hold: ${day.reason}.`));
    for (const candidate of [day.proposed, ...day.alternatives, ...day.heldCandidates].filter(Boolean)) {
      assert.equal(candidate.payload, archive.messages[candidate.archiveIndex].fullText);
      assert.equal(candidate.payloadSha256, sha256(candidate.payload));
      assert.equal(candidate.sourceId, `${sha256(bytes)}:${candidate.archiveIndex}`);
      assert.equal(candidate.provenance.authorshipVerified, false);
      const escapedPayload = candidate.payload.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const payloadSection = day.alternatives.includes(candidate) ? section.split('<details>')[1].split('</details>')[0] : visible;
      assert.ok(payloadSection.includes(`<pre>${escapedPayload}</pre>`));
      assert.ok(payloadSection.includes(`Source #${candidate.archiveIndex}. Archive date ${candidate.archiveDate}. Citation ${candidate.citation}.`));
      for (const finding of candidate.editorialFindings) assert.ok(visible.includes(finding.finding));
      if (day.proposed && !day.heldCandidates.includes(candidate) && !candidate.ranking.calendarLabelExact) assert.ok(visible.includes(`source #${candidate.archiveIndex} uses "${candidate.originalLabel || '(none)'}"`));
      if (day.proposed === candidate) assert.equal(candidate.editorialFindings.length, 0);
    }
  }
});

test('committed archive stores the fields the importer reads from each message', () => {
  const archive = JSON.parse(fs.readFileSync(path.join(root, 'gospel_messages.json')));
  for (const [index, record] of archive.messages.entries()) {
    const fields = extractFields({ text: record.fullText, date: '30/10/26' });
    assert.deepEqual([record.citation, record.verse, record.closing], [fields.citation, fields.verse, fields.closing], `source #${index}`);
  }
});

test('published messages cover consecutive dates and decode as UTF-8 text', () => {
  const files = fs.readdirSync(messagesDirectory).filter(file => file !== '.gitkeep').sort();
  files.forEach((file, index) => {
    assert.match(file, /^\d{4}-\d{2}-\d{2}\.txt$/);
    if (index) {
      const expected = new Date(Date.parse(files[index - 1].slice(0, 10)) + 86400000).toISOString().slice(0, 10);
      assert.equal(file.slice(0, 10), expected, `content/messages is missing ${expected}.txt`);
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(path.join(messagesDirectory, file)));
    assert.ok(text.trim() && !text.startsWith('﻿'), `${file} is empty or starts with a byte order mark`);
  });
});

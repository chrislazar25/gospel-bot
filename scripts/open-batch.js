const fs = require('node:fs');
const path = require('node:path');
const { draftBatch, fetchSnapshot, validateDate, validateSnapshot, batchDates } = require('./draft-content');

const REPOSITORY = path.resolve(__dirname, '..');
const LEAD_DAYS = 21;
const HOLD_REASONS = {
  'no-fully-contained-archive-citation': 'No archive message quotes this reading.',
  'partial-verses-unsupported': 'The reading cites part of a verse, which the matcher cannot check.',
  'known-quote-citation-mismatch': 'The only archive matches have a known quotation error.',
};

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const istToday = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
const dayName = date => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const quote = text => '> ' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function publishedDates(messagesDirectory) {
  return fs.readdirSync(messagesDirectory).filter(file => file !== '.gitkeep').map(file => validateDate(file.slice(0, -4))).sort();
}

function nextStartDate(published, today) {
  const last = published.at(-1);
  if (last && last >= addDays(today, LEAD_DAYS)) return null;
  return last && last >= today ? addDays(last, 1) : addDays(today, 1);
}

function missingUpcomingDates(published, today) {
  const upcoming = published.filter(date => date >= today);
  const missing = [];
  for (let date = upcoming[0]; date && date < upcoming.at(-1); date = addDays(date, 1)) if (!upcoming.includes(date)) missing.push(date);
  return missing;
}

function headingNote(candidate, day) {
  const label = candidate.originalLabel;
  if (!label || /^today'?s$/i.test(label) || candidate.ranking.calendarLabelExact) return null;
  return `Heading says "${label}". The day is ${day.celebration || 'not in the calendar feed'}.`;
}

function formatBatchBody(batch) {
  const needsMessage = batch.days.filter(day => !day.proposed);
  const headings = batch.days.flatMap(day => day.proposed && headingNote(day.proposed, day) ? [`${dayName(day.date)}. ${headingNote(day.proposed, day)}`] : []);
  const lines = [
    `Messages for ${dayName(batch.startDate)} to ${dayName(batch.endDate)}. Merging this PR publishes them.`, '',
    'To change a message, edit its file in this PR. To use an alternative, paste its text into the file. A date in the middle without a file fails CI.', '',
    needsMessage.length
      ? `**Needs a message.** ${needsMessage.map(day => `${dayName(day.date)} (${day.gospel})`).join(', ')}. Add \`content/messages/<date>.txt\` for each.`
      : '**Every date has a proposed message.**', '',
  ];
  if (headings.length) lines.push('**Check the heading.**', '', ...headings.map(note => `- ${note}`), '');
  for (const day of batch.days) {
    lines.push(`## ${dayName(day.date)}. ${day.gospel}`, '', `${day.celebration || 'Not in the calendar feed'}. [Reading](${day.readingsUrl}).`, '');
    for (const held of day.heldCandidates) {
      lines.push(`Held, do not send. Source #${held.archiveIndex}. ${held.editorialFindings.map(finding => finding.finding).join(' ')}`, '');
    }
    if (!day.proposed) {
      lines.push(`**No file.** ${HOLD_REASONS[day.reason] || day.reason}`, '');
      continue;
    }
    lines.push(`Proposed. Source #${day.proposed.archiveIndex}, sent ${day.proposed.archiveDate}. File \`content/messages/${day.date}.txt\`.`, '', quote(day.proposed.payload), '');
    if (day.alternatives.length) {
      lines.push('<details>', `<summary>${day.alternatives.length} alternative${day.alternatives.length > 1 ? 's' : ''}</summary>`, '');
      for (const alternative of day.alternatives) lines.push(`Source #${alternative.archiveIndex}, sent ${alternative.archiveDate}.`, '', quote(alternative.payload), '');
      lines.push('</details>', '');
    }
  }
  const body = lines.join('\n');
  if (body.length > 60000) throw new Error('Batch PR body exceeds the GitHub limit');
  return body;
}

async function openBatch({ root = REPOSITORY, today = istToday(new Date()), snapshot, fetchImpl = fetch }) {
  const messagesDirectory = path.join(root, 'content/messages');
  const startDate = nextStartDate(publishedDates(messagesDirectory), today);
  if (!startDate) return { due: false };
  const readings = snapshot ? validateSnapshot(snapshot, batchDates(startDate)) : await fetchSnapshot(startDate, fetchImpl);
  const batch = draftBatch({ startDate, archiveBytes: fs.readFileSync(path.join(root, 'gospel_messages.json')), archivePath: 'gospel_messages.json', snapshot: readings });
  if (!batch.days.some(day => day.proposed)) throw new Error(`No archive message for ${batch.startDate} to ${batch.endDate}. Add those messages in a content PR by hand.`);
  for (const day of batch.days) {
    if (day.proposed) fs.writeFileSync(path.join(messagesDirectory, `${day.date}.txt`), day.proposed.payload, { flag: 'wx' });
  }
  return { due: true, startDate: batch.startDate, endDate: batch.endDate, needsMessage: batch.days.filter(day => !day.proposed).map(day => day.date), body: formatBatchBody(batch) };
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--body-file', '--today', '--snapshot'].includes(args[index]) || !args[index + 1] || options[args[index]]) {
      throw new Error('Usage: node scripts/open-batch.js --body-file pr-body.md [--today YYYY-MM-DD] [--snapshot readings.json]');
    }
    options[args[index]] = args[index + 1];
  }
  if (!options['--body-file']) throw new Error('--body-file is required');
  const result = await openBatch({
    today: options['--today'] ? validateDate(options['--today']) : undefined,
    snapshot: options['--snapshot'] ? JSON.parse(fs.readFileSync(options['--snapshot'], 'utf8')) : undefined,
  });
  if (result.due) fs.writeFileSync(options['--body-file'], result.body, { flag: 'wx' });
  const { body, ...summary } = result;
  console.log(JSON.stringify(summary));
}

module.exports = { nextStartDate, missingUpcomingDates, formatBatchBody, openBatch };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

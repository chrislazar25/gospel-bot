/**
 * Gospel WhatsApp Sender — Green API edition
 *
 * Flow:
 *   5:00 PM IST  (day before) → preview email to mom
 *   12:30 AM IST (send day)   → send to WhatsApp group via Green API
 *   1:00 AM IST  (send day)   → watchdog: retry if not sent
 *
 * Setup:
 *   1. Sign up at green-api.com
 *   2. Create an instance, scan QR on WhatsApp
 *   3. Copy ID_INSTANCE and API_TOKEN from their dashboard
 *   4. Get GROUP_ID from Green API dashboard or journal below
 *   5. Set env vars, npm install, pm2 start app.js
 *
 * Manual triggers (bot must be running via pm2):
 *   curl "http://localhost:3000/trigger"
 *   curl "http://localhost:3000/trigger?date=2026-04-17"
 *   curl "http://localhost:3000/preview"
 *   curl "http://localhost:3000/status"
 *
 * CLI (run directly):
 *   node app.js --trigger-now
 *   node app.js --trigger-now --date=2026-04-17
 *   node app.js --preview-now
 */

const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');
const http       = require('http');

const { getTodaysMessage } = require('./gospel_matcher');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  // Green API credentials — from green-api.com dashboard
  GREEN_API_ID:    process.env.GREEN_API_ID    || 'YOUR_ID_INSTANCE',
  GREEN_API_TOKEN: process.env.GREEN_API_TOKEN || 'YOUR_API_TOKEN',

  // WhatsApp group ID — format: 1234567890-1234567890@g.us
  // Get from Green API dashboard → Contacts → find the group
  GROUP_ID: process.env.GROUP_ID || 'YOUR_GROUP_ID@g.us',

  // Gmail SMTP — use App Password
  EMAIL_USER:    process.env.EMAIL_USER    || 'youremail@gmail.com',
  EMAIL_PASS:    process.env.EMAIL_PASS    || 'your-app-password',
  ALERT_EMAIL:   process.env.ALERT_EMAIL   || 'youremail@gmail.com',
  PREVIEW_EMAIL: process.env.PREVIEW_EMAIL || 'moms-email@gmail.com',

  // Retry settings
  MAX_RETRIES:    3,
  RETRY_DELAY_MS: 5 * 60 * 1000,  // 5 mins

  // HTTP trigger port
  TRIGGER_PORT: parseInt(process.env.TRIGGER_PORT || '3000'),

  // Paths
  SENT_LOG:   path.join(__dirname, 'sent.log.json'),
  QUEUE_FILE: path.join(__dirname, 'pending.json'),
};

const TIMEZONE        = 'Asia/Kolkata';
const DEFAULT_CLOSING = 'Jesus is Lord, spread the living word of God.';

// ─────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────
function log(level, ...args) {
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
}

// Handle unhandled promise rejections gracefully
process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection:', reason?.message || reason);
});

// ─────────────────────────────────────────────
// GREEN API — send message
// ─────────────────────────────────────────────
async function sendToGroup(text) {
  const url = `https://api.green-api.com/waInstance${CONFIG.GREEN_API_ID}/sendMessage/${CONFIG.GREEN_API_TOKEN}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chatId: CONFIG.GROUP_ID, message: text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Green API ${res.status}: ${body}`);
  }

  const data = await res.json();
  log('info', 'Green API response:', JSON.stringify(data));
  return data;
}

// ─────────────────────────────────────────────
// GREEN API — check instance is connected
// ─────────────────────────────────────────────
async function checkGreenApiStatus() {
  try {
    const url = `https://api.green-api.com/waInstance${CONFIG.GREEN_API_ID}/getStateInstance/${CONFIG.GREEN_API_TOKEN}`;
    const res  = await fetch(url);
    const data = await res.json();
    // stateInstance: "authorized" = connected, "notAuthorized" = needs QR scan
    return data.stateInstance;
  } catch (err) {
    return 'error: ' + err.message;
  }
}

// ─────────────────────────────────────────────
// BUILD MESSAGE
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// BIBLE API FALLBACK
// ─────────────────────────────────────────────
async function fetchBibleApiFallback(gospelRef) {
  try {
    const query = (gospelRef || 'john 3:16').toLowerCase().replace(/\s+/g, '+');
    const res   = await fetch(`https://bible-api.com/${query}?translation=kjv`);
    if (!res.ok) throw new Error(`Bible API ${res.status}`);
    const data  = await res.json();
    const text  = data.text?.replace(/\n/g, ' ').trim();
    return `Today's Gospel Msg ${text} ${data.reference} ${DEFAULT_CLOSING}`;
  } catch (err) {
    log('warn', 'Bible API failed:', err.message);
    return `Today's Gospel Msg Jesus said, "I am the way and the truth and the life." JH(14:6) ${DEFAULT_CLOSING}`;
  }
}

// ─────────────────────────────────────────────
// GET MESSAGE FOR A DATE
// ─────────────────────────────────────────────
async function getMessageForDate(dateStr) {
  // Always resolve to IST date — server is UTC so new Date() alone is wrong
  const istDateStr = dateStr || new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const [y, m, d] = istDateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);

  const result = await getTodaysMessage(date);

  if (result.source === 'archive') {
    return { text: buildMessage(result.message, result.todayReading), source: 'archive' };
  }

  log('info', 'No archive match — falling back to Bible API');
  const text = await fetchBibleApiFallback(result.todayReading?.gospelRaw);
  return { text, source: 'fallback' };
}

// ─────────────────────────────────────────────
// SENT LOG
// ─────────────────────────────────────────────
function getSentLog() {
  try { return JSON.parse(fs.readFileSync(CONFIG.SENT_LOG, 'utf8')); }
  catch { return []; }
}

function markSent(entry) {
  const entries = getSentLog();
  const istDate = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  entries.push({ ...entry, sentAt: new Date().toISOString(), istDate });
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  fs.writeFileSync(CONFIG.SENT_LOG, JSON.stringify(
    entries.filter(e => new Date(e.sentAt) > cutoff), null, 2
  ));
}

function alreadySentToday() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  return getSentLog().some(e => e.istDate === today || e.sentAt?.startsWith(today));
}

// ─────────────────────────────────────────────
// QUEUE
// ─────────────────────────────────────────────
function queueMessage(text) {
  const q     = getPendingQueue();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  if (q.some(e => e.date === today)) return;
  q.push({ date: today, text, queuedAt: new Date().toISOString() });
  fs.writeFileSync(CONFIG.QUEUE_FILE, JSON.stringify(q, null, 2));
  log('info', 'Message queued for retry');
}

function getPendingQueue() {
  try { return JSON.parse(fs.readFileSync(CONFIG.QUEUE_FILE, 'utf8')); }
  catch { return []; }
}

function clearQueue() {
  fs.writeFileSync(CONFIG.QUEUE_FILE, JSON.stringify([]));
}

async function flushQueue() {
  const queue = getPendingQueue();
  if (!queue.length) return;
  log('info', `Flushing ${queue.length} queued message(s)`);
  for (const item of queue) {
    try {
      await sendToGroup(item.text);
      markSent({ text: item.text.slice(0, 80), source: 'queue', originalDate: item.date });
      log('info', `✅ Queued message sent (originally for ${item.date})`);
    } catch (err) {
      log('error', 'Failed to flush queue:', err.message);
      return;
    }
  }
  clearQueue();
}

// ─────────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: CONFIG.EMAIL_USER, pass: CONFIG.EMAIL_PASS },
});

async function sendEmail({ to, subject, body }) {
  try {
    await mailer.sendMail({
      from:    CONFIG.EMAIL_USER,
      to,
      subject: `[Gospel Bot] ${subject}`,
      text:    body,
    });
    log('info', `Email sent to ${to}: ${subject}`);
  } catch (err) {
    log('error', 'Email failed:', err.message);
  }
}

// ─────────────────────────────────────────────
// PREVIEW EMAIL TO MOM
// ─────────────────────────────────────────────
async function sendPreviewToMom() {
  log('info', '📧 Preparing preview email for mom...');

  const todayStr    = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const [y, m, d]   = todayStr.split('-').map(Number);
  const tomorrowStr = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);

  let messageText;
  try {
    const result = await getMessageForDate(tomorrowStr);
    messageText  = result.text;
  } catch (err) {
    log('error', "Failed to get tomorrow's message:", err.message);
    await sendEmail({
      to:      CONFIG.ALERT_EMAIL,
      subject: '⚠️ Could not prepare preview email for mom',
      body:    `Error: ${err.message}`,
    });
    return;
  }

  const [ty, tm, td]   = tomorrowStr.split('-').map(Number);
  const tomorrowFormatted = new Date(Date.UTC(ty, tm - 1, td))
    .toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

  await sendEmail({
    to:      CONFIG.PREVIEW_EMAIL,
    subject: `📖 Tomorrow's Gospel Message — ${tomorrowFormatted}`,
    body:
`Hi,

Here is tomorrow's gospel message that will be sent to the group at 12:30 AM:

─────────────────────────────────────
${messageText}
─────────────────────────────────────

The bot will send this automatically. If you don't see it in the group by 1:00 AM, please send it manually.

God bless,
Gospel Bot`,
  });

  log('info', `✅ Preview email sent to mom for ${tomorrowStr}`);
}

// ─────────────────────────────────────────────
// SEND WITH RETRY
// ─────────────────────────────────────────────
async function sendWithRetry(text, attempt = 1) {
  try {
    await sendToGroup(text);
    markSent({ text: text.slice(0, 80), attempt });
    log('info', `✅ Message sent (attempt ${attempt})`);
    await sendEmail({
      to:      CONFIG.ALERT_EMAIL,
      subject: '✅ Gospel message sent',
      body:    `Sent at ${new Date().toLocaleTimeString('en-IN', { timeZone: TIMEZONE })}\n\n${text}`,
    });
    // Flush any queued messages now that we know the connection works
    await flushQueue();
  } catch (err) {
    log('error', `Send failed (attempt ${attempt}):`, err.message);

    if (attempt < CONFIG.MAX_RETRIES) {
      log('info', `Retrying in ${CONFIG.RETRY_DELAY_MS / 60000} mins...`);
      await sendEmail({
        to:      CONFIG.ALERT_EMAIL,
        subject: `🔁 Retry ${attempt}/${CONFIG.MAX_RETRIES}`,
        body:    `Send failed: ${err.message}\nRetrying in ${CONFIG.RETRY_DELAY_MS / 60000} minutes.`,
      });
      setTimeout(() => sendWithRetry(text, attempt + 1), CONFIG.RETRY_DELAY_MS);
    } else {
      queueMessage(text);
      await sendEmail({
        to:      CONFIG.ALERT_EMAIL,
        subject: '💀 All retries failed — message queued',
        body:    `Failed after ${CONFIG.MAX_RETRIES} attempts.\nError: ${err.message}\n\nQueued for next retry.\n\nMessage:\n${text}`,
      });
    }
  }
}

// ─────────────────────────────────────────────
// CRON JOBS (all IST)
// ─────────────────────────────────────────────

// 5:00 PM — preview email to mom
cron.schedule('0 17 * * *', async () => {
  log('info', '⏰ Preview cron fired (5:00 PM IST)');
  await sendPreviewToMom();
}, { timezone: TIMEZONE });

// 12:30 AM — send to WhatsApp group
cron.schedule('30 0 * * *', async () => {
  log('info', '⏰ Send cron fired (12:30 AM IST)');

  if (alreadySentToday()) {
    log('info', 'Already sent today — skipping');
    return;
  }

  try {
    const { text } = await getMessageForDate(null);
    await sendWithRetry(text);
  } catch (err) {
    log('error', 'Send cron failed:', err.message);
    await sendEmail({
      to:      CONFIG.ALERT_EMAIL,
      subject: '❌ Send cron error',
      body:    `Failed to get or send today's message:\n${err.message}`,
    });
  }
}, { timezone: TIMEZONE });

// 1:00 AM — watchdog
cron.schedule('0 1 * * *', async () => {
  if (alreadySentToday()) return;

  log('warn', '⚠️ Watchdog: message not sent — retrying');
  await sendEmail({
    to:      CONFIG.ALERT_EMAIL,
    subject: '⚠️ Watchdog triggered',
    body:    'Main send missed. Watchdog attempting now.',
  });

  try {
    const { text } = await getMessageForDate(null);
    await sendWithRetry(text);
  } catch (err) {
    log('error', 'Watchdog failed:', err.message);
    await sendEmail({
      to:      CONFIG.ALERT_EMAIL,
      subject: '💀 Watchdog also failed',
      body:    `Both main send and watchdog failed.\n\nPlease ask mom to send manually — she received a preview at 5 PM.\n\nError: ${err.message}`,
    });
  }
}, { timezone: TIMEZONE });

// ─────────────────────────────────────────────
// HTTP TRIGGER SERVER
// ─────────────────────────────────────────────
const triggerServer = http.createServer(async (req, res) => {
  const url = req.url;

  // /trigger?date=YYYY-MM-DD (date optional)
  if (url.startsWith('/trigger')) {
    const dateParam = new URL(url, 'http://localhost').searchParams.get('date') || null;
    if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      res.writeHead(400);
      res.end('Bad date. Use YYYY-MM-DD e.g. /trigger?date=2026-04-17\n');
      return;
    }
    log('info', `🔧 Manual trigger${dateParam ? ' for ' + dateParam : ' (today)'}`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Triggered${dateParam ? ' for ' + dateParam : ' for today'}. Check logs: pm2 logs gospel-bot\n`);
    try {
      const { text } = await getMessageForDate(dateParam);
      await sendWithRetry(text);
    } catch (err) {
      log('error', 'Manual trigger failed:', err.message);
    }

  // /preview
  } else if (url === '/preview') {
    log('info', '🔧 Manual preview triggered');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Preview email triggered. Check inbox.\n');
    await sendPreviewToMom();

  // /status
  } else if (url === '/status') {
    const greenStatus = await checkGreenApiStatus();
    const status = {
      greenApi:    greenStatus,
      sentToday:   alreadySentToday(),
      queueLength: getPendingQueue().length,
      time:        new Date().toLocaleString('en-IN', { timeZone: TIMEZONE }),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2) + '\n');

  } else {
    res.writeHead(404);
    res.end('Try /trigger  /trigger?date=YYYY-MM-DD  /preview  /status\n');
  }
});

triggerServer.listen(CONFIG.TRIGGER_PORT, '127.0.0.1', () => {
  log('info', `🔧 Trigger server on localhost:${CONFIG.TRIGGER_PORT}`);
});

// ─────────────────────────────────────────────
// CLI FLAGS
// ─────────────────────────────────────────────

// node app.js --trigger-now [--date=YYYY-MM-DD]
if (process.argv.includes('--trigger-now')) {
  const dateArg   = process.argv.find(a => a.startsWith('--date='));
  const dateParam = dateArg ? dateArg.split('=')[1] : null;
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    console.error('❌ Bad date. Use --date=YYYY-MM-DD');
    process.exit(1);
  }
  (async () => {
    log('info', `--trigger-now${dateParam ? ' for ' + dateParam : ' (today)'}`);
    try {
      const { text } = await getMessageForDate(dateParam);
      log('info', 'Message:', text);
      await sendWithRetry(text);
    } catch (err) {
      log('error', '--trigger-now failed:', err.message);
    }
  })();
}

// node app.js --preview-now
if (process.argv.includes('--preview-now')) {
  (async () => {
    log('info', '--preview-now: sending preview email');
    await sendPreviewToMom();
    log('info', 'Done');
    process.exit(0);
  })();
}

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────
(async () => {
  log('info', '🚀 Gospel bot starting (Green API edition)');
  log('info', `Timezone : ${TIMEZONE}`);
  log('info', `Preview  : 5:00 PM IST → mom's email`);
  log('info', `Send     : 12:30 AM IST → WhatsApp group`);
  log('info', `Watchdog : 1:00 AM IST`);
  log('info', `Group ID : ${CONFIG.GROUP_ID}`);

  // Check Green API connection on startup
  const status = await checkGreenApiStatus();
  log('info', `Green API status: ${status}`);
  if (status !== 'authorized') {
    log('warn', '⚠️ Green API not authorized — go to green-api.com dashboard and scan QR');
    await sendEmail({
      to:      CONFIG.ALERT_EMAIL,
      subject: '⚠️ Green API not authorized',
      body:    `Green API instance is not connected.\n\nGo to green-api.com → your instance → scan QR code to reconnect.`,
    });
  }
})();
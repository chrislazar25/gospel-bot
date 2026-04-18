/**
 * Gospel WhatsApp Sender
 *
 * Flow:
 *   Day before  @ 5:00 PM IST  → email tomorrow's message to mom (preview)
 *   Send day    @ 12:30 AM IST → send message to WhatsApp group
 *   Send day    @ 1:00 AM IST  → watchdog: check if sent, retry if not
 *
 * First time setup:
 *   npm install whatsapp-web.js node-cron nodemailer qrcode
 *   node app.js --list-groups     ← scan QR on dad's phone, find group ID
 *   node app.js --trigger-now     ← manually fire today's send (for testing)
 *   node app.js --preview-now     ← manually fire today's preview email
 *   node app.js                   ← normal run via pm2
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const QRCode     = require('qrcode');
const fs         = require('fs');
const path       = require('path');
const http       = require('http');

const { getTodaysMessage, parseApiRef, findMatches, pickBest } = require('./gospel_matcher');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  // WhatsApp group ID
  // Run: node app.js --list-groups   to find it
  // Looks like: 1234567890-1234567890@g.us
  GROUP_ID: process.env.GROUP_ID || 'YOUR_GROUP_ID@g.us',

  // Gmail SMTP — use an App Password (not your real password)
  // https://myaccount.google.com/apppasswords
  EMAIL_USER:    process.env.EMAIL_USER    || 'youremail@gmail.com',
  EMAIL_PASS:    process.env.EMAIL_PASS    || 'your-app-password',
  ALERT_EMAIL:   process.env.ALERT_EMAIL   || 'youremail@gmail.com',   // your email (alerts)
  PREVIEW_EMAIL: process.env.PREVIEW_EMAIL || 'moms-email@gmail.com',  // mom's email (preview)

  // Retry settings
  MAX_RETRIES:    3,
  RETRY_DELAY_MS: 5 * 60 * 1000,  // 5 mins between retries

  // Manual trigger HTTP port (for GCP testing)
  TRIGGER_PORT: parseInt(process.env.TRIGGER_PORT || '3000'),

  // Paths
  SENT_LOG:    path.join(__dirname, 'sent.log.json'),
  QUEUE_FILE:  path.join(__dirname, 'pending.json'),
  SESSION_DIR: path.join(__dirname, 'session'),
};

const TIMEZONE = 'Asia/Kolkata';
const DEFAULT_CLOSING = 'Jesus is Lord, spread the living word of God.';

// ─────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────
function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
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
// GET MESSAGE FOR A SPECIFIC DATE
// dateStr = 'YYYY-MM-DD', or null for today
// ─────────────────────────────────────────────
async function getMessageForDate(dateStr) {
  // Build date without timezone issues
  let date;
  if (dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    date = new Date(y, m - 1, d);   // local time, no UTC conversion
  } else {
    date = new Date();
  }

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
  const log = getSentLog();
  log.push({ ...entry, sentAt: new Date().toISOString() });
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  fs.writeFileSync(CONFIG.SENT_LOG, JSON.stringify(
    log.filter(e => new Date(e.sentAt) > cutoff), null, 2
  ));
}

function alreadySentToday() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD in IST
  return getSentLog().some(e => e.sentAt?.startsWith(today));
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
  log('info', 'Message queued for retry on reconnect');
}

function getPendingQueue() {
  try { return JSON.parse(fs.readFileSync(CONFIG.QUEUE_FILE, 'utf8')); }
  catch { return []; }
}

function clearQueue() {
  fs.writeFileSync(CONFIG.QUEUE_FILE, JSON.stringify([]));
}

// ─────────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: CONFIG.EMAIL_USER, pass: CONFIG.EMAIL_PASS },
});

async function sendEmail({ to, subject, body, attachments = [] }) {
  try {
    await mailer.sendMail({
      from:    CONFIG.EMAIL_USER,
      to,
      subject: `[Gospel Bot] ${subject}`,
      text:    body,
      attachments,
    });
    log('info', `Email sent to ${to}: ${subject}`);
  } catch (err) {
    log('error', 'Email failed:', err.message);
  }
}

async function alertQRCode(qrString) {
  const qrBuffer = await QRCode.toBuffer(qrString);
  await sendEmail({
    to:      CONFIG.ALERT_EMAIL,
    subject: '📷 WhatsApp needs re-linking — scan QR code',
    body:    'The gospel bot needs re-linking.\n\nOpen WhatsApp on dad\'s phone → Linked Devices → Link a Device → scan the attached QR image.',
    attachments: [{ filename: 'scan-me.png', content: qrBuffer }],
  });
}

// ─────────────────────────────────────────────
// PREVIEW EMAIL TO MOM
// Sends tomorrow's gospel message to mom at 5pm
// so she can manually forward if the bot fails
// ─────────────────────────────────────────────
async function sendPreviewToMom() {
  log('info', '📧 Preparing preview email for mom...');

  // Get tomorrow in IST — split string to avoid UTC offset bug
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  const [y, m, d] = todayStr.split("-").map(Number);
  const tomorrowStr = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);

  let messageText;
  try {
    const result = await getMessageForDate(tomorrowStr);
    messageText  = result.text;
  } catch (err) {
    log('error', 'Failed to get tomorrow\'s message:', err.message);
    await sendEmail({
      to:      CONFIG.ALERT_EMAIL,
      subject: '⚠️ Could not prepare preview email for mom',
      body:    `Error: ${err.message}`,
    });
    return;
  }

  const [ty, tm, td] = tomorrowStr.split('-').map(Number);
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
// WHATSAPP SEND
// ─────────────────────────────────────────────
let whatsappReady = false;

async function sendToGroup(text) {
  if (!whatsappReady) throw new Error('WhatsApp not ready');
  await client.sendMessage(CONFIG.GROUP_ID, text);
}

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
        body:    `Failed after ${CONFIG.MAX_RETRIES} attempts.\n\nThe message has been queued and will send on reconnect.\n\nMessage:\n${text}`,
      });
    }
  }
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
// WHATSAPP CLIENT
// ─────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: CONFIG.SESSION_DIR }),
  authTimeoutMs: 120000,
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
    ]
  },
});

// Handle unhandled rejections gracefully
process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection:', reason?.message || reason);
});

client.on('qr', async (qr) => {
  log('warn', 'QR code received — scan with dad\'s phone');
  await alertQRCode(qr);
});

client.on('ready', async () => {
  whatsappReady = true;
  log('info', 'WhatsApp client ready ✅');
  await flushQueue();
});

client.on('disconnected', async (reason) => {
  whatsappReady = false;
  log('warn', 'WhatsApp disconnected:', reason);
  await sendEmail({
    to:      CONFIG.ALERT_EMAIL,
    subject: '❌ WhatsApp disconnected',
    body:    `Reason: ${reason}\n\nBot will attempt to reconnect. If it doesn't within 10 mins, re-scan the QR code.`,
  });
});

client.on('auth_failure', async (msg) => {
  whatsappReady = false;
  log('error', 'Auth failure:', msg);
  await sendEmail({
    to:      CONFIG.ALERT_EMAIL,
    subject: '🔐 Auth failure',
    body:    `WhatsApp auth failed: ${msg}`,
  });
});

// ─────────────────────────────────────────────
// CRON JOBS  (all IST)
// ─────────────────────────────────────────────

// 5:00 PM — preview email to mom with tomorrow's message
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
      body:    `Both main send and watchdog failed.\n\nPlease ask mom to send the message manually — she received a preview email yesterday at 5 PM.\n\nError: ${err.message}`,
    });
  }
}, { timezone: TIMEZONE });

// ─────────────────────────────────────────────
// MANUAL TRIGGER HTTP SERVER
// On GCP: curl http://localhost:3000/trigger
//         curl http://localhost:3000/preview
//         curl http://localhost:3000/status
// ─────────────────────────────────────────────
const triggerServer = http.createServer(async (req, res) => {
  const url = req.url;

  // Manually fire today's WhatsApp send
  if (url === '/trigger') {
    log('info', '🔧 Manual trigger via HTTP');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Triggered. Check logs: pm2 logs gospel-bot\n');
    try {
      const { text } = await getMessageForDate(null);
      await sendWithRetry(text);
    } catch (err) {
      log('error', 'Manual trigger failed:', err.message);
    }

  // Manually fire preview email to mom
  } else if (url === '/preview') {
    log('info', '🔧 Manual preview via HTTP');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Preview email triggered. Check your inbox.\n');
    await sendPreviewToMom();

  // Status check
  } else if (url === '/status') {
    const sentToday = alreadySentToday();
    const queue     = getPendingQueue();
    const status    = {
      whatsappReady,
      sentToday,
      queueLength: queue.length,
      time: new Date().toLocaleString('en-IN', { timeZone: TIMEZONE }),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2) + '\n');

  } else {
    res.writeHead(404);
    res.end('Not found. Try /trigger  /preview  /status\n');
  }
});

triggerServer.listen(CONFIG.TRIGGER_PORT, '127.0.0.1', () => {
  log('info', `🔧 Trigger server listening on localhost:${CONFIG.TRIGGER_PORT}`);
  log('info', `   curl http://localhost:${CONFIG.TRIGGER_PORT}/trigger`);
  log('info', `   curl http://localhost:${CONFIG.TRIGGER_PORT}/preview`);
  log('info', `   curl http://localhost:${CONFIG.TRIGGER_PORT}/status`);
});

// ─────────────────────────────────────────────
// CLI FLAGS
// ─────────────────────────────────────────────

// node app.js --list-groups
// Scan QR on dad's phone, see all group names + IDs, copy the right one
if (process.argv.includes('--list-groups')) {
  client.on('ready', async () => {
    // Wait for chats to fully load on slow/low RAM machines
    log('info', 'Client ready — waiting 10s for chats to load...');
    await new Promise(r => setTimeout(r, 20000));
    const chats  = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    console.log('\n=== YOUR WHATSAPP GROUPS ===');
    groups.forEach(g => console.log(`  "${g.name}"  →  ${g.id._serialized}`));
    console.log('\nCopy the ID next to dad\'s gospel group into CONFIG.GROUP_ID\n');
    process.exit(0);
  });
}

// node app.js --trigger-now [--date=YYYY-MM-DD]
// Manually fire a send — optionally for a specific date
// e.g. node app.js --trigger-now --date=2026-04-17
if (process.argv.includes('--trigger-now')) {
  const dateArg = process.argv.find(a => a.startsWith('--date='));
  const dateParam = dateArg ? dateArg.split('=')[1] : null;
  if (dateParam && !/^d{4}-d{2}-d{2}$/.test(dateParam)) {
    console.error('❌ Bad date format. Use --date=YYYY-MM-DD');
    process.exit(1);
  }
  client.on('ready', async () => {
    log('info', `--trigger-now: firing send${dateParam ? ' for ' + dateParam : ' (today)'}`);
    try {
      const { text } = await getMessageForDate(dateParam);
      log('info', 'Message:', text);
      await sendWithRetry(text);
    } catch (err) {
      log('error', '--trigger-now failed:', err.message);
    }
  });
}

// node app.js --preview-now
// Manually fire the preview email to mom right now
if (process.argv.includes('--preview-now')) {
  client.on('ready', async () => {
    log('info', '--preview-now: sending preview email');
    await sendPreviewToMom();
    log('info', 'Done');
    process.exit(0);
  });
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
log('info', '🚀 Gospel bot starting...');
log('info', `Timezone : ${TIMEZONE}`);
log('info', `Preview  : 5:00 PM IST → mom's email`);
log('info', `Send     : 12:30 AM IST → WhatsApp group`);
log('info', `Watchdog : 1:00 AM IST`);
log('info', `Group ID : ${CONFIG.GROUP_ID}`);
client.initialize();
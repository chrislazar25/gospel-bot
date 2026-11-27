import { REPORT_LABEL, TABLE } from './states.js';

// Separators include the Unicode spaces and dashes phones and keyboards insert (NBSP, narrow NBSP, en dash, minus sign).
// Invisible format characters (\p{Cf}: bidi marks and isolates, BOM, soft hyphen) may sit anywhere between the digits.
const SEP = String.raw`[ \t\u00A0\u2000-\u200A\u202F\u205F\u3000\-\u2010-\u2015\u2212\uFE63\uFF0D.()\uFF08\uFF09]`;
const DIGIT = String.raw`[0-9\uFF10-\uFF19]`;
const PHONE_LIKE = new RegExp(String.raw`[+\uFF0B]?\p{Cf}*${DIGIT}(?:(?:\p{Cf}*${SEP}){0,2}\p{Cf}*${DIGIT}){7,}`, 'gu');
const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

export type Photo = { url: string } | { tooLarge: true };

export const scrub = (text: string) => text.replace(PHONE_LIKE, '[number removed]').replace(/@/g, '@\u200b');
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '');

export const messageMarker = (messageId: string) => `<!-- wa-message:${safeId(messageId)} -->`;
export const followupMarker = (messageId: string) => `<!-- wa-followup:${safeId(messageId)} -->`;
export const photoPath = (messageId: string, mimetype: string) => `reports/${safeId(messageId)}.${EXTENSIONS[mimetype] ?? 'jpg'}`;
export const photoMarkdown = (photo: Photo) => ('url' in photo ? `![photo](${photo.url})` : '(photo too large to attach)');

export function issueTitle(text: string): string {
  return 'WhatsApp report: ' + (scrub(text).replace(/\s+/g, ' ').trim().slice(0, 60).trimEnd() || 'photo');
}

export function issueBody(text: string, messageId: string, photo?: Photo): string {
  return [
    scrub(text).trim(), photo && photoMarkdown(photo), 'Reported in the Gospel Bot help WhatsApp group.', messageMarker(messageId),
  ].filter(Boolean).join('\n\n');
}

export const followupBody = (text: string, messageId: string, photo?: Photo) =>
  [scrub(text).trim(), photo && photoMarkdown(photo), followupMarker(messageId)].filter(Boolean).join('\n\n');

export const newIssue = (text: string, messageId: string, photo?: Photo) => ({
  title: issueTitle(text), body: issueBody(text, messageId, photo), labels: [REPORT_LABEL, TABLE.new.label!],
});

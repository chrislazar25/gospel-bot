import { REPORT_LABEL, TABLE } from './states.js';

const PHONE_LIKE = /\+?\d(?:[ \-.()]{0,2}\d){7,}/g;
const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

export type Photo = { url: string } | { tooLarge: true };

export const scrub = (text: string) => text.replace(PHONE_LIKE, '[number removed]').replace(/@/g, '@\u200b');
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '');

export const photoPath = (messageId: string, mimetype: string) => `reports/${safeId(messageId)}.${EXTENSIONS[mimetype] ?? 'jpg'}`;
export const photoMarkdown = (photo: Photo) => ('url' in photo ? `![photo](${photo.url})` : '(photo too large to attach)');

export function issueTitle(text: string): string {
  return 'WhatsApp report: ' + (scrub(text).replace(/\s+/g, ' ').trim().slice(0, 60).trimEnd() || 'photo');
}

export function issueBody(text: string, messageId: string, photo?: Photo): string {
  return [
    scrub(text).trim(), photo && photoMarkdown(photo), 'Reported in the Gospel Bot help WhatsApp group.', `<!-- wa-message:${safeId(messageId)} -->`,
  ].filter(Boolean).join('\n\n');
}

export const newIssue = (text: string, messageId: string, photo?: Photo) => ({
  title: issueTitle(text), body: issueBody(text, messageId, photo), labels: [REPORT_LABEL, TABLE.new.label!],
});

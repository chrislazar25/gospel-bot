import { REPORT_LABEL, TABLE } from './states.js';

const PHONE_LIKE = /\+?\d(?:[ \-.()]{0,2}\d){7,}/g;

export const scrub = (text: string) => text.replace(PHONE_LIKE, '[number removed]');

export function issueTitle(text: string): string {
  return 'WhatsApp report: ' + scrub(text).replace(/\s+/g, ' ').trim().slice(0, 60).trimEnd();
}

export function issueBody(text: string, messageId: string): string {
  return `${scrub(text).trim()}\n\nReported in the Gospel Bot help WhatsApp group.\n\n<!-- wa-message:${messageId.replace(/[^A-Za-z0-9_]/g, '')} -->`;
}

export const newIssue = (text: string, messageId: string) => ({
  title: issueTitle(text), body: issueBody(text, messageId), labels: [REPORT_LABEL, TABLE.new.label!],
});

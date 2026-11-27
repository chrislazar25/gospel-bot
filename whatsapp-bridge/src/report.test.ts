import assert from 'node:assert/strict';
import test from 'node:test';
import { issueBody, followupBody, issueTitle, newIssue, photoPath } from './report.js';

test('phone-like numbers are removed from the body', () => {
  const body = issueBody('Call me on +1 555-123-4567 or 0771234567, also 12345678 and (555) 123-4567', 'ABC123');
  assert.ok(!/\d{4}/.test(body.split('<!--')[0]!), body);
  assert.equal(body.split('[number removed]').length - 1, 4);
});

const unicodeNumbers = [
  '+44\u00A07700\u00A0900123', '+33\u202F6\u202F12\u202F34\u202F56\u202F78', '+1\u2013555\u2013123\u20134567',
  '+49\u2009151\u20091234\u20095678', '+1\u2011555\u2011123\u20114567', '\u2212555\u2007123\u20074567', '\uFF0B\uFF14\uFF14\u00A0\uFF17\uFF17\uFF10\uFF10\uFF19\uFF10\uFF10\uFF11\uFF12\uFF13',
];

test('numbers formatted with Unicode spaces and dashes are removed from the title, body and follow-up', () => {
  for (const n of unicodeNumbers) {
    const digits = (s: string) => s.replace(/[^0-9\uFF10-\uFF19]/gu, '');
    for (const out of [issueTitle(`call ${n} now`), issueBody(`call ${n} now`, 'M1').split('<!--')[0]!, followupBody(`call ${n} now`)]) {
      assert.ok(out.includes('[number removed]'), JSON.stringify(out));
      assert.equal(digits(out.split('<!--')[0]!), '', JSON.stringify(out));
    }
  }
});

const markedNumbers = [
  '‎+44‎ 7700‎ 900123', '+1‏555‏123‏4567', '‪+33 6 12 34 56 78‬', '‫+1‮555‭1234567',
  '⁦+49⁩ ⁦151⁩ ⁦1234⁩ ⁦5678⁩', '⁧555⁨123⁩4567', '+1﻿555﻿123﻿4567',
  '555­123­4567', '+44 ‎7700 ‎900‎ 123', '5‎5‏5‎1‏2‎3‏4‎5‏6‎7',
];

test('numbers with bidi marks, isolates, BOM or soft hyphens between the digits are removed from the title, body and follow-up', () => {
  for (const n of markedNumbers) {
    for (const out of [issueTitle(`call ${n} now`), issueBody(`call ${n} now`, 'M1').split('<!--')[0]!, followupBody(`call ${n} now`).split('<!--')[0]!]) {
      assert.ok(out.includes('[number removed]'), JSON.stringify(out));
      assert.equal(out.replace(/\D/g, ''), '', JSON.stringify(out));
    }
  }
});

test('short numbers and verse references survive', () => {
  assert.match(issueBody('The reading for 2026-12 shows John 3:16 and 1234567 items', 'M1'), /John 3:16 and 1234567 items/);
});

test('the body carries the footer and a marker with only the message id', () => {
  const body = issueBody('The verse is wrong', '3EB0AB12');
  assert.match(body, /^The verse is wrong\n\nReported in the Gospel Bot help WhatsApp group\.\n\n<!-- wa-message:3EB0AB12 -->$/);
  assert.ok(!body.includes('@'));
});

test('the marker cannot be broken out of by an odd message id', () => {
  assert.match(issueBody('x', 'A-->B<'), /<!-- wa-message:AB -->$/);
});

test('the title is one line, 60 characters of text, and number free', () => {
  assert.equal(issueTitle('Short\nreport'), 'WhatsApp report: Short report');
  assert.equal(issueTitle('a'.repeat(100)), 'WhatsApp report: ' + 'a'.repeat(60));
  assert.equal(issueTitle('call 555 123 4567 now'), 'WhatsApp report: call [number removed] now');
});

test('@mentions in the report cannot notify GitHub users', () => {
  const body = issueBody('ask @chrislazar25 and @octocat', 'M1');
  assert.ok(!/@[A-Za-z]/.test(body), body);
  assert.match(body, /ask @\u200bchrislazar25/);
});

test('a new issue is labelled report and new', () => {
  assert.deepEqual(newIssue('hi', 'M1').labels, ['benny:report', 'benny:new']);
});

test('a photo is embedded above the footer, or noted as too large', () => {
  assert.match(issueBody('see this', 'M1', { url: 'https://x/y.jpg' }), /^see this\n\n!\[photo\]\(https:\/\/x\/y\.jpg\)\n\nReported in/);
  assert.match(issueBody('', 'M1', { tooLarge: true }), /^\(photo too large to attach\)\n\nReported in/);
  assert.equal(newIssue('', 'M1', { url: 'u' }).title, 'WhatsApp report: photo');
});

test('a caption is scrubbed even with a photo', () => {
  const { body } = newIssue('call 555 123 4567 @octocat', 'M1', { url: 'u' });
  assert.ok(!body.includes('555') && !/@[A-Za-z]/.test(body), body);
});

test('the photo path is built from a sanitized message id and a known extension', () => {
  assert.equal(photoPath('3EB0/../AB', 'image/png'), 'reports/3EB0AB.png');
  assert.equal(photoPath('M1', 'image/jpeg'), 'reports/M1.jpg');
  assert.equal(photoPath('M1', 'application/x-evil'), 'reports/M1.jpg');
});

test('a follow-up comment is scrubbed and ends with the marker', () => {
  assert.equal(followupBody('hi @octocat', { url: 'https://x/y.jpg' }), 'hi @\u200boctocat\n\n![photo](https://x/y.jpg)\n\n<!-- wa-followup -->');
  assert.equal(followupBody('plain'), 'plain\n\n<!-- wa-followup -->');
});

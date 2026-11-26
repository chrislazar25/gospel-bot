import assert from 'node:assert/strict';
import test from 'node:test';
import { issueBody, issueTitle, newIssue } from './report.js';

test('phone-like numbers are removed from the body', () => {
  const body = issueBody('Call me on +1 555-123-4567 or 0771234567, also 12345678 and (555) 123-4567', 'ABC123');
  assert.ok(!/\d{4}/.test(body.split('<!--')[0]!), body);
  assert.equal(body.split('[number removed]').length - 1, 4);
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

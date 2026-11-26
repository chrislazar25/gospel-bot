import assert from 'node:assert/strict';
import test from 'node:test';
import { stateOf, STATES, TABLE } from './states.js';

const open = (...labels: string[]) => ({ state: 'open' as const, stateReason: null, labels });

test('an issue with no status label is new', () => {
  assert.equal(stateOf(open()), 'new');
  assert.equal(stateOf(open('benny:report', 'bug')), 'new');
});

test('each status label maps to its state', () => {
  for (const s of STATES) if (TABLE[s].label) assert.equal(stateOf(open('benny:report', TABLE[s].label)), s);
});

test('the label furthest along the lifecycle wins', () => {
  assert.equal(stateOf(open('benny:new', 'benny:triage')), 'triage');
  assert.equal(stateOf(open('benny:triage', 'benny:bug')), 'bug');
  assert.equal(stateOf(open('benny:bug', 'benny:fixing')), 'fixing');
  assert.equal(stateOf(open('benny:fixing', 'benny:blocked')), 'blocked');
  assert.equal(stateOf(open('benny:pr', 'benny:fixing', 'benny:bug')), 'pr');
  assert.equal(stateOf(open('benny:no-repro', 'benny:triage')), 'no-repro');
});

test('closed as completed is merged whatever the labels say', () => {
  assert.equal(stateOf({ state: 'closed', stateReason: 'completed', labels: ['benny:fixing'] }), 'merged');
  assert.equal(stateOf({ state: 'closed', stateReason: 'completed', labels: [] }), 'merged');
});

test('closed for another reason follows the labels', () => {
  assert.equal(stateOf({ state: 'closed', stateReason: 'not_planned', labels: ['benny:other'] }), 'other');
  assert.equal(stateOf({ state: 'closed', stateReason: null, labels: [] }), 'new');
});

test('an open issue is never merged', () => {
  assert.notEqual(stateOf({ state: 'open', stateReason: 'completed', labels: [] }), 'merged');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHookScore, computeQualityScore, computeVisualScore } from './scoring.js';

const question = (a, b, aq = 'red sports car', bq = 'private jet runway') => ({
  category: 'luxury',
  optionA: { text: a, searchQuery: aq },
  optionB: { text: b, searchQuery: bq },
});

test('a boring/blocked pair scores zero on quality and hook', () => {
  const q = question('Coffee', 'Tea');
  assert.equal(computeQualityScore(q), 0);
  assert.equal(computeHookScore(q), 0);
});

test('a concise, visually concrete pair scores near the top of the range', () => {
  const q = question('Drive a sports car', 'Fly in a private jet');
  assert.equal(computeQualityScore(q), 100);
  assert.equal(computeVisualScore(q), 100);
  assert.ok(computeHookScore(q) > 70, `expected a strong hook score, got ${computeHookScore(q)}`);
});

test('a longer-but-valid option (41-55 chars) scores lower on quality than a comfortably concise one', () => {
  const concise = question('Own a mountain cabin', 'Live in a beach villa');
  const longerValid = question('Own a stunning luxurious mountain cabin retreat', 'Live in a stunning luxurious tropical beach villa');
  assert.ok(computeQualityScore(longerValid) < computeQualityScore(concise), 'longer-but-valid option should score lower than concise');
});

test('a vague, non-concrete searchQuery scores lower on visual score', () => {
  const concrete = question('Own a mountain cabin', 'Live in a beach villa', 'snow mountain cabin', 'tropical beach villa');
  const vague = question('Own a mountain cabin', 'Live in a beach villa', 'happiness', 'freedom concept idea abstract feeling');
  assert.ok(computeVisualScore(vague) < computeVisualScore(concrete), 'vague query should score lower than concrete query');
});

test('hook score rewards short option text over a longer, still-valid option', () => {
  const short = question('See northern lights', 'Watch a volcano erupt');
  const longer = question('See the northern lights over the mountains tonight', 'Watch a volcano erupt in the distance');
  assert.ok(computeHookScore(short) >= computeHookScore(longer), 'short/concise option should not score below a longer one');
});

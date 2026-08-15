import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateNarrationSecondsFromText, estimateSceneDurationFromText, DEFAULT_DURATION_BUDGET_TOTAL_SECONDS } from './duration-estimate.js';

test('estimateNarrationSecondsFromText grows with word count', () => {
  const short = estimateNarrationSecondsFromText('Own a yacht', 'Own a jet');
  const long = estimateNarrationSecondsFromText('Own a small private island somewhere remote', 'Own a tall city penthouse downtown');
  assert.ok(long > short, `expected longer option text to estimate more narration seconds (short=${short}, long=${long})`);
});

test('estimateNarrationSecondsFromText matches audio.js buildNarration wording (strips "would you rather", trailing punctuation, capitalizes/lowercases correctly)', () => {
  // "Would you rather" contributes zero narration words -- estimateNarrationSecondsFromText must
  // agree with buildNarration on this, or the estimate would systematically over-count.
  const withPrefix = estimateNarrationSecondsFromText('Would you rather own a yacht?', 'Own a jet');
  const withoutPrefix = estimateNarrationSecondsFromText('Own a yacht', 'Own a jet');
  assert.equal(withPrefix, withoutPrefix);
});

test('estimateSceneDurationFromText never returns less than baseDuration (the scene floor)', () => {
  const duration = estimateSceneDurationFromText('Fly', 'Swim', { baseDuration: 7 });
  assert.ok(duration >= 7, `expected at least the 7s floor, got ${duration}`);
});

test('estimateSceneDurationFromText grows once narration exceeds the floor', () => {
  const short = estimateSceneDurationFromText('Fly', 'Swim', { baseDuration: 7 });
  const long = estimateSceneDurationFromText('Own a small private island somewhere remote and quiet', 'Own a tall city penthouse downtown and busy', { baseDuration: 7 });
  assert.ok(long > short, `expected a much longer option pair to produce a longer scene duration (short=${short}, long=${long})`);
});

test('estimateSceneDurationFromText is quantized to whole video frames (30fps)', () => {
  const duration = estimateSceneDurationFromText('Own a small private island somewhere remote and quiet', 'Own a tall city penthouse downtown and busy', { baseDuration: 7 });
  const frames = duration * 30;
  assert.ok(Math.abs(frames - Math.round(frames)) < 1e-9, `expected a whole number of frames at 30fps, got ${frames} frames (${duration}s)`);
});

test('DEFAULT_DURATION_BUDGET_TOTAL_SECONDS mirrors the real pipeline pre-render safety ceiling (60s Shorts limit minus a 0.5s margin)', () => {
  assert.equal(DEFAULT_DURATION_BUDGET_TOTAL_SECONDS, 59.5);
});

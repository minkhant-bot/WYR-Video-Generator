import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from './config.js';

test('legacy WYR_QUESTION_COUNT cannot reduce the exact ten-question production contract', () => {
  const previous = process.env.WYR_QUESTION_COUNT;
  process.env.WYR_QUESTION_COUNT = '6';
  try {
    assert.equal(getConfig().questionCount, 10);
  } finally {
    if (previous === undefined) delete process.env.WYR_QUESTION_COUNT;
    else process.env.WYR_QUESTION_COUNT = previous;
  }
});

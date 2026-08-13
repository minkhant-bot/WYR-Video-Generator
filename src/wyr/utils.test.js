import test from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from './utils.js';

test('bounded concurrency never exceeds its limit and preserves result order', async () => {
  let active = 0; let maximumActive = 0;
  const results = await mapWithConcurrency([30, 5, 20, 1, 10, 2], 3, async (delay, index) => {
    active += 1; maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, delay)); active -= 1;
    return index;
  });
  assert.equal(maximumActive, 3);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
});

test('bounded concurrency rejects zero, negative, and non-integer limits', async () => {
  for (const concurrency of [0, -1, 1.5]) await assert.rejects(() => mapWithConcurrency([1], concurrency, async value => value), /positive integer/);
});

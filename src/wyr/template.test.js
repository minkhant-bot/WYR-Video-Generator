import test from 'node:test';
import assert from 'node:assert/strict';
import { fitOptionText, WYR_TEMPLATE } from './template.js';

const measureText = async (text, fontSize) => Array.from(text).reduce((width, character) => width + (character === ' ' ? 0.32 : 0.56) * fontSize, 0);

test('font fitting keeps preferred size for very short text', async () => {
  const fit = await fitOptionText({ text: 'Fly', measureText });
  assert.equal(fit.fontSize, WYR_TEMPLATE.typography.preferredOptionSize);
  assert.deepEqual(fit.lines, ['Fly']);
});

test('font fitting wraps medium text without reducing the preferred size', async () => {
  const fit = await fitOptionText({ text: 'Explore a mountain cabin beneath northern lights', measureText });
  assert.equal(fit.fontSize, WYR_TEMPLATE.typography.preferredOptionSize);
  assert.equal(fit.lines.length, 2);
});

test('font fitting reduces size for a long two-line option', async () => {
  const fit = await fitOptionText({ text: 'Own a rooftop garden overlooking the sparkling city skyline tonight', measureText });
  assert.ok(fit.fontSize < WYR_TEMPLATE.typography.preferredOptionSize);
  assert.ok(fit.fontSize >= WYR_TEMPLATE.typography.minimumOptionSize);
  assert.equal(fit.lines.length, 2);
});

test('font fitting rejects intentionally difficult copy only after reaching minimum size', async () => {
  await assert.rejects(() => fitOptionText({ text: 'extraordinary '.repeat(30), measureText }), /minimum readable font size of 42px/);
});

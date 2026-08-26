import test from 'node:test';
import assert from 'node:assert/strict';
import { fitOptionText, WYR_TEMPLATE } from './template.js';

const measureText = async (text, fontSize) => Array.from(text).reduce((width, character) => width + (character === ' ' ? 0.32 : 0.56) * fontSize, 0);

test('production timing uses the reference first-scene slide and bounded post-narration gap', () => {
  assert.equal(WYR_TEMPLATE.timing.initialEntranceDuration, 0.4);
  assert.equal(WYR_TEMPLATE.timing.transitionSlideDuration, 0.2);
  assert.equal(WYR_TEMPLATE.timing.countdownPauseAfterVoice, 0.1);
  assert.equal(WYR_TEMPLATE.timing.maximumNarrationCountdownGap, 0.2);
});

test('the scene background is a red/blue split panel with a white divider and accent color', () => {
  assert.equal(WYR_TEMPLATE.layout.panelTopColor, '0x7C0D05');
  assert.equal(WYR_TEMPLATE.layout.panelBottomColor, '0x032859');
  assert.equal(WYR_TEMPLATE.layout.dividerColor, '0xFFFFFF');
  assert.equal(WYR_TEMPLATE.layout.dividerHeight, 6);
  assert.equal(WYR_TEMPLATE.layout.accentColor, '0xFCC701');
});

test('food panels form a vertically centered stack with balanced outer margins', () => {
  const { layout, canvas } = WYR_TEMPLATE;
  assert.deepEqual([layout.imageWidth, layout.imageHeight], [960, 600]);
  assert.equal(layout.topImageY, 100);
  assert.equal(layout.bottomImageY + layout.imageHeight, canvas.height - layout.topImageY);
  assert.equal(layout.textHeight, 160);
  assert.equal(layout.topTextY, layout.topPercentageY);
  assert.equal(layout.bottomTextY, layout.bottomPercentageY);
  assert.equal(layout.topImageY + layout.imageHeight + 8, layout.topTextY);
  assert.equal(layout.bottomTextY + layout.textHeight + 8, layout.bottomImageY);
});

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

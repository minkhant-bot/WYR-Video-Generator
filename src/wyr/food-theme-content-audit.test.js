import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFoodEntityLabel } from './food-content.js';
import { assessQuestionQuality } from './content-engine.js';
import { FOOD_THEME_SEEDS, auditFoodThemeContent, auditFoodThemeVisualVariety, normalizeFoodOption, validateFoodThemeCollection } from './food-themes.js';

const TARGET_REUSE_LIMITS = Object.freeze({
  'Potato Chips': 2,
  Brownies: 1,
  'Carrot Cake': 1,
  'Garlic Bread': 1,
  Lemonade: 2,
  Yogurt: 0,
  Cheeseburgers: 2,
  'Hot Dogs': 2,
  'Fried Chicken': 2,
  'Mac and Cheese': 2,
  'Mashed Potatoes': 2,
});

const overlapFor = (report, leftTheme, rightTheme) => report.crossThemeOptionOverlap.find(item =>
  new Set([item.leftTheme, item.rightTheme]).has(leftTheme) && new Set([item.leftTheme, item.rightTheme]).has(rightTheme),
) || { count: 0, sharedOptions: [] };

test('complete static FOOD set has 33 themes, 298 distinct normalized pairs, and no near duplicates', () => {
  const validation = validateFoodThemeCollection();
  assert.equal(validation.valid, true, validation.reasons.join('; '));
  assert.deepEqual({
    themes: validation.report.themeCount,
    pairs: validation.report.totalPairs,
    uniquePairs: validation.report.uniqueNormalizedPairs,
    exact: validation.report.exactDuplicates.length,
    reversed: validation.report.reversedDuplicates.length,
    near: validation.report.nearDuplicatePairs.length,
    visualVariety: validation.report.visualVariety.totals,
    maximumCompleteVideos: validation.report.maximumCompleteVideos,
  }, { themes: 33, pairs: 298, uniquePairs: 298, exact: 0, reversed: 0, near: 0, visualVariety: { PASS: 33, BORDERLINE: 0, FAIL: 0 }, maximumCompleteVideos: 33 });
});

test('visual-variety audit flags repeated food forms without penalizing a cohesive varied meal', () => {
  const makeQuestion = (optionA, optionB) => ({ optionA: { text: optionA }, optionB: { text: optionB } });
  const makeTheme = (title, pairs) => ({ themeKey: title.toLowerCase(), title, questions: pairs.map(pair => makeQuestion(...pair)) });
  const report = auditFoodThemeVisualVariety([
    makeTheme('Same-looking pizza sequence', [
      ['Pepperoni Pizza', 'Cheese Pizza'], ['Mushroom Pizza', 'Sausage Pizza'], ['Pesto Pizza', 'White Pizza'],
      ['Chicken Pizza', 'Meatball Pizza'], ['Garlic Pizza', 'Olive Pizza'], ['Thin Pizza', 'Deep Pizza'], ['Veggie Pizza', 'Bacon Pizza'],
    ]),
    makeTheme('Cup-heavy cafe sequence', [
      ['Coffee', 'Tea'], ['Lemonade', 'Cola'], ['Smoothie', 'Milkshake'], ['Bagel', 'Muffin'],
      ['Sandwich', 'Wrap'], ['Brownies', 'Cookies'], ['Fruit Salad', 'Granola'],
    ]),
    makeTheme('Varied taco-night meal', [
      ['Beef Tacos', 'Chicken Tacos'], ['Cheese Quesadillas', 'Bean Tostadas'], ['Loaded Nachos', 'Curly Fries'],
      ['Guacamole', 'Tomato Salsa'], ['Tamales', 'Pork Burrito'], ['Cinnamon Churros', 'Caramel Pudding'], ['Lime Soda', 'Fruit Smoothie'],
    ]),
  ]);
  assert.equal(report.themes[0].classification, 'FAIL');
  assert.match(report.themes[0].reasons.join('; '), /pizza appears in 14/);
  assert.equal(report.themes[1].classification, 'BORDERLINE');
  assert.equal(report.themes[2].classification, 'PASS');
});

test('static FOOD options remain concise recognized foods and targeted repetition stays reduced', () => {
  const report = auditFoodThemeContent();
  const frequency = new Map(report.optionFrequency.map(item => [item.option, item.count]));
  for (const theme of FOOD_THEME_SEEDS) for (const question of theme.questions) for (const side of ['optionA', 'optionB']) {
    const label = question[side].text;
    assert.ok(label.trim().split(/\s+/).length <= 3, `${theme.title}: ${label} must remain a 1-3 word noun phrase`);
    assert.equal(assessFoodEntityLabel(label).valid, true, `${theme.title}: ${label} must pass the strict FOOD gate`);
  }
  for (const theme of FOOD_THEME_SEEDS) for (const question of theme.questions) {
    const quality = assessQuestionQuality(question);
    assert.equal(quality.accepted, true, `${theme.title}: ${question.optionA.text} / ${question.optionB.text}: ${quality.reasons.join(', ')}`);
  }
  for (const [label, maximum] of Object.entries(TARGET_REUSE_LIMITS)) {
    assert.ok((frequency.get(normalizeFoodOption(label)) || 0) <= maximum, `${label} exceeds its normalized reuse limit of ${maximum}`);
  }
  assert.ok(report.optionFrequency[0].count <= 3, `highest normalized option reuse is ${report.optionFrequency[0].count}`);
});

test('named high-overlap FOOD theme pairs share no more than two normalized options', () => {
  const report = auditFoodThemeContent();
  const targets = [
    ['Pack Your Picnic Basket', 'Pack Your Lunchbox'],
    ['Choose Your Comfort Food', 'Build Your Backyard Barbecue'],
    ['Fill Your Bakery Box', 'Choose Your Coffee Shop Order'],
    ['Pick Your Movie Snacks', 'Fill Your Snack Board'],
    ['Pick Your Movie Snacks', 'Build Your Game Day Spread'],
  ];
  for (const [left, right] of targets) {
    const overlap = overlapFor(report, left, right);
    assert.ok(overlap.count <= 2, `${left} / ${right} still share ${overlap.sharedOptions.join(', ')}`);
  }
});

test('audit normalization detects singular/plural, punctuation, reversed, and near-duplicate pairs', () => {
  assert.equal(normalizeFoodOption('  POTATO-chips! '), normalizeFoodOption('Potato Chip'));
  const makeTheme = (title, optionA, optionB) => ({ themeKey: title.toLowerCase(), title, questions: [{ optionA: { text: optionA }, optionB: { text: optionB } }] });
  const duplicates = auditFoodThemeContent([
    makeTheme('First', 'Lobster Roll', 'Shrimp Rolls'),
    makeTheme('Second', 'Shrimp Roll', 'Lobster Rolls'),
  ]);
  assert.equal(duplicates.reversedDuplicates.length, 1);
  const near = auditFoodThemeContent([
    makeTheme('First', 'Chicken Wings', 'Chicken Tenders'),
    makeTheme('Second', 'Buffalo Wings', 'Chicken Tenders'),
  ]);
  assert.equal(near.nearDuplicatePairs.length, 1);
  assert.equal(near.nearDuplicatePairs[0].similarity, 0.75);
});

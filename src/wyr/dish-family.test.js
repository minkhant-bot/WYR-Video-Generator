// Focused tests for same-base-food filtering only (see pool-selection.js's dishFamilyOf/
// selectDiversePlan, question-pool.js's selectAndReservePlan hard same-family-pair filter).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dishFamilyOf, selectDiversePlan } from './pool-selection.js';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { selectAndReservePlan } from './question-pool.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); } finally { __resetPoolForTests(); }
};

let nextId = 1;
const themeId = 1;
const foodRow = (a, b, position, hookScore = 60) => ({
  id: nextId++, category: 'food', content_family: 'food_and_social',
  option_a_text: a, option_b_text: b, option_a_search_query: a, option_b_search_query: b,
  option_a_visual_subject: a, option_b_visual_subject: b,
  hook_score: hookScore, quality_score: 90, visual_score: 90,
  is_fantasy: false, motif_key_a: `motif-${a}`, motif_key_b: `motif-${b}`,
  last_used_at: null, used_count: 0, theme_id: themeId, theme_position: nextId,
  status: 'ready',
});

test('clam chowder and chicken soup are counted in the same dish family', () => {
  assert.equal(dishFamilyOf('Clam Chowder'), dishFamilyOf('Chicken Soup'));
  assert.equal(dishFamilyOf('Clam Chowder'), 'soup');
  assert.equal(dishFamilyOf('Chicken Soup'), 'soup');
  assert.equal(dishFamilyOf('Roasted Tomato Soup'), 'soup');
  assert.equal(dishFamilyOf('Beef Stew'), 'soup');
});

test('caesar salad vs greek salad is rejected as a pair (same dish family) before selection', () => withFakeDb(async fake => {
  fake.state.themes.set(themeId, { id: themeId, theme_key: 'test-theme', title: 'Test Theme', hook_tts_text: 'Test.' });
  const table = fake.state.questions;
  // The bad pair: both options are "salad" family -- must never be reservable.
  const badPair = foodRow('Caesar Salad', 'Greek Salad', 1);
  table.set(badPair.id, badPair);
  // Enough distinct-family valid rows to fill a 10-question plan without ever touching badPair.
  const validPairs = [
    ['Pizza', 'Burger'], ['Tacos', 'Sushi'], ['Donuts', 'Brownies'], ['Pancakes', 'Waffles'],
    ['Fried Chicken', 'Pork Ribs'], ['Cheesecake', 'Tiramisu'], ['Nachos', 'Popcorn'],
    ['Ice Cream', 'Gelato'], ['Bagel', 'Croissant'], ['Sushi Roll', 'Dumplings'],
  ];
  for (const [a, b] of validPairs) { const row = foodRow(a, b, table.size + 1); table.set(row.id, row); }

  const reservation = await selectAndReservePlan({ jobId: 'job-family', count: 10, targetTotalSeconds: 999 });
  assert.ok(reservation, 'a full 10-question plan must still be reachable once the bad pair is excluded');
  assert.equal(reservation.selected.length, 10);
  assert.ok(!reservation.selected.some(row => row.id === badPair.id), 'Caesar Salad vs Greek Salad must never be reserved');
  assert.ok(reservation.sameDishFamilyRejectedCount >= 1, 'the same-family pair must be counted as rejected');
}));

test('a 10-question plan cannot contain more than 2 soup-family questions unless the relax ladder was triggered', () => {
  // Case A: abundant non-soup alternatives -- the cap must hold at 2.
  const soupRows = [
    foodRow('Chicken Soup', 'Pizza', 1), foodRow('Clam Chowder', 'Burger', 2),
    foodRow('Beef Stew', 'Tacos', 3), foodRow('Roasted Tomato Soup', 'Sushi', 4),
    foodRow('Noodle Soup', 'Donuts', 5),
  ];
  const nonSoupRows = [
    foodRow('Pancakes', 'Waffles', 6), foodRow('Fried Chicken', 'Pork Ribs', 7),
    foodRow('Cheesecake', 'Tiramisu', 8), foodRow('Nachos', 'Popcorn', 9),
    foodRow('Bagel', 'Croissant', 10), foodRow('Ice Cream', 'Gelato', 11),
    foodRow('Brownies', 'Cookies', 12), foodRow('Custard', 'Parfait', 13),
  ];
  const abundant = selectDiversePlan([...soupRows, ...nonSoupRows], { count: 10 });
  assert.ok(abundant);
  assert.equal(abundant.selected.length, 10);
  const soupInvolvedAbundant = abundant.selected.filter(row => dishFamilyOf(row.option_a_text) === 'soup' || dishFamilyOf(row.option_b_text) === 'soup');
  assert.ok(soupInvolvedAbundant.length <= 2, `expected at most 2 soup-family questions, got ${soupInvolvedAbundant.length}`);

  // Case B: the pool is thin enough that reaching count=10 requires relaxing the cap -- the ladder
  // must still fill the plan (never fail purely because one family is overrepresented), and the
  // soup count above 2 in the result proves relaxation actually engaged rather than the function
  // silently returning fewer than 10.
  const thinNonSoup = nonSoupRows.slice(0, 3);
  const thin = selectDiversePlan([...soupRows, ...thinNonSoup], { count: 8 });
  assert.ok(thin, 'the relax ladder must still fill the plan when the pool is thin');
  assert.equal(thin.selected.length, 8);
  const soupInvolvedThin = thin.selected.filter(row => dishFamilyOf(row.option_a_text) === 'soup' || dishFamilyOf(row.option_b_text) === 'soup');
  assert.ok(soupInvolvedThin.length > 2, `expected the relax ladder to exceed the cap of 2 when forced, got ${soupInvolvedThin.length}`);
});

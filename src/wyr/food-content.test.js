import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFoodEntityLabel, assertStrictFoodPlan, InvalidFoodContentError } from './food-content.js';

const VALID = [
  'Cheeseburger', 'Fried Chicken', 'Pizza', 'Sushi', 'Pancakes', 'Waffles',
  'Cheesecake', 'Tiramisu', 'Onion Rings', 'Mozzarella Sticks', 'French Toast',
  'Cinnamon Roll', 'Chicken Wings', 'Nachos', 'Ice Cream', 'Brownies',
];

const INVALID = [
  'Only eat pizza for a year', 'Only eat sushi for a year', 'Eat pizza forever',
  'Unlimited street food', 'Master one cuisine perfectly', 'Personal barista',
  'Personal baker', 'Celebrity chef', 'Food truck', 'Fine dining experience',
  'Own a restaurant', 'Cooking skills', 'Free meals forever', 'Street food',
  'Try Pizza', 'Order Sushi', "Baker's Donuts", 'All You Can Eat Sushi',
];

test('strict FOOD entity gate accepts recognizable photographable food noun phrases', () => {
  for (const label of VALID) assert.equal(assessFoodEntityLabel(label).valid, true, label);
});

test('strict FOOD entity gate rejects scenario, action, person, profession, place and abstract labels', () => {
  for (const label of INVALID) assert.equal(assessFoodEntityLabel(label).valid, false, label);
});

test('render-time FOOD assertion requires both A and B to independently pass', () => {
  const plan = {
    questions: [{ category: 'food', optionA: { text: 'Pizza' }, optionB: { text: 'Personal baker' } }],
  };
  assert.throws(() => assertStrictFoodPlan(plan), error => error instanceof InvalidFoodContentError && error.code === 'INVALID_FOOD_CONTENT');
});

test('render-time FOOD assertion accepts a complete literal-food plan', () => {
  const plan = {
    questions: [
      { category: 'food', optionA: { text: 'Pizza' }, optionB: { text: 'Sushi' } },
      { category: 'food', optionA: { text: 'Pancakes' }, optionB: { text: 'Waffles' } },
    ],
  };
  assert.equal(assertStrictFoodPlan(plan), plan);
});

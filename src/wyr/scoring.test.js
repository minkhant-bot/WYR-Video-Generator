import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDilemmaStrengthScore, computeHookScore, computeQualityScore, computeVisualScore, deriveToneBucket } from './scoring.js';

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

test('a fantasy/superpower question scores lower than an equivalent relatable one, but is never fully zeroed out', () => {
  const relatable = { category: 'money', optionA: { text: 'Own a yacht', searchQuery: 'luxury yacht ocean' }, optionB: { text: 'Own a jet', searchQuery: 'private jet runway' } };
  const fantasy = { category: 'superpowers', optionA: { text: 'Fly through the sky', searchQuery: 'person flying sky superhero' }, optionB: { text: 'Turn invisible', searchQuery: 'invisible person disappearing' } };
  assert.ok(computeHookScore(fantasy) < computeHookScore(relatable), 'fantasy-coded content should score below an equivalent realistic/relatable dilemma');
  assert.ok(computeHookScore(fantasy) > 0, 'the fantasy penalty must never zero out an otherwise-valid question');
});

test('sharply contrasting options score higher on hook than accepted-but-fairly-similar ones', () => {
  const sharp = question('Own a yacht', 'Own a jet');
  const similar = question('Eat spicy tacos for every meal', 'Eat mild tacos for every meal');
  assert.ok(computeHookScore(sharp) > computeHookScore(similar), 'clearly distinct options should out-score a more "samey" tradeoff');
});

test('computeHookScore never returns a negative number', () => {
  const q = { category: 'superpowers', optionA: { text: 'Read every single stranger nearby mind', searchQuery: 'telepathy mind reading glow' }, optionB: { text: 'Turn completely invisible near every other person nearby', searchQuery: 'invisible person disappearing slowly' } };
  assert.ok(computeHookScore(q) >= 0);
});

test('computeDilemmaStrengthScore scores a real values tradeoff above two low-stakes near-equivalent choices', () => {
  const strong = computeDilemmaStrengthScore('Earn more but lose your weekends', 'Earn less and keep every weekend');
  const weak = computeDilemmaStrengthScore('One suitcase of belongings', 'A house full of memories');
  assert.ok(strong > weak, `expected a real freedom-vs-money tradeoff to score above a mundane low-stakes pair, got strong=${strong} weak=${weak}`);
});

test('computeDilemmaStrengthScore rewards options landing on DIFFERENT axes over two options on the SAME axis', () => {
  const crossAxis = computeDilemmaStrengthScore('Own a yacht', 'Keep every weekend off'); // status_luxury vs time
  const sameAxis = computeDilemmaStrengthScore('Own a yacht', 'Own a private jet'); // status_luxury vs status_luxury
  assert.ok(crossAxis > sameAxis, `expected a cross-axis tradeoff to score above two same-axis luxury options, got crossAxis=${crossAxis} sameAxis=${sameAxis}`);
});

test('computeDilemmaStrengthScore is never negative and returns 0 for a pair with no recognizable stake', () => {
  assert.equal(computeDilemmaStrengthScore('Visit Rome', 'Visit Cairo'), 0);
  assert.ok(computeDilemmaStrengthScore('', '') >= 0);
});

test('deriveToneBucket classifies a fantasy/superpower question as fantasy_surprising regardless of category flag vs lexicon hit', () => {
  assert.equal(deriveToneBucket('Read minds', 'Turn invisible', true), 'fantasy_surprising');
  assert.equal(deriveToneBucket('Fly everywhere', 'Teleport anywhere', false), 'fantasy_surprising');
});

test('deriveToneBucket classifies humor/absurd, high-consequence, and relatable/social pairs distinctly, and falls back to lifestyle_tradeoff otherwise', () => {
  assert.equal(deriveToneBucket('Smell like garbage forever', 'Look ridiculous every day', false), 'funny_absurd');
  assert.equal(deriveToneBucket('Lose your best friend forever', 'Move away permanently', false), 'high_consequence');
  assert.equal(deriveToneBucket('Spend more time with family', 'Spend more time with friends', false), 'relatable_social');
  assert.equal(deriveToneBucket('Visit Rome', 'Visit Cairo', false), 'lifestyle_tradeoff');
});

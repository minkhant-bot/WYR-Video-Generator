import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFoodImageSemanticRelevance, assessImageCandidate } from './images.js';
import { createImageSelection } from './image-picker.js';

const candidate = semanticMetadata => ({
  id: 'candidate-1', provider: 'Pexels', width: 1600, height: 900,
  semanticMetadata, alt: semanticMetadata, title: semanticMetadata,
  downloadUrl: 'https://images.example/asset-1.jpg', originalImageUrl: 'https://images.example/asset-1.jpg',
  sourcePageUrl: 'https://example.test/photo/1', sourceDomain: 'example.test', position: 0,
});
const food = text => ({ text, searchQuery: text, category: 'food' });

test('exact requested FOOD identity passes', () => {
  const semantic = assessFoodImageSemanticRelevance(candidate('Chicken tacos with salsa isolated on white'), food('Chicken Tacos'));
  assert.equal(semantic.decision, 'match');
  assert.equal(assessImageCandidate(candidate('Chicken tacos with salsa isolated on white'), food('Chicken Tacos')).accepted, true);
});

test('an unrelated FOOD identity fails', () => {
  const semantic = assessFoodImageSemanticRelevance(candidate('Pepperoni pizza isolated on white background'), food('Chicken Tacos'));
  assert.equal(semantic.accepted, false);
  assert.match(semantic.reason, /different food \(pizza\)/);
});

test('query-derived display text cannot override conflicting source-authored metadata', () => {
  const result = assessFoodImageSemanticRelevance({
    ...candidate('Pepperoni pizza isolated on white'),
    alt: 'Chicken tacos photograph - pepperoni pizza',
    title: 'Chicken tacos photograph - pepperoni pizza',
  }, food('Chicken Tacos'));
  assert.equal(result.accepted, false);
  assert.match(result.reason, /different food \(pizza\)/);
});

test('a modifier-only match fails when the requested base FOOD is missing', () => {
  for (const [label, metadata, expectedBase] of [
    ['Chicken Tacos', 'Crispy fried chicken pieces on a white plate', 'taco'],
    ['Chocolate Cake', 'Dark chocolate candy pieces isolated on white', 'cake'],
    ['Apple Cobbler', 'Fresh red apples isolated on white', 'cobbler'],
  ]) {
    const semantic = assessFoodImageSemanticRelevance(candidate(metadata), food(label));
    assert.equal(semantic.accepted, false, label);
    assert.equal(semantic.base, expectedBase, label);
    assert.match(semantic.reason, /modifier only/, label);
  }
});

test('an explicitly conflicting modifier fails even when the base FOOD matches', () => {
  const semantic = assessFoodImageSemanticRelevance(candidate('Beef tacos with salsa isolated on white'), food('Chicken Tacos'));
  assert.equal(semantic.accepted, false);
  assert.match(semantic.reason, /conflicting modifier \(beef\)/);
});

test('common exact FOOD synonyms pass without fuzzy dish matching', () => {
  for (const [label, metadata] of [
    ['French Fries', 'Crispy fries isolated on white'],
    ['Donut', 'Glazed doughnut studio photograph'],
    ['Soda', 'Cold soft drink in a glass'],
    ['Omelet', 'Cheese omelette on a plate'],
  ]) assert.equal(assessFoodImageSemanticRelevance(candidate(metadata), food(label)).decision, 'match', label);
});

test('ambiguous, non-conflicting metadata is allowed to continue through existing ranking', () => {
  const semantic = assessFoodImageSemanticRelevance(candidate('Homemade baked dessert on a white plate'), food('Apple Cobbler'));
  assert.equal(semantic.accepted, true);
  assert.equal(semantic.decision, 'ambiguous');
});

test('FOOD semantic rejection falls through from Pixabay to the next valid provider candidate', async () => {
  const originalFetch = global.fetch;
  let id = 0;
  try {
    global.fetch = async url => {
      const parsed = new URL(url);
      id += 1;
      if (parsed.hostname === 'pixabay.com') return {
        ok: true,
        async json() {
          return { hits: [{ id: `px-${id}`, imageWidth: 1600, imageHeight: 900, tags: 'pepperoni pizza isolated white background', pageURL: `https://pixabay.test/${id}`, largeImageURL: `https://cdn.pixabay.test/${id}.jpg` }] };
        },
      };
      const query = parsed.searchParams.get('query') || '';
      const requested = /cobbler/i.test(query) ? 'apple cobbler' : 'chicken tacos';
      return {
        ok: true,
        async json() {
          return { photos: [{ id: `pe-${id}`, width: 1600, height: 900, alt: `${requested} isolated white background`, url: `https://pexels.test/${id}`, photographer: 'Test', photographer_url: 'https://pexels.test/p', src: { large2x: `https://cdn.pexels.test/${id}.jpg`, original: `https://cdn.pexels.test/${id}-original.jpg` } }] };
        },
      };
    };
    const plan = { questions: [{ index: 0, category: 'food', optionA: { text: 'Chicken Tacos', searchQuery: 'chicken tacos' }, optionB: { text: 'Apple Cobbler', searchQuery: 'apple cobbler' } }] };
    const selection = await createImageSelection({ plan, config: { pixabayApiKey: 'pixabay-key', pexelsApiKey: 'pexels-key', timeoutMs: 1000, pexelsConcurrency: 2 } });
    for (const state of Object.values(selection.slots)) {
      const selected = state.candidates.find(item => item.candidateKey === state.selectedId);
      assert.equal(selected.provider, 'Pexels');
      assert.ok(state.diagnostics.semanticRejected > 0);
      assert.equal(state.candidates.some(item => item.provider === 'Pixabay'), false);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

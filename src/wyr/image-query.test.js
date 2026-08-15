import test from 'node:test';
import assert from 'node:assert/strict';
import { coreSubjectQuery, deterministicImageQueries } from './image-query.js';

test('"Live in a treehouse" produces a treehouse-specific query, not a generic trees query', () => {
  const query = coreSubjectQuery('Live in a treehouse');
  assert.equal(query, 'treehouse');
});

test('"Eat pizza forever" produces a pizza-specific query, not generic restaurant/food imagery', () => {
  const query = coreSubjectQuery('Eat pizza forever');
  assert.equal(query, 'pizza');
});

test('"Explore outer space" produces a space-specific query, not generic sky imagery', () => {
  const query = coreSubjectQuery('Explore outer space');
  assert.equal(query, 'outer space');
});

test('coreSubjectQuery strips generic verbs/connectors but keeps every meaningful noun', () => {
  assert.equal(coreSubjectQuery('Own a private yacht'), 'private yacht');
  assert.equal(coreSubjectQuery('Visit the International Space Station'), 'international space station');
  assert.equal(coreSubjectQuery('Build a small shelter alone in a forest'), 'small shelter alone forest');
});

test('coreSubjectQuery never returns an empty string for valid production-shaped option text', () => {
  assert.ok(coreSubjectQuery('Own a yacht').length > 0);
  assert.ok(coreSubjectQuery('Fly fast').length > 0);
});

test('deterministicImageQueries returns the literal subject first, before any category-blended broader query', () => {
  const queries = deterministicImageQueries({ text: 'Live in a treehouse' }, { category: 'dream homes' });
  assert.equal(queries[0], 'treehouse');
  assert.ok(queries.length >= 1);
  assert.ok(queries.every(query => query.length >= 3));
});

test('deterministicImageQueries never includes decorative/stylistic filler words', () => {
  const queries = deterministicImageQueries({ text: 'Eat pizza forever' }, { category: 'food' });
  for (const query of queries) {
    assert.equal(/cinematic|dramatic|fantasy art|surreal/i.test(query), false, `query "${query}" should not contain decorative styling words`);
  }
});

test('deterministicImageQueries de-duplicates when the subject and category blend collapse to the same text', () => {
  const queries = deterministicImageQueries({ text: 'Own a yacht' }, { category: '' });
  assert.equal(new Set(queries).size, queries.length);
});

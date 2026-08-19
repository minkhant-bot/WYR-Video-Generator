import test from 'node:test';
import assert from 'node:assert/strict';
import { coreSubjectQuery, coreSubjectWords, deterministicImageQueries } from './image-query.js';

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

// ---------------------------------------------------------------------------------------------
// Live Railway failure: "savings doubled today" and "spend freely grows" never cleared the
// dominant-subject/relevance gates despite hundreds of inspected candidates, because pure
// non-visual adverbs/time-words ("today", "freely") were counted as MANDATORY subject words that
// no real photo is ever tagged with -- diluting coverage below the 50% threshold even for a
// perfectly on-subject candidate. coreSubjectWords must drop these outright while KEEPING genuine
// content words (concrete or abstract-but-alias-matchable) intact.
// ---------------------------------------------------------------------------------------------
test('coreSubjectWords drops pure non-visual time/manner words but keeps the concrete noun -- "savings doubled today"', () => {
  const words = coreSubjectWords('savings doubled today');
  assert.equal(words.includes('today'), false, '"today" has no possible visual representation and must never be a required subject word');
  assert.ok(words.includes('savings'), 'the genuine concrete noun "savings" must be preserved');
});

test('coreSubjectWords drops pure non-visual adverbs but keeps abstract action words (matchable via a visual synonym) -- "spend freely grows"', () => {
  const words = coreSubjectWords('spend freely grows');
  assert.equal(words.includes('freely'), false, '"freely" has no possible visual representation and must never be a required subject word');
  assert.ok(words.length > 0, 'stripping "freely" must never empty the subject word list entirely');
});

test('coreSubjectWords never drops a genuine concrete noun that happens to share a strip word (regression guard)', () => {
  assert.deepEqual(coreSubjectWords('Live in a treehouse'), ['treehouse']);
  assert.deepEqual(coreSubjectWords('Eat pizza forever'), ['pizza']);
});

test('deterministicImageQueries for "savings doubled today" never includes the non-visual word "today"', () => {
  const queries = deterministicImageQueries({ text: 'savings doubled today' }, { category: 'money' });
  for (const query of queries) assert.equal(/\btoday\b/.test(query), false, `query "${query}" must not carry the non-visual word "today"`);
  assert.ok(queries.some(query => query.includes('savings')), 'at least one query must retain the concrete "savings" subject');
});

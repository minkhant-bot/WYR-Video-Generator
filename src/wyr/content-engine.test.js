import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_CATEGORIES } from './content.js';
import { assessQuestionQuality, compareDilemmas, ContentGenerationError, ContentHistoryStore, generateProductionPlan, selectCategories } from './content-engine.js';

const quality = Object.freeze({ dilemmaStrength: 8, curiosity: 8, emotionalPull: 8, visualPotential: 8, readability: 9 });
const dilemma = (a, b, category = 'superpowers', scores = quality) => ({ category, quality: scores, optionA: { text: a, searchQuery: `${a} concept photo` }, optionB: { text: b, searchQuery: `${b} concept photo` } });
const temporaryStore = operation => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-content-history-'));
  const store = new ContentHistoryStore(path.join(directory, 'history.json'));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const result = operation(store, directory);
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup(); return result;
  } catch (error) { cleanup(); throw error; }
};

test('exact duplicate rejection is order-independent', () => {
  assert.deepEqual(compareDilemmas(dilemma('Fly freely', 'Teleport anywhere'), dilemma('Fly freely', 'Teleport anywhere')), { duplicate: true, kind: 'exact', similarity: 1 });
});

test('reversed A/B duplicate is rejected', () => {
  const result = compareDilemmas(dilemma('Fly freely', 'Teleport anywhere'), dilemma('Teleport anywhere', 'Fly freely'));
  assert.equal(result.duplicate, true); assert.equal(result.kind, 'reversed');
});

test('near-duplicate wording variation is rejected', () => {
  const result = compareDilemmas(dilemma('Own a Private Jet', 'Own a Private Island'), dilemma('Have Your Own Jet', 'Live On A Private Island'));
  assert.equal(result.duplicate, true); assert.equal(result.kind, 'near');
});

test('persistent history reloads accepted dilemmas and categories', () => temporaryStore((store, directory) => {
  const plan = { topic: 'Dream choices', questions: [dilemma('Control Gravity', 'Control Lightning', 'superpowers')] };
  store.appendPlan(plan, '2026-01-01T00:00:00.000Z');
  const reloaded = new ContentHistoryStore(path.join(directory, 'history.json')).load();
  assert.equal(reloaded.videos.length, 1);
  assert.equal(reloaded.videos[0].questions[0].canonical, 'gravity | lightning');
  assert.deepEqual(reloaded.videos[0].categories, ['superpowers']);
}));

test('category rotation favors categories not used in the previous video', () => {
  const used = CONTENT_CATEGORIES.slice(0, 8);
  const history = { version: 1, videos: [{ generatedAt: '2026-01-01T00:00:00Z', categories: used, questions: [] }] };
  const selected = selectCategories(history, 8);
  assert.deepEqual(selected, CONTENT_CATEGORIES.slice(8, 16));
  assert.equal(selected.some(category => used.includes(category)), false);
});

test('boring content is rejected even when self-reported scores are high', () => {
  const result = assessQuestionQuality(dilemma('Coffee', 'Tea', 'food'));
  assert.equal(result.accepted, false); assert.match(result.reasons.join(' '), /generic low-stakes/);
});

test('high-quality short visual content is accepted', () => {
  const result = assessQuestionQuality(dilemma('Control Gravity', 'Control Lightning'));
  assert.equal(result.accepted, true); assert.deepEqual(result.reasons, []);
});

test('duplicate detection inside one video requests a replacement', async () => temporaryStore(async store => {
  let calls = 0;
  const provider = { async generatePlan(count, context) {
    calls += 1;
    const questions = context.categories.map(category => dilemma(`${category} wonder ${calls}`, `${category} escape ${calls}`, category));
    if (calls === 1) questions[1] = { ...questions[1], optionA: questions[0].optionA, optionB: questions[0].optionB };
    return { topic: 'Candidates', questions: questions.slice(0, count) };
  } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2 });
  assert.equal(plan.questions.length, 8); assert.equal(calls, 2);
  assert.equal(new Set(plan.questions.map(question => question.category)).size, 8);
}));

test('bounded retry failure never loops indefinitely', async () => temporaryStore(async store => {
  let calls = 0;
  const low = { ...quality, curiosity: 4 };
  const provider = { async generatePlan(count, context) { calls += 1; return { topic: 'Weak', questions: context.categories.map((category, index) => dilemma(`Plain choice ${index}`, `Other choice ${index}`, category, low)).slice(0, count) }; } };
  await assert.rejects(() => generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2 }), ContentGenerationError);
  assert.equal(calls, 2);
}));

test('production selection succeeds with exactly 8 distinct quality-gated questions', async () => temporaryStore(async store => {
  const provider = { async generatePlan(count, context) { return { topic: 'Strong choices', questions: context.categories.map((category, index) => dilemma(`Dream ability ${index}`, `Rare adventure ${index}`, category)).slice(0, count) }; } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 3 });
  assert.equal(plan.questions.length, 8);
  assert.equal(plan.questions.every(question => question.duplicateCheck.status === 'clear'), true);
  assert.equal(store.load().videos[0].questions.length, 8);
}));

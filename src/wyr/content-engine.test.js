import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_CATEGORIES, DILEMMA_STYLES } from './content.js';
import { assessQuestionQuality, compareDilemmas, ContentGenerationError, ContentHistoryStore, ContentRateLimitError, generateProductionPlan, MOTIF_HISTORY_WINDOW, recentMotifs, selectCategories } from './content-engine.js';

const quality = Object.freeze({ dilemmaStrength: 8, curiosity: 8, emotionalPull: 8, visualPotential: 8, readability: 9 });
const dilemma = (a, b, category = 'superpowers', scores = quality) => ({ category, quality: scores, optionA: { text: a, searchQuery: `${a} concept photo` }, optionB: { text: b, searchQuery: `${b} concept photo` } });
const withMotif = (a, b, conceptKeyA, conceptKeyB, category = 'superpowers', dilemmaStyle = 'power') => ({
  category, dilemmaStyle, quality,
  optionA: { text: a, searchQuery: `${a} concept photo`, conceptKey: conceptKeyA },
  optionB: { text: b, searchQuery: `${b} concept photo`, conceptKey: conceptKeyB },
});
const styledMotifPlan = calls => (category, index) => withMotif(`${category} wonder ${calls}`, `${category} escape ${calls}`, `motif-${calls}-${index}`, `alt-${calls}-${index}`, category, DILEMMA_STYLES[index % DILEMMA_STYLES.length]);
const rateLimitError = retryAfterMs => Object.assign(new Error('Groq returned HTTP 429 (rate_limit_exceeded).'), { status: 429, code: 'rate_limit_exceeded', retryAfterMs });
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

test('seven accepted dilemmas survive a 429 and only the final missing dilemma is requested again', async () => temporaryStore(async store => {
  const requestedCounts = []; const contexts = []; const waits = []; let calls = 0;
  const low = { ...quality, curiosity: 4 };
  const provider = { async generatePlan(count, context) {
    calls += 1; requestedCounts.push(count); contexts.push(context);
    if (calls === 1) return { topic: 'Partial progress', questions: context.categories.map((category, index) => dilemma(`${category} wonder`, `${category} escape`, category, index === 7 ? low : quality)) };
    if (calls === 2) throw rateLimitError(25);
    return { topic: 'Final replacement', questions: [dilemma('Summon friendly dragons', 'Open magical portals', context.categories[0])] };
  } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 3, rateLimitPolicy: { maxRetries: 2, maxWaitMs: 1000 }, sleep: async milliseconds => waits.push(milliseconds) });
  assert.deepEqual(requestedCounts, [8, 1, 1]);
  assert.deepEqual(contexts.slice(1).map(context => context.categories), [['fantasy'], ['fantasy']]);
  assert.deepEqual(waits, [25]);
  assert.equal(plan.questions.length, 8);
  assert.equal(plan.questions[0].optionA.text, 'superpowers wonder');
  assert.equal(plan.contentQuality.attemptsUsed, 2);
  assert.equal(plan.contentQuality.rateLimitRetries, 1);
}));

test('Retry-After controls the rate-limit wait duration', async () => temporaryStore(async store => {
  const waits = []; let calls = 0;
  const provider = { async generatePlan(count, context) { calls += 1; if (calls === 1) throw rateLimitError(2400); return { topic: 'Recovered', questions: [dilemma('Control gravity', 'Control lightning', context.categories[0])] }; } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 1, maxAttempts: 1, rateLimitPolicy: { maxRetries: 1, maxWaitMs: 3000 }, sleep: async milliseconds => waits.push(milliseconds) });
  assert.equal(plan.questions.length, 1); assert.deepEqual(waits, [2400]); assert.equal(calls, 2);
}));

test('missing Retry-After uses bounded exponential backoff with jitter support', async () => temporaryStore(async store => {
  const waits = []; let calls = 0;
  const provider = { async generatePlan(count, context) { calls += 1; if (calls <= 2) throw rateLimitError(undefined); return { topic: 'Recovered', questions: [dilemma('Control gravity', 'Control lightning', context.categories[0])] }; } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 1, maxAttempts: 1, rateLimitPolicy: { maxRetries: 2, maxWaitMs: 1000, baseDelayMs: 100, maxDelayMs: 500, jitterMs: 50 }, sleep: async milliseconds => waits.push(milliseconds), random: () => 0 });
  assert.deepEqual(waits, [100, 200]); assert.equal(calls, 3); assert.equal(plan.contentQuality.rateLimitWaitedMs, 300);
}));

test('rate-limit wait budget fails clearly without persisting or rendering an incomplete plan', async () => temporaryStore(async store => {
  const waits = []; let calls = 0; const low = { ...quality, curiosity: 4 };
  const provider = { async generatePlan(count, context) { calls += 1; if (calls === 1) return { topic: 'Partial', questions: context.categories.map((category, index) => dilemma(`${category} prize`, `${category} journey`, category, index === 7 ? low : quality)) }; throw rateLimitError(1500); } };
  await assert.rejects(() => generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 3, rateLimitPolicy: { maxRetries: 4, maxWaitMs: 1000 }, sleep: async milliseconds => waits.push(milliseconds) }), error => {
    assert.ok(error instanceof ContentRateLimitError); assert.equal(error.code, 'groq_rate_limit_exceeded'); assert.equal(error.acceptedCount, 7); assert.match(error.message, /No incomplete video was rendered/); return true;
  });
  assert.equal(calls, 2); assert.deepEqual(waits, []); assert.deepEqual(store.load().videos, []);
}));

test('rate-limit recovery does not bypass duplicate or persistent-history checks', async () => temporaryStore(async store => {
  store.appendPlan({ topic: 'Previous', questions: [dilemma('Control gravity', 'Control lightning', 'superpowers')] });
  const requestedCounts = []; let calls = 0;
  const provider = { async generatePlan(count, context) {
    calls += 1; requestedCounts.push(count);
    if (calls === 1) throw rateLimitError(1);
    if (calls === 2) return { topic: 'Duplicate first', questions: context.categories.map((category, index) => index === 0 ? dilemma('Control gravity', 'Control lightning', category) : dilemma(`${category} vision`, `${category} adventure`, category)) };
    return { topic: 'Replacement', questions: [dilemma('Breathe beneath oceans', 'Walk across clouds', context.categories[0])] };
  } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2, rateLimitPolicy: { maxRetries: 1, maxWaitMs: 100 }, sleep: async () => {} });
  assert.deepEqual(requestedCounts, [8, 8, 1]);
  assert.equal(plan.questions.length, 8);
  assert.equal(plan.questions.some(question => compareDilemmas(question, dilemma('Control gravity', 'Control lightning')).duplicate), false);
  assert.equal(store.load().videos.length, 2);
}));

test('recentMotifs collects concept keys only from the most recent window of videos', () => {
  const oldVideo = { generatedAt: '2020-01-01T00:00:00Z', categories: ['superpowers'], questions: [{ category: 'superpowers', dilemmaStyle: 'power', optionA: 'a', optionB: 'b', conceptKeyA: 'ancient-motif', conceptKeyB: 'other-motif' }] };
  const recentVideos = Array.from({ length: MOTIF_HISTORY_WINDOW }, (_, index) => ({ generatedAt: `2021-01-01T00:0${index}:00Z`, categories: ['money'], questions: [{ category: 'money', dilemmaStyle: 'tradeoff', optionA: `a${index}`, optionB: `b${index}`, conceptKeyA: `motif-${index}`, conceptKeyB: null }] }));
  const history = { version: 1, videos: [oldVideo, ...recentVideos] };
  const motifs = recentMotifs(history, MOTIF_HISTORY_WINDOW);
  assert.equal(motifs.has('ancient-motif'), false);
  assert.equal(motifs.has('motif-0'), true);
  assert.equal(motifs.has(`motif-${MOTIF_HISTORY_WINDOW - 1}`), true);
});

test('persisted history stores conceptKey and dilemmaStyle per question', () => temporaryStore((store, directory) => {
  store.appendPlan({ topic: 'Motifs', questions: [withMotif('Teleport anywhere', 'Read minds', 'teleportation', 'mind-reading', 'superpowers', 'power')] });
  const reloaded = new ContentHistoryStore(path.join(directory, 'history.json')).load();
  assert.equal(reloaded.videos[0].questions[0].conceptKeyA, 'teleportation');
  assert.equal(reloaded.videos[0].questions[0].conceptKeyB, 'mind-reading');
  assert.equal(reloaded.videos[0].questions[0].dilemmaStyle, 'power');
}));

test('a candidate reusing a motif blocked by recent video history is rejected and replaced', async () => temporaryStore(async store => {
  store.appendPlan({ topic: 'Prior', questions: [withMotif('Teleport anywhere', 'Read minds', 'teleportation', 'mind-reading')] });
  let calls = 0;
  const provider = { async generatePlan(count, context) {
    calls += 1;
    assert.ok(context.excludedMotifs.includes('teleportation'));
    const questions = context.categories.map((category, index) => calls === 1 && index === 0
      ? withMotif(`${category} wonder`, `${category} escape`, 'teleportation', 'alt-0', category, DILEMMA_STYLES[index % DILEMMA_STYLES.length])
      : styledMotifPlan(calls)(category, index));
    return { topic: 'Candidates', questions: questions.slice(0, count) };
  } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 3 });
  assert.equal(plan.questions.length, 8);
  assert.equal(calls, 2);
  assert.equal(plan.questions.every(question => question.optionA.conceptKey !== 'teleportation' && question.optionB.conceptKey !== 'teleportation'), true);
}));

test('a duplicate motif inside the same video batch is rejected and replaced', async () => temporaryStore(async store => {
  let calls = 0;
  const provider = { async generatePlan(count, context) {
    calls += 1;
    const questions = context.categories.map(styledMotifPlan(calls));
    if (calls === 1) questions[1] = { ...questions[1], optionA: { ...questions[1].optionA, conceptKey: questions[0].optionA.conceptKey } };
    return { topic: 'Candidates', questions: questions.slice(0, count) };
  } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2 });
  assert.equal(plan.questions.length, 8); assert.equal(calls, 2);
  const motifs = plan.questions.flatMap(question => [question.optionA.conceptKey, question.optionB.conceptKey]);
  assert.equal(new Set(motifs).size, motifs.length);
}));

test('a different concept key in a previously used category is not blocked', async () => temporaryStore(async store => {
  store.appendPlan({ topic: 'Prior', questions: [withMotif('Teleport anywhere', 'Read minds', 'teleportation', 'mind-reading', 'superpowers')] });
  const provider = { async generatePlan(count, context) { return { topic: 'New', questions: context.categories.map((category, index) => withMotif(`${category} ability ${index}`, `${category} feat ${index}`, `invisibility-${index}`, `flight-${index}`, category, DILEMMA_STYLES[index % DILEMMA_STYLES.length])) }; } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 1 });
  assert.equal(plan.questions.length, 8);
  assert.equal(plan.contentQuality.rejectedCandidates, 0);
  assert.equal(plan.contentQuality.attemptsUsed, 1);
}));

test('a dilemma style repeated beyond the per-video cap is rejected and replaced', async () => temporaryStore(async store => {
  await assert.rejects(() => generateProductionPlan({
    provider: { async generatePlan(count, context) { return { topic: 'Samey', questions: context.categories.map((category, index) => withMotif(`${category} wonder ${index}`, `${category} escape ${index}`, `motif-${index}`, `alt-${index}`, category, 'power')) }; } },
    historyStore: store, questionCount: 8, maxAttempts: 1,
  }), ContentGenerationError);
}));

test('varied dilemma styles across a video are all accepted', async () => temporaryStore(async store => {
  const provider = { async generatePlan(count, context) { return { topic: 'Varied', questions: context.categories.map(styledMotifPlan(1)).slice(0, count) }; } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 1 });
  assert.equal(plan.questions.length, 8);
  assert.equal(new Set(plan.questions.map(question => question.dilemmaStyle)).size >= 4, true);
}));

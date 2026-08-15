import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_CATEGORIES, CONTENT_FAMILIES, DILEMMA_STYLES, FANTASY_CONTENT_FAMILIES } from './content.js';
import { assessQuestionQuality, canonicalMotifKey, compareDilemmas, ContentGenerationError, ContentHistoryStore, ContentRateLimitError, DEFAULT_GROQ_RATE_LIMIT_POLICY, generateProductionPlan, MOTIF_HISTORY_WINDOW, recentMotifs, selectCategories, selectContentFamilies } from './content-engine.js';

const quality = Object.freeze({ dilemmaStrength: 8, curiosity: 8, emotionalPull: 8, visualPotential: 8, readability: 9 });
const dilemma = (a, b, category = 'superpowers', scores = quality) => ({ category, quality: scores, optionA: { text: a, searchQuery: `${a} concept photo` }, optionB: { text: b, searchQuery: `${b} concept photo` } });
const withMotif = (a, b, conceptKeyA, conceptKeyB, category = 'superpowers', dilemmaStyle = 'power', contentFamily = undefined) => ({
  category, dilemmaStyle, contentFamily, quality,
  optionA: { text: a, searchQuery: `${a} concept photo`, conceptKey: conceptKeyA },
  optionB: { text: b, searchQuery: `${b} concept photo`, conceptKey: conceptKeyB },
});
const styledMotifPlan = calls => (category, index) => withMotif(`${category} wonder ${calls}`, `${category} escape ${calls}`, `motif-${calls}-${index}`, `alt-${calls}-${index}`, category, DILEMMA_STYLES[index % DILEMMA_STYLES.length]);
const REALISTIC_FAMILIES = CONTENT_FAMILIES.filter(family => !FANTASY_CONTENT_FAMILIES.includes(family));
const styledFamilyPlan = calls => (category, index) => withMotif(`${category} wonder ${calls}`, `${category} escape ${calls}`, `motif-${calls}-${index}`, `alt-${calls}-${index}`, category, DILEMMA_STYLES[index % DILEMMA_STYLES.length], REALISTIC_FAMILIES[index % REALISTIC_FAMILIES.length]);
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

test('the default Groq rate-limit policy is bounded but wide enough to survive a free-tier burst (~2-3 minutes, finite retries)', () => {
  assert.equal(DEFAULT_GROQ_RATE_LIMIT_POLICY.maxRetries, 7);
  assert.equal(DEFAULT_GROQ_RATE_LIMIT_POLICY.maxWaitMs, 150_000);
  assert.ok(DEFAULT_GROQ_RATE_LIMIT_POLICY.maxWaitMs >= 120_000 && DEFAULT_GROQ_RATE_LIMIT_POLICY.maxWaitMs <= 180_000);
  assert.ok(Number.isInteger(DEFAULT_GROQ_RATE_LIMIT_POLICY.maxRetries) && DEFAULT_GROQ_RATE_LIMIT_POLICY.maxRetries < Infinity);
});

test('sustained 429s never discard already-accepted candidates, and the widened window logs request/429/wait counters', async () => temporaryStore(async store => {
  const logs = []; const originalInfo = console.info;
  console.info = message => logs.push(message);
  try {
    let calls = 0;
    const provider = {
      requestCount: 0, rateLimitCount: 0,
      async generatePlan(count, context) {
        calls += 1; this.requestCount += 1;
        if (calls === 1) return { topic: 'Partial progress', questions: context.categories.map((category, index) => dilemma(`${category} wonder`, `${category} escape`, category, index === 7 ? { ...quality, curiosity: 4 } : quality)) };
        if (calls <= 4) { this.rateLimitCount += 1; throw rateLimitError(5); }
        return { topic: 'Final replacement', questions: [dilemma('Summon friendly dragons', 'Open magical portals', context.categories[0])] };
      },
    };
    const waits = [];
    const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 3, rateLimitPolicy: { maxRetries: 5, maxWaitMs: 30_000 }, sleep: async milliseconds => waits.push(milliseconds) });
    assert.equal(plan.questions.length, 8);
    // The 7 candidates accepted before the 429 storm survive untouched — no restart from zero.
    assert.equal(plan.questions[0].optionA.text, 'superpowers wonder');
    assert.deepEqual(waits, [5, 5, 5]);

    const parsed = logs.map(line => JSON.parse(line));
    const requestLogs = parsed.filter(entry => entry.event === 'content.groq_request');
    assert.equal(requestLogs.length, 2);
    assert.equal(requestLogs[0].totalGroqRequests, 1);
    assert.equal(requestLogs[0].acceptedFromRequest, 7);

    const waitLogs = parsed.filter(entry => entry.event === 'content.groq_rate_limit_wait');
    assert.equal(waitLogs.length, 3);
    assert.deepEqual(waitLogs.map(entry => entry.cumulativeWaitMs), [5, 10, 15]);
    assert.equal(waitLogs.at(-1).rateLimitCount, 3);

    const summaryLogs = parsed.filter(entry => entry.event === 'content.generation_summary');
    assert.equal(summaryLogs.length, 1);
    assert.equal(summaryLogs[0].accepted, 8);
    assert.equal(summaryLogs[0].totalGroqRequests, 5);
  } finally { console.info = originalInfo; }
}));

test('exhausting the rate-limit budget reports the request/429/wait counters instead of failing silently', async () => temporaryStore(async store => {
  const logs = []; const originalInfo = console.info;
  console.info = message => logs.push(message);
  try {
    const provider = { requestCount: 0, rateLimitCount: 0, async generatePlan() { this.requestCount += 1; this.rateLimitCount += 1; throw rateLimitError(10_000); } };
    await assert.rejects(() => generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 3, rateLimitPolicy: { maxRetries: 2, maxWaitMs: 25_000 }, sleep: async () => {} }), ContentRateLimitError);
    const exhausted = logs.map(line => JSON.parse(line)).find(entry => entry.event === 'content.groq_rate_limit_exhausted');
    assert.ok(exhausted);
    assert.equal(exhausted.totalGroqRequests, provider.requestCount);
    assert.equal(exhausted.rateLimitCount, provider.rateLimitCount);
  } finally { console.info = originalInfo; }
}));

test('canonicalMotifKey collides known paraphrases of the same motif', () => {
  const teleport = ['Teleport anywhere instantly', 'Open a portal to any country', 'Instantly travel anywhere on Earth'];
  assert.equal(new Set(teleport.map(text => canonicalMotifKey({ text }))).size, 1);
  assert.equal(canonicalMotifKey({ text: teleport[0] }), 'teleportation');

  const timeControl = ['Freeze time whenever you want', 'Stop time for one hour', 'Pause time to catch your breath'];
  assert.equal(new Set(timeControl.map(text => canonicalMotifKey({ text }))).size, 1);
  assert.equal(canonicalMotifKey({ text: timeControl[0] }), 'time-control');

  const mindReading = ['Read minds forever', "Hear people's thoughts at will"];
  assert.equal(new Set(mindReading.map(text => canonicalMotifKey({ text }))).size, 1);
  assert.equal(canonicalMotifKey({ text: mindReading[0] }), 'mind-reading');

  const invisibility = ['Become invisible whenever you want', 'Disappear at will'];
  assert.equal(new Set(invisibility.map(text => canonicalMotifKey({ text }))).size, 1);
  assert.equal(canonicalMotifKey({ text: invisibility[0] }), 'invisibility');

  const island = ['Own a private island', 'Live alone on your own island'];
  assert.equal(new Set(island.map(text => canonicalMotifKey({ text }))).size, 1);
  assert.equal(canonicalMotifKey({ text: island[0] }), 'private-island');

  const creatureBond = ["Be a dragon's best friend", "Be a unicorn's guardian"];
  assert.equal(new Set(creatureBond.map(text => canonicalMotifKey({ text }))).size, 1);
});

test('canonicalMotifKey does not over-collide genuinely different concepts that share a broad category', () => {
  const sportsCar = canonicalMotifKey({ text: 'Own a sports car' });
  const privateJet = canonicalMotifKey({ text: 'Own a private jet' });
  assert.notEqual(sportsCar, privateJet);
  const mountainCabin = canonicalMotifKey({ text: 'Live in a mountain cabin' });
  const beachVilla = canonicalMotifKey({ text: 'Relax at a beach villa' });
  assert.notEqual(mountainCabin, beachVilla);
});

test('canonicalMotifKey backfills a stable motif from legacy option text with no conceptKey at all', () => {
  const key = canonicalMotifKey({ conceptKey: undefined, text: 'Teleport to any era you want' });
  assert.equal(key, 'teleportation');
  assert.equal(canonicalMotifKey({ text: 'Teleport to any era you want' }), key);
});

test('legacy history entries without conceptKeyA/B immediately participate in motif duplicate protection', async () => temporaryStore(async store => {
  fs.writeFileSync(store.filePath, JSON.stringify({
    version: 1,
    videos: [{
      generatedAt: '2025-01-01T00:00:00.000Z', topic: 'Legacy video', categories: ['superpowers'],
      questions: [{ category: 'superpowers', optionA: 'Teleport every hour', optionB: 'Read minds forever' }],
    }],
  }));
  const motifs = recentMotifs(store.load());
  assert.ok(motifs.has('teleportation'));
  assert.ok(motifs.has('mind-reading'));

  let calls = 0;
  const provider = { async generatePlan(count, context) {
    calls += 1;
    assert.ok(context.excludedMotifs.includes('teleportation'));
    const questions = context.categories.map((category, index) => calls === 1 && index === 0
      ? withMotif('Open a portal to any country', 'Own a sports car', undefined, undefined, category, DILEMMA_STYLES[index % DILEMMA_STYLES.length])
      : styledMotifPlan(calls)(category, index));
    return { topic: 'New', questions: questions.slice(0, count) };
  } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 3 });
  assert.equal(plan.questions.length, 8);
  assert.equal(plan.questions.some(question => canonicalMotifKey({ conceptKey: question.optionA.conceptKey, text: question.optionA.text }) === 'teleportation'), false);
}));

test('fantasy-like content family is capped at 1 per video even when Groq keeps offering fantasy candidates', async () => temporaryStore(async store => {
  await assert.rejects(() => generateProductionPlan({
    provider: { async generatePlan(count, context) { return { topic: 'Fantasy heavy', questions: context.categories.map((category, index) => withMotif(`${category} wonder ${index}`, `${category} escape ${index}`, `motif-${index}`, `alt-${index}`, category, 'power', 'superpower')) }; } },
    historyStore: store, questionCount: 8, maxAttempts: 1,
  }), ContentGenerationError);
}));

test('any single content family is capped at 2 per video', async () => temporaryStore(async store => {
  await assert.rejects(() => generateProductionPlan({
    provider: { async generatePlan(count, context) { return { topic: 'Samey family', questions: context.categories.map((category, index) => withMotif(`${category} wonder ${index}`, `${category} escape ${index}`, `motif-${index}`, `alt-${index}`, category, DILEMMA_STYLES[index % DILEMMA_STYLES.length], 'food')) }; } },
    historyStore: store, questionCount: 8, maxAttempts: 1,
  }), ContentGenerationError);
}));

test('a normal production plan reaches at least 6 distinct content families across 8 questions', async () => temporaryStore(async store => {
  const provider = { async generatePlan(count, context) { return { topic: 'Diverse', questions: context.categories.map(styledFamilyPlan(1)).slice(0, count) }; } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 1 });
  assert.equal(plan.questions.length, 8);
  const distinctFamilies = new Set(plan.questions.map(question => question.contentFamily));
  assert.ok(distinctFamilies.size >= 6, `expected >=6 distinct families, got ${distinctFamilies.size}`);
  assert.equal(plan.contentQuality.distinctContentFamilies, distinctFamilies.size);
  assert.ok(plan.contentQuality.fantasyFamilyCount <= 1);
}));

test('selectContentFamilies targets at most one fantasy-like family and prefers realistic families otherwise', () => {
  const targets = selectContentFamilies({ version: 1, videos: [] }, 8);
  assert.equal(targets.length, 8);
  assert.equal(new Set(targets).size, 8);
  const fantasyInTargets = targets.filter(family => FANTASY_CONTENT_FAMILIES.includes(family));
  assert.ok(fantasyInTargets.length <= 1);
});

test('selectContentFamilies rotates away from families used in the immediately preceding video', () => {
  const usedRealistic = REALISTIC_FAMILIES.slice(0, 7);
  const history = { version: 1, videos: [{ generatedAt: '2026-01-01T00:00:00Z', categories: [], contentFamilies: [...usedRealistic, 'superpower'], questions: [] }] };
  const targets = selectContentFamilies(history, 8);
  assert.equal(targets.some(family => usedRealistic.includes(family)), false);
});

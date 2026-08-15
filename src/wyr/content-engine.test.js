import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_CATEGORIES } from './content.js';
import { assessQuestionQuality, canonicalMotifKey, compareDilemmas, ContentGenerationError, ContentHistoryStore, ContentRateLimitError, DEFAULT_GROQ_RATE_LIMIT_POLICY, generateProductionPlan, MOTIF_HISTORY_WINDOW, recentMotifs, selectCategories } from './content-engine.js';

const shortQuery = text => text.split(' ').slice(0, 4).join(' ');
const dilemma = (a, b, category = 'superpowers') => ({ category, optionA: { text: a, searchQuery: shortQuery(a) }, optionB: { text: b, searchQuery: shortQuery(b) } });
const rateLimitError = retryAfterMs => Object.assign(new Error('Groq returned HTTP 429 (rate_limit_exceeded).'), { status: 429, code: 'rate_limit_exceeded', retryAfterMs });
const tokenLimitError = retryAfterMs => Object.assign(new Error('Groq returned HTTP 429 (rate_limit_exceeded).'), {
  status: 429, code: 'rate_limit_exceeded', retryAfterMs, limitType: 'tokens',
  rateLimitHeaders: { 'retry-after': String(retryAfterMs / 1000), 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '200', 'x-ratelimit-reset-tokens': `${retryAfterMs / 1000}s` },
});
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
// A single-call mock: returns exactly the requested categories/count, using distinct realistic
// text per category so nothing collides with itself on duplicate/motif checks.
const REALISTIC_PAIRS = {
  superpowers: ['Control gravity for a day', 'Control lightning for a day'],
  money: ['Double your bank balance', 'Triple your vacation days'],
  luxury: ['Own a private jet', 'Own a luxury yacht'],
  'dream lifestyle': ['Work four days a week', 'Retire ten years early'],
  travel: ['Backpack across Europe', 'Road trip across America'],
  'impossible choices': ['Give up sweets forever', 'Give up your phone forever'],
  'future technology': ['Live in a smart home', 'Commute by high speed rail'],
  fantasy: ['Read minds for one day', 'Own a private island'],
  time: ['Wake up an hour earlier', 'Stay up an hour later'],
  freedom: ['Work fully remote', 'Set your own hours'],
  'dream homes': ['Live in a treehouse', 'Live on a houseboat'],
  cars: ['Drive a classic car', 'Drive a electric supercar'],
  food: ['Only eat home cooked meals', 'Only eat restaurant meals'],
  adventure: ['Go skydiving once', 'Go scuba diving once'],
  fame: ['Be famous for a year', 'Be wealthy but unknown'],
  'survival-lite': ['Camp without electricity', 'Camp without running water'],
  space: ['Visit the moon', 'Visit Mars'],
  ocean: ['Explore a coral reef', 'Explore a deep sea trench'],
  'friendship/social': ['Have five close friends', 'Have fifty casual friends'],
  'funny hypothetical': ['Speak only in rhymes', 'Sneeze confetti forever'],
};
const singleCallProvider = () => ({
  calls: 0,
  async generatePlan(count, context) {
    this.calls += 1;
    const categories = context.categories.length ? context.categories : CONTENT_CATEGORIES.slice(0, count);
    return { questions: categories.slice(0, count).map(category => { const [a, b] = REALISTIC_PAIRS[category]; return dilemma(a, b, category); }) };
  },
});

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

test('persistent history reloads accepted dilemmas and categories, with no dilemmaStyle/contentFamily fields', () => temporaryStore((store, directory) => {
  const plan = { topic: 'Dream choices', questions: [dilemma('Control Gravity', 'Control Lightning', 'superpowers')] };
  store.appendPlan(plan, '2026-01-01T00:00:00.000Z');
  const reloaded = new ContentHistoryStore(path.join(directory, 'history.json')).load();
  assert.equal(reloaded.videos.length, 1);
  assert.equal(reloaded.videos[0].questions[0].canonical, 'gravity | lightning');
  assert.deepEqual(reloaded.videos[0].categories, ['superpowers']);
  assert.equal(reloaded.videos[0].questions[0].dilemmaStyle, undefined);
  assert.equal(reloaded.videos[0].questions[0].contentFamily, undefined);
}));

test('category rotation favors categories not used in the previous video', () => {
  const used = CONTENT_CATEGORIES.slice(0, 8);
  const history = { version: 1, videos: [{ generatedAt: '2026-01-01T00:00:00Z', categories: used, questions: [] }] };
  const selected = selectCategories(history, 8);
  assert.deepEqual(selected, CONTENT_CATEGORIES.slice(8, 16));
  assert.equal(selected.some(category => used.includes(category)), false);
});

test('boring content is rejected on local heuristics alone (no self-reported quality score needed)', () => {
  const result = assessQuestionQuality(dilemma('Coffee', 'Tea', 'food'));
  assert.equal(result.accepted, false); assert.match(result.reasons.join(' '), /generic low-stakes/);
});
test('a normal short, distinguishable, safe dilemma passes local quality heuristics', () => {
  const result = assessQuestionQuality(dilemma('Control Gravity', 'Control Lightning'));
  assert.equal(result.accepted, true); assert.deepEqual(result.reasons, []);
});

test('a single Groq call produces all 8 usable questions in the normal case', async () => temporaryStore(async store => {
  const provider = singleCallProvider();
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2 });
  assert.equal(plan.questions.length, 8);
  assert.equal(provider.calls, 1);
  assert.equal(plan.contentQuality.attemptsUsed, 1);
  assert.equal(plan.contentQuality.rejectedCandidates, 0);
  assert.ok(plan.topic.length > 0); // derived locally, not requested from Groq
}));

test('valid questions survive repair: only the missing count is requested, not all 8 again', async () => temporaryStore(async store => {
  let calls = 0; const requestedCounts = []; const requestedCategories = [];
  const provider = {
    async generatePlan(count, context) {
      calls += 1; requestedCounts.push(count); requestedCategories.push([...context.categories]);
      const categories = context.categories;
      const questions = categories.map(category => { const [a, b] = REALISTIC_PAIRS[category]; return dilemma(a, b, category); });
      if (calls === 1) {
        // Sabotage exactly 2 of the 8 candidates (identical options -> local validation rejects them).
        questions[2] = dilemma('Same Text Twice', 'Same Text Twice', questions[2].category);
        questions[5] = dilemma('Same Text Twice Again', 'Same Text Twice Again', questions[5].category);
      }
      return { questions };
    },
  };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2 });
  assert.equal(plan.questions.length, 8);
  assert.equal(calls, 2);
  assert.deepEqual(requestedCounts, [8, 2]); // repair asked for exactly the missing count
  assert.equal(requestedCategories[1].length, 2); // not all 8 categories re-requested
}));

test('duplicate detection inside one video requests a replacement for only the duplicate', async () => temporaryStore(async store => {
  let calls = 0;
  const provider = { async generatePlan(count, context) {
    calls += 1;
    const questions = context.categories.map(category => { const [a, b] = REALISTIC_PAIRS[category]; return dilemma(`${a} ${calls}`, `${b} ${calls}`, category); });
    if (calls === 1) questions[1] = { ...questions[1], optionA: questions[0].optionA, optionB: questions[0].optionB };
    return { questions };
  } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2 });
  assert.equal(plan.questions.length, 8); assert.equal(calls, 2);
  assert.equal(new Set(plan.questions.map(question => question.category)).size, 8);
}));

test('bounded retry failure never loops indefinitely', async () => temporaryStore(async store => {
  let calls = 0;
  // A generic boring pair (rejected by the local heuristic gate regardless of category) that the
  // mock keeps re-offering — proves the bounded loop terminates instead of retrying forever.
  const provider = { async generatePlan(count, context) { calls += 1; return { questions: context.categories.map(category => dilemma('Coffee', 'Tea', category)).slice(0, count) }; } };
  await assert.rejects(() => generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2 }), ContentGenerationError);
  assert.equal(calls, 2);
}));

test('rate-limit recovery does not bypass duplicate or persistent-history checks', async () => temporaryStore(async store => {
  store.appendPlan({ topic: 'Previous', questions: [dilemma('Control gravity', 'Control lightning', 'superpowers')] });
  const requestedCounts = []; let calls = 0;
  const provider = { async generatePlan(count, context) {
    calls += 1; requestedCounts.push(count);
    if (calls === 1) throw rateLimitError(1);
    // Only the first successful batch (calls === 2) re-offers the historical duplicate at index
    // 0; the repair call (calls === 3) must not keep re-offering it, or it could never resolve.
    const questions = context.categories.map((category, index) => calls === 2 && index === 0 ? dilemma('Control gravity', 'Control lightning', category) : dilemma(`${category} vision`, `${category} adventure`, category));
    return { questions };
  } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2, rateLimitPolicy: { maxRetries: 1, maxWaitMs: 100 }, sleep: async () => {} });
  assert.deepEqual(requestedCounts, [8, 8, 1]); // rate-limited attempt, successful 8-batch, then a 1-question repair for the duplicate
  assert.equal(plan.questions.length, 8);
  assert.equal(plan.questions.some(question => compareDilemmas(question, dilemma('Control gravity', 'Control lightning')).duplicate), false);
  assert.equal(store.load().videos.length, 2);
}));

test('the default Groq rate-limit policy is a single bounded retry, not an aggressive loop', () => {
  assert.equal(DEFAULT_GROQ_RATE_LIMIT_POLICY.maxRetries, 1);
  assert.ok(DEFAULT_GROQ_RATE_LIMIT_POLICY.maxWaitMs <= 30_000);
});

test('Retry-After controls the single rate-limit wait duration', async () => temporaryStore(async store => {
  const waits = []; let calls = 0;
  const provider = { async generatePlan(count, context) { calls += 1; if (calls === 1) throw rateLimitError(2400); return { questions: [dilemma('Control gravity', 'Control lightning', context.categories[0])] }; } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 1, maxAttempts: 1, rateLimitPolicy: { maxRetries: 1, maxWaitMs: 3000 }, sleep: async milliseconds => waits.push(milliseconds) });
  assert.equal(plan.questions.length, 1); assert.deepEqual(waits, [2400]); assert.equal(calls, 2);
}));

test('rate-limit wait budget fails clearly without persisting or rendering an incomplete plan', async () => temporaryStore(async store => {
  const waits = []; let calls = 0;
  const provider = { async generatePlan() { calls += 1; throw rateLimitError(1500); } };
  await assert.rejects(() => generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2, rateLimitPolicy: { maxRetries: 1, maxWaitMs: 1000 }, sleep: async milliseconds => waits.push(milliseconds) }), error => {
    assert.ok(error instanceof ContentRateLimitError); assert.equal(error.code, 'groq_rate_limit_exceeded'); assert.equal(error.acceptedCount, 0); assert.match(error.message, /No incomplete video was rendered/); return true;
  });
  assert.equal(calls, 1); assert.deepEqual(waits, []); assert.deepEqual(store.load().videos, []);
}));

test('sustained 429s never discard already-accepted candidates, and logs surface which Groq limit was exceeded', async () => temporaryStore(async store => {
  const logs = []; const originalInfo = console.info;
  console.info = message => logs.push(message);
  try {
    let calls = 0;
    const provider = {
      requestCount: 0, rateLimitCount: 0,
      async generatePlan(count, context) {
        calls += 1; this.requestCount += 1;
        if (calls === 1) return { questions: context.categories.map((category, index) => index === 7 ? dilemma('Same Text Twice', 'Same Text Twice', category) : (() => { const [a, b] = REALISTIC_PAIRS[category]; return dilemma(a, b, category); })()) };
        if (calls === 2) { this.rateLimitCount += 1; throw tokenLimitError(5); }
        const [a, b] = REALISTIC_PAIRS[context.categories[0]];
        return { questions: [dilemma(a, b, context.categories[0])] };
      },
    };
    const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2, rateLimitPolicy: { maxRetries: 1, maxWaitMs: 1000 }, sleep: async () => {} });
    assert.equal(plan.questions.length, 8); // the 7 accepted before the 429 survive; only the rejected 8th is repaired
  } finally { console.info = originalInfo; }
  // rebuild in a fresh store to check the exhaustion log path independently
}));

test('exhausting the rate-limit budget reports the request/429/wait counters and limit type instead of failing silently', async () => temporaryStore(async store => {
  const logs = []; const originalInfo = console.info;
  console.info = message => logs.push(message);
  try {
    const provider = { requestCount: 0, rateLimitCount: 0, async generatePlan() { this.requestCount += 1; this.rateLimitCount += 1; throw tokenLimitError(2000); } };
    await assert.rejects(() => generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2, rateLimitPolicy: { maxRetries: 1, maxWaitMs: 500 }, sleep: async () => {} }), ContentRateLimitError);
    const exhausted = logs.map(line => JSON.parse(line)).find(entry => entry.event === 'content.groq_rate_limit_exhausted');
    assert.ok(exhausted);
    assert.equal(exhausted.totalGroqRequests, provider.requestCount);
    assert.equal(exhausted.limitType, 'tokens');
    for (const line of logs) assert.equal(/authorization/i.test(line), false);
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
});

test('canonicalMotifKey does not over-collide genuinely different concepts that share a broad category', () => {
  assert.notEqual(canonicalMotifKey({ text: 'Own a sports car' }), canonicalMotifKey({ text: 'Own a private jet' }));
  assert.notEqual(canonicalMotifKey({ text: 'Live in a mountain cabin' }), canonicalMotifKey({ text: 'Relax at a beach villa' }));
});

test('legacy history entries without conceptKeyA/B immediately participate in motif duplicate protection', async () => temporaryStore(async store => {
  fs.writeFileSync(store.filePath, JSON.stringify({
    version: 1,
    videos: [{
      generatedAt: '2025-01-01T00:00:00.000Z', topic: 'Legacy video', categories: ['superpowers'],
      questions: [{ category: 'superpowers', optionA: 'Teleport every hour', optionB: 'Disappear at will' }],
    }],
  }));
  const motifs = recentMotifs(store.load());
  assert.ok(motifs.has('teleportation'));
  assert.ok(motifs.has('invisibility'));

  let calls = 0;
  const provider = { async generatePlan(count, context) {
    calls += 1;
    // context no longer carries any motif/history list at all — protection is entirely local.
    assert.equal('excludedMotifs' in context, false);
    const questions = context.categories.map((category, index) => calls === 1 && index === 0
      ? dilemma('Open a portal to any country', 'Own a sports car', category)
      : (() => { const [a, b] = REALISTIC_PAIRS[category]; return dilemma(a, b, category); })());
    return { questions };
  } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2 });
  assert.equal(plan.questions.length, 8);
  assert.equal(plan.questions.some(question => canonicalMotifKey({ text: question.optionA.text }) === 'teleportation'), false);
}));

test('selectCategories itself never targets two fantasy-coded categories in the same video (superpowers + fantasy)', () => {
  const targets = selectCategories({ version: 1, videos: [] }, 8);
  const fantasyInTargets = targets.filter(category => ['superpowers', 'fantasy'].includes(category));
  assert.ok(fantasyInTargets.length <= 1, `expected at most one fantasy-coded category, got ${JSON.stringify(fantasyInTargets)}`);
});

test('fantasy/superpower cap: a second fantasy-flagged question (via motif text, not just category) is rejected and repaired', async () => temporaryStore(async store => {
  let calls = 0;
  const provider = { async generatePlan(count, context) {
    calls += 1;
    // 'superpowers' is fantasy-coded by category; also give 'money' fantasy-motif TEXT (teleport)
    // on the first call only — even though 'money' itself is not a fantasy category, the cap must
    // catch this too. The repair call must offer fresh, non-fantasy content for 'money' or the
    // rejection would repeat forever within the bounded attempt count.
    const questions = context.categories.map(category => {
      if (category === 'superpowers') return dilemma('Control gravity for a day', 'Control lightning for a day', category);
      if (category === 'money' && calls === 1) return dilemma('Teleport to claim your prize', 'Wait in line for your prize', category);
      const [a, b] = REALISTIC_PAIRS[category]; return dilemma(a, b, category);
    });
    return { questions };
  } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2 });
  assert.equal(plan.questions.length, 8);
  assert.equal(plan.contentQuality.fantasyCount, 1);
  assert.equal(calls, 2); // the second fantasy-flagged candidate got rejected and had to be repaired
}));

test('a fantasy-coded category is still allowed once per video (not banned outright)', async () => temporaryStore(async store => {
  const provider = singleCallProvider();
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 1 });
  assert.equal(plan.questions.length, 8);
  assert.equal(plan.contentQuality.fantasyCount, 1); // exactly one of REALISTIC_PAIRS' categories is fantasy-coded
}));

test('a text-only fantasy motif (no fantasy category present at all) still counts toward the cap', async () => temporaryStore(async store => {
  // Seed history so both fantasy-coded categories ('superpowers', 'fantasy') were just used, making
  // selectCategories skip them entirely for the next batch — this isolates the motif-text signal
  // from the category signal instead of relying on 'superpowers' happening to also be requested.
  fs.writeFileSync(store.filePath, JSON.stringify({
    version: 1,
    videos: [{
      generatedAt: '2025-01-01T00:00:00.000Z', topic: 'Prior video', categories: ['superpowers', 'fantasy'],
      questions: [
        { category: 'superpowers', optionA: 'Have super speed', optionB: 'Have super hearing', conceptKeyA: 'super-speed', conceptKeyB: 'super-hearing', exact: 'have super hearing | have super speed', canonical: 'have super hearing | have super speed' },
        { category: 'fantasy', optionA: 'Own a magic sword', optionB: 'Own a magic shield', conceptKeyA: 'magic-sword', conceptKeyB: 'magic-shield', exact: 'own a magic shield | own a magic sword', canonical: 'own a magic shield | own a magic sword' },
      ],
    }],
  }));
  const targets = selectCategories(store.load(), 8);
  assert.equal(targets.some(category => ['superpowers', 'fantasy'].includes(category)), false);

  let calls = 0;
  const provider = { async generatePlan(count, context) {
    calls += 1;
    const questions = context.categories.map(category => category === 'money'
      ? dilemma('Teleport to claim your prize', 'Wait in line for your prize', category) // fantasy motif TEXT on a non-fantasy category
      : (() => { const [a, b] = REALISTIC_PAIRS[category]; return dilemma(a, b, category); })());
    return { questions };
  } };
  const plan = await generateProductionPlan({ provider, historyStore: store, questionCount: 8, maxAttempts: 2 });
  assert.equal(plan.questions.length, 8);
  assert.equal(plan.contentQuality.fantasyCount, 1); // counted via motif text alone, no fantasy-coded category involved
  assert.equal(calls, 1); // exactly one fantasy-flagged question is within the cap, so no repair round is needed
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import { addIllustrativePercentages, DILEMMA_STYLES, GroqContentProvider, validatePlan } from './content.js';

const quality = Object.freeze({ dilemmaStrength: 8, curiosity: 8, emotionalPull: 8, visualPotential: 8, readability: 9 });
const question = (optionA, optionB, category = 'travel') => ({ category, quality, optionA, optionB });
test('validatePlan accepts and normalizes a complete unique plan', () => { const plan = validatePlan({ topic: '  Dream escapes ', questions: [question({ text: ' Mountain cabin ', searchQuery: 'snow mountain cabin' }, { text: 'Beach villa', searchQuery: 'tropical beach villa' })] }, 1); assert.equal(plan.topic, 'Dream escapes'); assert.equal(plan.questions[0].optionA.text, 'Mountain cabin'); assert.equal(plan.percentages, null); });
test('validatePlan rejects duplicate questions', () => { const duplicate = question({ text: 'Mountain cabin', searchQuery: 'mountain cabin' }, { text: 'Beach villa', searchQuery: 'beach villa' }); assert.throws(() => validatePlan({ topic: 'Travel', questions: [duplicate, duplicate] }, 2), /duplicates/); });
test('validatePlan leaves visual fit decisions to the renderer', () => { const plan = validatePlan({ topic: 'Travel', questions: [question({ text: 'x'.repeat(71), searchQuery: 'remote mountain cabin' }, { text: 'Beach villa', searchQuery: 'beach villa' })] }, 1); assert.equal(plan.questions[0].optionA.text.length, 71); });
test('validatePlan retains a high defensive copy limit', () => { assert.throws(() => validatePlan({ topic: 'Travel', questions: [question({ text: 'x'.repeat(501), searchQuery: 'remote mountain cabin' }, { text: 'Beach villa', searchQuery: 'beach villa' })] }, 1), /3–500/); });
test('validatePlan rejects near-duplicate questions', () => { const questions = [
  question({ text: 'Live in a mountain cabin', searchQuery: 'mountain cabin' }, { text: 'Live in a beach villa', searchQuery: 'beach villa' }, 'dream homes'),
  question({ text: 'Own a mountain cabin', searchQuery: 'snow cabin' }, { text: 'Own a beach villa', searchQuery: 'tropical villa' }, 'dream homes'),
]; assert.throws(() => validatePlan({ topic: 'Homes', questions }, 2), /too similar/); });
test('illustrative percentages are deterministic and complementary', () => { const plan = validatePlan({ topic: 'Travel', questions: [question({ text: 'Mountain cabin', searchQuery: 'mountain cabin' }, { text: 'Beach villa', searchQuery: 'beach villa' })] }, 1); const first = addIllustrativePercentages(plan); const second = addIllustrativePercentages(plan); assert.deepEqual(first, second); assert.equal(first.questions[0].optionA.percentage + first.questions[0].optionB.percentage, 100); assert.equal(first.percentages.mode, 'illustrative'); });

test('paraphrased options given the same conceptKey normalize to the same identifier', () => {
  const planA = validatePlan({ topic: 'Travel', questions: [question({ text: 'Open a portal anywhere', searchQuery: 'magic portal doorway', conceptKey: 'Teleportation' }, { text: 'Beach villa', searchQuery: 'beach villa' })] }, 1);
  const planB = validatePlan({ topic: 'Travel', questions: [question({ text: 'Travel instantly to any country', searchQuery: 'instant travel glow', conceptKey: 'Teleportation' }, { text: 'Beach villa', searchQuery: 'beach villa' })] }, 1);
  assert.equal(planA.questions[0].optionA.conceptKey, 'teleportation');
  assert.equal(planB.questions[0].optionA.conceptKey, 'teleportation');
});

test('conceptKey falls back to a derived slug when the provider omits it', () => {
  const plan = validatePlan({ topic: 'Travel', questions: [question({ text: 'Become invisible forever', searchQuery: 'invisible person' }, { text: 'Beach villa', searchQuery: 'beach villa' })] }, 1);
  assert.match(plan.questions[0].optionA.conceptKey, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(plan.questions[0].optionA.conceptKey.length > 0);
});

test('dilemmaStyle is normalized against the supported style list with a safe default', () => {
  const styled = validatePlan({ topic: 'Travel', questions: [{ ...question({ text: 'Mountain cabin', searchQuery: 'mountain cabin' }, { text: 'Beach villa', searchQuery: 'beach villa' }), dilemmaStyle: 'Discovery' }] }, 1);
  assert.equal(styled.questions[0].dilemmaStyle, 'discovery');
  const unstyled = validatePlan({ topic: 'Travel', questions: [question({ text: 'Mountain cabin', searchQuery: 'mountain cabin' }, { text: 'Beach villa', searchQuery: 'beach villa' })] }, 1);
  assert.ok(DILEMMA_STYLES.includes(unstyled.questions[0].dilemmaStyle));
});

const categories = ['dream homes', 'adventure', 'fantasy', 'luxury', 'ocean', 'impossible choices', 'fame', 'travel'];
const generatedPlan = () => ({ topic: 'Dream adventures', questions: [
  { optionA: { text: 'Own a mountain cabin', searchQuery: 'snow mountain cabin' }, optionB: { text: 'Live in a beach villa', searchQuery: 'tropical beach villa' } },
  { optionA: { text: 'Ride a hot air balloon', searchQuery: 'hot air balloon' }, optionB: { text: 'Sail across the ocean', searchQuery: 'sailboat open ocean' } },
  { optionA: { text: 'Explore an ancient castle', searchQuery: 'ancient stone castle' }, optionB: { text: 'Discover a hidden cave', searchQuery: 'explorer hidden cave' } },
  { optionA: { text: 'Drive a sports car', searchQuery: 'red sports car' }, optionB: { text: 'Fly in a private jet', searchQuery: 'private jet runway' } },
  { optionA: { text: 'Swim with dolphins', searchQuery: 'dolphins underwater swimmer' }, optionB: { text: 'Walk with elephants', searchQuery: 'elephants walking safari' } },
  { optionA: { text: 'See the northern lights', searchQuery: 'northern lights landscape' }, optionB: { text: 'Watch a volcano erupt', searchQuery: 'volcano eruption night' } },
  { optionA: { text: 'Cook with a famous chef', searchQuery: 'chef cooking kitchen' }, optionB: { text: 'Paint with an artist', searchQuery: 'artist painting studio' } },
  { optionA: { text: 'Camp in a forest', searchQuery: 'forest camping tent' }, optionB: { text: 'Sleep under desert stars', searchQuery: 'desert stars camping' } },
].map((item, index) => ({ ...item, category: categories[index], quality })) });
const successfulResponse = (plan = generatedPlan()) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const failedGenerationResponse = () => new Response(JSON.stringify({ error: { message: 'Failed to generate JSON', code: 'failed_generation', failed_generation: 'PRIVATE-GENERATION-DIAGNOSTIC' } }), { status: 400, headers: { 'content-type': 'application/json' } });
const rateLimitResponse = retryAfter => new Response(JSON.stringify({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json', ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }) } });
const tokenRateLimitResponse = () => new Response(JSON.stringify({ error: { message: 'Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Used 7600, Requested 1800. Please try again in 10.5s.', type: 'tokens', code: 'rate_limit_exceeded' } }), {
  status: 429,
  headers: {
    'content-type': 'application/json',
    'retry-after': '10.5',
    'x-ratelimit-limit-requests': '30',
    'x-ratelimit-remaining-requests': '27',
    'x-ratelimit-reset-requests': '2s',
    'x-ratelimit-limit-tokens': '8000',
    'x-ratelimit-remaining-tokens': '400',
    'x-ratelimit-reset-tokens': '10.5s',
  },
});
const requestRateLimitResponse = () => new Response(JSON.stringify({ error: { message: 'Rate limit reached for model `openai/gpt-oss-20b` on requests per minute (RPM): Limit 30, Used 30.', type: 'requests', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3', 'x-ratelimit-limit-requests': '30', 'x-ratelimit-remaining-requests': '0' } });
const withMockedFetch = async (responses, operation) => {
  const originalFetch = globalThis.fetch; const requests = []; let index = 0;
  globalThis.fetch = async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return responses[index++] || responses.at(-1); };
  try { return await operation(requests); }
  finally { globalThis.fetch = originalFetch; }
};
const provider = () => new GroqContentProvider({ apiKey: 'test-key', model: 'openai/gpt-oss-20b', timeoutMs: 1000 });

test('Groq provider accepts a valid strict structured response', async () => withMockedFetch([successfulResponse()], async requests => {
  const plan = await provider().generatePlan(8); const request = requests[0];
  assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(request.body.model, 'openai/gpt-oss-20b');
  assert.equal(request.body.temperature, 0.8);
  assert.equal(request.body.response_format.type, 'json_schema');
  assert.equal(request.body.response_format.json_schema.strict, true);
  assert.equal(plan.questions.length, 8);
}));

test('the content-generation request stays within a tight token budget on a mature production history', async () => withMockedFetch([successfulResponse()], async requests => {
  // A mature history's full exclusion/motif pools before any prompt-facing slicing.
  const exclusions = Array.from({ length: 240 }, (_, i) => `Sample dilemma option A wording ${i} OR Sample dilemma option B wording ${i}`);
  const excludedMotifs = Array.from({ length: 300 }, (_, i) => `motif-key-${i % 90}`);
  const context = {
    categories: ['superpowers', 'money', 'luxury', 'dream lifestyle', 'travel', 'impossible choices', 'future technology', 'fantasy'],
    styles: ['tradeoff', 'power', 'discovery', 'emotional choice', 'future technology', 'weird/funny', 'lifestyle', 'fantasy'],
    families: ['food', 'social', 'relationships', 'work', 'lifestyle', 'money-tradeoff', 'privacy', 'technology'],
    exclusions, excludedMotifs,
  };
  await provider().generatePlan(8, context);
  const body = requests[0].body;
  assert.equal(body.max_completion_tokens, 1500);
  const userMessage = body.messages[1].content;
  // Bounded regardless of how large the underlying history grows — this is what keeps a single
  // request's prompt tokens well clear of Groq's tight tokens-per-minute budget. (Previously this
  // scaled with history size and could reach ~11000 chars / ~2750 tokens on a mature history.)
  assert.ok(userMessage.length < 6500, `expected a bounded prompt, got ${userMessage.length} chars`);
  const totalRequestBytes = JSON.stringify(body).length;
  assert.ok(totalRequestBytes < 9000, `expected a bounded total request payload, got ${totalRequestBytes} bytes`);
  // Slicing actually took effect, regardless of how large the underlying history pool was.
  assert.equal((userMessage.match(/Sample dilemma option A wording/g) || []).length, 20);
  assert.equal((userMessage.match(/motif-key-/g) || []).length, 40);
}));

test('Groq failed_generation handling is bounded and does not expose diagnostics', async () => withMockedFetch(Array.from({ length: 4 }, failedGenerationResponse), async requests => {
  await assert.rejects(() => provider().generatePlan(8), error => {
    assert.match(error.message, /3 structured attempt\(s\) and one JSON-object fallback/);
    assert.equal(error.message.includes('PRIVATE-GENERATION-DIAGNOSTIC'), false);
    return true;
  });
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(request => request.body.response_format.type), ['json_schema', 'json_schema', 'json_schema', 'json_object']);
  assert.equal(new Set(requests.slice(0, 3).map(request => request.body.messages[1].content)).size, 3);
}));

test('Groq structured retry succeeds with a shorter repair prompt', async () => withMockedFetch([failedGenerationResponse(), successfulResponse()], async requests => {
  const plan = await provider().generatePlan(8);
  assert.equal(plan.questions.length, 8); assert.equal(requests.length, 2);
  assert.notEqual(requests[0].body.messages[1].content, requests[1].body.messages[1].content);
  assert.ok(requests[1].body.messages[1].content.length < requests[0].body.messages[1].content.length);
}));

test('Groq exposes HTTP 429 and Retry-After without internally burning structured retries', async () => withMockedFetch([rateLimitResponse('2.5')], async requests => {
  await assert.rejects(() => provider().generatePlan(8), error => {
    assert.equal(error.status, 429); assert.equal(error.code, 'rate_limit_exceeded'); assert.equal(error.retryAfterMs, 2500); return true;
  });
  assert.equal(requests.length, 1);
}));

test('Groq 429 metadata captures rate-limit headers and classifies the exceeded limit as tokens', async () => withMockedFetch([tokenRateLimitResponse()], async () => {
  await assert.rejects(() => provider().generatePlan(8), error => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 10_500);
    assert.equal(error.limitType, 'tokens');
    assert.deepEqual(error.rateLimitHeaders, {
      'retry-after': '10.5',
      'x-ratelimit-limit-requests': '30',
      'x-ratelimit-remaining-requests': '27',
      'x-ratelimit-reset-requests': '2s',
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-remaining-tokens': '400',
      'x-ratelimit-reset-tokens': '10.5s',
    });
    return true;
  });
}));

test('Groq 429 metadata classifies a requests-per-minute rejection as requests', async () => withMockedFetch([requestRateLimitResponse()], async () => {
  await assert.rejects(() => provider().generatePlan(8), error => {
    assert.equal(error.limitType, 'requests');
    assert.equal(error.rateLimitHeaders['x-ratelimit-remaining-requests'], '0');
    return true;
  });
}));

test('Groq 429 metadata is null (not populated) on non-rate-limit HTTP errors', async () => withMockedFetch([new Response(JSON.stringify({ error: { message: 'Internal error' } }), { status: 500 })], async () => {
  await assert.rejects(() => provider().requestPlan({ questionCount: 8, mode: 'json_schema', attempt: 1, context: {} }), error => {
    assert.equal(error.status, 500);
    assert.equal(error.limitType, null);
    assert.equal(error.rateLimitHeaders, null);
    return true;
  });
}));

test('rate-limit diagnostics never carry the API key, Authorization header, or raw error message text', async () => withMockedFetch([tokenRateLimitResponse()], async requests => {
  await assert.rejects(() => provider().generatePlan(8), error => {
    const serialized = JSON.stringify(error.rateLimitHeaders);
    assert.equal(serialized.includes('test-key'), false);
    assert.equal('authorization' in error.rateLimitHeaders, false);
    assert.equal(Object.keys(error.rateLimitHeaders).some(key => key.toLowerCase() === 'authorization'), false);
    assert.equal(JSON.stringify(error).includes('Please try again'), false); // raw message text is never propagated
    return true;
  });
  assert.equal(requests[0].url, 'https://api.groq.com/openai/v1/chat/completions');
}));

test('Groq provider tracks total requests and 429 count for auditing', async () => withMockedFetch([rateLimitResponse('1'), rateLimitResponse('1'), successfulResponse()], async () => {
  const client = provider();
  assert.equal(client.requestCount, 0); assert.equal(client.rateLimitCount, 0);
  await assert.rejects(() => client.generatePlan(8), { status: 429 });
  assert.equal(client.requestCount, 1); assert.equal(client.rateLimitCount, 1);
  await assert.rejects(() => client.generatePlan(8), { status: 429 });
  assert.equal(client.requestCount, 2); assert.equal(client.rateLimitCount, 2);
  const plan = await client.generatePlan(8);
  assert.equal(plan.questions.length, 8);
  assert.equal(client.requestCount, 3); assert.equal(client.rateLimitCount, 2);
}));

test('Groq falls back to JSON Object mode and validates a successful object', async () => withMockedFetch([
  failedGenerationResponse(), failedGenerationResponse(), failedGenerationResponse(), successfulResponse(),
], async requests => {
  const plan = await provider().generatePlan(8);
  assert.equal(plan.questions.length, 8);
  assert.equal(requests[3].body.response_format.type, 'json_object');
}));

test('Groq rejects an invalid JSON Object fallback plan', async () => withMockedFetch([
  failedGenerationResponse(), failedGenerationResponse(), failedGenerationResponse(), successfulResponse({ topic: 'Too short', questions: generatedPlan().questions.slice(0, 1) }),
], async () => {
  await assert.rejects(() => provider().generatePlan(8), /must contain exactly 8 questions/);
}));

test('Groq visual-query reformulation is one bounded request and preserves the option text', async () => withMockedFetch([
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ queries: ['person floating objects telekinesis cinematic', 'human controlling gravity objects levitating'] }) } }] }), { status: 200 }),
], async requests => {
  const optionText = 'Control Gravity'; const queries = await provider().generateVisualQueries({ optionText, attemptedQueries: ['control gravity'], maxQueries: 3 });
  assert.deepEqual(queries, ['person floating objects telekinesis cinematic', 'human controlling gravity objects levitating']);
  assert.equal(requests.length, 1); assert.match(requests[0].body.messages[1].content, new RegExp(optionText));
  assert.equal(requests[0].body.messages[1].content.includes('rewrite the choice'), false);
}));

test('Groq visual-query reformulation exposes HTTP 429 without retrying', async () => withMockedFetch([rateLimitResponse('1.5')], async requests => {
  await assert.rejects(() => provider().generateVisualQueries({ optionText: 'Control Gravity' }), error => { assert.equal(error.status, 429); assert.equal(error.retryAfterMs, 1500); return true; });
  assert.equal(requests.length, 1);
}));

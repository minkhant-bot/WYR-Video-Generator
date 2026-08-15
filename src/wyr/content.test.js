import test from 'node:test';
import assert from 'node:assert/strict';
import { addIllustrativePercentages, GroqContentProvider, parseGroqResetDuration, validatePlan } from './content.js';

const question = (a, b, category = 'travel') => ({
  category,
  optionA: { text: a, searchQuery: `${a} concept photo` },
  optionB: { text: b, searchQuery: `${b} concept photo` },
});

test('validatePlan accepts a minimal plan with no topic, conceptKey, dilemmaStyle, contentFamily, or quality fields', () => {
  const plan = validatePlan({ questions: [question('Mountain cabin', 'Beach villa')] }, 1);
  assert.equal(plan.questions[0].optionA.text, 'Mountain cabin');
  assert.equal(plan.questions[0].optionA.conceptKey, undefined);
  assert.equal(plan.questions[0].dilemmaStyle, undefined);
  assert.equal(plan.questions[0].contentFamily, undefined);
  assert.equal(plan.questions[0].quality, undefined);
  assert.equal('topic' in plan, false);
});
test('validatePlan rejects duplicate questions', () => { const duplicate = question('Mountain cabin', 'Beach villa'); assert.throws(() => validatePlan({ questions: [duplicate, duplicate] }, 2), /duplicates/); });
test('validatePlan leaves visual fit decisions to the renderer', () => { const plan = validatePlan({ questions: [question('x'.repeat(71), 'Beach villa')] }, 1); assert.equal(plan.questions[0].optionA.text.length, 71); });
test('validatePlan retains a high defensive copy limit', () => { assert.throws(() => validatePlan({ questions: [question('x'.repeat(501), 'Beach villa')] }, 1), /3–500/); });
test('validatePlan rejects near-duplicate questions', () => { const questions = [
  question('Live in a mountain cabin', 'Live in a beach villa', 'dream homes'),
  question('Own a mountain cabin', 'Own a beach villa', 'dream homes'),
]; assert.throws(() => validatePlan({ questions }, 2), /too similar/); });
test('illustrative percentages are deterministic and complementary', () => { const plan = validatePlan({ questions: [question('Mountain cabin', 'Beach villa')] }, 1); const first = addIllustrativePercentages(plan); const second = addIllustrativePercentages(plan); assert.deepEqual(first, second); assert.equal(first.questions[0].optionA.percentage + first.questions[0].optionB.percentage, 100); assert.equal(first.percentages.mode, 'illustrative'); });

const generatedPlan = () => ({ questions: [
  { category: 'dream homes', optionA: { text: 'Own a mountain cabin', searchQuery: 'snow mountain cabin' }, optionB: { text: 'Live in a beach villa', searchQuery: 'tropical beach villa' } },
  { category: 'adventure', optionA: { text: 'Ride a hot air balloon', searchQuery: 'hot air balloon' }, optionB: { text: 'Sail across the ocean', searchQuery: 'sailboat open ocean' } },
  { category: 'fantasy', optionA: { text: 'Explore an ancient castle', searchQuery: 'ancient stone castle' }, optionB: { text: 'Discover a hidden cave', searchQuery: 'explorer hidden cave' } },
  { category: 'luxury', optionA: { text: 'Drive a sports car', searchQuery: 'red sports car' }, optionB: { text: 'Fly in a private jet', searchQuery: 'private jet runway' } },
  { category: 'ocean', optionA: { text: 'Swim with dolphins', searchQuery: 'dolphins underwater swimmer' }, optionB: { text: 'Walk with elephants', searchQuery: 'elephants walking safari' } },
  { category: 'impossible choices', optionA: { text: 'See the northern lights', searchQuery: 'northern lights landscape' }, optionB: { text: 'Watch a volcano erupt', searchQuery: 'volcano eruption night' } },
  { category: 'food', optionA: { text: 'Cook with a famous chef', searchQuery: 'chef cooking kitchen' }, optionB: { text: 'Paint with an artist', searchQuery: 'artist painting studio' } },
  { category: 'travel', optionA: { text: 'Camp in a forest', searchQuery: 'forest camping tent' }, optionB: { text: 'Sleep under desert stars', searchQuery: 'desert stars camping' } },
] });
const successfulResponse = (plan = generatedPlan()) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const successfulResponseWithHeaders = (headers, plan = generatedPlan()) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
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

test('one lightweight Groq call produces all 8 usable questions', async () => withMockedFetch([successfulResponse()], async requests => {
  const plan = await provider().generatePlan(8); const request = requests[0];
  assert.equal(requests.length, 1);
  assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(request.body.model, 'openai/gpt-oss-20b');
  assert.equal(request.body.response_format.type, 'json_schema');
  assert.equal(request.body.response_format.json_schema.strict, true);
  assert.equal(plan.questions.length, 8);
  assert.equal('topic' in request.body, false);
}));

test('the minimal schema and prompt keep a normal request small — no history/motif dump, low completion budget', async () => withMockedFetch([successfulResponse()], async requests => {
  const categories = ['superpowers', 'money', 'luxury', 'dream lifestyle', 'travel', 'impossible choices', 'future technology', 'fantasy'];
  await provider().generatePlan(8, { categories });
  const body = requests[0].body;
  assert.ok(body.max_completion_tokens <= 900, `expected a small completion budget, got ${body.max_completion_tokens}`);
  const userMessage = body.messages[1].content;
  assert.ok(userMessage.length < 1200, `expected a short prompt, got ${userMessage.length} chars`);
  const schemaChars = JSON.stringify(body.response_format).length;
  assert.ok(schemaChars < 1600, `expected a small schema, got ${schemaChars} chars`);
  // No conceptKey/dilemmaStyle/contentFamily/quality anywhere in the schema.
  const schemaText = JSON.stringify(body.response_format);
  for (const field of ['conceptKey', 'dilemmaStyle', 'contentFamily', 'quality']) assert.equal(schemaText.includes(field), false, `schema unexpectedly mentions ${field}`);
}));

test('a repair request for only the missing count stays just as small as the initial request', async () => withMockedFetch([successfulResponse({ questions: generatedPlan().questions.slice(0, 2) })], async requests => {
  await provider().generatePlan(2, { categories: ['food', 'travel'] });
  const userMessage = requests[0].body.messages[1].content;
  assert.ok(userMessage.length < 1200, `expected a short repair prompt, got ${userMessage.length} chars`);
  assert.doesNotMatch(userMessage, /Do not repeat or paraphrase|already-used idea/); // no history dump
}));

test('Groq failed_generation handling is bounded and does not expose diagnostics', async () => withMockedFetch(Array.from({ length: 3 }, failedGenerationResponse), async requests => {
  await assert.rejects(() => provider().generatePlan(8), error => {
    assert.match(error.message, /2 structured attempt\(s\) and one JSON-object fallback/);
    assert.equal(error.message.includes('PRIVATE-GENERATION-DIAGNOSTIC'), false);
    return true;
  });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(request => request.body.response_format.type), ['json_schema', 'json_schema', 'json_object']);
}));

test('Groq structured retry succeeds with a repair prompt', async () => withMockedFetch([failedGenerationResponse(), successfulResponse()], async requests => {
  const plan = await provider().generatePlan(8);
  assert.equal(plan.questions.length, 8); assert.equal(requests.length, 2);
  assert.notEqual(requests[0].body.messages[1].content, requests[1].body.messages[1].content);
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
    assert.equal(JSON.stringify(error).includes('Please try again'), false);
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
  failedGenerationResponse(), failedGenerationResponse(), successfulResponse(),
], async requests => {
  const plan = await provider().generatePlan(8);
  assert.equal(plan.questions.length, 8);
  assert.equal(requests[2].body.response_format.type, 'json_object');
}));

test('Groq rejects an invalid JSON Object fallback plan', async () => withMockedFetch([
  failedGenerationResponse(), failedGenerationResponse(), successfulResponse({ questions: generatedPlan().questions.slice(0, 1) }),
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

test('parseGroqResetDuration handles the documented Groq duration formats', () => {
  assert.equal(parseGroqResetDuration('7.66s'), 7660);
  assert.equal(parseGroqResetDuration('1m7.66s'), 67660);
  assert.equal(parseGroqResetDuration('500ms'), 500);
  assert.equal(parseGroqResetDuration('2h'), 7_200_000);
  assert.equal(parseGroqResetDuration('3'), 3000); // plain number treated as seconds
  assert.equal(parseGroqResetDuration(''), null);
  assert.equal(parseGroqResetDuration(undefined), null);
  assert.equal(parseGroqResetDuration('not-a-duration'), null);
});

test('a low remaining-token reading from a prior response proactively throttles the next request instead of risking a 429', async () => withMockedFetch([
  successfulResponseWithHeaders({ 'x-ratelimit-remaining-tokens': '500', 'x-ratelimit-reset-tokens': '3s' }),
  successfulResponse(),
], async requests => {
  const waits = [];
  const client = new GroqContentProvider({ apiKey: 'test-key', model: 'openai/gpt-oss-20b', timeoutMs: 1000, sleep: async ms => waits.push(ms) });
  await client.generatePlan(8);
  assert.deepEqual(waits, []); // no prior snapshot on the very first call — nothing to throttle against
  await client.generatePlan(8);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0 && waits[0] <= 3000, `expected a bounded wait, got ${waits[0]}`);
  assert.equal(client.proactiveThrottleCount, 1);
  assert.equal(client.proactiveThrottleWaitedMs, waits[0]);
  assert.equal(requests.length, 2); // throttling delays the request, it never skips or duplicates it
}));

test('healthy remaining-token capacity never triggers a proactive wait', async () => withMockedFetch([
  successfulResponseWithHeaders({ 'x-ratelimit-remaining-tokens': '7500', 'x-ratelimit-reset-tokens': '3s' }),
  successfulResponse(),
], async () => {
  const waits = [];
  const client = new GroqContentProvider({ apiKey: 'test-key', model: 'openai/gpt-oss-20b', timeoutMs: 1000, sleep: async ms => waits.push(ms) });
  await client.generatePlan(8);
  await client.generatePlan(8);
  assert.deepEqual(waits, []);
  assert.equal(client.proactiveThrottleCount, 0);
}));

test('the proactive wait is bounded well under a full reset window even when the reported reset is long', async () => withMockedFetch([
  successfulResponseWithHeaders({ 'x-ratelimit-remaining-tokens': '100', 'x-ratelimit-reset-tokens': '58s' }),
  successfulResponse(),
], async () => {
  const waits = [];
  const client = new GroqContentProvider({ apiKey: 'test-key', model: 'openai/gpt-oss-20b', timeoutMs: 1000, sleep: async ms => waits.push(ms) });
  await client.generatePlan(8);
  await client.generatePlan(8);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] <= 20_000, `expected the wait to be capped at 20s, got ${waits[0]}`);
}));

test('a missing or unparseable reset-tokens header fails open (no throttle, no crash) and relies on the reactive retry path', async () => withMockedFetch([
  successfulResponseWithHeaders({ 'x-ratelimit-remaining-tokens': '100' }), // no reset-tokens header at all
  successfulResponse(),
], async () => {
  const waits = [];
  const client = new GroqContentProvider({ apiKey: 'test-key', model: 'openai/gpt-oss-20b', timeoutMs: 1000, sleep: async ms => waits.push(ms) });
  await client.generatePlan(8);
  const plan = await client.generatePlan(8);
  assert.deepEqual(waits, []);
  assert.equal(plan.questions.length, 8);
}));

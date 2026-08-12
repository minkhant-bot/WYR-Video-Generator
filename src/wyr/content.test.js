import test from 'node:test';
import assert from 'node:assert/strict';
import { addIllustrativePercentages, GroqContentProvider, validatePlan } from './content.js';

test('validatePlan accepts and normalizes a complete unique plan', () => { const plan = validatePlan({ topic: '  Dream escapes ', questions: [{ optionA: { text: ' Mountain cabin ', searchQuery: 'snow mountain cabin' }, optionB: { text: 'Beach villa', searchQuery: 'tropical beach villa' } }] }, 1); assert.equal(plan.topic, 'Dream escapes'); assert.equal(plan.questions[0].optionA.text, 'Mountain cabin'); assert.equal(plan.percentages, null); });
test('validatePlan rejects duplicate questions', () => { const question = { optionA: { text: 'Mountain cabin', searchQuery: 'mountain cabin' }, optionB: { text: 'Beach villa', searchQuery: 'beach villa' } }; assert.throws(() => validatePlan({ topic: 'Travel', questions: [question, question] }, 2), /duplicates/); });
test('validatePlan leaves visual fit decisions to the renderer', () => { const plan = validatePlan({ topic: 'Travel', questions: [{ optionA: { text: 'x'.repeat(71), searchQuery: 'cabin' }, optionB: { text: 'Beach villa', searchQuery: 'beach villa' } }] }, 1); assert.equal(plan.questions[0].optionA.text.length, 71); });
test('validatePlan retains a high defensive copy limit', () => { assert.throws(() => validatePlan({ topic: 'Travel', questions: [{ optionA: { text: 'x'.repeat(501), searchQuery: 'cabin' }, optionB: { text: 'Beach villa', searchQuery: 'beach villa' } }] }, 1), /3–500/); });
test('validatePlan rejects near-duplicate questions', () => { const questions = [
  { optionA: { text: 'Live in a mountain cabin', searchQuery: 'mountain cabin' }, optionB: { text: 'Live in a beach villa', searchQuery: 'beach villa' } },
  { optionA: { text: 'Own a mountain cabin', searchQuery: 'snow cabin' }, optionB: { text: 'Own a beach villa', searchQuery: 'tropical villa' } },
]; assert.throws(() => validatePlan({ topic: 'Homes', questions }, 2), /too similar/); });
test('illustrative percentages are deterministic and complementary', () => { const plan = validatePlan({ topic: 'Travel', questions: [{ optionA: { text: 'Mountain cabin', searchQuery: 'mountain cabin' }, optionB: { text: 'Beach villa', searchQuery: 'beach villa' } }] }, 1); const first = addIllustrativePercentages(plan); const second = addIllustrativePercentages(plan); assert.deepEqual(first, second); assert.equal(first.questions[0].optionA.percentage + first.questions[0].optionB.percentage, 100); assert.equal(first.percentages.mode, 'illustrative'); });

const generatedPlan = () => ({ topic: 'Dream adventures', questions: [
  { optionA: { text: 'Own a mountain cabin', searchQuery: 'snow mountain cabin' }, optionB: { text: 'Live in a beach villa', searchQuery: 'tropical beach villa' } },
  { optionA: { text: 'Ride a hot air balloon', searchQuery: 'hot air balloon' }, optionB: { text: 'Sail across the ocean', searchQuery: 'sailboat open ocean' } },
  { optionA: { text: 'Explore an ancient castle', searchQuery: 'ancient stone castle' }, optionB: { text: 'Discover a hidden cave', searchQuery: 'explorer hidden cave' } },
  { optionA: { text: 'Drive a sports car', searchQuery: 'red sports car' }, optionB: { text: 'Fly in a private jet', searchQuery: 'private jet runway' } },
  { optionA: { text: 'Swim with dolphins', searchQuery: 'dolphins underwater swimmer' }, optionB: { text: 'Walk with elephants', searchQuery: 'elephants walking safari' } },
  { optionA: { text: 'See the northern lights', searchQuery: 'northern lights landscape' }, optionB: { text: 'Watch a volcano erupt', searchQuery: 'volcano eruption night' } },
  { optionA: { text: 'Cook with a famous chef', searchQuery: 'chef cooking kitchen' }, optionB: { text: 'Paint with an artist', searchQuery: 'artist painting studio' } },
  { optionA: { text: 'Camp in a forest', searchQuery: 'forest camping tent' }, optionB: { text: 'Sleep under desert stars', searchQuery: 'desert stars camping' } },
] });
const successfulResponse = (plan = generatedPlan()) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const failedGenerationResponse = () => new Response(JSON.stringify({ error: { message: 'Failed to generate JSON', code: 'failed_generation', failed_generation: 'PRIVATE-GENERATION-DIAGNOSTIC' } }), { status: 400, headers: { 'content-type': 'application/json' } });
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
  assert.equal(request.body.temperature, 0.1);
  assert.equal(request.body.response_format.type, 'json_schema');
  assert.equal(request.body.response_format.json_schema.strict, true);
  assert.equal(plan.questions.length, 8);
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

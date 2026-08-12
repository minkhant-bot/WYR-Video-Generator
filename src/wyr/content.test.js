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
test('Groq provider requests strict structured JSON and validates the response', async () => {
  const originalFetch = globalThis.fetch; let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topic: 'Dream trips', questions: [{ optionA: { text: 'Explore a mountain cabin', searchQuery: 'snowy mountain cabin' }, optionB: { text: 'Relax on a tropical island', searchQuery: 'tropical island beach' } }] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try { const plan = await new GroqContentProvider({ apiKey: 'test-key', model: 'openai/gpt-oss-20b', timeoutMs: 1000 }).generatePlan(1); const body = JSON.parse(request.options.body); assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions'); assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.response_format.json_schema.strict, true); assert.equal(plan.questions.length, 1); }
  finally { globalThis.fetch = originalFetch; }
});

import crypto from 'node:crypto';
import { fetchWithTimeout } from './utils.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const STRUCTURED_ATTEMPTS = 3;
const TEMPERATURE = 0.1;

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
const normalizeOption = (option, index, label) => {
  const text = normalize(option?.text); const searchQuery = normalize(option?.searchQuery);
  if (text.length < 3 || text.length > 500) throw new Error(`Question ${index + 1} option ${label} text must contain 3–500 characters before visual fitting.`);
  if (searchQuery.length < 3 || searchQuery.length > 100) throw new Error(`Question ${index + 1} option ${label} search query must contain 3–100 characters.`);
  return { text, searchQuery };
};

const significantWords = text => new Set(text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(word => word.length > 2 && !['the', 'and', 'for', 'you', 'your', 'with', 'every'].includes(word)));
const similarity = (left, right) => {
  const intersection = [...left].filter(word => right.has(word)).length; const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
};

export const validatePlan = (input, questionCount) => {
  if (!input || typeof input !== 'object') throw new Error('Content plan must be an object.');
  const topic = normalize(input.topic);
  if (topic.length < 3 || topic.length > 80) throw new Error('Topic must contain 3–80 characters.');
  if (!Array.isArray(input.questions) || input.questions.length !== questionCount) throw new Error(`Content plan must contain exactly ${questionCount} questions.`);
  const seen = new Set(); const previousWordSets = [];
  const questions = input.questions.map((question, index) => {
    const optionA = normalizeOption(question?.optionA, index, 'A'); const optionB = normalizeOption(question?.optionB, index, 'B');
    if (optionA.text.toLowerCase() === optionB.text.toLowerCase()) throw new Error(`Question ${index + 1} has identical options.`);
    const signature = [optionA.text, optionB.text].map(text => text.toLowerCase()).sort().join('|');
    if (seen.has(signature)) throw new Error(`Question ${index + 1} duplicates another question.`);
    const words = significantWords(signature);
    if (previousWordSets.some(previous => similarity(words, previous) >= 0.65)) throw new Error(`Question ${index + 1} is too similar to another question.`);
    seen.add(signature); previousWordSets.push(words); return { index, optionA, optionB };
  });
  return { version: 1, topic, percentages: null, questions };
};

export class ContentProvider { async generatePlan() { throw new Error('ContentProvider.generatePlan must be implemented.'); } }

class GroqGenerationError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const planSchema = () => {
  const option = { type: 'object', properties: { text: { type: 'string' }, searchQuery: { type: 'string' } }, required: ['text', 'searchQuery'], additionalProperties: false };
  const question = { type: 'object', properties: { optionA: option, optionB: option }, required: ['optionA', 'optionB'], additionalProperties: false };
  return { type: 'object', properties: { topic: { type: 'string' }, questions: { type: 'array', items: question } }, required: ['topic', 'questions'], additionalProperties: false };
};

const initialPrompt = questionCount => `Create one English Would You Rather topic and exactly ${questionCount} unique questions. For every question provide optionA and optionB. Each option needs only text and searchQuery. Keep option text simple and under 55 characters. Keep each Pexels searchQuery to 2–5 concrete visual words. Use safe, broadly appealing ideas. Do not include percentages or explanations.`;
const repairPrompt = (questionCount, attempt) => attempt === 2
  ? `Return exactly ${questionCount} unique Would You Rather questions as JSON. Use only: topic, questions, optionA, optionB, text, searchQuery. Keep option text under 55 characters. Keep searchQuery concrete and 2–5 words. No percentages or extra fields.`
  : `JSON only. Exactly ${questionCount} questions. Keys only: topic, questions, optionA, optionB, text, searchQuery. Short option text. Concrete 2–5 word searchQuery.`;
const objectPrompt = questionCount => `${repairPrompt(questionCount, 3)} Shape: {"topic":"...","questions":[{"optionA":{"text":"...","searchQuery":"..."},"optionB":{"text":"...","searchQuery":"..."}}]}`;

const groqErrorFromResponse = async response => {
  const raw = await response.text(); let payload;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  const remoteError = payload?.error;
  const failedGeneration = remoteError?.code === 'failed_generation'
    || remoteError?.type === 'failed_generation'
    || remoteError?.failed_generation !== undefined
    || /failed_generation|failed to generate json/i.test(raw);
  if (failedGeneration) return new GroqGenerationError(`Groq generation failed with HTTP ${response.status}.`, 'failed_generation');
  const code = normalize(remoteError?.code || remoteError?.type);
  return new GroqGenerationError(`Groq returned HTTP ${response.status}${code ? ` (${code})` : ''}.`, code || 'http_error');
};

const validateGeneratedPlan = (text, questionCount) => {
  if (!text) throw new GroqGenerationError('Groq returned no JSON content.', 'invalid_generation');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new GroqGenerationError('Groq returned invalid JSON content.', 'invalid_generation'); }
  let plan;
  try { plan = validatePlan(parsed, questionCount); }
  catch (error) { throw new GroqGenerationError(`Groq returned an invalid content plan: ${error.message}`, 'invalid_generation'); }
  for (const question of plan.questions) {
    for (const [label, option] of [['A', question.optionA], ['B', question.optionB]]) {
      if (option.text.length > 68) throw new GroqGenerationError(`Groq question ${question.index + 1} option ${label} exceeds the 68-character production limit.`, 'invalid_generation');
    }
  }
  return plan;
};

export class GroqContentProvider extends ContentProvider {
  constructor({ apiKey, model, timeoutMs }) { super(); this.apiKey = apiKey; this.model = model; this.timeoutMs = timeoutMs; }
  async requestPlan({ questionCount, mode, attempt = 1 }) {
    const structured = mode === 'json_schema';
    const response = await fetchWithTimeout(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: TEMPERATURE,
        max_completion_tokens: 2500,
        messages: [
          { role: 'system', content: 'Return only the requested Would You Rather plan as JSON.' },
          { role: 'user', content: structured ? (attempt === 1 ? initialPrompt(questionCount) : repairPrompt(questionCount, attempt)) : objectPrompt(questionCount) },
        ],
        response_format: structured
          ? { type: 'json_schema', json_schema: { name: 'would_you_rather_plan', strict: true, schema: planSchema() } }
          : { type: 'json_object' },
      }),
    }, this.timeoutMs);
    if (!response.ok) throw await groqErrorFromResponse(response);
    let payload;
    try { payload = await response.json(); }
    catch { throw new GroqGenerationError('Groq returned an invalid API response.', 'invalid_generation'); }
    const message = payload?.choices?.[0]?.message;
    if (message?.refusal) throw new GroqGenerationError('Groq refused content generation.', 'refusal');
    return validateGeneratedPlan(message?.content, questionCount);
  }
  async generatePlan(questionCount) {
    for (let attempt = 1; attempt <= STRUCTURED_ATTEMPTS; attempt += 1) {
      try { return await this.requestPlan({ questionCount, mode: 'json_schema', attempt }); }
      catch (error) {
        if (!['failed_generation', 'invalid_generation'].includes(error.code)) throw error;
      }
    }
    try { return await this.requestPlan({ questionCount, mode: 'json_object' }); }
    catch (error) {
      throw new Error(`Groq content generation failed after ${STRUCTURED_ATTEMPTS} structured attempt(s) and one JSON-object fallback: ${error.message}`, { cause: error });
    }
  }
}

export const addIllustrativePercentages = plan => ({
  ...plan,
  percentages: { mode: 'illustrative', label: 'Illustrative entertainment split; not audience polling data' },
  questions: plan.questions.map(question => {
    const digest = crypto.createHash('sha256').update(`${question.optionA.text}|${question.optionB.text}`).digest(); const percentage = 38 + digest[0] % 25;
    return { ...question, optionA: { ...question.optionA, percentage }, optionB: { ...question.optionB, percentage: 100 - percentage } };
  }),
});

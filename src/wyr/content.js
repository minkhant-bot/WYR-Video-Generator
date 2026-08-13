import crypto from 'node:crypto';
import { fetchWithTimeout } from './utils.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const STRUCTURED_ATTEMPTS = 3;
const TEMPERATURE = 0.8;

export const CONTENT_CATEGORIES = Object.freeze([
  'superpowers', 'money', 'luxury', 'dream lifestyle', 'travel', 'impossible choices',
  'future technology', 'fantasy', 'time', 'freedom', 'dream homes', 'cars', 'food',
  'adventure', 'fame', 'survival-lite', 'space', 'ocean', 'friendship/social',
  'funny hypothetical',
]);
export const QUALITY_DIMENSIONS = Object.freeze([
  'dilemmaStrength', 'curiosity', 'emotionalPull', 'visualPotential', 'readability',
]);

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
const normalizeOption = (option, index, label) => {
  const text = normalize(option?.text); const searchQuery = normalize(option?.searchQuery);
  if (text.length < 3 || text.length > 500) throw new Error(`Question ${index + 1} option ${label} text must contain 3–500 characters before visual fitting.`);
  if (searchQuery.length < 3 || searchQuery.length > 100) throw new Error(`Question ${index + 1} option ${label} search query must contain 3–100 characters.`);
  return { text, searchQuery };
};

const normalizeQuality = (quality, index) => {
  if (!quality || typeof quality !== 'object') throw new Error(`Question ${index + 1} must include quality scores.`);
  return Object.fromEntries(QUALITY_DIMENSIONS.map(dimension => {
    const value = Number(quality[dimension]);
    if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error(`Question ${index + 1} quality.${dimension} must be an integer from 1–10.`);
    return [dimension, value];
  }));
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
    const category = normalize(question?.category).toLowerCase();
    if (!CONTENT_CATEGORIES.includes(category)) throw new Error(`Question ${index + 1} category must be one of the supported production categories.`);
    const quality = normalizeQuality(question?.quality, index);
    if (optionA.text.toLowerCase() === optionB.text.toLowerCase()) throw new Error(`Question ${index + 1} has identical options.`);
    const signature = [optionA.text, optionB.text].map(text => text.toLowerCase()).sort().join('|');
    if (seen.has(signature)) throw new Error(`Question ${index + 1} duplicates another question.`);
    const words = significantWords(signature);
    if (previousWordSets.some(previous => similarity(words, previous) >= 0.65)) throw new Error(`Question ${index + 1} is too similar to another question.`);
    seen.add(signature); previousWordSets.push(words); return { index, category, quality, optionA, optionB };
  });
  return { version: 1, topic, percentages: null, questions };
};

export class ContentProvider { async generatePlan() { throw new Error('ContentProvider.generatePlan must be implemented.'); } }

class GroqGenerationError extends Error {
  constructor(message, code, details = {}) { super(message); this.code = code; Object.assign(this, details); }
}

const retryAfterMilliseconds = (value, now = Date.now()) => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
};

export const groqRateLimitDetails = error => {
  for (let current = error; current; current = current.cause) {
    if (current.status === 429 || current.code === 'rate_limit_exceeded' || current.code === 'rate_limit') return { rateLimited: true, retryAfterMs: Number.isFinite(current.retryAfterMs) ? current.retryAfterMs : null };
  }
  return { rateLimited: false, retryAfterMs: null };
};

const planSchema = () => {
  const option = { type: 'object', properties: { text: { type: 'string' }, searchQuery: { type: 'string' } }, required: ['text', 'searchQuery'], additionalProperties: false };
  const quality = { type: 'object', properties: Object.fromEntries(QUALITY_DIMENSIONS.map(dimension => [dimension, { type: 'integer', minimum: 1, maximum: 10 }])), required: QUALITY_DIMENSIONS, additionalProperties: false };
  const question = { type: 'object', properties: { category: { type: 'string', enum: CONTENT_CATEGORIES }, quality, optionA: option, optionB: option }, required: ['category', 'quality', 'optionA', 'optionB'], additionalProperties: false };
  return { type: 'object', properties: { topic: { type: 'string' }, questions: { type: 'array', items: question } }, required: ['topic', 'questions'], additionalProperties: false };
};

const contextText = context => {
  const categories = Array.isArray(context?.categories) ? context.categories.filter(category => CONTENT_CATEGORIES.includes(category)) : [];
  const exclusions = Array.isArray(context?.exclusions) ? context.exclusions.slice(-80) : [];
  return `${categories.length ? ` Use these categories once each, in order: ${categories.join(', ')}.` : ''}${exclusions.length ? ` Do not repeat or paraphrase these prior dilemmas: ${exclusions.join('; ')}.` : ''}`;
};
const initialPrompt = (questionCount, context) => `Create exactly ${questionCount} exceptionally engaging English Would You Rather dilemmas for short-form video.${contextText(context)} Both options must be tempting, surprising, funny, or emotionally compelling; neither may be obviously superior. Prefer 2–8 words per option and never exceed 55 characters. Avoid generic pairs such as coffee/tea, cats/dogs, summer/winter, or city/countryside. Avoid politics, graphic violence, sexual or hateful content, dangerous challenges, and complicated conditions. Give each question one supported category and honest integer 1–10 scores for dilemmaStrength, curiosity, emotionalPull, visualPotential, and readability. Every score should be at least 7 only when the candidate truly earns it. Each Pexels searchQuery must be 2–5 concrete visual words that clearly distinguish the two choices. Return no percentages or explanations.`;
const repairPrompt = (questionCount, attempt, context) => attempt === 2
  ? `Return exactly ${questionCount} strong, distinct dilemmas in the required JSON schema.${contextText(context)} Use supported categories and all five honest integer quality scores. Each option must be instantly readable, ideally 2–8 words and under 55 characters. Both sides must be compelling. Use concrete 2–5 word image queries. No percentages or extra fields.`
  : `JSON only. Exactly ${questionCount} distinct high-quality dilemmas.${contextText(context)} Include category, all five quality scores, optionA and optionB with short text and concrete searchQuery.`;
const objectPrompt = (questionCount, context) => `${repairPrompt(questionCount, 3, context)} Shape: {"topic":"...","questions":[{"category":"fantasy","quality":{"dilemmaStrength":8,"curiosity":8,"emotionalPull":8,"visualPotential":8,"readability":9},"optionA":{"text":"...","searchQuery":"..."},"optionB":{"text":"...","searchQuery":"..."}}]}`;

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
  return new GroqGenerationError(`Groq returned HTTP ${response.status}${code ? ` (${code})` : ''}.`, code || 'http_error', { status: response.status, retryAfterMs: response.status === 429 ? retryAfterMilliseconds(response.headers.get('retry-after')) : null });
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
  async requestPlan({ questionCount, mode, attempt = 1, context = {} }) {
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
          { role: 'user', content: structured ? (attempt === 1 ? initialPrompt(questionCount, context) : repairPrompt(questionCount, attempt, context)) : objectPrompt(questionCount, context) },
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
  async generatePlan(questionCount, context = {}) {
    for (let attempt = 1; attempt <= STRUCTURED_ATTEMPTS; attempt += 1) {
      try { return await this.requestPlan({ questionCount, mode: 'json_schema', attempt, context }); }
      catch (error) {
        if (!['failed_generation', 'invalid_generation'].includes(error.code)) throw error;
      }
    }
    try { return await this.requestPlan({ questionCount, mode: 'json_object', context }); }
    catch (error) {
      if (groqRateLimitDetails(error).rateLimited) throw error;
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

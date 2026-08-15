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
export const DILEMMA_STYLES = Object.freeze([
  'tradeoff', 'power', 'discovery', 'emotional choice', 'future technology', 'weird/funny',
  'lifestyle', 'fantasy', 'consequence', 'adventure', 'social', 'impossible scenario',
]);
// contentFamily is distinct from category/dilemmaStyle: it classifies how fantastical vs. relatable
// a specific question actually is, so the fantasy-heavy family can be hard-capped independently.
export const FANTASY_CONTENT_FAMILIES = Object.freeze([
  'fantasy', 'superpower', 'magic', 'supernatural', 'mythical-creature', 'impossible-power', 'time-manipulation',
]);
export const CONTENT_FAMILIES = Object.freeze([
  ...FANTASY_CONTENT_FAMILIES,
  'food', 'social', 'relationships', 'work', 'lifestyle', 'money-tradeoff', 'privacy', 'technology', 'travel',
  'adventure', 'entertainment', 'funny-awkward', 'memory', 'everyday-inconvenience', 'unusual-but-realistic',
  'personal-habits', 'communication', 'comfort', 'skills', 'experiences',
]);
const DEFAULT_CONTENT_FAMILY = 'lifestyle';

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
const CONCEPT_KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+){0,3}$/;
const CONCEPT_KEY_FILLER = new Set(['the', 'and', 'for', 'you', 'your', 'with', 'every', 'own', 'have', 'can', 'into', 'anywhere', 'instantly', 'forever', 'always', 'never']);
const conceptKeyFallback = text => {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(word => word.length > 2 && !CONCEPT_KEY_FILLER.has(word));
  return words.slice(0, 3).join('-') || 'concept';
};
const normalizeConceptKey = (value, fallbackText) => {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (normalized && normalized.length <= 40 && CONCEPT_KEY_PATTERN.test(normalized)) return normalized;
  return conceptKeyFallback(fallbackText);
};
const normalizeDilemmaStyle = value => { const style = normalize(value).toLowerCase(); return DILEMMA_STYLES.includes(style) ? style : DILEMMA_STYLES[0]; };
const normalizeContentFamily = value => { const family = normalize(value).toLowerCase(); return CONTENT_FAMILIES.includes(family) ? family : DEFAULT_CONTENT_FAMILY; };
const normalizeOption = (option, index, label) => {
  const text = normalize(option?.text); const searchQuery = normalize(option?.searchQuery);
  if (text.length < 3 || text.length > 500) throw new Error(`Question ${index + 1} option ${label} text must contain 3–500 characters before visual fitting.`);
  if (searchQuery.length < 3 || searchQuery.length > 100) throw new Error(`Question ${index + 1} option ${label} search query must contain 3–100 characters.`);
  const conceptKey = normalizeConceptKey(option?.conceptKey, text);
  return { text, searchQuery, conceptKey };
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
    const dilemmaStyle = normalizeDilemmaStyle(question?.dilemmaStyle);
    const contentFamily = normalizeContentFamily(question?.contentFamily);
    if (optionA.text.toLowerCase() === optionB.text.toLowerCase()) throw new Error(`Question ${index + 1} has identical options.`);
    const signature = [optionA.text, optionB.text].map(text => text.toLowerCase()).sort().join('|');
    if (seen.has(signature)) throw new Error(`Question ${index + 1} duplicates another question.`);
    const words = significantWords(signature);
    if (previousWordSets.some(previous => similarity(words, previous) >= 0.65)) throw new Error(`Question ${index + 1} is too similar to another question.`);
    seen.add(signature); previousWordSets.push(words); return { index, category, quality, dilemmaStyle, contentFamily, optionA, optionB };
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
    if (current.status === 429 || current.code === 'rate_limit_exceeded' || current.code === 'rate_limit') return { rateLimited: true, retryAfterMs: Number.isFinite(current.retryAfterMs) ? current.retryAfterMs : null, rateLimitHeaders: current.rateLimitHeaders || null, limitType: current.limitType || null };
  }
  return { rateLimited: false, retryAfterMs: null, rateLimitHeaders: null, limitType: null };
};

// Only these specific, non-sensitive Groq rate-limit headers are ever captured — never
// Authorization or any other header that could carry a credential.
const RATE_LIMIT_HEADER_NAMES = Object.freeze([
  'retry-after',
  'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens',
]);
const extractRateLimitHeaders = response => {
  const headers = {};
  for (const name of RATE_LIMIT_HEADER_NAMES) { const value = response.headers.get(name); if (value !== null) headers[name] = value; }
  return headers;
};
// Groq's 429 error message names which budget was exceeded (e.g. "...on tokens per minute
// (TPM): Limit 8000, Used 7500...") — classify it without ever logging the raw message text.
const detectLimitType = (message, fallbackType) => {
  const text = String(message || '');
  if (/tokens per (?:minute|day)|\bTPM\b|\bTPD\b/i.test(text)) return 'tokens';
  if (/requests per (?:minute|day)|\bRPM\b|\bRPD\b/i.test(text)) return 'requests';
  return fallbackType === 'tokens' || fallbackType === 'requests' ? fallbackType : null;
};

const planSchema = () => {
  const option = { type: 'object', properties: { text: { type: 'string' }, searchQuery: { type: 'string' }, conceptKey: { type: 'string' } }, required: ['text', 'searchQuery', 'conceptKey'], additionalProperties: false };
  const quality = { type: 'object', properties: Object.fromEntries(QUALITY_DIMENSIONS.map(dimension => [dimension, { type: 'integer', minimum: 1, maximum: 10 }])), required: QUALITY_DIMENSIONS, additionalProperties: false };
  const question = { type: 'object', properties: { category: { type: 'string', enum: CONTENT_CATEGORIES }, dilemmaStyle: { type: 'string', enum: DILEMMA_STYLES }, contentFamily: { type: 'string', enum: CONTENT_FAMILIES }, quality, optionA: option, optionB: option }, required: ['category', 'dilemmaStyle', 'contentFamily', 'quality', 'optionA', 'optionB'], additionalProperties: false };
  return { type: 'object', properties: { topic: { type: 'string' }, questions: { type: 'array', items: question } }, required: ['topic', 'questions'], additionalProperties: false };
};

// These are only an efficiency hint to help Groq avoid an obviously-wasted regeneration attempt.
// Actual duplicate/motif protection is 100% enforced in content-engine.js against the FULL
// history (compareDilemmas, blockedMotifs), independent of what's in the prompt — so these can
// stay small without weakening protection. Kept deliberately small because a mature production
// history's full exclusion/motif lists alone could consume most of a request's token budget
// against Groq's tight per-minute token limit.
const PROMPT_EXCLUSION_LIMIT = 20;
const PROMPT_MOTIF_LIMIT = 40;
const contextText = context => {
  const categories = Array.isArray(context?.categories) ? context.categories.filter(category => CONTENT_CATEGORIES.includes(category)) : [];
  const exclusions = Array.isArray(context?.exclusions) ? context.exclusions.slice(-PROMPT_EXCLUSION_LIMIT) : [];
  const motifs = Array.isArray(context?.excludedMotifs) ? [...new Set(context.excludedMotifs)].slice(-PROMPT_MOTIF_LIMIT) : [];
  const styles = Array.isArray(context?.styles) ? context.styles.filter(style => DILEMMA_STYLES.includes(style)) : [];
  const families = Array.isArray(context?.families) ? context.families.filter(family => CONTENT_FAMILIES.includes(family)) : [];
  return `${categories.length ? ` Use these categories once each, in order: ${categories.join(', ')}.` : ''}${styles.length ? ` Use these dilemma styles once each, matched to the same order: ${styles.join(', ')}.` : ''}${families.length ? ` Use these contentFamily values once each, matched to the same order: ${families.join(', ')}. At most one of these may be a fantasy-like family (${FANTASY_CONTENT_FAMILIES.join(', ')}).` : ''}${exclusions.length ? ` Do not repeat or paraphrase these prior dilemmas: ${exclusions.join('; ')}.` : ''}${motifs.length ? ` Do not reuse these core concepts/motifs even with different wording (e.g. teleportation, mind-reading, invisibility, time-freeze, dragon, private-island, mars, flying-car, million-dollars, memory-loss, robot-companion, alien-city, lost-civilization, underwater-world, or any other already-used idea): ${motifs.join(', ')}.` : ''}`;
};
const CONCEPT_KEY_INSTRUCTIONS = 'For each option also produce a conceptKey: a short, stable, normalized machine-readable identifier (1–3 lowercase hyphenated words, e.g. "teleportation", "mind-reading", "private-island") describing the actual core concept, independent of exact wording — paraphrases of the same idea must produce the same conceptKey. Also give each question a dilemmaStyle chosen from the supported style list, and vary style across the set — avoid making most questions feel like superpower-vs-superpower, luxury-vs-luxury, destination-vs-destination, or own-X-vs-own-Y; mix tradeoffs, power, discovery, emotional choices, future technology, weird/funny, lifestyle, fantasy, consequence, adventure, social, and impossible-scenario framings.';
const CONTENT_FAMILY_INSTRUCTIONS = 'Also give each question a contentFamily from the supported family list. Fantasy is OPTIONAL and must NEVER be the default: across all 8 questions, at most ONE may come from a fantasy-like family (fantasy, superpower, magic, supernatural, mythical-creature, impossible-power, time-manipulation), and never default to superpowers, teleportation, telepathy, dragons, or other impossible-fantasy tropes for the rest. Strongly prefer realistic, relatable, everyday dilemmas (food, social, relationships, work, lifestyle, money-tradeoff, privacy, technology, travel, adventure, entertainment, funny-awkward, memory, everyday-inconvenience, unusual-but-realistic, personal-habits, communication, comfort, skills, experiences) that a real stock photograph can literally depict. Avoid famous overused Would You Rather tropes, avoid unnecessarily abstract concepts (like "infinite passive income" or "own a personal drone farm") that have no clear literal photograph, and never pair two options that both require impossible fantasy artwork unless it is the one permitted fantasy question.';
const initialPrompt = (questionCount, context) => `Create exactly ${questionCount} exceptionally engaging English Would You Rather dilemmas for short-form video.${contextText(context)} Both options must be tempting, surprising, funny, or emotionally compelling; neither may be obviously superior. Prefer 2–8 words per option and never exceed 55 characters. Avoid generic pairs such as coffee/tea, cats/dogs, summer/winter, or city/countryside. Avoid politics, graphic violence, sexual or hateful content, dangerous challenges, and complicated conditions. Give each question one supported category and honest integer 1–10 scores for dilemmaStrength, curiosity, emotionalPull, visualPotential, and readability. Every score should be at least 7 only when the candidate truly earns it. Each Pexels/Pixabay searchQuery must be 2–5 concrete, literal, photographable visual words that clearly distinguish the two choices — name the actual visible object, place, or action, not an abstract idea. ${CONCEPT_KEY_INSTRUCTIONS} ${CONTENT_FAMILY_INSTRUCTIONS} Return no percentages or explanations.`;
const repairPrompt = (questionCount, attempt, context) => attempt === 2
  ? `Return exactly ${questionCount} strong, distinct dilemmas in the required JSON schema.${contextText(context)} Use supported categories and all five honest integer quality scores. Each option must be instantly readable, ideally 2–8 words and under 55 characters. Both sides must be compelling. Use concrete 2–5 word literal, photographable image queries. ${CONCEPT_KEY_INSTRUCTIONS} ${CONTENT_FAMILY_INSTRUCTIONS} No percentages or extra fields.`
  : `JSON only. Exactly ${questionCount} distinct high-quality dilemmas.${contextText(context)} Include category, dilemmaStyle, contentFamily, all five quality scores, optionA and optionB with short text, concrete literal searchQuery, and conceptKey. ${CONCEPT_KEY_INSTRUCTIONS} ${CONTENT_FAMILY_INSTRUCTIONS}`;
const objectPrompt = (questionCount, context) => `${repairPrompt(questionCount, 3, context)} Shape: {"topic":"...","questions":[{"category":"food","dilemmaStyle":"discovery","contentFamily":"food","quality":{"dilemmaStrength":8,"curiosity":8,"emotionalPull":8,"visualPotential":8,"readability":9},"optionA":{"text":"...","searchQuery":"...","conceptKey":"..."},"optionB":{"text":"...","searchQuery":"...","conceptKey":"..."}}]}`;

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
  const isRateLimited = response.status === 429;
  return new GroqGenerationError(`Groq returned HTTP ${response.status}${code ? ` (${code})` : ''}.`, code || 'http_error', {
    status: response.status,
    retryAfterMs: isRateLimited ? retryAfterMilliseconds(response.headers.get('retry-after')) : null,
    rateLimitHeaders: isRateLimited ? extractRateLimitHeaders(response) : null,
    limitType: isRateLimited ? detectLimitType(remoteError?.message, remoteError?.type) : null,
  });
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
  constructor({ apiKey, model, timeoutMs }) { super(); this.apiKey = apiKey; this.model = model; this.timeoutMs = timeoutMs; this.requestCount = 0; this.rateLimitCount = 0; }
  async requestPlan({ questionCount, mode, attempt = 1, context = {} }) {
    const structured = mode === 'json_schema';
    this.requestCount += 1;
    const response = await fetchWithTimeout(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: TEMPERATURE,
        // A realistic 8-question completion measures ~900-1100 tokens; 1500 leaves comfortable
        // headroom while cutting the reserved/requested token budget by 40% versus the previous
        // 2500, which mattered once Groq's TPM (tokens-per-minute) limit was identified as the
        // actual binding constraint (not RPM) for this model tier.
        max_completion_tokens: 1500,
        messages: [
          { role: 'system', content: 'Return only the requested Would You Rather plan as JSON.' },
          { role: 'user', content: structured ? (attempt === 1 ? initialPrompt(questionCount, context) : repairPrompt(questionCount, attempt, context)) : objectPrompt(questionCount, context) },
        ],
        response_format: structured
          ? { type: 'json_schema', json_schema: { name: 'would_you_rather_plan', strict: true, schema: planSchema() } }
          : { type: 'json_object' },
      }),
    }, this.timeoutMs);
    if (!response.ok) { if (response.status === 429) this.rateLimitCount += 1; throw await groqErrorFromResponse(response); }
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
  async generateVisualQueries({ optionText, attemptedQueries = [], maxQueries = 3 }) {
    const response = await fetchWithTimeout(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.3,
        max_completion_tokens: 300,
        messages: [
          { role: 'system', content: 'Return only JSON with a queries array. Do not rewrite the choice or dilemma.' },
          { role: 'user', content: `Create up to ${maxQueries} short, ordered image-search phrases for the same Would You Rather option. The phrases must describe concrete visible scenes, people, objects, actions, or environments that would depict this exact concept. Do not change the option, invent a different ability, add text-heavy graphics, or include explanations. Avoid these already-tried queries: ${attemptedQueries.join(' | ') || 'none'}. Option text: ${optionText}` },
        ],
        response_format: { type: 'json_object' },
      }),
    }, this.timeoutMs);
    if (!response.ok) throw await groqErrorFromResponse(response);
    let payload;
    try { payload = await response.json(); } catch { throw new GroqGenerationError('Groq returned an invalid visual-query response.', 'invalid_generation'); }
    const message = payload?.choices?.[0]?.message;
    if (message?.refusal) throw new GroqGenerationError('Groq refused visual-query generation.', 'refusal');
    let parsed;
    try { parsed = JSON.parse(message?.content || ''); } catch { throw new GroqGenerationError('Groq returned invalid visual-query JSON.', 'invalid_generation'); }
    const queries = Array.isArray(parsed) ? parsed : parsed?.queries;
    if (!Array.isArray(queries)) throw new GroqGenerationError('Groq visual-query response did not include a queries array.', 'invalid_generation');
    const attempted = new Set(attemptedQueries.map(query => normalize(query).toLowerCase()));
    const normalized = [...new Set(queries.map(normalize).filter(query => query.length >= 3 && query.length <= 120 && !attempted.has(query.toLowerCase())))].slice(0, maxQueries);
    if (!normalized.length) throw new GroqGenerationError('Groq returned no new visual-search queries.', 'invalid_generation');
    return normalized;
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

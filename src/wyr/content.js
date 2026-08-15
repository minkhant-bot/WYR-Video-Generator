import crypto from 'node:crypto';
import { fetchWithTimeout, log } from './utils.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Lightweight-flow ladder: 2 structured attempts (initial + one repair-shaped retry on malformed
// JSON) + 1 json_object fallback = 3 HTTP requests worst case per generatePlan() call, down from
// 4. The common case (valid JSON schema output) is exactly 1 request.
const STRUCTURED_ATTEMPTS = 2;
const TEMPERATURE = 0.8;

export const CONTENT_CATEGORIES = Object.freeze([
  'superpowers', 'money', 'luxury', 'dream lifestyle', 'travel', 'impossible choices',
  'future technology', 'fantasy', 'time', 'freedom', 'dream homes', 'cars', 'food',
  'adventure', 'fame', 'survival-lite', 'space', 'ocean', 'friendship/social',
  'funny hypothetical',
]);

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

// Minimal Groq-facing plan shape: no topic, no conceptKey, no dilemmaStyle, no contentFamily, no
// quality scores. Duplicate/motif/fantasy/quality checks all happen locally in content-engine.js
// against this plain text — see canonicalMotifKey and assessQuestionQuality there.
export const validatePlan = (input, questionCount) => {
  if (!input || typeof input !== 'object') throw new Error('Content plan must be an object.');
  if (!Array.isArray(input.questions) || input.questions.length !== questionCount) throw new Error(`Content plan must contain exactly ${questionCount} questions.`);
  const seen = new Set(); const previousWordSets = [];
  const questions = input.questions.map((question, index) => {
    const optionA = normalizeOption(question?.optionA, index, 'A'); const optionB = normalizeOption(question?.optionB, index, 'B');
    const category = normalize(question?.category).toLowerCase();
    if (!CONTENT_CATEGORIES.includes(category)) throw new Error(`Question ${index + 1} category must be one of the supported production categories.`);
    if (optionA.text.toLowerCase() === optionB.text.toLowerCase()) throw new Error(`Question ${index + 1} has identical options.`);
    const signature = [optionA.text, optionB.text].map(text => text.toLowerCase()).sort().join('|');
    if (seen.has(signature)) throw new Error(`Question ${index + 1} duplicates another question.`);
    const words = significantWords(signature);
    if (previousWordSets.some(previous => similarity(words, previous) >= 0.65)) throw new Error(`Question ${index + 1} is too similar to another question.`);
    seen.add(signature); previousWordSets.push(words); return { index, category, optionA, optionB };
  });
  return { version: 1, questions };
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

// Groq returns x-ratelimit-reset-tokens/requests as a short duration string (e.g. "7.66s",
// "1m7.66s", "500ms"), not an absolute timestamp. Parses it to milliseconds; returns null (never
// throws) for anything unrecognized so an unexpected format can only disable proactive throttling,
// not corrupt it — the reactive 429 retry path remains the authoritative fallback either way.
export const parseGroqResetDuration = value => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const plainSeconds = Number(text);
  if (Number.isFinite(plainSeconds)) return Math.max(0, plainSeconds * 1000);
  const match = text.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/i);
  if (!match || !(match[1] || match[2] || match[3] || match[4])) return null;
  const [, hours, minutes, seconds, millis] = match;
  const totalMs = (Number(hours || 0) * 3600 + Number(minutes || 0) * 60 + Number(seconds || 0)) * 1000 + Number(millis || 0);
  return Number.isFinite(totalMs) ? Math.max(0, totalMs) : null;
};

// Proactive throttling, layered on top of (not instead of) the reactive 429 retry in
// content-engine.js. Groq returns remaining-capacity headers on EVERY response, success or not.
// A measured lightweight-schema request now costs well under 1000 tokens; 1200 is a safety margin
// above that. The wait is capped well under a full ~60s TPM window: best-effort front-line
// reduction in 429 frequency, not a guarantee — the bounded reactive retry remains authoritative.
const MIN_SAFE_REMAINING_TOKENS = 1200;
const MAX_PROACTIVE_WAIT_MS = 20_000;
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const planSchema = () => {
  const option = { type: 'object', properties: { text: { type: 'string' }, searchQuery: { type: 'string' } }, required: ['text', 'searchQuery'], additionalProperties: false };
  const question = { type: 'object', properties: { category: { type: 'string', enum: CONTENT_CATEGORIES }, optionA: option, optionB: option }, required: ['category', 'optionA', 'optionB'], additionalProperties: false };
  return { type: 'object', properties: { questions: { type: 'array', items: question } }, required: ['questions'], additionalProperties: false };
};

// Only the category list is ever sent — no exclusion or motif history. Duplicate/motif protection
// is 100% enforced locally in content-engine.js against the FULL history regardless of what's in
// the prompt, so there is nothing to gain from spending tokens on a history dump here.
const contextText = context => {
  const categories = Array.isArray(context?.categories) ? context.categories.filter(category => CONTENT_CATEGORIES.includes(category)) : [];
  return categories.length ? ` Use these categories once each, in order: ${categories.join(', ')}.` : '';
};
const CORE_INSTRUCTIONS = 'Each option: 2-8 words, under 55 characters, visually concrete, instantly readable. Both options tempting and roughly balanced — no obviously better choice. No politics, violence, sexual content, or hate speech. At most ONE question may involve a fantasy, superpower, or otherwise impossible ability; make the rest realistic, everyday choices. Avoid overused pairs like coffee/tea or cats/dogs. Give each option a short searchQuery: 2-5 concrete words naming a real, literal, photographable scene or object.';
const initialPrompt = (questionCount, context) => `Create exactly ${questionCount} short, punchy Would You Rather dilemmas for a vertical short-form video.${contextText(context)} ${CORE_INSTRUCTIONS} Return JSON only.`;
const repairPrompt = (questionCount, context) => `Create exactly ${questionCount} more distinct Would You Rather dilemmas, different from anything already used.${contextText(context)} ${CORE_INSTRUCTIONS} Return JSON only.`;
const objectPrompt = (questionCount, context) => `${repairPrompt(questionCount, context)} Shape: {"questions":[{"category":"food","optionA":{"text":"...","searchQuery":"..."},"optionB":{"text":"...","searchQuery":"..."}}]}`;

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
  constructor({ apiKey, model, timeoutMs, sleep = defaultSleep }) {
    super(); this.apiKey = apiKey; this.model = model; this.timeoutMs = timeoutMs; this.sleep = sleep;
    this.requestCount = 0; this.rateLimitCount = 0; this.proactiveThrottleCount = 0; this.proactiveThrottleWaitedMs = 0;
    this.rateLimitSnapshot = null;
  }
  // Records the capacity Groq reported as of THIS response, for the next call to consult.
  recordRateLimitSnapshot(response) {
    const headers = extractRateLimitHeaders(response);
    const remainingTokens = headers['x-ratelimit-remaining-tokens'] !== undefined ? Number(headers['x-ratelimit-remaining-tokens']) : null;
    if (!Number.isFinite(remainingTokens)) return;
    this.rateLimitSnapshot = {
      capturedAt: Date.now(),
      remainingTokens,
      remainingRequests: headers['x-ratelimit-remaining-requests'] !== undefined ? Number(headers['x-ratelimit-remaining-requests']) : null,
      resetTokensMs: parseGroqResetDuration(headers['x-ratelimit-reset-tokens']),
    };
  }
  // Consults the last known snapshot BEFORE firing a request; waits (bounded) if capacity looks
  // too low to safely fit another request, instead of firing and predictably getting a 429.
  async throttleForCapacity() {
    const snapshot = this.rateLimitSnapshot;
    if (!snapshot || !Number.isFinite(snapshot.remainingTokens) || !Number.isFinite(snapshot.resetTokensMs)) return false;
    if (snapshot.remainingTokens >= MIN_SAFE_REMAINING_TOKENS) return false;
    const elapsedMs = Date.now() - snapshot.capturedAt;
    const waitMs = Math.min(MAX_PROACTIVE_WAIT_MS, Math.max(0, snapshot.resetTokensMs - elapsedMs));
    if (waitMs <= 0) return false;
    this.proactiveThrottleCount += 1; this.proactiveThrottleWaitedMs += waitMs;
    log('content.groq_proactive_throttle', { remainingTokens: snapshot.remainingTokens, minSafeRemainingTokens: MIN_SAFE_REMAINING_TOKENS, waitMs, snapshotAgeMs: elapsedMs });
    await this.sleep(waitMs);
    this.rateLimitSnapshot = null; // stale; the next response will provide a fresh reading
    return true;
  }
  async requestPlan({ questionCount, mode, attempt = 1, context = {} }) {
    const structured = mode === 'json_schema';
    await this.throttleForCapacity();
    this.requestCount += 1;
    const response = await fetchWithTimeout(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: TEMPERATURE,
        // A minimal-schema 8-question completion measures well under 1000 tokens; 900 leaves
        // headroom while keeping the reserved/requested token budget small.
        max_completion_tokens: 900,
        messages: [
          { role: 'system', content: 'Return only the requested Would You Rather plan as JSON.' },
          { role: 'user', content: structured ? (attempt === 1 ? initialPrompt(questionCount, context) : repairPrompt(questionCount, context)) : objectPrompt(questionCount, context) },
        ],
        response_format: structured
          ? { type: 'json_schema', json_schema: { name: 'would_you_rather_plan', strict: true, schema: planSchema() } }
          : { type: 'json_object' },
      }),
    }, this.timeoutMs);
    this.recordRateLimitSnapshot(response);
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
    await this.throttleForCapacity();
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
    this.recordRateLimitSnapshot(response);
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

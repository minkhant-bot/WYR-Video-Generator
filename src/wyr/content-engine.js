import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_CATEGORIES, CONTENT_FAMILIES, DILEMMA_STYLES, FANTASY_CONTENT_FAMILIES, QUALITY_DIMENSIONS, groqRateLimitDetails } from './content.js';
import { log, writeJsonAtomic } from './utils.js';

const HISTORY_VERSION = 1;
const QUALITY_THRESHOLD = 7;
const GENERIC_WORDS = new Set(['a', 'an', 'the', 'your', 'you', 'to', 'of', 'in', 'on', 'at', 'with', 'for', 'and', 'or']);
const CONCEPT_FILLER = new Set([...GENERIC_WORDS, 'always', 'never', 'every', 'forever', 'private', 'own', 'owns', 'owned', 'have', 'has', 'having', 'get', 'gets', 'getting', 'live', 'lives', 'living', 'be', 'being', 'become', 'choose', 'control']);
const TOKEN_ALIASES = Object.freeze({ automobiles: 'car', automobile: 'car', cars: 'car', vehicle: 'car', vehicles: 'car', cash: 'money', dollars: 'money', dollar: 'money', riches: 'money', wealthy: 'wealth', aeroplane: 'plane', airplane: 'plane', aircraft: 'plane', jets: 'jet', islands: 'island', homes: 'home', houses: 'home', mansion: 'home', mansions: 'home', invisible: 'invisibility', strength: 'strength', strong: 'strength', flying: 'fly', flies: 'fly', teleports: 'teleport', teleporting: 'teleport', lightning: 'lightning', oceans: 'ocean', seas: 'ocean', sea: 'ocean', underwater: 'underwater', languages: 'language', years: 'year', months: 'month', travelling: 'travel', traveling: 'travel', travelled: 'travel', traveled: 'travel' });
const BORING_PAIRS = new Set(['cats|dogs', 'city|countryside', 'coffee|tea', 'summer|winter']);
const BLOCKED_CONTENT = /\b(politic(?:s|al)?|election|president|partisan|sexual|nude|porn|hate(?:ful)?|slur|murder|suicide|weapon|gun|knife|overdose|choking challenge)\b/i;

const cleanText = value => String(value ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9$ ]/g, ' ').replace(/\s+/g, ' ').trim();
const stem = token => {
  if (TOKEN_ALIASES[token]) return TOKEN_ALIASES[token];
  const aliased = token;
  if (aliased.length > 5 && aliased.endsWith('ies')) return `${aliased.slice(0, -3)}y`;
  if (aliased.length > 5 && aliased.endsWith('ing')) return aliased.slice(0, -3);
  if (aliased.length > 4 && aliased.endsWith('ed')) return aliased.slice(0, -2);
  if (aliased.length > 4 && aliased.endsWith('s')) return aliased.slice(0, -1);
  return aliased;
};
const tokens = (text, ignored = GENERIC_WORDS) => cleanText(text).split(' ').map(stem).filter(token => token && !ignored.has(token));
const setSimilarity = (left, right) => {
  const a = new Set(left); const b = new Set(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter(token => b.has(token)).length;
  return 2 * intersection / (a.size + b.size);
};
const compactOption = text => tokens(text, CONCEPT_FILLER).join(' ') || tokens(text).join(' ');
const exactOption = text => cleanText(text);
export const canonicalDilemma = question => [compactOption(question.optionA.text), compactOption(question.optionB.text)].sort().join(' | ');
export const exactDilemma = question => [exactOption(question.optionA.text), exactOption(question.optionB.text)].sort().join(' | ');

const optionSimilarity = (left, right) => {
  const leftTokens = tokens(left, CONCEPT_FILLER); const rightTokens = tokens(right, CONCEPT_FILLER);
  if (leftTokens.join(' ') === rightTokens.join(' ') && leftTokens.length) return 1;
  return setSimilarity(leftTokens, rightTokens);
};
export const compareDilemmas = (left, right) => {
  const sameOrder = exactOption(left.optionA.text) === exactOption(right.optionA.text) && exactOption(left.optionB.text) === exactOption(right.optionB.text);
  const reversedOrder = exactOption(left.optionA.text) === exactOption(right.optionB.text) && exactOption(left.optionB.text) === exactOption(right.optionA.text);
  if (sameOrder || reversedOrder) return { duplicate: true, kind: sameOrder ? 'exact' : 'reversed', similarity: 1 };
  const direct = [optionSimilarity(left.optionA.text, right.optionA.text), optionSimilarity(left.optionB.text, right.optionB.text)];
  const reversed = [optionSimilarity(left.optionA.text, right.optionB.text), optionSimilarity(left.optionB.text, right.optionA.text)];
  const best = (direct[0] + direct[1] >= reversed[0] + reversed[1]) ? direct : reversed;
  const similarity = (best[0] + best[1]) / 2;
  return { duplicate: Math.min(...best) >= 0.62 && similarity >= 0.72, kind: 'near', similarity };
};

// Exact conceptKey equality misses obvious paraphrases (Groq may name the same idea differently
// across two calls). This alias table canonicalizes well-known collision-prone motifs so
// "teleport anywhere" / "open a portal anywhere" / "instant travel anywhere" all land on the
// same bucket, purely deterministically (no extra Groq/embedding calls). It also doubles as the
// legacy-history backfill: entries created before conceptKey existed still resolve a motif from
// their stored option text alone, so old videos participate in duplicate protection immediately.
const MOTIF_ALIAS_RULES = Object.freeze([
  { motif: 'teleportation', test: t => /\bteleport|\bportal\b|\binstant(?:ly)?\s+travel|\btravel\s+instant|\bwarp\b/.test(t) },
  { motif: 'time-control', test: t => /\bfreeze\s+time|\bstop\s+time|\bpause\s+time|\btime\s+freeze|\bfrozen\s+time/.test(t) },
  { motif: 'time-travel', test: t => /\btime[- ]travel|\btravel(?:ing|led)?\s+(?:through|back\s+in)\s+time|\bany\s+era\b|\btime\s+machine|\btime\s+bus/.test(t) },
  { motif: 'mind-reading', test: t => /\bread\s+minds?|\bhear\b.{0,20}\bthoughts?\b|\bknow\s+what\s+(?:people|others)\s+are\s+thinking|\bmind[- ]reading|\btelepath/.test(t) },
  { motif: 'invisibility', test: t => /\binvisib|\bdisappear\s+(?:at\s+will|whenever|anytime|on\s+command)|\bturn\s+invisible/.test(t) },
  { motif: 'private-island', test: t => /\bprivate\s+island|\bown\s+(?:an?\s+)?island|\blive\s+alone\s+on\s+(?:your\s+)?(?:own\s+)?island/.test(t) },
  { motif: 'mythical-creature-bond', test: t => /\b(dragon|unicorn|phoenix|griffin|mermaid)s?\b/.test(t) && /\b(friend|companion|guardian|bond|tame|befriend|pet|ally)\b/.test(t) },
  { motif: 'super-strength', test: t => /\bsuper\s*strength|\bsuperhuman\s+strength|\blift\s+(?:a\s+)?car|\bincredible\s+strength/.test(t) },
  { motif: 'flight', test: t => /\bfly\b|\bflying\b|\bfly\s+like\s+a\s+bird/.test(t) },
  { motif: 'mega-wealth', test: t => /\bmillion\s+dollars|\bbillion\s+dollars|\binfinite\s+money|\bunlimited\s+money|\bpassive\s+income|\binfinite\s+(?:passive\s+)?income/.test(t) },
]);
const normalizeMotifText = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const motifSlugFromText = text => compactOption(text).split(' ').filter(Boolean).slice(0, 3).join('-') || null;
export const canonicalMotifKey = ({ conceptKey, text } = {}) => {
  const normalizedText = normalizeMotifText(text);
  const aliasMatch = normalizedText && MOTIF_ALIAS_RULES.find(rule => rule.test(normalizedText));
  if (aliasMatch) return aliasMatch.motif;
  const provided = String(conceptKey ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (provided) return provided;
  return motifSlugFromText(text);
};

const optionWordCount = text => cleanText(text).split(' ').filter(Boolean).length;
const queryWordCount = text => cleanText(text).split(' ').filter(Boolean).length;
export const assessQuestionQuality = question => {
  const reasons = [];
  for (const dimension of QUALITY_DIMENSIONS) if (!Number.isInteger(question.quality?.[dimension]) || question.quality[dimension] < QUALITY_THRESHOLD) reasons.push(`${dimension} must score at least ${QUALITY_THRESHOLD}`);
  for (const [label, option] of [['A', question.optionA], ['B', question.optionB]]) {
    const words = optionWordCount(option?.text);
    if (words < 1 || words > 9) reasons.push(`option ${label} must contain 1–9 instantly readable words`);
    if (String(option?.text || '').length > 55) reasons.push(`option ${label} exceeds 55 characters`);
    const queryWords = queryWordCount(option?.searchQuery);
    if (queryWords < 2 || queryWords > 6) reasons.push(`option ${label} searchQuery must contain 2–6 concrete words`);
  }
  const boring = [compactOption(question.optionA.text), compactOption(question.optionB.text)].sort().join('|');
  if (BORING_PAIRS.has(boring)) reasons.push('generic low-stakes dilemma is blocked');
  if (BLOCKED_CONTENT.test(`${question.optionA.text} ${question.optionB.text}`)) reasons.push('unsafe or excluded subject matter is blocked');
  if (optionSimilarity(question.optionA.text, question.optionB.text) >= 0.8) reasons.push('options are not clearly distinguishable');
  return { accepted: reasons.length === 0, reasons, threshold: QUALITY_THRESHOLD, scores: question.quality };
};

const emptyHistory = () => ({ version: HISTORY_VERSION, videos: [] });
const validateHistory = history => {
  if (!history || history.version !== HISTORY_VERSION || !Array.isArray(history.videos)) throw new Error('Content history is invalid or uses an unsupported version.');
  return history;
};
export class ContentHistoryStore {
  constructor(filePath) { this.filePath = path.resolve(filePath); }
  load() {
    if (!fs.existsSync(this.filePath)) return emptyHistory();
    try { return validateHistory(JSON.parse(fs.readFileSync(this.filePath, 'utf8'))); }
    catch (error) { throw new Error(`Could not load persistent content history at ${this.filePath}: ${error.message}`, { cause: error }); }
  }
  appendPlan(plan, generatedAt = new Date().toISOString()) {
    const history = this.load();
    const prior = historyQuestions(history); const checked = [...prior];
    for (const question of plan.questions) {
      if (checked.some(previous => compareDilemmas(question, previous).duplicate)) throw new ContentGenerationError('Content history changed during generation and now contains a duplicate; the job will not render.');
      checked.push(question);
    }
    history.videos.push({ generatedAt, topic: plan.topic, categories: plan.questions.map(question => question.category), contentFamilies: plan.questions.map(question => question.contentFamily || null), questions: plan.questions.map(question => ({ category: question.category, dilemmaStyle: question.dilemmaStyle || null, contentFamily: question.contentFamily || null, optionA: question.optionA.text, optionB: question.optionB.text, conceptKeyA: canonicalMotifKey({ conceptKey: question.optionA.conceptKey, text: question.optionA.text }), conceptKeyB: canonicalMotifKey({ conceptKey: question.optionB.conceptKey, text: question.optionB.text }), exact: exactDilemma(question), canonical: canonicalDilemma(question) })) });
    writeJsonAtomic(this.filePath, history);
    return history;
  }
}

const historyQuestions = history => history.videos.flatMap(video => video.questions.map(question => ({ optionA: { text: question.optionA }, optionB: { text: question.optionB } })));
const recentExclusions = history => history.videos.slice(-30).flatMap(video => video.questions.map(question => `${question.optionA} OR ${question.optionB}`));
export const MOTIF_HISTORY_WINDOW = 50;
// Canonicalizing on every read (rather than rewriting history.json) is the backfill strategy:
// legacy entries with no conceptKeyA/B simply fall through to deriving a motif from their stored
// option text via the same alias rules, so they participate in duplicate protection immediately,
// with zero risk of corrupting the persisted file and no Groq calls required.
export const recentMotifs = (history, windowSize = MOTIF_HISTORY_WINDOW) => new Set(
  history.videos.slice(-windowSize).flatMap(video => video.questions.flatMap(question => [
    canonicalMotifKey({ conceptKey: question.conceptKeyA, text: question.optionA }),
    canonicalMotifKey({ conceptKey: question.conceptKeyB, text: question.optionB }),
  ].filter(Boolean))),
);
export const selectCategories = (history, count) => {
  const lastUsed = new Map(CONTENT_CATEGORIES.map(category => [category, -1]));
  history.videos.forEach((video, videoIndex) => video.categories.forEach(category => lastUsed.set(category, videoIndex)));
  return [...CONTENT_CATEGORIES].sort((left, right) => lastUsed.get(left) - lastUsed.get(right) || CONTENT_CATEGORIES.indexOf(left) - CONTENT_CATEGORIES.indexOf(right)).slice(0, count);
};
// Mirrors selectCategories' least-recently-used rotation, but caps the fantasy-like slice of the
// target list at 1 slot so fantasy stays optional/occasional by construction, not just by a
// post-hoc reject — while still leaving room for the hard per-video caps below as a safety net.
export const selectContentFamilies = (history, count) => {
  const lastUsed = new Map(CONTENT_FAMILIES.map(family => [family, -1]));
  history.videos.forEach((video, videoIndex) => (video.contentFamilies || []).forEach(family => { if (family) lastUsed.set(family, videoIndex); }));
  const ranked = [...CONTENT_FAMILIES].sort((left, right) => lastUsed.get(left) - lastUsed.get(right) || CONTENT_FAMILIES.indexOf(left) - CONTENT_FAMILIES.indexOf(right));
  const realistic = ranked.filter(family => !FANTASY_CONTENT_FAMILIES.includes(family));
  const fantasy = ranked.filter(family => FANTASY_CONTENT_FAMILIES.includes(family));
  const selected = [...realistic.slice(0, Math.max(0, count - 1)), ...fantasy.slice(0, 1)];
  for (const family of ranked) { if (selected.length >= count) break; if (!selected.includes(family)) selected.push(family); }
  return selected.slice(0, count).sort((left, right) => CONTENT_FAMILIES.indexOf(left) - CONTENT_FAMILIES.indexOf(right));
};

export class ContentGenerationError extends Error {}
export class ContentRateLimitError extends ContentGenerationError {
  constructor(message, { acceptedCount, requiredCount, retries, waitedMs } = {}) { super(message); this.code = 'groq_rate_limit_exceeded'; this.acceptedCount = acceptedCount; this.requiredCount = requiredCount; this.retries = retries; this.waitedMs = waitedMs; }
}

// Free-tier Groq rate limits can take longer than 60s to clear; bounded but wide enough
// (~2.5 minutes, 7 retries) to ride out a burst without failing an otherwise-healthy job.
export const DEFAULT_GROQ_RATE_LIMIT_POLICY = Object.freeze({ maxRetries: 7, maxWaitMs: 150_000, baseDelayMs: 1_000, maxDelayMs: 15_000, jitterMs: 250 });
const providerRequestStats = provider => ({ totalGroqRequests: Number.isFinite(provider?.requestCount) ? provider.requestCount : null, rateLimitCount: Number.isFinite(provider?.rateLimitCount) ? provider.rateLimitCount : null });
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const rateLimitFailure = ({ accepted, questionCount, retries, waitedMs, maxRetries, maxWaitMs, lastProviderError }) => new ContentRateLimitError(
  `Groq rate limit did not recover within the bounded policy (${maxRetries} retries, ${maxWaitMs}ms maximum cumulative wait): accepted ${accepted.length} of ${questionCount} required distinct high-quality dilemmas. No incomplete video was rendered.${lastProviderError ? ` Last provider error: ${lastProviderError.message}` : ''}`,
  { acceptedCount: accepted.length, requiredCount: questionCount, retries, waitedMs },
);

export const generateProductionPlan = async ({ provider, historyStore, questionCount = 8, maxAttempts = 4, rateLimitPolicy = {}, sleep = wait, random = Math.random }) => {
  if (!provider || typeof provider.generatePlan !== 'function') throw new TypeError('A content provider is required.');
  if (!historyStore || typeof historyStore.load !== 'function' || typeof historyStore.appendPlan !== 'function') throw new TypeError('A persistent content history store is required.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer.');
  const configuredPolicy = Object.fromEntries(Object.entries(rateLimitPolicy).filter(([, value]) => value !== undefined));
  const policy = { ...DEFAULT_GROQ_RATE_LIMIT_POLICY, ...configuredPolicy };
  if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0 || !Number.isFinite(policy.maxWaitMs) || policy.maxWaitMs < 0 || !Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0 || !Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < 0 || !Number.isFinite(policy.jitterMs) || policy.jitterMs < 0) throw new TypeError('Groq rate-limit policy values must be non-negative numbers, and maxRetries must be an integer.');
  const history = historyStore.load(); const priorQuestions = historyQuestions(history); const accepted = []; const rejectionSummary = [];
  const targetCategories = selectCategories(history, questionCount);
  const targetFamilies = selectContentFamilies(history, questionCount);
  const blockedMotifs = recentMotifs(history);
  const styleOffset = history.videos.length % DILEMMA_STYLES.length;
  const targetStyles = Array.from({ length: questionCount }, (_, offset) => DILEMMA_STYLES[(styleOffset + offset) % DILEMMA_STYLES.length]);
  const MAX_STYLE_REPEATS_PER_VIDEO = 2;
  const MAX_FAMILY_REPEATS_PER_VIDEO = 2;
  const MAX_FANTASY_PER_VIDEO = 1;
  let lastProviderError = null; let topic = null; let attempt = 0; let rateLimitRetries = 0; let rateLimitWaitedMs = 0;
  while (attempt < maxAttempts && accepted.length < questionCount) {
    const missingCategories = targetCategories.filter(category => !accepted.some(question => question.category === category));
    const acceptedMotifs = new Set(accepted.flatMap(question => [
      canonicalMotifKey({ conceptKey: question.optionA.conceptKey, text: question.optionA.text }),
      canonicalMotifKey({ conceptKey: question.optionB.conceptKey, text: question.optionB.text }),
    ]));
    const styleCounts = accepted.reduce((counts, question) => { if (question.dilemmaStyle) counts[question.dilemmaStyle] = (counts[question.dilemmaStyle] || 0) + 1; return counts; }, {});
    const familyCounts = accepted.reduce((counts, question) => { if (question.contentFamily) counts[question.contentFamily] = (counts[question.contentFamily] || 0) + 1; return counts; }, {});
    let fantasyAccepted = accepted.filter(question => FANTASY_CONTENT_FAMILIES.includes(question.contentFamily)).length;
    try {
      const requestedCount = missingCategories.length; const acceptedBeforeRequest = accepted.length;
      const candidates = await provider.generatePlan(requestedCount, { categories: missingCategories, styles: targetStyles, families: targetFamilies, exclusions: [...recentExclusions(history), ...accepted.map(question => `${question.optionA.text} OR ${question.optionB.text}`)], excludedMotifs: [...blockedMotifs, ...acceptedMotifs] });
      attempt += 1;
      topic ||= candidates.topic;
      let rejectedThisRound = 0; const reasonsThisRound = new Set();
      for (const candidate of candidates.questions) {
        if (accepted.length >= questionCount) break;
        const reasons = [...assessQuestionQuality(candidate).reasons];
        if (!missingCategories.includes(candidate.category)) reasons.push('category is not currently requested');
        if (accepted.some(question => question.category === candidate.category)) reasons.push('category duplicates another question in this video');
        const comparisons = [...priorQuestions, ...accepted].map(question => compareDilemmas(candidate, question));
        const duplicate = comparisons.find(result => result.duplicate);
        if (duplicate) reasons.push(`${duplicate.kind} duplicate detected`);
        const candidateMotifs = [
          canonicalMotifKey({ conceptKey: candidate.optionA?.conceptKey, text: candidate.optionA?.text }),
          canonicalMotifKey({ conceptKey: candidate.optionB?.conceptKey, text: candidate.optionB?.text }),
        ].filter(Boolean);
        const reusedMotif = candidateMotifs.find(motif => blockedMotifs.has(motif));
        if (reusedMotif) reasons.push(`concept motif "${reusedMotif}" was used in a recent video`);
        const duplicateMotifInVideo = candidateMotifs.find(motif => acceptedMotifs.has(motif));
        if (duplicateMotifInVideo) reasons.push(`concept motif "${duplicateMotifInVideo}" duplicates another question in this video`);
        if (candidate.dilemmaStyle && (styleCounts[candidate.dilemmaStyle] || 0) >= MAX_STYLE_REPEATS_PER_VIDEO) reasons.push(`dilemma style "${candidate.dilemmaStyle}" is overused in this video`);
        const isFantasyFamily = FANTASY_CONTENT_FAMILIES.includes(candidate.contentFamily);
        if (isFantasyFamily && fantasyAccepted >= MAX_FANTASY_PER_VIDEO) reasons.push(`fantasy/superpower content family "${candidate.contentFamily}" exceeds the ${MAX_FANTASY_PER_VIDEO}-per-video cap`);
        else if (candidate.contentFamily && (familyCounts[candidate.contentFamily] || 0) >= MAX_FAMILY_REPEATS_PER_VIDEO) reasons.push(`content family "${candidate.contentFamily}" exceeds the ${MAX_FAMILY_REPEATS_PER_VIDEO}-per-video cap`);
        if (reasons.length) { rejectionSummary.push({ attempt, dilemma: `${candidate.optionA.text} OR ${candidate.optionB.text}`, reasons }); rejectedThisRound += 1; for (const reason of reasons) reasonsThisRound.add(reason); continue; }
        accepted.push({ ...candidate, duplicateCheck: { status: 'clear', comparedAgainst: priorQuestions.length + accepted.length } });
        for (const motif of candidateMotifs) acceptedMotifs.add(motif);
        if (candidate.dilemmaStyle) styleCounts[candidate.dilemmaStyle] = (styleCounts[candidate.dilemmaStyle] || 0) + 1;
        if (candidate.contentFamily) familyCounts[candidate.contentFamily] = (familyCounts[candidate.contentFamily] || 0) + 1;
        if (isFantasyFamily) fantasyAccepted += 1;
      }
      log('content.groq_request', { attempt, requestedCount, acceptedFromRequest: accepted.length - acceptedBeforeRequest, rejectedFromRequest: rejectedThisRound, remaining: questionCount - accepted.length, totalAccepted: accepted.length, required: questionCount, rejectionReasons: [...reasonsThisRound].slice(0, 8), ...providerRequestStats(provider) });
    } catch (error) {
      lastProviderError = error;
      const rateLimit = groqRateLimitDetails(error);
      if (rateLimit.rateLimited) {
        const limitDiagnostics = { limitType: rateLimit.limitType, rateLimitHeaders: rateLimit.rateLimitHeaders };
        if (rateLimitRetries >= policy.maxRetries) { log('content.groq_rate_limit_exhausted', { retries: rateLimitRetries, maxRetries: policy.maxRetries, cumulativeWaitMs: rateLimitWaitedMs, maxWaitMs: policy.maxWaitMs, accepted: accepted.length, required: questionCount, ...limitDiagnostics, ...providerRequestStats(provider) }); throw rateLimitFailure({ accepted, questionCount, retries: rateLimitRetries, waitedMs: rateLimitWaitedMs, maxRetries: policy.maxRetries, maxWaitMs: policy.maxWaitMs, lastProviderError }); }
        const exponentialDelay = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** rateLimitRetries));
        const jitter = Math.floor(random() * (policy.jitterMs + 1));
        const waitMs = rateLimit.retryAfterMs ?? (exponentialDelay + jitter);
        if (!Number.isFinite(waitMs) || waitMs < 0 || rateLimitWaitedMs + waitMs > policy.maxWaitMs) { log('content.groq_rate_limit_exhausted', { retries: rateLimitRetries, maxRetries: policy.maxRetries, cumulativeWaitMs: rateLimitWaitedMs, maxWaitMs: policy.maxWaitMs, accepted: accepted.length, required: questionCount, ...limitDiagnostics, ...providerRequestStats(provider) }); throw rateLimitFailure({ accepted, questionCount, retries: rateLimitRetries, waitedMs: rateLimitWaitedMs, maxRetries: policy.maxRetries, maxWaitMs: policy.maxWaitMs, lastProviderError }); }
        rateLimitRetries += 1; rateLimitWaitedMs += waitMs;
        log('content.groq_rate_limit_wait', { retry: rateLimitRetries, maxRetries: policy.maxRetries, retryAfterMs: rateLimit.retryAfterMs, waitMs, cumulativeWaitMs: rateLimitWaitedMs, accepted: accepted.length, required: questionCount, remaining: questionCount - accepted.length, source: rateLimit.retryAfterMs === null ? 'exponential_backoff' : 'retry_after', ...limitDiagnostics, ...providerRequestStats(provider) });
        await sleep(waitMs); continue;
      }
      attempt += 1; rejectionSummary.push({ attempt, providerError: error.message, kind: 'provider_failure' });
      log('content.groq_request_failed', { attempt, providerError: error.message, accepted: accepted.length, required: questionCount, ...providerRequestStats(provider) });
    }
  }
  if (accepted.length !== questionCount) {
    log('content.generation_failed', { attemptsUsed: attempt, maxAttempts, accepted: accepted.length, required: questionCount, rateLimitRetries, rateLimitWaitedMs, ...providerRequestStats(provider) });
    throw new ContentGenerationError(`Content generation failed after ${maxAttempts} bounded attempt(s): accepted ${accepted.length} of ${questionCount} required distinct high-quality dilemmas.${lastProviderError ? ` Last provider error: ${lastProviderError.message}` : ''}`);
  }
  const distinctFamilies = new Set(accepted.map(question => question.contentFamily).filter(Boolean)).size;
  const fantasyCount = accepted.filter(question => FANTASY_CONTENT_FAMILIES.includes(question.contentFamily)).length;
  const plan = { version: 1, topic: topic || 'High-stakes dream choices', percentages: null, contentQuality: { threshold: QUALITY_THRESHOLD, attemptsAllowed: maxAttempts, attemptsUsed: attempt, rejectedCandidates: rejectionSummary.filter(rejection => rejection.dilemma).length, providerFailures: rejectionSummary.filter(rejection => rejection.providerError).length, rateLimitRetries, rateLimitWaitedMs, categoryStrategy: 'least-recently-used', distinctContentFamilies: distinctFamilies, fantasyFamilyCount: fantasyCount }, questions: accepted.map((question, index) => ({ ...question, index })) };
  log('content.generation_summary', { attemptsUsed: attempt, accepted: accepted.length, required: questionCount, rateLimitRetries, rateLimitWaitedMs, distinctContentFamilies: distinctFamilies, fantasyFamilyCount: fantasyCount, ...providerRequestStats(provider) });
  historyStore.appendPlan(plan);
  return plan;
};

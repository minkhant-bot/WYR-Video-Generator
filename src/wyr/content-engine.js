import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_CATEGORIES, groqRateLimitDetails } from './content.js';
import { log, writeJsonAtomic } from './utils.js';

const HISTORY_VERSION = 1;
const GENERIC_WORDS = new Set(['a', 'an', 'the', 'your', 'you', 'to', 'of', 'in', 'on', 'at', 'with', 'for', 'and', 'or']);
const CONCEPT_FILLER = new Set([...GENERIC_WORDS, 'always', 'never', 'every', 'forever', 'private', 'own', 'owns', 'owned', 'have', 'has', 'having', 'get', 'gets', 'getting', 'live', 'lives', 'living', 'be', 'being', 'become', 'choose', 'control']);
const TOKEN_ALIASES = Object.freeze({ automobiles: 'car', automobile: 'car', cars: 'car', vehicle: 'car', vehicles: 'car', cash: 'money', dollars: 'money', dollar: 'money', riches: 'money', wealthy: 'wealth', aeroplane: 'plane', airplane: 'plane', aircraft: 'plane', jets: 'jet', islands: 'island', homes: 'home', houses: 'home', mansion: 'home', mansions: 'home', invisible: 'invisibility', strength: 'strength', strong: 'strength', flying: 'fly', flies: 'fly', teleports: 'teleport', teleporting: 'teleport', lightning: 'lightning', oceans: 'ocean', seas: 'ocean', sea: 'ocean', underwater: 'underwater', languages: 'language', years: 'year', months: 'month', travelling: 'travel', traveling: 'travel', travelled: 'travel', traveled: 'travel' });
const BORING_PAIRS = new Set(['cats|dogs', 'city|countryside', 'coffee|tea', 'summer|winter']);
const BLOCKED_CONTENT = /\b(politic(?:s|al)?|election|president|partisan|sexual|nude|porn|hate(?:ful)?|slur|murder|suicide|weapon|gun|knife|overdose|choking challenge)\b/i;
// Options describing an invisible ABSTRACT STATE CHANGE to a non-physical financial obligation (a
// debt/loan/balance/fee being erased, forgiven, cancelled, or wiped away) have no reliable
// stock-photo stand-in: a camera can show money, bills, or a bank vault, but never the erasure ACT
// itself, and the best an image search can return is generic, ambiguous "relief"/"paperwork"
// imagery that isn't specific to the concept. This is the demonstrated root cause behind a real
// production IMAGE_SELECTION_EXHAUSTED failure ("Have all your debt erased today"). Deliberately
// narrow: does NOT cover the growth/spend/save/earn family (double/grow/spend/save/earn all DO have
// a genuine, commonly-tagged literal photo -- a growth chart, a piggy bank, a shopping bag -- and
// already clear image selection via images.js's VISUAL_EXPANSIONS aliases; that is proven working
// behavior and must not be touched). Only the removal/erasure family, which has no equivalent
// literal photographic stand-in, is blocked here.
const ABSTRACT_FINANCIAL_OBLIGATION_PATTERN = /\b(debts?|balances?|loans?|interest|fees?|fines?|mortgages?|bills?)\b/i;
const ABSTRACT_ERASURE_VERB_PATTERN = /\b(erased|erase|erases|forgiven|forgive|forgives|forgave|cancell?ed|cancels?|wiped|wipes?|vanish(?:ed|es)?|disappear(?:ed|s)?)\b/i;
// NOTE: this used to also block a vague-pronoun-reference pattern (everything/nothing/anything/...),
// an arbitrary-count pattern ("N times"), a timing-unit pattern (seconds/minutes/hours), and a
// knowledge/mental-state-verb pattern (know/think/remember/forget/...). Real production import data
// showed those four were rejecting the large majority of normal, usable questions (a 300-question
// batch produced 0 insertions) -- ordinary options routinely and legitimately contain "today",
// "forever", "instantly", "times", a plural pronoun, or a verb like "know"/"forget" (even
// hand-curated seed-questions.js entries like "Know how you will die" and "Forget names every day"
// were being rejected by the mental-state pattern), so all four were far too broad for what they
// were meant to catch and have been removed. Only the financial-erasure combination below (still
// narrow and low-frequency) remains.
export const isNonPhotographableAbstractOption = text => {
  const value = String(text ?? '');
  if (ABSTRACT_FINANCIAL_OBLIGATION_PATTERN.test(value) && ABSTRACT_ERASURE_VERB_PATTERN.test(value)) return true;
  return false;
};

// General wording-quality gate -- orthogonal to isNonPhotographableAbstractOption above (which
// screens for a missing PHOTOGRAPHABLE SUBJECT, not for readable English). Catches sentence
// fragments and run-on constructions a normal viewer would not instantly parse, mechanically and
// structurally (same regex/pattern style as the rest of this file) rather than via a per-phrase
// example list. Deliberately narrow and permissive -- verified against every seed-questions.js
// entry with zero false positives, AND tuned down after real production import data showed the
// original, broader trailing-word set was rejecting normal options too aggressively (a 300-question
// batch produced 0 insertions). Hard-rejects only high-confidence breakage: a phrase visibly missing
// its object (trailing "...for the"), a phrase that starts mid-sentence, a run-on splice of two
// clauses, or a narrated past-tense headline -- never merely "unusual", "abstract", or "fantasy".
const FRAGMENT_BOUNDARY_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'from', 'with', 'for']);
const LEADING_FRAGMENT_WORDS = new Set(['and', 'or', 'but', 'so', 'because', 'although', 'while', 'of', 'to', 'than', 'then', 'yet']);
const ADVERB_RUNON_EXCEPTIONS = new Set(['always', 'sometimes', 'outdoors', 'indoors', 'upstairs', 'downstairs', 'across', 'towards', 'yes', 'unless', 'less']);
// Adjective suffixes chosen to avoid colliding with common verbs (deliberately excludes -ive/-ent/
// -ant, which also end common verbs like "live", "arrive", "prevent", "want").
const BARE_ADJECTIVE_OPENER = /^[a-z]+(?:able|ible|ful|ous)$/;
// A bare deictic time-adverb trailing a past-tense verb reads as a narrated, already-happened
// headline ("Savings doubled today"), not an actionable/choosable phrase -- distinct from "instantly"
// or "forever", which read fine as the tail of an active option ("Turn invisible instantly").
const TRAILING_NARRATED_PAST_ADVERBS = new Set(['today', 'yesterday', 'tonight', 'overnight', 'already', 'suddenly', 'recently', 'previously']);
export const hasNaturalWording = text => {
  const value = String(text ?? '').trim();
  if (!value) return false;
  const words = value.toLowerCase().replace(/[^a-z0-9'\s]/g, '').split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const first = words[0]; const last = words[words.length - 1];
  if (FRAGMENT_BOUNDARY_WORDS.has(last)) return false; // ends mid-phrase, e.g. trailing "...for the"
  if (LEADING_FRAGMENT_WORDS.has(first)) return false; // starts mid-sentence, e.g. "Because you..."
  if (words.some((word, index) => index > 0 && word === words[index - 1])) return false; // "the the"
  if (words.length >= 3) {
    const secondLast = words[words.length - 2];
    // Two clauses glued together with no conjunction, e.g. "Spend freely grows": [verb] [adverb] [verb].
    if (/ly$/.test(secondLast) && /(?:s|ed)$/.test(last) && last.length > 3 && !ADVERB_RUNON_EXCEPTIONS.has(last)) return false;
    // A narrated past-tense statement, e.g. "Savings doubled today": [subject] [verb-ed] [today].
    if (/ed$/.test(secondLast) && TRAILING_NARRATED_PAST_ADVERBS.has(last)) return false;
  }
  // A bare predicate adjective describing a duration instead of a concrete action/thing, e.g.
  // "Comfortable for eighty years" -- natural options open with a verb or a concrete noun phrase.
  if (BARE_ADJECTIVE_OPENER.test(first) && /\b(for|since)\b/.test(value.toLowerCase())) return false;
  return true;
};

// The concrete, photographable description of what an option's image should show -- separate from
// `text` (short punchy display wording) and `searchQuery` (the compressed provider search phrase).
// Prefers an explicitly authored visualSubject (see content.js's Groq schema); falls back to
// searchQuery (already required to be "a real, literal, photographable scene or object") for
// content authored before this field existed -- a legacy DB row or the static seed-questions.js
// bank -- so every option always has SOME usable visual-subject description, never re-derived by
// stripping words out of the display text.
export const deriveVisualSubject = option => {
  const provided = String(option?.visualSubject ?? '').trim();
  if (provided) return provided;
  return String(option?.searchQuery ?? '').trim();
};
// The visual-feasibility gate: a resolved visualSubject must be non-empty and must not match the
// same narrow non-photographable category isNonPhotographableAbstractOption already screens display
// text for (abstract financial erasure) -- applied to whichever text
// (author-provided or derived) is actually going to reach image search.
export const isVisualSubjectFeasible = visualSubject => {
  const value = String(visualSubject ?? '').trim();
  if (!value) return false;
  return !isNonPhotographableAbstractOption(value);
};

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

export const optionSimilarity = (left, right) => {
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

// Deterministic, local semantic-motif fingerprinting — no Groq field required. Well-known
// collision-prone motifs are recognized by pattern so "teleport anywhere" / "open a portal
// anywhere" / "instant travel anywhere" all land on the same bucket; anything else falls back to
// a slug derived from the option's own significant words. Because this reads only option text, it
// works identically for brand-new plans and for legacy history entries from before any
// conceptKey field ever existed — nothing to migrate, nothing that can corrupt history.json.
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

// Fantasy/superpower classification is now entirely local: a question counts as fantasy-like if
// its category is one of the two fantasy-coded categories, OR if either option's motif is one of
// the inherently-impossible motifs above (teleportation, time manipulation, invisibility,
// mind-reading, a mythical-creature bond, super-strength, or flight). No extra Groq field needed.
export const FANTASY_CATEGORIES = new Set(['superpowers', 'fantasy']);
export const FANTASY_MOTIFS = new Set(['teleportation', 'time-control', 'time-travel', 'invisibility', 'mind-reading', 'mythical-creature-bond', 'super-strength', 'flight']);
export const questionMotifs = question => [canonicalMotifKey({ text: question.optionA.text }), canonicalMotifKey({ text: question.optionB.text })].filter(Boolean);
export const isFantasyQuestion = (question, motifs = questionMotifs(question)) => FANTASY_CATEGORIES.has(question.category) || motifs.some(motif => FANTASY_MOTIFS.has(motif));

const optionWordCount = text => cleanText(text).split(' ').filter(Boolean).length;
const queryWordCount = text => cleanText(text).split(' ').filter(Boolean).length;
// Local quality heuristics replace Groq's previous self-reported 1-10 quality scores entirely —
// readability/length/distinguishability/safety are all mechanically checkable, so there was
// nothing genuinely subjective being validated by asking the model to grade its own output.
export const assessQuestionQuality = question => {
  const reasons = [];
  for (const [label, option] of [['A', question.optionA], ['B', question.optionB]]) {
    const words = optionWordCount(option?.text);
    if (words < 1 || words > 9) reasons.push(`option ${label} must contain 1–9 instantly readable words`);
    if (String(option?.text || '').length > 55) reasons.push(`option ${label} exceeds 55 characters`);
    const queryWords = queryWordCount(option?.searchQuery);
    if (queryWords < 2 || queryWords > 6) reasons.push(`option ${label} searchQuery must contain 2–6 concrete words`);
    if (isNonPhotographableAbstractOption(option?.text)) reasons.push(`option ${label} has no concrete, photographable real-world subject (abstract state change, vague reference, knowledge/mental state, arbitrary count, or timing concept)`);
    if (!hasNaturalWording(option?.text)) reasons.push(`option ${label} reads as an awkward fragment or run-on, not simple natural English`);
    const visualSubject = deriveVisualSubject(option);
    if (!visualSubject) reasons.push(`option ${label} has no visualSubject or searchQuery to derive a visual target from`);
    else if (!isVisualSubjectFeasible(visualSubject)) reasons.push(`option ${label} visualSubject "${visualSubject}" has no concrete, photographable subject`);
  }
  const boring = [compactOption(question.optionA.text), compactOption(question.optionB.text)].sort().join('|');
  if (BORING_PAIRS.has(boring)) reasons.push('generic low-stakes dilemma is blocked');
  if (BLOCKED_CONTENT.test(`${question.optionA.text} ${question.optionB.text}`)) reasons.push('unsafe or excluded subject matter is blocked');
  if (optionSimilarity(question.optionA.text, question.optionB.text) >= 0.8) reasons.push('options are not clearly distinguishable');
  return { accepted: reasons.length === 0, reasons };
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
    history.videos.push({ generatedAt, topic: plan.topic, categories: plan.questions.map(question => question.category), questions: plan.questions.map(question => ({ category: question.category, optionA: question.optionA.text, optionB: question.optionB.text, conceptKeyA: canonicalMotifKey({ text: question.optionA.text }), conceptKeyB: canonicalMotifKey({ text: question.optionB.text }), exact: exactDilemma(question), canonical: canonicalDilemma(question) })) });
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
// Two of the 20 categories ('superpowers', 'fantasy') are themselves fantasy-coded; selecting
// both in the same least-recently-used batch would guarantee an extra repair round every time
// (the fantasy cap below would reject the second one). Capping the target list itself at one
// fantasy-coded category — purely local, no extra Groq field — keeps the common case at one call.
export const selectCategories = (history, count) => {
  const lastUsed = new Map(CONTENT_CATEGORIES.map(category => [category, -1]));
  history.videos.forEach((video, videoIndex) => video.categories.forEach(category => lastUsed.set(category, videoIndex)));
  const ranked = [...CONTENT_CATEGORIES].sort((left, right) => lastUsed.get(left) - lastUsed.get(right) || CONTENT_CATEGORIES.indexOf(left) - CONTENT_CATEGORIES.indexOf(right));
  const selected = []; let fantasyPicked = false;
  for (const category of ranked) {
    if (selected.length >= count) break;
    if (FANTASY_CATEGORIES.has(category)) { if (fantasyPicked) continue; fantasyPicked = true; }
    selected.push(category);
  }
  return selected;
};

// Topic is cosmetic display text only (job list / result screen) — deriving it locally from the
// accepted categories removes the need to ask Groq for it at all.
const titleCase = word => word.replace(/(^|[\s/-])([a-z])/g, (_, separator, letter) => `${separator}${letter.toUpperCase()}`);
export const deriveTopic = questions => {
  const categories = [...new Set(questions.map(question => question.category))].slice(0, 3).map(titleCase);
  return categories.length ? `Would You Rather: ${categories.join(', ')}` : 'Would You Rather';
};

// Auto-generated social caption, built locally from Scene 1's own option text -- no Groq/LLM call.
// Scene 1 is whichever question already leads plan.questions (pool-selection.js's arrangeForHook
// already put the strongest hook_score question there for DB-pool plans; unchanged for a
// Groq-generated plan, where index 0 is just whatever order generation produced) -- this only
// formats that question's real text, never re-selects or rewrites it. Every video previously
// shared the exact same generic caption regardless of content; this makes each video's caption
// reflect its own actual opening dilemma instead.
export const buildShareCaption = questions => {
  const first = questions?.[0];
  if (!first?.optionA?.text || !first?.optionB?.text) return null;
  return `${first.optionA.text} or ${first.optionB.text}? 👀\n#wouldyourather #thisorthat #pickone`;
};

export class ContentGenerationError extends Error {}
export class ContentRateLimitError extends ContentGenerationError {
  constructor(message, { acceptedCount, requiredCount, retries, waitedMs } = {}) { super(message); this.code = 'groq_rate_limit_exceeded'; this.acceptedCount = acceptedCount; this.requiredCount = requiredCount; this.retries = retries; this.waitedMs = waitedMs; }
}

// Lightweight-flow default: respect Retry-After once, wait for the reported reset, retry once.
// Bounded and finite — this is not meant to ride out a sustained outage, only a single transient
// 429 (the schema/prompt-size reduction is what's supposed to prevent 429s from recurring at all).
export const DEFAULT_GROQ_RATE_LIMIT_POLICY = Object.freeze({ maxRetries: 1, maxWaitMs: 30_000, baseDelayMs: 1_000, maxDelayMs: 15_000, jitterMs: 250 });
const providerRequestStats = provider => ({
  totalGroqRequests: Number.isFinite(provider?.requestCount) ? provider.requestCount : null,
  rateLimitCount: Number.isFinite(provider?.rateLimitCount) ? provider.rateLimitCount : null,
  proactiveThrottleCount: Number.isFinite(provider?.proactiveThrottleCount) ? provider.proactiveThrottleCount : null,
  proactiveThrottleWaitedMs: Number.isFinite(provider?.proactiveThrottleWaitedMs) ? provider.proactiveThrottleWaitedMs : null,
});
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const rateLimitFailure = ({ accepted, questionCount, retries, waitedMs, maxRetries, maxWaitMs, lastProviderError }) => new ContentRateLimitError(
  `Groq rate limit did not recover within the bounded policy (${maxRetries} retries, ${maxWaitMs}ms maximum cumulative wait): accepted ${accepted.length} of ${questionCount} required distinct high-quality dilemmas. No incomplete video was rendered.${lastProviderError ? ` Last provider error: ${lastProviderError.message}` : ''}`,
  { acceptedCount: accepted.length, requiredCount: questionCount, retries, waitedMs },
);

// Lightweight flow: one request for all 8, local validation, and — if some are rejected — exactly
// one repair request for only the still-missing count (maxAttempts defaults to 2: initial +
// one repair round). Never regenerates the whole batch just because part of it was rejected.
export const generateProductionPlan = async ({ provider, historyStore, questionCount = 8, maxAttempts = 2, rateLimitPolicy = {}, sleep = wait, random = Math.random }) => {
  if (!provider || typeof provider.generatePlan !== 'function') throw new TypeError('A content provider is required.');
  if (!historyStore || typeof historyStore.load !== 'function' || typeof historyStore.appendPlan !== 'function') throw new TypeError('A persistent content history store is required.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer.');
  const configuredPolicy = Object.fromEntries(Object.entries(rateLimitPolicy).filter(([, value]) => value !== undefined));
  const policy = { ...DEFAULT_GROQ_RATE_LIMIT_POLICY, ...configuredPolicy };
  if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0 || !Number.isFinite(policy.maxWaitMs) || policy.maxWaitMs < 0 || !Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0 || !Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < 0 || !Number.isFinite(policy.jitterMs) || policy.jitterMs < 0) throw new TypeError('Groq rate-limit policy values must be non-negative numbers, and maxRetries must be an integer.');
  const history = historyStore.load(); const priorQuestions = historyQuestions(history); const accepted = []; const rejectionSummary = [];
  const targetCategories = selectCategories(history, questionCount);
  const blockedMotifs = recentMotifs(history);
  const MAX_FANTASY_PER_VIDEO = 1;
  let lastProviderError = null; let attempt = 0; let rateLimitRetries = 0; let rateLimitWaitedMs = 0;
  while (attempt < maxAttempts && accepted.length < questionCount) {
    const missingCategories = targetCategories.filter(category => !accepted.some(question => question.category === category));
    const acceptedMotifs = new Set(accepted.flatMap(questionMotifs));
    let fantasyAccepted = accepted.filter(question => isFantasyQuestion(question)).length;
    try {
      const requestedCount = missingCategories.length; const acceptedBeforeRequest = accepted.length;
      const candidates = await provider.generatePlan(requestedCount, { categories: missingCategories });
      attempt += 1;
      let rejectedThisRound = 0; const reasonsThisRound = new Set();
      for (const candidate of candidates.questions) {
        if (accepted.length >= questionCount) break;
        const reasons = [...assessQuestionQuality(candidate).reasons];
        if (!missingCategories.includes(candidate.category)) reasons.push('category is not currently requested');
        if (accepted.some(question => question.category === candidate.category)) reasons.push('category duplicates another question in this video');
        const comparisons = [...priorQuestions, ...accepted].map(question => compareDilemmas(candidate, question));
        const duplicate = comparisons.find(result => result.duplicate);
        if (duplicate) reasons.push(`${duplicate.kind} duplicate detected`);
        const candidateMotifs = questionMotifs(candidate);
        const reusedMotif = candidateMotifs.find(motif => blockedMotifs.has(motif));
        if (reusedMotif) reasons.push(`concept motif "${reusedMotif}" was used in a recent video`);
        const duplicateMotifInVideo = candidateMotifs.find(motif => acceptedMotifs.has(motif));
        if (duplicateMotifInVideo) reasons.push(`concept motif "${duplicateMotifInVideo}" duplicates another question in this video`);
        const isFantasy = isFantasyQuestion(candidate, candidateMotifs);
        if (isFantasy && fantasyAccepted >= MAX_FANTASY_PER_VIDEO) reasons.push(`fantasy/superpower question exceeds the ${MAX_FANTASY_PER_VIDEO}-per-video cap`);
        if (reasons.length) { rejectionSummary.push({ attempt, dilemma: `${candidate.optionA.text} OR ${candidate.optionB.text}`, reasons }); rejectedThisRound += 1; for (const reason of reasons) reasonsThisRound.add(reason); continue; }
        accepted.push({ ...candidate, duplicateCheck: { status: 'clear', comparedAgainst: priorQuestions.length + accepted.length } });
        for (const motif of candidateMotifs) acceptedMotifs.add(motif);
        if (isFantasy) fantasyAccepted += 1;
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
  const fantasyCount = accepted.filter(question => isFantasyQuestion(question)).length;
  const plan = { version: 1, topic: deriveTopic(accepted), percentages: null, contentQuality: { attemptsAllowed: maxAttempts, attemptsUsed: attempt, rejectedCandidates: rejectionSummary.filter(rejection => rejection.dilemma).length, providerFailures: rejectionSummary.filter(rejection => rejection.providerError).length, rateLimitRetries, rateLimitWaitedMs, categoryStrategy: 'least-recently-used', fantasyCount }, questions: accepted.map((question, index) => ({ ...question, index })) };
  log('content.generation_summary', { attemptsUsed: attempt, accepted: accepted.length, required: questionCount, rateLimitRetries, rateLimitWaitedMs, fantasyCount, ...providerRequestStats(provider) });
  historyStore.appendPlan(plan);
  return plan;
};

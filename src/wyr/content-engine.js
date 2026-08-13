import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_CATEGORIES, QUALITY_DIMENSIONS } from './content.js';
import { writeJsonAtomic } from './utils.js';

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

const optionWordCount = text => cleanText(text).split(' ').filter(Boolean).length;
const queryWordCount = text => cleanText(text).split(' ').filter(Boolean).length;
export const assessQuestionQuality = question => {
  const reasons = [];
  for (const dimension of QUALITY_DIMENSIONS) if (!Number.isInteger(question.quality?.[dimension]) || question.quality[dimension] < QUALITY_THRESHOLD) reasons.push(`${dimension} must score at least ${QUALITY_THRESHOLD}`);
  for (const [label, option] of [['A', question.optionA], ['B', question.optionB]]) {
    const words = optionWordCount(option?.text);
    if (words < 1 || words > 10) reasons.push(`option ${label} must contain 1–10 instantly readable words`);
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
    history.videos.push({ generatedAt, topic: plan.topic, categories: plan.questions.map(question => question.category), questions: plan.questions.map(question => ({ category: question.category, optionA: question.optionA.text, optionB: question.optionB.text, exact: exactDilemma(question), canonical: canonicalDilemma(question) })) });
    writeJsonAtomic(this.filePath, history);
    return history;
  }
}

const historyQuestions = history => history.videos.flatMap(video => video.questions.map(question => ({ optionA: { text: question.optionA }, optionB: { text: question.optionB } })));
const recentExclusions = history => history.videos.slice(-30).flatMap(video => video.questions.map(question => `${question.optionA} OR ${question.optionB}`));
export const selectCategories = (history, count) => {
  const lastUsed = new Map(CONTENT_CATEGORIES.map(category => [category, -1]));
  history.videos.forEach((video, videoIndex) => video.categories.forEach(category => lastUsed.set(category, videoIndex)));
  return [...CONTENT_CATEGORIES].sort((left, right) => lastUsed.get(left) - lastUsed.get(right) || CONTENT_CATEGORIES.indexOf(left) - CONTENT_CATEGORIES.indexOf(right)).slice(0, count);
};

export class ContentGenerationError extends Error {}
export const generateProductionPlan = async ({ provider, historyStore, questionCount = 8, maxAttempts = 4 }) => {
  if (!provider || typeof provider.generatePlan !== 'function') throw new TypeError('A content provider is required.');
  if (!historyStore || typeof historyStore.load !== 'function' || typeof historyStore.appendPlan !== 'function') throw new TypeError('A persistent content history store is required.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer.');
  const history = historyStore.load(); const priorQuestions = historyQuestions(history); const accepted = []; const rejectionSummary = [];
  const targetCategories = selectCategories(history, questionCount);
  let lastProviderError = null; let topic = null;
  for (let attempt = 1; attempt <= maxAttempts && accepted.length < questionCount; attempt += 1) {
    const missingCategories = targetCategories.filter(category => !accepted.some(question => question.category === category));
    try {
      const candidates = await provider.generatePlan(missingCategories.length, { categories: missingCategories, exclusions: [...recentExclusions(history), ...accepted.map(question => `${question.optionA.text} OR ${question.optionB.text}`)] });
      topic ||= candidates.topic;
      for (const candidate of candidates.questions) {
        if (accepted.length >= questionCount) break;
        const reasons = [...assessQuestionQuality(candidate).reasons];
        if (!missingCategories.includes(candidate.category)) reasons.push('category is not currently requested');
        if (accepted.some(question => question.category === candidate.category)) reasons.push('category duplicates another question in this video');
        const comparisons = [...priorQuestions, ...accepted].map(question => compareDilemmas(candidate, question));
        const duplicate = comparisons.find(result => result.duplicate);
        if (duplicate) reasons.push(`${duplicate.kind} duplicate detected`);
        if (reasons.length) { rejectionSummary.push({ attempt, dilemma: `${candidate.optionA.text} OR ${candidate.optionB.text}`, reasons }); continue; }
        accepted.push({ ...candidate, duplicateCheck: { status: 'clear', comparedAgainst: priorQuestions.length + accepted.length } });
      }
    } catch (error) { lastProviderError = error; rejectionSummary.push({ attempt, providerError: error.message }); }
  }
  if (accepted.length !== questionCount) throw new ContentGenerationError(`Content generation failed after ${maxAttempts} bounded attempt(s): accepted ${accepted.length} of ${questionCount} required distinct high-quality dilemmas.${lastProviderError ? ` Last provider error: ${lastProviderError.message}` : ''}`);
  const plan = { version: 1, topic: topic || 'High-stakes dream choices', percentages: null, contentQuality: { threshold: QUALITY_THRESHOLD, attemptsAllowed: maxAttempts, rejectedCandidates: rejectionSummary.length, categoryStrategy: 'least-recently-used' }, questions: accepted.map((question, index) => ({ ...question, index })) };
  historyStore.appendPlan(plan);
  return plan;
};

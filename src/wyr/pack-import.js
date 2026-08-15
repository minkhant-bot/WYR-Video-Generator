import { CONTENT_CATEGORIES } from './content.js';
import { insertQuestions, getPoolStats } from './question-pool.js';
import { coreSubjectQuery } from './image-query.js';

export class PackFormatError extends Error {
  constructor(message) { super(message); this.code = 'PACK_FORMAT_INVALID'; }
}

// A pack may be at most this many questions -- keeps a single import request bounded (one DB
// transaction, one HTTP request/response) regardless of who generated the pack.
export const MAX_QUESTIONS_PER_PACK = 500;
const SUPPORTED_PACK_VERSION = 1;

// Accepts either the canonical { packVersion: 1, questions: [...] } shape or a bare array of the
// same question objects (both are treated identically once unwrapped) -- never anything else.
// Never executes/evals anything from the payload; this only ever reads plain string/number fields.
const unwrapQuestions = payload => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray(payload.questions)) {
    if (payload.packVersion !== undefined && payload.packVersion !== SUPPORTED_PACK_VERSION) {
      throw new PackFormatError(`Unsupported packVersion ${JSON.stringify(payload.packVersion)}; only version ${SUPPORTED_PACK_VERSION} is supported.`);
    }
    return payload.questions;
  }
  throw new PackFormatError('Pack must be either { "packVersion": 1, "questions": [...] } or a plain JSON array of question objects.');
};

// A short, provider-agnostic search query derived deterministically from the option text (no
// Groq) -- the canonical import format never supplies one. Reuses the same literal-subject
// extraction the image pipeline itself now prefers (see image-query.js), so imported questions get
// image queries just as specific as the curated seed set's.
const deriveSearchQuery = (text, category) => {
  const subject = coreSubjectQuery(text, 5);
  const words = subject.split(' ').filter(Boolean);
  if (words.length >= 2) return subject;
  const categoryWords = String(category ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
  const padded = [...words, ...categoryWords].slice(0, 5).join(' ');
  return padded.split(' ').filter(Boolean).length >= 2 ? padded : `${subject} scene`.trim();
};

const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;

// Validates one raw pack entry and, if valid, maps it to the internal {category, optionA:
// {text, searchQuery}, optionB: {text, searchQuery}} shape insertQuestions() expects -- the exact
// same shape Groq/seed/refill produce, so it goes through the identical downstream quality gate
// (computeInsertionFields -> assessQuestionQuality) with no separate/weaker validation path.
export const normalizeImportedQuestion = raw => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { accepted: false, reasons: ['entry must be a JSON object'] };
  const reasons = [];
  if (!isNonEmptyString(raw.category)) reasons.push('category must be a non-empty string');
  else if (!CONTENT_CATEGORIES.includes(raw.category)) reasons.push(`category "${raw.category}" is not a recognized category`);
  if (!isNonEmptyString(raw.optionA)) reasons.push('optionA must be a non-empty string');
  else if (raw.optionA.length > 300) reasons.push('optionA is too long');
  if (!isNonEmptyString(raw.optionB)) reasons.push('optionB must be a non-empty string');
  else if (raw.optionB.length > 300) reasons.push('optionB is too long');
  if (reasons.length) return { accepted: false, reasons };
  const optionAText = raw.optionA.trim(); const optionBText = raw.optionB.trim();
  return {
    accepted: true,
    question: {
      category: raw.category,
      optionA: { text: optionAText, searchQuery: deriveSearchQuery(optionAText, raw.category) },
      optionB: { text: optionBText, searchQuery: deriveSearchQuery(optionBText, raw.category) },
    },
  };
};

// Imports a question pack (canonical object or plain array) into the SAME PostgreSQL pool
// seed/refill write to, through the SAME insertQuestions() quality gate. Never deletes or
// overwrites anything already in the pool; never calls Groq. Idempotent: a dedupe_key collision
// (already in the DB, OR a repeat within this same file) is always reported as "skipped", never
// inserted twice -- re-uploading the identical pack is always safe.
export const importQuestionPack = async payload => {
  const rawQuestions = unwrapQuestions(payload);
  if (!Array.isArray(rawQuestions)) throw new PackFormatError('"questions" must be an array.');
  if (rawQuestions.length === 0) throw new PackFormatError('Pack contains no questions.');
  if (rawQuestions.length > MAX_QUESTIONS_PER_PACK) throw new PackFormatError(`Pack contains ${rawQuestions.length} questions; the maximum per import is ${MAX_QUESTIONS_PER_PACK}.`);

  const preRejected = [];
  const validQuestions = [];
  for (const raw of rawQuestions) {
    const result = normalizeImportedQuestion(raw);
    if (result.accepted) validQuestions.push(result.question);
    else preRejected.push({ reasons: result.reasons });
  }

  const { inserted, rejected: dbRejected } = validQuestions.length
    ? await insertQuestions(validQuestions, { sourceProvider: 'import' })
    : { inserted: [], rejected: [] };

  const skipped = dbRejected.filter(item => item.reasons.some(reason => reason.includes('duplicate')));
  const trueRejected = dbRejected.filter(item => !item.reasons.some(reason => reason.includes('duplicate')));
  const stats = await getPoolStats();
  return {
    inserted: inserted.length,
    skipped: skipped.length,
    rejected: preRejected.length + trueRejected.length,
    total: stats.total,
  };
};

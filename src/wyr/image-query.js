// Pure, deterministic image-search query construction -- no Groq, no network, no provider
// knowledge. Used by image-picker.js (the production Pixabay/Pexels path) to build the FIRST,
// most-specific queries tried for an option, before the broader/decorative fallback queries in
// images.js's buildImageQueries. Also reusable by JSON pack import (see question-pool.js /
// seed.js) to derive a searchQuery for imported questions that don't supply one.
const CORE_SUBJECT_STRIP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'in', 'on', 'at', 'with', 'for', 'your', 'you', 'of', 'and', 'or',
  'be', 'become', 'becomes', 'own', 'owns', 'owned', 'have', 'has', 'having', 'get', 'gets', 'getting',
  'live', 'lives', 'living', 'visit', 'visits', 'visiting', 'eat', 'eats', 'eating', 'try', 'tries', 'trying',
  'explore', 'explores', 'exploring', 'build', 'builds', 'building', 'start', 'starts', 'starting',
  'find', 'finds', 'finding', 'wear', 'wears', 'wearing', 'ride', 'rides', 'riding', 'use', 'uses', 'using',
  'only', 'always', 'never', 'every', 'forever', 'instead', 'anytime', 'anywhere', 'whenever', 'yourself',
  'go', 'goes', 'going', 'do', 'does', 'doing', 'make', 'makes', 'making',
]);
const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// The literal, photographable subject of an option -- what a real photo of this option should
// actually show. Strips generic verbs/connectors ("live in a", "eat", "own", "explore") that add
// no visual specificity and can bias a search away from the exact subject (e.g. keeping "explore"
// in "explore outer space" doesn't hurt much, but keeping "eat" in "eat pizza forever" risks
// matching generic eating/restaurant photos instead of pizza itself).
export const coreSubjectWords = text => {
  const words = normalize(text).split(' ').filter(word => word.length > 2 && !CORE_SUBJECT_STRIP_WORDS.has(word));
  return words.length ? words : normalize(text).split(' ').filter(Boolean);
};
export const coreSubjectQuery = (text, maxWords = 4) => coreSubjectWords(text).slice(0, maxWords).join(' ');

// Ranked, most-specific-first queries for one option: the literal subject, then the subject
// blended with its category for a broader fallback. Deliberately has NO decorative/stylistic
// words ("cinematic", "dramatic scene") -- those reduce relevance for the realistic, concrete
// subjects the seed/imported pool is made of, and stay confined to images.js's buildImageQueries
// fallback (still tried afterward) which is reserved for genuinely fantastical concepts.
export const deterministicImageQueries = (option, { category = '' } = {}) => {
  const subject = coreSubjectQuery(option?.text, 4);
  const categoryWords = normalize(category).split(' ').filter(Boolean);
  const categoryBlend = [subject, ...categoryWords].filter(Boolean).slice(0, 5).join(' ');
  return [...new Set([subject, categoryBlend].filter(query => query.length >= 3))];
};

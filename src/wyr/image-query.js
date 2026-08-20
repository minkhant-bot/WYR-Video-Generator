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
  // Added: further generic verbs/connectors that add no visual specificity of their own (e.g. "take
  // luxury trains everywhere" -> "take"/"everywhere" contribute nothing a photo could show, but were
  // previously left in the query, diluting it toward whatever else "take" or "everywhere" happen to
  // co-occur with in provider tags).
  'take', 'takes', 'taking', 'win', 'wins', 'winning', 'through', 'without', 'into', 'onto', 'about',
  'around', 'across', 'over', 'under', 'out', 'off', 'up', 'down', 'near', 'someday', 'somewhere',
  'everywhere', 'anyway', 'price', 'prices', 'priced', 'limit', 'limits', 'limited', 'unlimited', 'cost', 'costs',
  // "free" (as in "at no cost" -- "free fuel", "free flights") is the same pricing-modifier class as
  // price/cost/limit above: it describes an economic condition, not anything a photo could show, and
  // is an extremely common incidental word in provider tags/titles ("free stock photo") that let a
  // completely unrelated candidate (e.g. a laptop/desk image for "Free fuel for life") satisfy 50%
  // dominant-subject coverage without ever matching the real subject.
  'free',
  // English determiners/quantifiers ("all your debt", "any amount", "some money") are a small,
  // CLOSED grammatical class -- unlike abstract verbs (see NON_VISUAL_MODIFIER_WORDS and Tier 5's
  // Groq-based semantic fallback in image-picker.js, which handle the genuinely open-ended,
  // unenumerable problem), English has a fixed, complete set of these, so listing them fully here
  // is a one-time closed-class fix, not a growing per-phrase dictionary.
  'all', 'any', 'some', 'none', 'each', 'both', 'either', 'neither', 'few', 'several', 'many', 'much', 'most', 'various', 'certain',
]);
// Pure manner/frequency adverbs and generic time-words: unlike a concrete noun, nothing can ever
// literally photograph "freely" or "today" -- no real stock photo is ever meaningfully tagged with
// them, so keeping them in the subject word list only dilutes it, artificially lowering the
// coverage percentage a genuinely on-subject candidate (e.g. one tagged "savings") can reach. This
// was the actual root cause behind two live Railway option texts ("savings doubled today", "spend
// freely grows") never clearing the dominant-subject/relevance gates despite hundreds of inspected
// candidates -- their non-visual words ("today", "freely") were counted as MANDATORY subject
// words with zero real-world matchability. Exported so images.js's own separate "core" relevance
// measure (assessImageCandidate) can apply the exact same exclusion, instead of only the stricter
// dominant-subject gate below getting fixed while a second, still-diluted gate keeps rejecting.
export const NON_VISUAL_MODIFIER_WORDS = new Set([
  'today', 'tomorrow', 'tonight', 'yesterday', 'now', 'later', 'soon', 'currently',
  'freely', 'quickly', 'slowly', 'instantly', 'immediately', 'suddenly', 'gradually',
  'constantly', 'endlessly', 'automatically', 'magically', 'effortlessly', 'easily',
]);
// Common activity verbs whose bare dictionary form searches poorly (a literal "shop" search returns
// storefronts/shop signage as often as people shopping) but whose gerund is a much more literal,
// photographable search term. Applied AFTER stripping, so e.g. "shop with no price limit" becomes
// "shopping" rather than "shop price limit".
const SUBJECT_WORD_FORM = Object.freeze({ shop: 'shopping', shops: 'shopping', dine: 'dining', dines: 'dining' });
// Abstract time-of-day/atmosphere words are real but non-literal modifiers -- a photo search engine
// tends to weight the leading word(s) of a query most heavily, and these words are strongly
// associated with their OWN stock-photo cliches (night skies, gothic architecture, sunsets) that can
// dominate and crowd out the actual literal subject (e.g. "midnight lunch" -> a literal "lunch"
// photo search polluted by "midnight" leading toward church/night imagery instead of food). Demoting
// them to the end of the query (never dropping them entirely) keeps the concrete, photographable
// noun in the lead position regardless of where it fell in the original sentence.
const TEMPORAL_MODIFIER_WORDS = new Set(['midnight', 'dawn', 'dusk', 'sunrise', 'sunset', 'noon', 'twilight', 'nightfall', 'daybreak']);
const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// The literal, photographable subject of an option -- what a real photo of this option should
// actually show. Strips generic verbs/connectors ("live in a", "eat", "own", "explore") that add
// no visual specificity and can bias a search away from the exact subject (e.g. keeping "explore"
// in "explore outer space" doesn't hurt much, but keeping "eat" in "eat pizza forever" risks
// matching generic eating/restaurant photos instead of pizza itself), applies a small set of
// verb->literal-noun rewrites, and demotes non-literal time-of-day modifiers to the end so they
// never outrank the concrete subject for query relevance.
export const coreSubjectWords = text => {
  const stripped = normalize(text).split(' ').filter(word => word.length > 2 && !CORE_SUBJECT_STRIP_WORDS.has(word) && !NON_VISUAL_MODIFIER_WORDS.has(word));
  const words = (stripped.length ? stripped : normalize(text).split(' ').filter(Boolean)).map(word => SUBJECT_WORD_FORM[word] || word);
  const literal = words.filter(word => !TEMPORAL_MODIFIER_WORDS.has(word));
  const temporal = words.filter(word => TEMPORAL_MODIFIER_WORDS.has(word));
  return [...literal, ...temporal];
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

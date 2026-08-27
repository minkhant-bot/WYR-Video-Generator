import { assessQuestionQuality, isFantasyQuestion, optionSimilarity } from './content-engine.js';
import { coreSubjectWords } from './image-query.js';

const wordCount = text => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
const charLength = text => String(text ?? '').length;

// Concise, instantly-parsable options make for a stronger scroll-stopping first scene. These are
// deliberately simple, explainable proxies (word/char length, searchQuery concreteness) -- there is
// no real watch-time data yet to train against. Once YouTube performance is recorded (see
// wyr_videos.performance / views / average_view_duration_seconds) these heuristics are the natural
// place to blend in real signal later, without a schema change.
export const computeQualityScore = question => {
  const { accepted } = assessQuestionQuality(question);
  if (!accepted) return 0;
  // assessQuestionQuality already rejects anything over 55 characters, so an accepted question is
  // always <=55 chars -- this only distinguishes "comfortably concise" from "at the limit".
  const longest = Math.max(charLength(question.optionA.text), charLength(question.optionB.text));
  return longest <= 40 ? 100 : 85;
};

export const computeVisualScore = question => {
  const scoreQuery = query => {
    const words = wordCount(query);
    if (words >= 2 && words <= 4) return 100;
    if (words <= 6) return 80;
    return 50;
  };
  return Math.round((scoreQuery(question.optionA.searchQuery) + scoreQuery(question.optionB.searchQuery)) / 2);
};

// How sharply the two options contrast. assessQuestionQuality already hard-rejects anything at or
// above 0.8 similarity (near-identical wording), but plenty of accepted pairs still sit in a
// "pretty similar, kind of a wash" zone that makes for a weaker, less scroll-stopping either/or --
// score higher the more the options diverge in wording/subject.
const computeDistinctnessBonus = question => {
  const similarity = optionSimilarity(question.optionA.text, question.optionB.text);
  if (similarity <= 0.2) return 15;
  if (similarity <= 0.45) return 8;
  return 0;
};

// Scene-1 hook strength. No real watch-time data exists yet to train against (see
// computeQualityScore), so this stays a set of simple, explainable, testable proxies:
//   + concise, instantly-parsable options (concisionBonus) -- "instantly understandable" / viewers
//     can read and answer before the countdown even starts
//   + sharply contrasting options (computeDistinctnessBonus) -- a real, felt tradeoff rather than a
//     near-toss-up; repetitive/boring exact pairs are already hard-rejected upstream
//   + concrete, photographable searchQuery text (visual score) -- correlates with a clean, legible
//     first frame
//   - fantasy/superpower dilemmas (fantasyPenalty) -- fun in small doses (still capped at 1 per
//     video by selectDiversePlan, unchanged), but a relatable/realistic choice is faster to
//     self-insert into as the very FIRST scene than an escapist one
// "Confusing/awkward AI-sounding wording" and "obviously one-sided" choices have no reliable
// keyword-level signal (they need semantic/sentiment understanding this scorer doesn't have) and
// are deliberately NOT guessed at here rather than risk a biased or noisy penalty.
export const computeHookScore = question => {
  const quality = computeQualityScore(question);
  if (quality === 0) return 0;
  const visual = computeVisualScore(question);
  const longestWordCount = Math.max(wordCount(question.optionA.text), wordCount(question.optionB.text));
  const concisionBonus = longestWordCount <= 6 ? 25 : longestWordCount <= 8 ? 10 : 0;
  const distinctnessBonus = computeDistinctnessBonus(question);
  const fantasyPenalty = isFantasyQuestion(question) ? 12 : 0;
  const score = quality * 0.4 + visual * 0.25 + concisionBonus + distinctnessBonus - fantasyPenalty + Math.min(quality, visual) * 0.05;
  return Math.max(0, Math.round(score));
};

// Deterministic, local (no Groq) lexicon of "WYR strength" tradeoff axes -- used both to rank
// candidate questions when reserving from the Content Pool (question-pool.js's
// selectAndReservePlan) and to pick which of an already-finalized set leads as Scene 1 (see
// pool-selection.js's arrangeForHook/computeDilemmaRankScore). Deliberately keyword/regex-based,
// same spirit as computeHookScore and content-engine.js's MOTIF_ALIAS_RULES: no fake stats, no
// manufactured urgency, just recognizing when an option's own wording already carries a real
// psychological stake (status/luxury, loss aversion, freedom vs security, money vs time, comfort vs
// ambition, love/social vs success, rare benefit vs sacrifice, fantasy/power curiosity, humor/
// absurdity, lasting consequence).
const DILEMMA_STRENGTH_LEXICON = Object.freeze([
  { tag: 'status_luxury', test: /\b(yacht|mansion|penthouse|private\s+jet|jet|luxury|designer|five[- ]star|first[- ]class|sports\s*car|celebrity|famous|fame|billion(?:aire)?s?|private\s+island)\b/ },
  { tag: 'wealth', test: /\b(money|rich|wealth\w*|salary|income|paycheck|dollars?|cash|millions?)\b/ },
  { tag: 'freedom', test: /\b(freedom|free\s+time|no\s+boss|remote\s+work|travel\s+the\s+world|quit\s+your\s+job|retire\s+early|your\s+own\s+boss)\b/ },
  { tag: 'security', test: /\b(stable\s+job|job\s+security|steady\s+paycheck|safety\s+net|guaranteed|health\s+insurance|savings)\b/ },
  // NOTE: bare "forever" was deliberately removed from this axis (and from `consequence` below) --
  // it's boilerplate WYR phrasing present on a large majority of Content Pool rows regardless of
  // actual stakes (see seed-questions.js/pack-import fixtures), so keeping it as a free match here
  // let a merely-concise, low-stakes pair (e.g. "wear a hat indoors forever" vs "wear sunglasses at
  // night forever") pick up the same tag presence as a genuinely time/consequence-driven dilemma.
  { tag: 'time', test: /\b(weekends?|vacation|time\s+off|every\s+(?:single\s+)?day)\b/ },
  { tag: 'comfort', test: /\b(comfort\w*|relax\w*|cozy|easy\s+life)\b/ },
  { tag: 'ambition', test: /\b(dream\s+job|career|success\w*|achieve\w*|hustle|ambition\w*|productive|productivity)\b/ },
  { tag: 'love_social', test: /\b(love|family|friends?|partner|relationship|soulmate|marry|marriage)\b/ },
  { tag: 'loss', test: /\b(lose|losing|give\s+up|never\s+again|can.?t\s+go\s+back|risk\s+losing|only\s+once)\b/ },
  { tag: 'power_fantasy', test: /\b(superpower\w*|read\b.{0,15}\bminds?\b|invisib\w*|flying|fly\b|time\s+travel|teleport\w*|telepath\w*|mind[- ]reading)\b/ },
  // Humor/absurdity -- a real WYR-comment-bait signal distinct from the "serious tradeoff" axes
  // above: options that are gross, embarrassing, or silly tend to draw disagreement/reactions even
  // when the stakes are low.
  { tag: 'humor_absurd', test: /\b(smell\w*|gross|disgusting|embarrass\w*|awkward|ridiculous|silly|weird|farts?|burp\w*|naked|clown|toilet)\b/ },
  // Lasting consequence -- distinct from "loss" (which is about giving something up): a choice that
  // is explicitly permanent/irreversible/lifelong reads as higher-stakes than one that isn't.
  { tag: 'consequence', test: /\b(permanent(?:ly)?|rest\s+of\s+your\s+life|irreversibl\w*|can\s+never|never\s+again)\b/ },
  // Curiosity -- a mystery/reveal/twist hook draws viewers in on its own, independent of whether the
  // underlying stakes are also high (e.g. money/loss/consequence).
  { tag: 'curiosity', test: /\b(secret\w*|mystery|mysterious|hidden|unknown|discover\w*|reveal\w*|surpris\w*|unexpected|twist)\b/ },
  // Identity/self-comparison -- an option framed relative to OTHER people (smarter/richer/more
  // attractive than everyone, your friends, your family) reads as a harder, more self-relevant
  // choice than the same trait framed in isolation.
  { tag: 'identity_comparison', test: /\b(everyone\s+else|than\s+(?:everyone|your\s+(?:friends|family|partner))|smarter\s+than|richer\s+than|more\s+attractive|better[ -]looking|most\s+successful)\b/ },
]);
// Low-stakes wardrobe/grooming/daily-habit nouns and mild-annoyance phrasing -- the concrete root
// cause behind a merely-concise pair (e.g. "wear a hat indoors" vs "wear sunglasses at night")
// out-scoring a genuinely strong dilemma on hook_score's length/concision proxies alone (see
// computeHookScore). These read as easy-to-dismiss, not a real felt tradeoff, so a pair whose ONLY
// lexicon coverage happens to come via one of these words is capped rather than credited as if it
// carried the same stake as a genuine luxury/loss/consequence tag.
const MUNDANE_LIFESTYLE_PATTERN = /\b(hat|cap|beanie|sunglasses|glasses|socks|sandals|slippers|pajamas|jacket|sweater|scarf|umbrella|backpack|earrings|bracelet|haircut|hairstyle|ponytail|indoors|barefoot|wristwatch|toothbrush|shoelaces)\b/;
const MILD_INCONVENIENCE_PATTERN = /\b(wait\s+in\s+line|stand\s+in\s+line|slow\s+wifi|slow\s+internet|cold\s+coffee|traffic\s+jam|small\s+talk|awkward\s+silence|itchy|squeaky|static\s+cling|lint\s+roller|hiccups?|mosquito\s+bites?|off[- ]key|out\s+of\s+tune)\b/;
const isMundaneLowStakes = text => {
  const normalized = String(text ?? '').toLowerCase();
  return MUNDANE_LIFESTYLE_PATTERN.test(normalized) || MILD_INCONVENIENCE_PATTERN.test(normalized);
};
const dilemmaTagsForText = text => {
  const normalized = String(text ?? '').toLowerCase();
  const tags = new Set();
  for (const entry of DILEMMA_STRENGTH_LEXICON) if (entry.test.test(normalized)) tags.add(entry.tag);
  return tags;
};

// Words whose CORE meaning is an abstract cadence/schedule ("once", "quarterly") or an invisible
// mental/interpersonal state ("feedback", "review", "mindset") rather than anything a camera can
// show. Deliberately small and conservative -- this only measures words that survive
// image-query.js's own coreSubjectWords stripping (already used by the real image-search path to
// find an option's literal subject), so a question is penalized only for what would ALSO reach
// image search as its "subject", never for incidental phrasing already filtered out upstream.
const ABSTRACT_CADENCE_WORDS = new Set(['once', 'twice', 'annual', 'annually', 'quarterly', 'biannual', 'monthly', 'weekly', 'daily', 'yearly', 'periodically', 'routinely', 'occasionally', 'frequency', 'schedule', 'scheduled', 'year', 'years', 'month', 'months', 'week', 'weeks']);
const ABSTRACT_MENTAL_STATE_WORDS = new Set(['feedback', 'review', 'evaluation', 'appraisal', 'opinion', 'impression', 'mindset', 'mood', 'confidence', 'motivation', 'anxiety', 'stress', 'happiness', 'satisfaction']);
// Conservative per-option visualizability penalty: how much of the option's OWN literal subject
// (coreSubjectWords, the same words image search treats as the thing to depict) is abstract
// cadence/mental-state vocabulary versus a genuine concrete noun. A single abstract word next to a
// real concrete anchor ("a vacation every year") is barely penalized; an option that collapses
// almost entirely into abstract/cadence words with nothing concrete left ("feedback once year") is
// penalized the most. Never a hard rejection -- this only lowers RANK (see computeDilemmaStrengthScore
// below), so a weak-visual question stays in the pool and simply sorts below stronger, concrete ones.
const visualizabilityPenaltyForOption = text => {
  const subjectWords = coreSubjectWords(text);
  if (!subjectWords.length) return 20;
  const abstractCount = subjectWords.filter(word => ABSTRACT_CADENCE_WORDS.has(word) || ABSTRACT_MENTAL_STATE_WORDS.has(word)).length;
  if (abstractCount === 0) return 0;
  const concreteRatio = 1 - abstractCount / subjectWords.length;
  if (subjectWords.length <= 3 && concreteRatio <= 0.34) return 20; // collapses almost entirely into abstract/cadence words
  if (concreteRatio <= 0.5) return 10;
  return 4;
};
export const computeVisualizabilityPenalty = (optionAText, optionBText) => visualizabilityPenaltyForOption(optionAText) + visualizabilityPenaltyForOption(optionBText);

// WYR strength bonus for an already-accepted question: rewards options that each carry a
// recognizable psychological stake, and rewards it MORE when option A and option B land on
// DIFFERENT axes -- a real values tradeoff (e.g. freedom vs security, comfort vs ambition) reads as
// a harder, more identity-relevant decision than two options that are really "the same kind of
// thing" twice (e.g. yacht vs jet, both just status/luxury). Capped and additive so it nudges,
// rather than dominates, the existing hook_score it's combined with in pool-selection.js/
// question-pool.js. Also subtracts computeVisualizabilityPenalty (see above) so a question whose
// meaning is inherently hard to represent with a single real-world photograph -- abstract
// schedules/frequencies, invisible mental states -- ranks below an equally "strong" but genuinely
// photographable dilemma, without ever being rewritten, deleted, or hard-rejected.
export const computeDilemmaStrengthScore = (optionAText, optionBText) => {
  const tagsA = dilemmaTagsForText(optionAText);
  const tagsB = dilemmaTagsForText(optionBText);
  const allTags = new Set([...tagsA, ...tagsB]);
  const presenceBonus = Math.min(allTags.size, 4) * 10;
  const hasTagUniqueToA = [...tagsA].some(tag => !tagsB.has(tag));
  const hasTagUniqueToB = [...tagsB].some(tag => !tagsA.has(tag));
  const tradeoffBonus = hasTagUniqueToA && hasTagUniqueToB ? 20 : 0;
  const visualizabilityPenalty = computeVisualizabilityPenalty(optionAText, optionBText);
  // Belt-and-suspenders alongside removing bare "forever" from the lexicon above: if BOTH options
  // are low-stakes wardrobe/grooming/daily-habit/mild-annoyance choices, cap the score back down
  // even if one side incidentally also matched a real tag (e.g. via an unrelated filler word), so a
  // dismissible pair never out-ranks a genuine tradeoff purely on lexicon coincidence.
  const mundanePenalty = isMundaneLowStakes(optionAText) && isMundaneLowStakes(optionBText) ? 15 : 0;
  return Math.max(0, presenceBonus + tradeoffBonus - visualizabilityPenalty - mundanePenalty);
};

// Coarse emotional-tone bucket for a question, reusing the SAME lexicon as computeDilemmaStrengthScore
// (no separate tagging system to maintain) -- used only to encourage tone VARIETY across one video's
// selected set (see pool-selection.js's rankCandidatesByStrength), never to reject or fabricate
// questions. Five buckets, checked in priority order (most specific/surprising first) since a
// question can trip more than one lexicon tag at once: a fantasy/superpower dilemma reads as
// "surprising" regardless of any other tag it happens to also match; a gross/embarrassing one reads
// as "funny" even if it also mentions e.g. money; "lifestyle_tradeoff" is the common default for the
// large majority of ordinary WYR pairs that don't trip any of the more specific buckets.
export const deriveToneBucket = (optionAText, optionBText, isFantasy = false) => {
  const tags = new Set([...dilemmaTagsForText(optionAText), ...dilemmaTagsForText(optionBText)]);
  if (isFantasy || tags.has('power_fantasy')) return 'fantasy_surprising';
  if (tags.has('humor_absurd')) return 'funny_absurd';
  if (tags.has('consequence') || tags.has('loss')) return 'high_consequence';
  if (tags.has('love_social')) return 'relatable_social';
  return 'lifestyle_tradeoff';
};

// DILEMMA_STRENGTH_LEXICON above is built for general lifestyle WYR stakes (yacht, mansion,
// superpower) and rarely fires for a FOOD pair at all ("Pizza" vs "Burger" trips zero tags), so
// food ranking today falls back almost entirely to the stale, concision-only hook_score with no
// signal for what section B of the retention brief actually asks for: both options being
// INSTANTLY recognizable / broadly familiar. Deliberately its own small, self-contained lexicon
// (not imported from food-content.js's FOOD_HEADS/EXACT_FOODS, which only answers "is this a real
// food," not "how recognizable is it") so this stays a pure, isolated ranking signal with zero
// coupling to the FOOD-mode validation gate. A general lookup over common US/UK staple foods --
// never a specific hardcoded pair, so it naturally applies across the whole DB, not just one match.
const HIGH_RECOGNIZABILITY_FOOD_WORDS = new Set([
  'pizza', 'burger', 'burgers', 'cheeseburger', 'cheeseburgers', 'hotdog', 'hotdogs', 'hot', 'dog', 'dogs',
  'taco', 'tacos', 'burrito', 'burritos', 'sushi', 'fries', 'nuggets', 'sandwich', 'sandwiches',
  'pasta', 'spaghetti', 'lasagna', 'noodles', 'ramen', 'rice', 'chicken', 'steak', 'ribs', 'wings',
  'bacon', 'egg', 'eggs', 'omelet', 'omelette', 'pancake', 'pancakes', 'waffle', 'waffles', 'toast',
  'cereal', 'donut', 'donuts', 'doughnut', 'doughnuts', 'bagel', 'bagels', 'muffin', 'muffins',
  'croissant', 'croissants', 'cake', 'cupcake', 'cupcakes', 'cookie', 'cookies', 'brownie', 'brownies',
  'cheesecake', 'pie', 'icecream', 'gelato', 'milkshake', 'milkshakes', 'smoothie', 'smoothies',
  'chocolate', 'candy', 'popcorn', 'chips', 'nachos', 'salad', 'soup', 'dumpling', 'dumplings',
  'meatball', 'meatballs', 'shrimp', 'salmon', 'fish', 'lobster', 'pretzel', 'pretzels', 'coffee',
  'soda', 'lemonade', 'ice', 'cream',
]);
const isHighlyRecognizableFood = text => {
  const words = String(text ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return words.some(word => HIGH_RECOGNIZABILITY_FOOD_WORDS.has(word));
};
// Deliberately small: a modest tie-breaker on top of hook_score/computeDilemmaStrengthScore, never
// strong enough on its own to flip an already-clear hook_score gap (see pool-selection.js's
// computeDilemmaRankScore/arrangeForHook, which only apply this for category:'food' rows).
export const computeFoodRecognizabilityScore = (optionAText, optionBText) => {
  const aRecognizable = isHighlyRecognizableFood(optionAText);
  const bRecognizable = isHighlyRecognizableFood(optionBText);
  if (aRecognizable && bRecognizable) return 6;
  if (aRecognizable || bRecognizable) return 2;
  return 0;
};

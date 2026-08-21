import { assessQuestionQuality, isFantasyQuestion, optionSimilarity } from './content-engine.js';

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

// Deterministic, local (no Groq) lexicon of psychological tradeoff axes -- used ONLY to pick which
// of an already-finalized set of questions leads as Scene 1 (see pool-selection.js's
// arrangeForHook/computeOpeningRankScore). Deliberately keyword/regex-based, same spirit as
// computeHookScore and content-engine.js's MOTIF_ALIAS_RULES: no fake stats, no manufactured
// urgency, just recognizing when an option's own wording already carries a real psychological
// stake (status/luxury, loss aversion, freedom vs security, money vs time, comfort vs ambition,
// love/social vs success, rare benefit vs sacrifice, fantasy/power curiosity).
const OPENING_PSYCHOLOGY_LEXICON = Object.freeze([
  { tag: 'status_luxury', test: /\b(yacht|mansion|penthouse|private\s+jet|jet|luxury|designer|five[- ]star|first[- ]class|sports\s*car|celebrity|famous|fame|billion(?:aire)?s?|private\s+island)\b/ },
  { tag: 'wealth', test: /\b(money|rich|wealth\w*|salary|income|paycheck|dollars?|cash|millions?)\b/ },
  { tag: 'freedom', test: /\b(freedom|free\s+time|no\s+boss|remote\s+work|travel\s+the\s+world|quit\s+your\s+job|retire\s+early|your\s+own\s+boss)\b/ },
  { tag: 'security', test: /\b(stable\s+job|job\s+security|steady\s+paycheck|safety\s+net|guaranteed|health\s+insurance|savings)\b/ },
  { tag: 'time', test: /\b(weekends?|vacation|time\s+off|forever|every\s+(?:single\s+)?day)\b/ },
  { tag: 'comfort', test: /\b(comfort\w*|relax\w*|cozy|easy\s+life)\b/ },
  { tag: 'ambition', test: /\b(dream\s+job|career|success\w*|achieve\w*|hustle|ambition\w*|productive|productivity)\b/ },
  { tag: 'love_social', test: /\b(love|family|friends?|partner|relationship|soulmate|marry|marriage)\b/ },
  { tag: 'loss', test: /\b(lose|losing|give\s+up|never\s+again|can.?t\s+go\s+back|risk\s+losing|only\s+once)\b/ },
  { tag: 'power_fantasy', test: /\b(superpower\w*|read\b.{0,15}\bminds?\b|invisib\w*|flying|fly\b|time\s+travel|teleport\w*|telepath\w*|mind[- ]reading)\b/ },
]);
const openingTagsForText = text => {
  const normalized = String(text ?? '').toLowerCase();
  const tags = new Set();
  for (const entry of OPENING_PSYCHOLOGY_LEXICON) if (entry.test.test(normalized)) tags.add(entry.tag);
  return tags;
};

// Scene-1 opening bonus for an already-accepted question: rewards options that each carry a
// recognizable psychological stake, and rewards it MORE when option A and option B land on
// DIFFERENT axes -- a real values tradeoff (e.g. freedom vs security, comfort vs ambition) reads as
// a harder, more identity-relevant decision than two options that are really "the same kind of
// thing" twice (e.g. yacht vs jet, both just status/luxury). Capped and additive so it nudges,
// rather than dominates, the existing hook_score it's combined with in pool-selection.js.
export const computeOpeningPsychologyScore = (optionAText, optionBText) => {
  const tagsA = openingTagsForText(optionAText);
  const tagsB = openingTagsForText(optionBText);
  const allTags = new Set([...tagsA, ...tagsB]);
  const presenceBonus = Math.min(allTags.size, 4) * 10;
  const hasTagUniqueToA = [...tagsA].some(tag => !tagsB.has(tag));
  const hasTagUniqueToB = [...tagsB].some(tag => !tagsA.has(tag));
  const tradeoffBonus = hasTagUniqueToA && hasTagUniqueToB ? 20 : 0;
  return presenceBonus + tradeoffBonus;
};

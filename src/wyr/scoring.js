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

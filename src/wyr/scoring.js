import { assessQuestionQuality } from './content-engine.js';

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

export const computeHookScore = question => {
  const quality = computeQualityScore(question);
  if (quality === 0) return 0;
  const visual = computeVisualScore(question);
  const longestWordCount = Math.max(wordCount(question.optionA.text), wordCount(question.optionB.text));
  const concisionBonus = longestWordCount <= 6 ? 25 : longestWordCount <= 8 ? 10 : 0;
  return Math.round(quality * 0.4 + visual * 0.3 + concisionBonus + Math.min(quality, visual) * 0.05);
};

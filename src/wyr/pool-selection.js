// Pure, DB-free selection/classification logic for the PostgreSQL question pool. Kept separate
// from question-pool.js (which only does I/O: run a query, hand rows to these functions, write
// the result back) so the actual diversity/hook/fantasy rules are unit-testable without a
// database, and reused identically by both insertion (refill) and selection (video generation).
import { canonicalDilemma, canonicalMotifKey, deriveTopic, isFantasyQuestion, questionMotifs } from './content-engine.js';
import { computeHookScore, computeQualityScore, computeVisualScore } from './scoring.js';
import { assessQuestionQuality } from './content-engine.js';
import { estimateSceneDurationFromText } from './duration-estimate.js';

// The 20 Groq-facing categories bucketed into broader "content families" purely locally -- Groq
// never supplies or needs to know about this grouping. Chosen so a normal 8-question selection can
// realistically reach the >=6-distinct-families target while still enforcing a 2-per-family cap.
export const CONTENT_FAMILY_BY_CATEGORY = Object.freeze({
  superpowers: 'powers_and_impossible', fantasy: 'powers_and_impossible', 'impossible choices': 'powers_and_impossible',
  time: 'time_and_technology', 'future technology': 'time_and_technology',
  money: 'wealth_and_luxury', luxury: 'wealth_and_luxury', 'dream homes': 'wealth_and_luxury', cars: 'wealth_and_luxury',
  'dream lifestyle': 'lifestyle_and_freedom', freedom: 'lifestyle_and_freedom', fame: 'lifestyle_and_freedom',
  food: 'food_and_social', 'friendship/social': 'food_and_social', 'funny hypothetical': 'food_and_social',
  travel: 'travel_and_adventure', adventure: 'travel_and_adventure',
  space: 'nature_and_exploration', ocean: 'nature_and_exploration',
  'survival-lite': 'survival',
});
export const contentFamilyForCategory = category => CONTENT_FAMILY_BY_CATEGORY[category] || 'other';

// Everything a raw {category, optionA, optionB} candidate (from Groq or a fixture) needs before it
// can be inserted as a wyr_questions row: hard quality gate, motif fingerprints, content family,
// fantasy classification, dedupe key, and the three ranking scores.
export const computeInsertionFields = question => {
  const quality = assessQuestionQuality(question);
  if (!quality.accepted) return { accepted: false, reasons: quality.reasons };
  const [motifA, motifB] = questionMotifs(question);
  const motifKey = [motifA, motifB].filter(Boolean).sort().join('|') || null;
  return {
    accepted: true,
    category: question.category,
    contentFamily: contentFamilyForCategory(question.category),
    motifKey, motifKeyA: motifA || null, motifKeyB: motifB || null,
    optionAText: question.optionA.text, optionASearchQuery: question.optionA.searchQuery,
    optionBText: question.optionB.text, optionBSearchQuery: question.optionB.searchQuery,
    dedupeKey: canonicalDilemma(question),
    isFantasy: isFantasyQuestion(question, [motifA, motifB]),
    hookScore: computeHookScore(question), qualityScore: computeQualityScore(question), visualScore: computeVisualScore(question),
  };
};

// Diversity selection over a candidate window of "ready" rows, already ordered least-recently-used
// first by the caller's SQL. Hard rules (fantasy cap, motif cooldown/duplication) are never
// relaxed; the content-family cap is relaxed only if the window can't otherwise fill `count`, so a
// thin pool degrades gracefully instead of blocking a job the inventory could still service.
export const selectDiversePlan = (candidates, { count = 8, blockedMotifs = new Set() } = {}) => {
  const attempt = relaxFamilyCap => {
    const familyCounts = new Map(); let fantasyCount = 0; const usedMotifs = new Set(); const selected = [];
    for (const row of candidates) {
      if (selected.length >= count) break;
      if (row.motif_key_a && blockedMotifs.has(row.motif_key_a)) continue;
      if (row.motif_key_b && blockedMotifs.has(row.motif_key_b)) continue;
      if (row.motif_key_a && usedMotifs.has(row.motif_key_a)) continue;
      if (row.motif_key_b && usedMotifs.has(row.motif_key_b)) continue;
      if (row.is_fantasy && fantasyCount >= 1) continue;
      const familyCount = familyCounts.get(row.content_family) || 0;
      if (!relaxFamilyCap && familyCount >= 2) continue;
      selected.push(row); familyCounts.set(row.content_family, familyCount + 1);
      if (row.is_fantasy) fantasyCount += 1;
      if (row.motif_key_a) usedMotifs.add(row.motif_key_a);
      if (row.motif_key_b) usedMotifs.add(row.motif_key_b);
    }
    return { selected, distinctFamilies: familyCounts.size, fantasyCount };
  };
  let result = attempt(false);
  if (result.selected.length < count) result = attempt(true);
  if (result.selected.length < count) return null;
  return result;
};

// Duration-aware repair pass, applied AFTER selectDiversePlan has already chosen `count` rows.
// Estimates each selected row's scene duration from its option text (see duration-estimate.js,
// which mirrors the real buildSceneTimeline math) and, if the projected total leaves too little
// margin under the Shorts limit, greedily swaps the single longest-projected row for the shortest
// valid substitute drawn from the SAME already-fetched candidate window -- never a new DB query,
// never Groq. A substitute must belong to the SAME content_family as the row it replaces (a strict
// like-for-like swap): without this, a substitute is only checked against the aggregate family cap,
// which lets it fill a DIFFERENT family's freed-up capacity than the one it displaced, silently
// dropping one family from the plan while a different family ends up represented twice (e.g. two
// 'space' rows and zero 'time' rows) -- same-family-count-preserved, still 8 questions, still under
// the cap, yet a real diversity regression the cap alone doesn't catch. Every hard diversity rule
// (motif blocklist + within-plan motif cooldown, fantasy cap) is also re-checked for the substitute,
// so a duration repair can never quietly undo the diversity guarantees selectDiversePlan already
// enforced. Runs before arrangeForHook, so Scene 1 selection (strongest hook score) still operates
// on the final, duration-repaired set -- that logic itself is untouched.
export const repairPlanForDuration = ({ selected, candidates, blockedMotifs = new Set(), count = 8, targetTotalSeconds, baseDuration } = {}) => {
  const durationOf = row => estimateSceneDurationFromText(row.option_a_text, row.option_b_text, { baseDuration });
  let working = [...selected];
  let swapped = false;
  const total = () => working.reduce((sum, row) => sum + durationOf(row), 0);

  const canSubstitute = (candidate, outgoing) => {
    if (working.some(row => row.id === candidate.id)) return false;
    if (candidate.content_family !== outgoing.content_family) return false;
    if (candidate.motif_key_a && blockedMotifs.has(candidate.motif_key_a)) return false;
    if (candidate.motif_key_b && blockedMotifs.has(candidate.motif_key_b)) return false;
    const motifsElsewhereInPlan = new Set();
    for (const row of working) {
      if (row.id === outgoing.id) continue;
      if (row.motif_key_a) motifsElsewhereInPlan.add(row.motif_key_a);
      if (row.motif_key_b) motifsElsewhereInPlan.add(row.motif_key_b);
    }
    if (candidate.motif_key_a && motifsElsewhereInPlan.has(candidate.motif_key_a)) return false;
    if (candidate.motif_key_b && motifsElsewhereInPlan.has(candidate.motif_key_b)) return false;
    const fantasyCountWithoutOutgoing = working.filter(row => row.is_fantasy && row.id !== outgoing.id).length;
    if (candidate.is_fantasy && fantasyCountWithoutOutgoing >= 1) return false;
    return true;
  };

  for (let iteration = 0; iteration < count; iteration += 1) {
    if (total() <= targetTotalSeconds) break;
    const outgoing = [...working].sort((a, b) => durationOf(b) - durationOf(a))[0];
    const incoming = candidates
      .filter(row => canSubstitute(row, outgoing))
      .sort((a, b) => durationOf(a) - durationOf(b))
      .find(row => durationOf(row) < durationOf(outgoing));
    if (!incoming) break; // no valid shorter substitute available locally -- stop, let the caller decide
    working = working.map(row => (row.id === outgoing.id ? incoming : row));
    swapped = true;
  }

  const projectedTotalSeconds = total();
  return { selected: working, swapped, projectedTotalSeconds, fits: projectedTotalSeconds <= targetTotalSeconds };
};

// Scene 1 is the highest-priority slot: whichever selected question has the strongest hook score
// leads, and the rest keep their diversity-selection order rather than being fully re-sorted by
// score (a flat score sort would front-load every strong hook and let pacing collapse afterward).
export const arrangeForHook = rows => {
  if (rows.length <= 1) return [...rows];
  const strongest = rows.reduce((best, row) => Number(row.hook_score) > Number(best.hook_score) ? row : best, rows[0]);
  return [strongest, ...rows.filter(row => row.id !== strongest.id)];
};

const rowToQuestion = (row, index) => ({
  index, category: row.category,
  optionA: { text: row.option_a_text, searchQuery: row.option_a_search_query },
  optionB: { text: row.option_b_text, searchQuery: row.option_b_search_query },
  poolId: row.id,
});

export const buildPlanFromPoolRows = rows => {
  const arranged = arrangeForHook(rows);
  const questions = arranged.map((row, index) => rowToQuestion(row, index));
  return {
    version: 1,
    topic: deriveTopic(questions),
    percentages: null,
    source: 'database_pool',
    contentQuality: {
      source: 'database_pool',
      distinctFamilies: new Set(rows.map(row => row.content_family)).size,
      fantasyCount: rows.filter(row => row.is_fantasy).length,
    },
    questions,
  };
};

export const canonicalMotifKeyOf = text => canonicalMotifKey({ text });

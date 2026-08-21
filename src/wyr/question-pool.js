import { withClient, withTransaction } from './db.js';
import { classifyRejectionReasons, computeInsertionFields, rankCandidatesByStrength, selectDiversePlan, repairPlanForDuration, buildPlanFromPoolRows } from './pool-selection.js';
import { DEFAULT_DURATION_BUDGET_TOTAL_SECONDS } from './duration-estimate.js';
import { hasNaturalWording, isNonPhotographableAbstractOption, isVisualSubjectFeasible } from './content-engine.js';
import { log, redactConnectionSecrets } from './utils.js';

// Diagnostics only -- max rows actually printed to Railway logs per insert_batch call, so a batch
// rejecting in the hundreds (see rejection_summary counts, which are never truncated) still produces
// a bounded log line rather than one entry per rejected question.
const REJECTION_LOG_SAMPLE_SIZE = 10;
// Shared by every insertQuestions() caller (startup seed, refill, JSON import) so "pool.insert_batch"
// always carries the same diagnostics shape, regardless of source. Never logs raw error objects or
// connection details -- only the already-redacted reason strings classifyRejectionReasons bucketed,
// plus the option text/category the question itself supplied.
export const logRejectionDiagnostics = (event, rejected) => {
  if (!rejected.length) return;
  const summary = {};
  for (const item of rejected) summary[item.rejectionType] = (summary[item.rejectionType] || 0) + 1;
  log(`${event}.rejection_summary`, summary);
  const sample = rejected.slice(0, REJECTION_LOG_SAMPLE_SIZE).map(item => ({
    optionA: item.optionA, optionB: item.optionB, category: item.category,
    rejectionType: item.rejectionType, rejectionReason: item.rejectionReason,
  }));
  log(`${event}.rejection_sample`, { sampleSize: sample.length, totalRejected: rejected.length, sample });
};

export class ContentPoolExhaustedError extends Error {
  constructor(message, details = {}) { super(message); this.code = 'CONTENT_POOL_EMPTY'; Object.assign(this, details); }
}

// Thrown when a diverse 8-question set WAS found, but even after locally swapping the
// longest-projected questions for shorter ready ones (see repairPlanForDuration), the estimated
// total still can't fit under budget. Deliberately distinct from ContentPoolExhaustedError: the
// caller (content-source.js) must never respond to this by calling Groq -- see requirement to keep
// duration repair a purely local, DB-only retry.
export class DurationBudgetExceededError extends Error {
  constructor(message, details = {}) { super(message); this.code = 'DURATION_BUDGET_EXCEEDED'; Object.assign(this, details); }
}

export const countReady = async () => {
  const { rows } = await withClient(client => client.query("SELECT count(*)::int AS count FROM wyr_questions WHERE status = 'ready'"));
  return rows[0].count;
};

// Admin/status-panel read model, sourced entirely from wyr_questions.status. A question that has
// been successfully used in a completed, verified video is retired to status='used' (see
// commitPlanUsage below) and never rotates back to 'ready' -- so "used" here counts consumed
// QUESTION ROWS, not completed videos, and directly reflects how much of the pool has been spent.
export const getPoolStats = async () => withClient(async client => {
  const { rows: statusRows } = await client.query('SELECT status, count(*)::int AS count FROM wyr_questions GROUP BY status');
  const byStatus = Object.fromEntries(statusRows.map(row => [row.status, row.count]));
  const total = statusRows.reduce((sum, row) => sum + row.count, 0);
  return { ready: byStatus.ready || 0, reserved: byStatus.reserved || 0, used: byStatus.used || 0, total };
});

// Validates and inserts a raw Groq (or fixture) batch. Rejections never throw -- a bad candidate
// is just excluded, so one malformed item in a batch can't discard the rest. A dedupe_key
// collision (already in the pool, worded differently or not) is treated as a rejection too, via
// the DB-level UNIQUE constraint -- the source of truth for "already have this" is the table
// itself, not an in-memory snapshot that could go stale between refill batches.
// A rejected-question diagnostics record never carries anything beyond what the caller itself
// supplied (option text, category) plus a classified reason -- never a raw DB error object, a
// connection string, or any credential/token.
const rejectionRecord = (raw, reasons) => ({
  question: raw, reasons,
  optionA: raw?.optionA?.text ?? null, optionB: raw?.optionB?.text ?? null, category: raw?.category ?? null,
  ...classifyRejectionReasons(reasons),
});
export const insertQuestions = async (rawQuestions, { sourceProvider = 'groq' } = {}) => withTransaction(async client => {
  const inserted = []; const rejected = [];
  for (const raw of rawQuestions) {
    const fields = computeInsertionFields(raw);
    if (!fields.accepted) { rejected.push(rejectionRecord(raw, fields.reasons)); continue; }
    try {
      const { rows } = await client.query(
        `INSERT INTO wyr_questions
           (category, content_family, motif_key, motif_key_a, motif_key_b,
            option_a_text, option_a_search_query, option_a_visual_subject,
            option_b_text, option_b_search_query, option_b_visual_subject,
            dedupe_key, is_fantasy, hook_score, quality_score, visual_score, source_provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        [fields.category, fields.contentFamily, fields.motifKey, fields.motifKeyA, fields.motifKeyB,
          fields.optionAText, fields.optionASearchQuery, fields.optionAVisualSubject,
          fields.optionBText, fields.optionBSearchQuery, fields.optionBVisualSubject,
          fields.dedupeKey, fields.isFantasy, fields.hookScore, fields.qualityScore, fields.visualScore, sourceProvider],
      );
      if (rows.length) inserted.push(rows[0].id);
      else rejected.push(rejectionRecord(raw, ['duplicate of a question already in the pool']));
    } catch (error) { rejected.push(rejectionRecord(raw, [redactConnectionSecrets(error.message)])); }
  }
  log('pool.insert_batch', { attempted: rawQuestions.length, inserted: inserted.length, rejected: rejected.length });
  logRejectionDiagnostics('pool.insert_batch', rejected);
  return { inserted, rejected };
});

const MOTIF_HISTORY_WINDOW_VIDEOS = 50;
const recentMotifsFromDb = async (client, windowVideos = MOTIF_HISTORY_WINDOW_VIDEOS) => {
  const { rows } = await client.query(
    `SELECT q.motif_key_a, q.motif_key_b
     FROM wyr_video_questions vq
     JOIN wyr_questions q ON q.id = vq.question_id
     WHERE vq.video_id IN (SELECT id FROM wyr_videos ORDER BY created_at DESC LIMIT $1)`,
    [windowVideos],
  );
  const motifs = new Set();
  for (const row of rows) { if (row.motif_key_a) motifs.add(row.motif_key_a); if (row.motif_key_b) motifs.add(row.motif_key_b); }
  return motifs;
};

// Atomically reserves exactly `count` diverse, duration-budgeted questions for one job, drawn only
// from status='ready' rows -- a question retired to status='used' by commitPlanUsage (see below)
// can never appear in this candidate window again, so a consumed question is never reselected for
// a future video, in any job, ever. FOR UPDATE SKIP LOCKED lets concurrent jobs each grab their own
// candidate window without blocking on or double-selecting rows another in-flight job already has
// locked. The candidate query orders by last_used_at/used_count (both always null/0 for 'ready'
// rows in this consume-once model, since either one being set means the row already moved to
// 'used') then hook_score as the effective tie-break -- hook_score already rewards concise option
// text (see scoring.js's concisionBonus), so this naturally favors shorter questions for normal
// generation, before duration repair ever needs to run. Returns null (never throws) when the ready
// pool can't currently fill a full video at all -- the caller decides whether that means "try an
// emergency refill" or "fail with CONTENT_POOL_EMPTY". Throws DurationBudgetExceededError (never
// returns null for this case) when a diverse set WAS found but couldn't be brought under the
// duration budget using only this candidate window -- that failure must never trigger a Groq call.
export const selectAndReservePlan = async ({ jobId, count = 8, candidateWindowSize = 80, baseDuration = 7, targetTotalSeconds = DEFAULT_DURATION_BUDGET_TOTAL_SECONDS }) => withTransaction(async client => {
  const { rows: rawCandidates } = await client.query(
    `SELECT * FROM wyr_questions WHERE status = 'ready'
     ORDER BY last_used_at ASC NULLS FIRST, used_count ASC, hook_score DESC, id ASC
     LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [candidateWindowSize],
  );
  // Runtime defense-in-depth: assessQuestionQuality/computeInsertionFields already reject this
  // content at insertion time for anything inserted from now on (see content-engine.js's
  // isNonPhotographableAbstractOption and isVisualSubjectFeasible), but a row inserted before
  // those checks existed could still be sitting in the pool with status='ready'. A legacy row with
  // no option_a_visual_subject/option_b_visual_subject falls back to its own search query (same
  // rule as rowToQuestion below) and is validated the same way a fresh visualSubject would be --
  // if that still isn't feasible, the row is excluded here so selectDiversePlan/repairPlanForDuration
  // below simply never see it, and the existing "choose another ready question from this window"
  // machinery does the rest, with zero new reservation state and zero new DB round-trip.
  const visuallyFeasible = rawCandidates.filter(row =>
    !isNonPhotographableAbstractOption(row.option_a_text) && !isNonPhotographableAbstractOption(row.option_b_text)
    && isVisualSubjectFeasible(row.option_a_visual_subject || row.option_a_search_query)
    && isVisualSubjectFeasible(row.option_b_visual_subject || row.option_b_search_query));
  // Second, independent re-validation pass: a 'ready' row may predate the general wording-quality
  // gate (hasNaturalWording, added to assessQuestionQuality -- see content-engine.js) that now runs
  // at insertion time. Re-checking here means an awkward/fragment-like legacy row is simply skipped
  // for THIS job -- never reserved, never sent to image search, never counted toward the final plan,
  // never marked 'used' -- exactly like the visual-feasibility filter above; selectDiversePlan below
  // never even sees it, so it naturally reaches for the next best 'ready' candidate instead.
  const naturalWording = visuallyFeasible.filter(row => hasNaturalWording(row.option_a_text) && hasNaturalWording(row.option_b_text));
  const wordingRejectedCount = visuallyFeasible.length - naturalWording.length;
  // Prefer stronger eligible dilemmas first (see pool-selection.js's rankCandidatesByStrength):
  // re-sorts WITHIN each LRU tier only, so a genuinely staler row never loses its fair-rotation
  // priority to a fresher-but-weaker one -- weaker questions stay in the window, just later in it.
  const candidates = rankCandidatesByStrength(naturalWording);
  const blockedMotifs = await recentMotifsFromDb(client);
  const result = selectDiversePlan(candidates, { count, blockedMotifs });
  if (!result) return null;
  const repair = repairPlanForDuration({ selected: result.selected, candidates, blockedMotifs, count, targetTotalSeconds, baseDuration });
  if (!repair.fits) {
    throw new DurationBudgetExceededError(
      `Could not select ${count} questions projected under ${targetTotalSeconds.toFixed(1)}s using only the current ready pool; the best local substitution still projected ${repair.projectedTotalSeconds.toFixed(1)}s. Seed or refill the pool with more concise questions.`,
      { projectedTotalSeconds: repair.projectedTotalSeconds, targetTotalSeconds },
    );
  }
  const selected = repair.selected;
  const ids = selected.map(row => row.id);
  await client.query(
    "UPDATE wyr_questions SET status = 'reserved', reserved_by_job = $1, reserved_at = now(), updated_at = now() WHERE id = ANY($2::bigint[])",
    [jobId, ids],
  );
  const distinctFamilies = new Set(selected.map(row => row.content_family)).size;
  const fantasyCount = selected.filter(row => row.is_fantasy).length;
  log('pool.reserved', { jobId, count: selected.length, distinctFamilies, fantasyCount, durationRepaired: repair.swapped, projectedTotalSeconds: repair.projectedTotalSeconds, wordingRejectedCount });
  return { selected, distinctFamilies, fantasyCount, wordingRejectedCount };
});

export const selectPlanForJob = async ({ jobId, count = 8, candidateWindowSize = 80, baseDuration, targetTotalSeconds }) => {
  const reservation = await selectAndReservePlan({ jobId, count, candidateWindowSize, baseDuration, targetTotalSeconds });
  if (!reservation) return null;
  const plan = buildPlanFromPoolRows(reservation.selected);
  plan.contentQuality.wordingRejectedCount = reservation.wordingRejectedCount;
  return plan;
};

export const releaseReservation = async jobId => {
  const { rowCount } = await withClient(client => client.query(
    "UPDATE wyr_questions SET status = 'ready', reserved_by_job = NULL, reserved_at = NULL, updated_at = now() WHERE reserved_by_job = $1 AND status = 'reserved'",
    [jobId],
  ));
  log('pool.reservation_released', { jobId, count: rowCount });
  return rowCount;
};

// Targeted, single-row counterpart to releaseReservation above -- releases exactly ONE reserved
// question back to 'ready' instead of every row reserved by this job. Used only by pipeline.js's
// bounded per-question image-selection-exhaustion replacement (see runAutomaticPipeline): when a
// question can't obtain both valid option images after the existing bounded image-search fallback,
// that ONE question is released (never consumed as 'used') so it stays available for a future job,
// while the OTHER already-reserved questions in this job are left untouched.
export const releaseQuestionReservation = async ({ jobId, poolId }) => {
  const { rowCount } = await withClient(client => client.query(
    "UPDATE wyr_questions SET status = 'ready', reserved_by_job = NULL, reserved_at = NULL, updated_at = now() WHERE id = $1 AND reserved_by_job = $2 AND status = 'reserved'",
    [poolId, jobId],
  ));
  log('pool.question_released', { jobId, poolId, released: rowCount > 0 });
  return rowCount;
};

// Reserves exactly ONE more READY question for a job already mid-flight -- the replacement
// counterpart to selectAndReservePlan's all-at-once batch reservation, used only when a question
// already in the plan turned out to be image-unfillable (see releaseQuestionReservation above and
// pipeline.js's runAutomaticPipeline). Same FOR UPDATE SKIP LOCKED concurrency safety as
// selectAndReservePlan: two jobs racing for a replacement can never double-reserve the same row.
// Re-enforces the same HARD diversity rules selectDiversePlan treats as non-negotiable (motif
// dedup within this plan, fantasy cap) -- never the content-family cap, which selectDiversePlan
// itself already treats as soft/relaxable when the candidate window is thin. Returns
// { candidate: null, wordingRejectedCount } (never throws) when no valid replacement exists in the
// current window, so the caller can stop and fail clearly instead of looping forever;
// wordingRejectedCount is always reported so the caller can fold it into job-level diagnostics.
export const reserveReplacementQuestion = async ({ jobId, excludeIds = [], inPlanMotifs = new Set(), fantasyCapReached = false, candidateWindowSize = 80 }) => withTransaction(async client => {
  const { rows: rawCandidates } = await client.query(
    `SELECT * FROM wyr_questions WHERE status = 'ready' AND NOT (id = ANY($1::bigint[]))
     ORDER BY last_used_at ASC NULLS FIRST, used_count ASC, hook_score DESC, id ASC
     LIMIT $2 FOR UPDATE SKIP LOCKED`,
    [excludeIds, candidateWindowSize],
  );
  // Same strength-first re-rank as selectAndReservePlan above -- a replacement should prefer a
  // stronger eligible dilemma too, not just whichever ready row happens to sort first on hook_score.
  const candidates = rankCandidatesByStrength(rawCandidates);
  let wordingRejectedCount = 0;
  const candidate = candidates.find(row => {
    if (row.motif_key_a && inPlanMotifs.has(row.motif_key_a)) return false;
    if (row.motif_key_b && inPlanMotifs.has(row.motif_key_b)) return false;
    if (row.is_fantasy && fantasyCapReached) return false;
    // Same visual-feasibility check as selectAndReservePlan's candidate window above -- a
    // replacement must not itself be a legacy row with no reliable visual metadata.
    if (isNonPhotographableAbstractOption(row.option_a_text) || isNonPhotographableAbstractOption(row.option_b_text)) return false;
    if (!isVisualSubjectFeasible(row.option_a_visual_subject || row.option_a_search_query)) return false;
    if (!isVisualSubjectFeasible(row.option_b_visual_subject || row.option_b_search_query)) return false;
    // Same wording-quality re-validation as selectAndReservePlan above -- a replacement candidate
    // gets no weaker a gate than the original plan did.
    if (!hasNaturalWording(row.option_a_text) || !hasNaturalWording(row.option_b_text)) { wordingRejectedCount += 1; return false; }
    return true;
  });
  if (!candidate) return { candidate: null, wordingRejectedCount };
  await client.query(
    "UPDATE wyr_questions SET status = 'reserved', reserved_by_job = $1, reserved_at = now(), updated_at = now() WHERE id = $2",
    [jobId, candidate.id],
  );
  log('pool.replacement_reserved', { jobId, replacedWithQuestionId: candidate.id, wordingRejectedCount });
  return { candidate, wordingRejectedCount };
});

// The job store (jobs.js) is an in-memory Map with no reload-from-disk on startup, so a process
// restart (Railway redeploy, crash, OOM) while a job is mid-flight orphans its reservation forever
// -- releaseReservation above only ever runs from inside THIS process's own handleJobFailure/commit
// path, which a dead process can never reach again. Nothing else in the codebase ever revisits a
// 'reserved' row, so without this, every interrupted job permanently shrinks the ready pool. Called
// once at server boot (see wyr-server.js), after migrations. Nothing legitimate should still be
// 'reserved' from a FRESH process's own perspective -- its job Map starts empty -- so this only
// needs to skip reservations young enough that they could belong to a still-finishing job from a
// brief old/new instance overlap during a rolling deploy; 20 minutes is far beyond the longest
// realistic single job (image search + TTS + render together normally complete in well under 5).
export const STALE_RESERVATION_AGE_MS = 20 * 60 * 1000;
export const releaseStaleReservations = async (olderThanMs = STALE_RESERVATION_AGE_MS) => {
  const { rowCount } = await withClient(client => client.query(
    "UPDATE wyr_questions SET status = 'ready', reserved_by_job = NULL, reserved_at = NULL, updated_at = now() WHERE status = 'reserved' AND reserved_at < now() - ($1 || ' milliseconds')::interval",
    [olderThanMs],
  ));
  if (rowCount) log('pool.stale_reservations_released', { count: rowCount, olderThanMs });
  return rowCount;
};

// Only called after a final MP4 has been verified successfully. Records the video/question
// relationship (for future motif-cooldown and performance-data queries) and retires the reserved
// questions to a terminal 'used' status with an updated used_count/last_used_at. Deliberately does
// NOT return them to 'ready': a question successfully used in a completed video must never be
// eligible for selection again (selectAndReservePlan's candidate query only ever reads
// status='ready' rows) -- this is a one-way, consume-once pool, not a rotating one.
//
// Idempotent per jobId: the wyr_videos insert already dedupes via its job_id UNIQUE constraint
// (ON CONFLICT DO UPDATE, never a second row), and the used_count UPDATE below is scoped to rows
// still reserved by THIS job -- so if this is ever invoked twice for the same completed job (e.g.
// a duplicated completion callback), the second call finds those rows already at status='used'
// with reserved_by_job=NULL and updates zero rows, instead of double-incrementing used_count or
// double-committing usage.
export const commitPlanUsage = async ({ jobId, plan, duration }) => withTransaction(async client => {
  const ids = plan.questions.map(question => question.poolId);
  const { rows: videoRows } = await client.query(
    `INSERT INTO wyr_videos (job_id, status, duration, topic) VALUES ($1, 'completed', $2, $3)
     ON CONFLICT (job_id) DO UPDATE SET status = 'completed', duration = EXCLUDED.duration, updated_at = now()
     RETURNING id`,
    [jobId, Number.isFinite(duration) ? duration : null, plan.topic],
  );
  const videoId = videoRows[0].id;
  for (const question of plan.questions) {
    await client.query('INSERT INTO wyr_video_questions (video_id, question_id, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [videoId, question.poolId, question.index]);
  }
  const { rowCount: questionsUpdated } = await client.query(
    "UPDATE wyr_questions SET status = 'used', reserved_by_job = NULL, reserved_at = NULL, used_count = used_count + 1, last_used_at = now(), updated_at = now() WHERE id = ANY($1::bigint[]) AND reserved_by_job = $2 AND status = 'reserved'",
    [ids, jobId],
  );
  log('pool.usage_committed', { jobId, videoId, count: ids.length, questionsUpdated });
  return videoId;
});

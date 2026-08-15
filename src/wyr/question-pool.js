import { withClient, withTransaction } from './db.js';
import { computeInsertionFields, selectDiversePlan, buildPlanFromPoolRows } from './pool-selection.js';
import { log } from './utils.js';

export class ContentPoolExhaustedError extends Error {
  constructor(message, details = {}) { super(message); this.code = 'CONTENT_POOL_EMPTY'; Object.assign(this, details); }
}

export const countReady = async () => {
  const { rows } = await withClient(client => client.query("SELECT count(*)::int AS count FROM wyr_questions WHERE status = 'ready'"));
  return rows[0].count;
};

// Validates and inserts a raw Groq (or fixture) batch. Rejections never throw -- a bad candidate
// is just excluded, so one malformed item in a batch can't discard the rest. A dedupe_key
// collision (already in the pool, worded differently or not) is treated as a rejection too, via
// the DB-level UNIQUE constraint -- the source of truth for "already have this" is the table
// itself, not an in-memory snapshot that could go stale between refill batches.
export const insertQuestions = async (rawQuestions, { sourceProvider = 'groq' } = {}) => withTransaction(async client => {
  const inserted = []; const rejected = [];
  for (const raw of rawQuestions) {
    const fields = computeInsertionFields(raw);
    if (!fields.accepted) { rejected.push({ question: raw, reasons: fields.reasons }); continue; }
    try {
      const { rows } = await client.query(
        `INSERT INTO wyr_questions
           (category, content_family, motif_key, motif_key_a, motif_key_b,
            option_a_text, option_a_search_query, option_b_text, option_b_search_query,
            dedupe_key, is_fantasy, hook_score, quality_score, visual_score, source_provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        [fields.category, fields.contentFamily, fields.motifKey, fields.motifKeyA, fields.motifKeyB,
          fields.optionAText, fields.optionASearchQuery, fields.optionBText, fields.optionBSearchQuery,
          fields.dedupeKey, fields.isFantasy, fields.hookScore, fields.qualityScore, fields.visualScore, sourceProvider],
      );
      if (rows.length) inserted.push(rows[0].id);
      else rejected.push({ question: raw, reasons: ['duplicate of a question already in the pool'] });
    } catch (error) { rejected.push({ question: raw, reasons: [error.message] }); }
  }
  log('pool.insert_batch', { attempted: rawQuestions.length, inserted: inserted.length, rejected: rejected.length });
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

// Atomically reserves exactly `count` diverse, non-recently-used questions for one job.
// FOR UPDATE SKIP LOCKED lets concurrent jobs each grab their own candidate window without
// blocking on or double-selecting rows another in-flight job already has locked. Returns null
// (never throws) when the ready pool can't currently fill a full video -- the caller decides
// whether that means "try an emergency refill" or "fail with CONTENT_POOL_EMPTY".
export const selectAndReservePlan = async ({ jobId, count = 8, candidateWindowSize = 80 }) => withTransaction(async client => {
  const { rows: candidates } = await client.query(
    `SELECT * FROM wyr_questions WHERE status = 'ready'
     ORDER BY last_used_at ASC NULLS FIRST, used_count ASC, id ASC
     LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [candidateWindowSize],
  );
  const blockedMotifs = await recentMotifsFromDb(client);
  const result = selectDiversePlan(candidates, { count, blockedMotifs });
  if (!result) return null;
  const ids = result.selected.map(row => row.id);
  await client.query(
    "UPDATE wyr_questions SET status = 'reserved', reserved_by_job = $1, reserved_at = now(), updated_at = now() WHERE id = ANY($2::bigint[])",
    [jobId, ids],
  );
  log('pool.reserved', { jobId, count: result.selected.length, distinctFamilies: result.distinctFamilies, fantasyCount: result.fantasyCount });
  return result;
});

export const selectPlanForJob = async ({ jobId, count = 8, candidateWindowSize = 80 }) => {
  const reservation = await selectAndReservePlan({ jobId, count, candidateWindowSize });
  if (!reservation) return null;
  return buildPlanFromPoolRows(reservation.selected);
};

export const releaseReservation = async jobId => {
  const { rowCount } = await withClient(client => client.query(
    "UPDATE wyr_questions SET status = 'ready', reserved_by_job = NULL, reserved_at = NULL, updated_at = now() WHERE reserved_by_job = $1 AND status = 'reserved'",
    [jobId],
  ));
  log('pool.reservation_released', { jobId, count: rowCount });
  return rowCount;
};

// Only called after a final MP4 has been verified successfully. Records the video/question
// relationship (for future motif-cooldown and performance-data queries) and returns the reserved
// questions to 'ready' with an updated used_count/last_used_at, so they naturally rotate to the
// back of the least-recently-used queue instead of being permanently retired.
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
  await client.query(
    "UPDATE wyr_questions SET status = 'ready', reserved_by_job = NULL, reserved_at = NULL, used_count = used_count + 1, last_used_at = now(), updated_at = now() WHERE id = ANY($1::bigint[])",
    [ids],
  );
  log('pool.usage_committed', { jobId, videoId, count: ids.length });
  return videoId;
});

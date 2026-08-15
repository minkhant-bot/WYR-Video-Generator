// A minimal in-memory stand-in for a pg.Pool/Client, used only by mocked-integration tests. It
// understands exactly the query shapes question-pool.js/migrate.js issue -- it is NOT a general
// SQL engine and proves nothing about real PostgreSQL semantics (real UNIQUE constraints, real
// FOR UPDATE SKIP LOCKED concurrency, real transaction isolation). It verifies wiring: the right
// SQL intent runs against the right in-memory state, in the right order, inside BEGIN/COMMIT.
let nextId = 1;

export const createFakeDb = () => {
  const state = { questions: new Map(), videos: new Map(), videoQuestions: [], migrations: new Set(), nextVideoId: 1 };
  const log = [];

  const query = async (sql, params = []) => {
    log.push(sql.trim().split('\n')[0]);
    const text = sql.trim();
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    if (text.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) return { rows: [] };
    if (text.startsWith('SELECT name FROM schema_migrations')) return { rows: [...state.migrations].map(name => ({ name })) };
    if (text.startsWith('INSERT INTO schema_migrations')) { state.migrations.add(params[0]); return { rows: [] }; }

    if (text.startsWith('SELECT count(*)::int AS count FROM wyr_questions')) {
      const count = [...state.questions.values()].filter(row => row.status === 'ready').length;
      return { rows: [{ count }] };
    }
    if (text.startsWith('SELECT status, count(*)::int AS count FROM wyr_questions GROUP BY status')) {
      const counts = new Map();
      for (const row of state.questions.values()) counts.set(row.status, (counts.get(row.status) || 0) + 1);
      return { rows: [...counts.entries()].map(([status, count]) => ({ status, count })) };
    }
    if (text.startsWith('SELECT count(*)::int AS count FROM wyr_videos')) {
      return { rows: [{ count: state.videos.size }] };
    }
    if (text.startsWith('INSERT INTO wyr_questions')) {
      const [category, contentFamily, motifKey, motifKeyA, motifKeyB, optionAText, optionASearchQuery, optionBText, optionBSearchQuery, dedupeKey, isFantasy, hookScore, qualityScore, visualScore, sourceProvider] = params;
      const existing = [...state.questions.values()].find(row => row.dedupe_key === dedupeKey);
      if (existing) return { rows: [] };
      const id = nextId++;
      state.questions.set(id, {
        id, category, content_family: contentFamily, motif_key: motifKey, motif_key_a: motifKeyA, motif_key_b: motifKeyB,
        option_a_text: optionAText, option_a_search_query: optionASearchQuery, option_b_text: optionBText, option_b_search_query: optionBSearchQuery,
        dedupe_key: dedupeKey, is_fantasy: isFantasy, hook_score: hookScore, quality_score: qualityScore, visual_score: visualScore,
        source_provider: sourceProvider, status: 'ready', used_count: 0, last_used_at: null, reserved_by_job: null, reserved_at: null,
      });
      return { rows: [{ id }] };
    }
    if (text.startsWith('SELECT * FROM wyr_questions')) {
      const [limit] = params;
      const ready = [...state.questions.values()].filter(row => row.status === 'ready')
        .sort((left, right) => (left.last_used_at ? 1 : 0) - (right.last_used_at ? 1 : 0) || left.used_count - right.used_count || right.hook_score - left.hook_score || left.id - right.id);
      return { rows: ready.slice(0, limit) };
    }
    if (text.startsWith('SELECT q.motif_key_a, q.motif_key_b')) {
      const [windowVideos] = params;
      const recentVideoIds = [...state.videos.values()].sort((left, right) => right.created_at - left.created_at).slice(0, windowVideos).map(video => video.id);
      const rows = state.videoQuestions.filter(vq => recentVideoIds.includes(vq.video_id)).map(vq => {
        const question = state.questions.get(vq.question_id);
        return { motif_key_a: question?.motif_key_a ?? null, motif_key_b: question?.motif_key_b ?? null };
      });
      return { rows };
    }
    if (text.startsWith("UPDATE wyr_questions SET status = 'reserved'")) {
      const [jobId, ids] = params;
      for (const id of ids) { const row = state.questions.get(id); if (row) { row.status = 'reserved'; row.reserved_by_job = jobId; row.reserved_at = new Date(); } }
      return { rows: [], rowCount: ids.length };
    }
    if (text.startsWith("UPDATE wyr_questions SET status = 'ready', reserved_by_job = NULL, reserved_at = NULL, updated_at = now() WHERE reserved_by_job")) {
      const [jobId] = params;
      let count = 0;
      for (const row of state.questions.values()) if (row.reserved_by_job === jobId && row.status === 'reserved') { row.status = 'ready'; row.reserved_by_job = null; row.reserved_at = null; count += 1; }
      return { rows: [], rowCount: count };
    }
    if (text.startsWith('INSERT INTO wyr_videos')) {
      const [jobId, duration, topic] = params;
      let video = [...state.videos.values()].find(v => v.job_id === jobId);
      if (!video) { video = { id: state.nextVideoId++, job_id: jobId, status: 'completed', duration, topic, created_at: new Date(Date.now() + state.nextVideoId) }; state.videos.set(video.id, video); }
      else { video.status = 'completed'; video.duration = duration; }
      return { rows: [{ id: video.id }] };
    }
    if (text.startsWith('INSERT INTO wyr_video_questions')) {
      const [videoId, questionId, position] = params;
      if (!state.videoQuestions.some(vq => vq.video_id === videoId && vq.question_id === questionId)) state.videoQuestions.push({ video_id: videoId, question_id: questionId, position });
      return { rows: [] };
    }
    if (text.startsWith("UPDATE wyr_questions SET status = 'ready', reserved_by_job = NULL, reserved_at = NULL, used_count")) {
      const [ids] = params;
      for (const id of ids) { const row = state.questions.get(id); if (row) { row.status = 'ready'; row.reserved_by_job = null; row.reserved_at = null; row.used_count += 1; row.last_used_at = new Date(); } }
      return { rows: [] };
    }
    // Migration bodies are opaque to this fake -- it only needs to prove BEGIN/apply/COMMIT/record
    // wiring works, not execute arbitrary DDL. Treat any other statement as a harmless no-op.
    return { rows: [] };
  };

  const client = { query, release: () => {} };
  const pool = { connect: async () => client, end: async () => {} };
  return { pool, client, state, log };
};

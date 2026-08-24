// A minimal in-memory stand-in for a pg.Pool/Client, used only by mocked-integration tests. It
// understands exactly the query shapes question-pool.js/migrate.js issue -- it is NOT a general
// SQL engine and proves nothing about real PostgreSQL semantics (real UNIQUE constraints, real
// FOR UPDATE SKIP LOCKED concurrency, real transaction isolation). It verifies wiring: the right
// SQL intent runs against the right in-memory state, in the right order, inside BEGIN/COMMIT.
let nextId = 1;

export const createFakeDb = () => {
  const state = { questions: new Map(), themes: new Map(), videos: new Map(), videoQuestions: [], migrations: new Set(), nextThemeId: 1, nextVideoId: 1 };
  const log = [];

  const query = async (sql, params = []) => {
    log.push(sql.trim().split('\n')[0]);
    const text = sql.trim();
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    if (text.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) return { rows: [] };
    if (text.startsWith('SELECT name FROM schema_migrations')) return { rows: [...state.migrations].map(name => ({ name })) };
    if (text.startsWith('INSERT INTO schema_migrations')) { state.migrations.add(params[0]); return { rows: [] }; }

    if (text.startsWith('SELECT count(*)::int AS count FROM wyr_questions')) {
      const foodOnly = text.includes("category = 'food'");
      const count = [...state.questions.values()].filter(row => row.status === 'ready' && (!foodOnly || row.category === 'food')).length;
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
    if (text.startsWith('INSERT INTO wyr_food_themes')) {
      const [themeKey, title, hookTtsText] = params;
      if ([...state.themes.values()].some(theme => theme.theme_key === themeKey)) return { rows: [] };
      const id = state.nextThemeId++; state.themes.set(id, { id, theme_key: themeKey, title, hook_tts_text: hookTtsText });
      return { rows: [{ id }] };
    }
    if (text.startsWith('SELECT id FROM wyr_food_themes WHERE theme_key')) {
      const theme = [...state.themes.values()].find(candidate => candidate.theme_key === params[0]);
      return { rows: theme ? [{ id: theme.id }] : [] };
    }
    if (text.startsWith('INSERT INTO wyr_questions')) {
      // Column order must mirror question-pool.js's real INSERT exactly (17 columns, including the
      // option_a_visual_subject/option_b_visual_subject pair added by migration 003) -- a stale,
      // shorter destructure here silently shifts every param after option_a_search_query by two
      // positions (e.g. hook_score would actually receive dedupe_key's string value), corrupting
      // hook_score/is_fantasy/quality_score/visual_score/source_provider for every fake-db test
      // without ever throwing, since JS destructuring past the real param list just yields extra
      // undefineds rather than an error.
      const [category, contentFamily, motifKey, motifKeyA, motifKeyB, optionAText, optionASearchQuery, optionAVisualSubject, optionBText, optionBSearchQuery, optionBVisualSubject, dedupeKey, isFantasy, hookScore, qualityScore, visualScore, sourceProvider, themeId = null, themePosition = null] = params;
      const existing = [...state.questions.values()].find(row => row.dedupe_key === dedupeKey);
      if (existing) return { rows: [] };
      const id = nextId++;
      state.questions.set(id, {
        id, category, content_family: contentFamily, motif_key: motifKey, motif_key_a: motifKeyA, motif_key_b: motifKeyB,
        option_a_text: optionAText, option_a_search_query: optionASearchQuery, option_a_visual_subject: optionAVisualSubject,
        option_b_text: optionBText, option_b_search_query: optionBSearchQuery, option_b_visual_subject: optionBVisualSubject,
        dedupe_key: dedupeKey, is_fantasy: isFantasy, hook_score: hookScore, quality_score: qualityScore, visual_score: visualScore,
        source_provider: sourceProvider, theme_id: themeId, theme_position: themePosition, status: 'ready', used_count: 0, last_used_at: null, reserved_by_job: null, reserved_at: null,
      });
      return { rows: [{ id }] };
    }
    if (text.startsWith('SELECT q.*, t.theme_key')) {
      const replacement = text.includes('t.theme_key = $1');
      const [themeKey, excludeIds, limit] = replacement ? params : [null, [], params[0]];
      const excluded = new Set(excludeIds || []);
      const rows = [...state.questions.values()].filter(row => row.status === 'ready' && row.category === 'food' && row.theme_id && !excluded.has(row.id))
        .flatMap(row => { const theme = state.themes.get(row.theme_id); return theme && (!replacement || theme.theme_key === themeKey) ? [{ ...row, theme_key: theme.theme_key, theme_title: theme.title, hook_tts_text: theme.hook_tts_text }] : []; })
        .sort((a, b) => a.theme_id - b.theme_id || a.theme_position - b.theme_position);
      return { rows: rows.slice(0, limit) };
    }
    if (text.startsWith('SELECT id, theme_id, theme_position, status FROM wyr_questions WHERE dedupe_key')) {
      const row = [...state.questions.values()].find(candidate => candidate.dedupe_key === params[0]);
      return { rows: row ? [{ id: row.id, theme_id: row.theme_id, theme_position: row.theme_position, status: row.status }] : [] };
    }
    if (text.startsWith('SELECT id FROM wyr_questions WHERE theme_id')) {
      const row = [...state.questions.values()].find(candidate => candidate.theme_id === params[0] && candidate.theme_position === params[1]);
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (text.startsWith('SELECT * FROM wyr_questions')) {
      // Two real callers share this prefix: selectAndReservePlan's plain candidate window (params =
      // [limit]) and reserveReplacementQuestion's exclusion-aware window (params = [excludeIds,
      // limit], SQL text includes "NOT (id = ANY(...)"). Reading params[0] as `limit` unconditionally
      // would treat excludeIds itself as the limit for the second shape.
      const excludesIds = text.includes('NOT (id = ANY(');
      const [excludeIds, limitAfterExclude] = excludesIds ? params : [[], params[0]];
      const limit = excludesIds ? limitAfterExclude : params[0];
      const excluded = new Set(excludeIds);
      const foodOnly = text.includes("category = 'food'");
      const ready = [...state.questions.values()].filter(row => row.status === 'ready' && (!foodOnly || row.category === 'food') && !excluded.has(row.id))
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
    if (text.startsWith('SELECT theme_key FROM wyr_videos')) {
      const [windowVideos] = params;
      return { rows: [...state.videos.values()].filter(video => video.theme_key).sort((a, b) => b.created_at - a.created_at).slice(0, windowVideos).map(video => ({ theme_key: video.theme_key })) };
    }
    if (text.startsWith("UPDATE wyr_questions SET status = 'reserved'")) {
      // Two real callers share this prefix: selectAndReservePlan's batch reservation (id = ANY($2::
      // bigint[]), an array) and reserveReplacementQuestion's single-row reservation (id = $2, a
      // scalar) -- normalize to an array either way instead of assuming the batch shape.
      const [jobId, idsOrId] = params;
      const ids = Array.isArray(idsOrId) ? idsOrId : [idsOrId];
      for (const id of ids) { const row = state.questions.get(id); if (row) { row.status = 'reserved'; row.reserved_by_job = jobId; row.reserved_at = new Date(); } }
      return { rows: [], rowCount: ids.length };
    }
    if (text.startsWith('UPDATE wyr_questions SET theme_id')) {
      const [themeId, themePosition, identifier] = params;
      const row = [...state.questions.values()].find(candidate => (text.includes('WHERE id = $3') ? candidate.id === identifier : candidate.dedupe_key === identifier) && candidate.theme_id == null && candidate.status === 'ready');
      if (!row) return { rows: [], rowCount: 0 };
      row.theme_id = themeId; row.theme_position = themePosition;
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (text.startsWith("UPDATE wyr_questions SET status = 'ready', reserved_by_job = NULL, reserved_at = NULL, updated_at = now() WHERE id = $1")) {
      const [id, jobId] = params;
      const row = state.questions.get(id);
      if (!row || row.reserved_by_job !== jobId || row.status !== 'reserved') return { rows: [], rowCount: 0 };
      row.status = 'ready'; row.reserved_by_job = null; row.reserved_at = null;
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE wyr_questions SET status = 'ready', reserved_by_job = NULL, reserved_at = NULL, updated_at = now() WHERE reserved_by_job")) {
      const [jobId] = params;
      let count = 0;
      for (const row of state.questions.values()) if (row.reserved_by_job === jobId && row.status === 'reserved') { row.status = 'ready'; row.reserved_by_job = null; row.reserved_at = null; count += 1; }
      return { rows: [], rowCount: count };
    }
    if (text.startsWith("UPDATE wyr_questions SET status = 'ready', reserved_by_job = NULL, reserved_at = NULL, updated_at = now() WHERE status = 'reserved'")) {
      const [olderThanMs] = params;
      const cutoff = Date.now() - Number(olderThanMs);
      let count = 0;
      for (const row of state.questions.values()) if (row.status === 'reserved' && row.reserved_at && row.reserved_at.getTime() < cutoff) { row.status = 'ready'; row.reserved_by_job = null; row.reserved_at = null; count += 1; }
      return { rows: [], rowCount: count };
    }
    if (text.startsWith('INSERT INTO wyr_videos')) {
      const [jobId, duration, topic, themeKey = null, themeTitle = null] = params;
      let video = [...state.videos.values()].find(v => v.job_id === jobId);
      if (!video) { video = { id: state.nextVideoId++, job_id: jobId, status: 'completed', duration, topic, theme_key: themeKey, theme_title: themeTitle, created_at: new Date(Date.now() + state.nextVideoId) }; state.videos.set(video.id, video); }
      else { video.status = 'completed'; video.duration = duration; video.theme_key = themeKey; video.theme_title = themeTitle; }
      return { rows: [{ id: video.id }] };
    }
    if (text.startsWith('SELECT id FROM wyr_videos WHERE job_id')) {
      const video = [...state.videos.values()].find(candidate => candidate.job_id === params[0]);
      return { rows: video ? [{ id: video.id }] : [] };
    }
    if (text.startsWith('SELECT id FROM wyr_questions WHERE id = ANY')) {
      const [ids, jobId] = params;
      return { rows: ids.flatMap(id => {
        const row = state.questions.get(id);
        return row?.reserved_by_job === jobId && row.status === 'reserved' ? [{ id }] : [];
      }) };
    }
    if (text.startsWith('INSERT INTO wyr_video_questions')) {
      const [videoId, questionId, position] = params;
      if (!state.videoQuestions.some(vq => vq.video_id === videoId && vq.question_id === questionId)) state.videoQuestions.push({ video_id: videoId, question_id: questionId, position });
      return { rows: [] };
    }
    if (text.startsWith("UPDATE wyr_questions SET status = 'used', reserved_by_job = NULL, reserved_at = NULL, used_count")) {
      const [ids, jobId] = params;
      let rowCount = 0;
      for (const id of ids) {
        const row = state.questions.get(id);
        if (row && row.reserved_by_job === jobId && row.status === 'reserved') { row.status = 'used'; row.reserved_by_job = null; row.reserved_at = null; row.used_count += 1; row.last_used_at = new Date(); rowCount += 1; }
      }
      return { rows: [], rowCount };
    }
    // Migration bodies are opaque to this fake -- it only needs to prove BEGIN/apply/COMMIT/record
    // wiring works, not execute arbitrary DDL. Treat any other statement as a harmless no-op.
    return { rows: [] };
  };

  const client = { query, release: () => {} };
  const pool = { connect: async () => client, end: async () => {} };
  return { pool, client, state, log };
};

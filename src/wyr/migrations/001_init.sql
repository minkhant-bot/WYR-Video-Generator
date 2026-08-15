-- Persistent production question pool, plus the video/question relationships needed for
-- cross-video motif cooldown and (later) YouTube performance analysis. Reused/derivable fields
-- (motif keys, content family, hook/quality/visual scores) are computed locally in JS before
-- insert -- Groq only ever supplies category/optionA/optionB/searchQuery text.

CREATE TABLE IF NOT EXISTS wyr_questions (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  content_family TEXT NOT NULL,
  motif_key TEXT,
  motif_key_a TEXT,
  motif_key_b TEXT,
  option_a_text TEXT NOT NULL,
  option_a_search_query TEXT NOT NULL,
  option_b_text TEXT NOT NULL,
  option_b_search_query TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  is_fantasy BOOLEAN NOT NULL DEFAULT FALSE,
  hook_score NUMERIC(6,2) NOT NULL DEFAULT 0,
  quality_score NUMERIC(6,2) NOT NULL DEFAULT 0,
  visual_score NUMERIC(6,2) NOT NULL DEFAULT 0,
  source_provider TEXT NOT NULL DEFAULT 'groq',
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'reserved', 'rejected')),
  used_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  reserved_by_job TEXT,
  reserved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wyr_questions_dedupe_key_unique UNIQUE (dedupe_key)
);

-- Selection reads "ready" rows ordered by least-recently-used; a partial index keeps that query
-- fast even once the pool grows into the thousands, without slowing down writes to reserved/used rows.
CREATE INDEX IF NOT EXISTS idx_wyr_questions_ready_lru ON wyr_questions (last_used_at NULLS FIRST, used_count, id) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_wyr_questions_status ON wyr_questions (status);
CREATE INDEX IF NOT EXISTS idx_wyr_questions_content_family ON wyr_questions (content_family);
CREATE INDEX IF NOT EXISTS idx_wyr_questions_reserved_by_job ON wyr_questions (reserved_by_job) WHERE reserved_by_job IS NOT NULL;

CREATE TABLE IF NOT EXISTS wyr_videos (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  duration NUMERIC(7,3),
  topic TEXT,
  -- Performance-data placeholders: nullable until a YouTube integration exists, plus a JSONB
  -- catch-all so new metrics can be recorded later without another migration.
  views BIGINT,
  likes BIGINT,
  comments BIGINT,
  average_view_duration_seconds NUMERIC(7,3),
  swipe_away_rate NUMERIC(6,4),
  published_at TIMESTAMPTZ,
  performance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wyr_videos_job_id_unique UNIQUE (job_id)
);
CREATE INDEX IF NOT EXISTS idx_wyr_videos_created_at ON wyr_videos (created_at DESC);

CREATE TABLE IF NOT EXISTS wyr_video_questions (
  video_id BIGINT NOT NULL REFERENCES wyr_videos(id) ON DELETE CASCADE,
  question_id BIGINT NOT NULL REFERENCES wyr_questions(id),
  position SMALLINT NOT NULL,
  PRIMARY KEY (video_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_wyr_video_questions_question_id ON wyr_video_questions (question_id);

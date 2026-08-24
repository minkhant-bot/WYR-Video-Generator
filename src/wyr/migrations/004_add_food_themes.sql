-- A theme is authored and stored ahead of time; production still selects content exclusively
-- from PostgreSQL and never generates a hook or questions at runtime.
CREATE TABLE IF NOT EXISTS wyr_food_themes (
  id BIGSERIAL PRIMARY KEY,
  theme_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  hook_tts_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE wyr_questions ADD COLUMN IF NOT EXISTS theme_id BIGINT REFERENCES wyr_food_themes(id);
ALTER TABLE wyr_questions ADD COLUMN IF NOT EXISTS theme_position SMALLINT;
ALTER TABLE wyr_questions DROP CONSTRAINT IF EXISTS wyr_questions_theme_position_check;
ALTER TABLE wyr_questions ADD CONSTRAINT wyr_questions_theme_position_check
  CHECK (theme_position IS NULL OR theme_position BETWEEN 1 AND 99);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wyr_questions_theme_position
  ON wyr_questions (theme_id, theme_position) WHERE theme_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wyr_questions_ready_theme
  ON wyr_questions (theme_id, theme_position) WHERE status = 'ready' AND theme_id IS NOT NULL;

ALTER TABLE wyr_videos ADD COLUMN IF NOT EXISTS theme_key TEXT;
ALTER TABLE wyr_videos ADD COLUMN IF NOT EXISTS theme_title TEXT;
CREATE INDEX IF NOT EXISTS idx_wyr_videos_theme_recent
  ON wyr_videos (theme_key, created_at DESC) WHERE theme_key IS NOT NULL;

-- Cross-job image rotation history: which real, downloaded photo was used for which normalized
-- food label, so a later job can deprioritize (never hard-exclude) a recently-used photo instead
-- of always re-selecting the same top-ranked provider result for a common food label -- the same
-- "ready pool may be thin" reasoning already applied to motif/theme/pair-key cooldown.
-- Written only at commitPlanUsage time (a completed, verified video), never at download/selection
-- time: a failed job's images never actually appeared in a published video and must not poison
-- rotation history. food_label is produced by normalizeFoodOption (food-themes.js), the SAME
-- normalization canonicalFoodPairKey already uses -- no second scheme.
CREATE TABLE IF NOT EXISTS wyr_used_food_images (
  id BIGSERIAL PRIMARY KEY,
  food_label TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_photo_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  video_id BIGINT REFERENCES wyr_videos(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_used_food_images_label ON wyr_used_food_images (food_label, used_at DESC);

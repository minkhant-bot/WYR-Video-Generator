-- Records revisioned, one-time static FOOD reconciliation passes. The actual row values and all
-- content-derived metadata are produced by the same local JS validation/scoring path used for
-- normal inserts; this table only makes that deployment step transactional and idempotent.
CREATE TABLE IF NOT EXISTS wyr_food_content_reconciliations (
  revision TEXT PRIMARY KEY,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A question successfully used in a completed, verified video must never be selectable again --
-- it is retired to a terminal 'used' status instead of rotating back to 'ready'. Additive only:
-- no rows are altered or deleted here, only the CHECK constraint is widened to permit the new
-- status value that commitPlanUsage() now writes.
ALTER TABLE wyr_questions DROP CONSTRAINT IF EXISTS wyr_questions_status_check;
ALTER TABLE wyr_questions ADD CONSTRAINT wyr_questions_status_check CHECK (status IN ('ready', 'reserved', 'used', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_wyr_questions_used ON wyr_questions (id) WHERE status = 'used';

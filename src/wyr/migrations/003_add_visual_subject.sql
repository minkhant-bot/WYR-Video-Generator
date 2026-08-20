-- Adds explicit visual-search metadata per option: a concrete, photographable description used as
-- the semantic-relevance target for image selection, kept separate from the display text
-- (option_a_text/option_b_text) and the provider search query (option_a_search_query/
-- option_b_search_query). This is what lets image selection compare candidates against an
-- intentional visual description instead of re-inferring a subject from display wording.
-- Additive only -- nullable, no existing rows touched. A NULL value means a row inserted before
-- this column existed; it is derived at selection time from the row's own search query instead
-- (see pool-selection.js's rowToQuestion), never backfilled or rewritten in place.
ALTER TABLE wyr_questions ADD COLUMN IF NOT EXISTS option_a_visual_subject TEXT;
ALTER TABLE wyr_questions ADD COLUMN IF NOT EXISTS option_b_visual_subject TEXT;

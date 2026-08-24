import { withTransaction } from './db.js';
import { isStrictFoodPoolRow } from './food-content.js';
import { FOOD_THEME_SEEDS, canonicalFoodThemeKey, validateFoodTheme } from './food-themes.js';
import { computeInsertionFields } from './pool-selection.js';

export const FOOD_CONTENT_REVISION = 'food-static-content-2026-08-24-visual-variety-v2';

const fieldValues = fields => [
  fields.category, fields.contentFamily, fields.motifKey, fields.motifKeyA, fields.motifKeyB,
  fields.optionAText, fields.optionASearchQuery, fields.optionAVisualSubject,
  fields.optionBText, fields.optionBSearchQuery, fields.optionBVisualSubject,
  fields.dedupeKey, fields.isFantasy, fields.hookScore, fields.qualityScore, fields.visualScore,
];

const prepareTheme = rawTheme => {
  const validation = validateFoodTheme(rawTheme);
  if (!validation.valid) throw new Error(`${rawTheme?.title || 'Untitled FOOD theme'}: ${validation.reasons.join('; ')}`);
  return rawTheme.questions.map((raw, index) => {
    const fields = computeInsertionFields(raw);
    if (!fields.accepted || raw?.category !== 'food' || !isStrictFoodPoolRow({ category: 'food', option_a_text: raw?.optionA?.text, option_b_text: raw?.optionB?.text })) {
      throw new Error(`${rawTheme.title} question ${index + 1} is not valid static FOOD content.`);
    }
    return { index, fields };
  });
};

const writeReadyRow = async (client, { id, fields, sourceProvider, themeId, themePosition }) => client.query(
  `UPDATE wyr_questions SET
     category = $1, content_family = $2, motif_key = $3, motif_key_a = $4, motif_key_b = $5,
     option_a_text = $6, option_a_search_query = $7, option_a_visual_subject = $8,
     option_b_text = $9, option_b_search_query = $10, option_b_visual_subject = $11,
     dedupe_key = $12, is_fantasy = $13, hook_score = $14, quality_score = $15,
     visual_score = $16, source_provider = $17, theme_id = $18, theme_position = $19, updated_at = now()
   WHERE id = $20 AND status = 'ready'
     AND NOT EXISTS (SELECT 1 FROM wyr_video_questions WHERE question_id = $20)
   RETURNING id`,
  [...fieldValues(fields), sourceProvider, themeId, themePosition, id],
);

const insertReadyRow = async (client, { fields, sourceProvider, themeId, themePosition }) => client.query(
  `INSERT INTO wyr_questions
     (category, content_family, motif_key, motif_key_a, motif_key_b,
      option_a_text, option_a_search_query, option_a_visual_subject,
      option_b_text, option_b_search_query, option_b_visual_subject,
      dedupe_key, is_fantasy, hook_score, quality_score, visual_score, source_provider,
      theme_id, theme_position)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
   ON CONFLICT (dedupe_key) DO NOTHING
   RETURNING id`,
  [...fieldValues(fields), sourceProvider, themeId, themePosition],
);

const findFreePosition = occupied => {
  for (let position = 10; position <= 99; position += 1) if (!occupied.has(position)) return position;
  return null;
};

// One-time deployment reconciliation. READY rows have no completed-video history and may be
// updated/replaced. USED rows are never updated, detached, deleted, or returned to READY; when a
// changed definition occupies their historical position, its new row is placed in a free overflow
// position in the same theme. The revision marker and all row changes commit atomically.
export const reconcileStaticFoodThemes = async ({
  themes = FOOD_THEME_SEEDS,
  revision = FOOD_CONTENT_REVISION,
  sourceProvider = 'seed-theme-reconciliation',
} = {}) => withTransaction(async client => {
  // The revision row does not exist on the first run, so SELECT ... FOR UPDATE alone cannot
  // serialize two overlapping Railway instances. A transaction-scoped advisory lock closes that
  // race and is released automatically on commit/rollback.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [revision]);
  const { rows: appliedRows } = await client.query(
    'SELECT revision FROM wyr_food_content_reconciliations WHERE revision = $1 FOR UPDATE',
    [revision],
  );
  if (appliedRows.length) return { revision, applied: false, alreadyApplied: true, updatedReady: 0, inserted: 0, attached: 0, preservedUsed: 0, conflicts: [] };

  const summary = { revision, applied: true, alreadyApplied: false, updatedReady: 0, inserted: 0, attached: 0, preservedUsed: 0, unchanged: 0, conflicts: [] };
  for (const rawTheme of themes) {
    const prepared = prepareTheme(rawTheme);
    const themeKey = canonicalFoodThemeKey(rawTheme.title);
    let { rows: themeRows } = await client.query(
      `INSERT INTO wyr_food_themes (theme_key, title, hook_tts_text) VALUES ($1,$2,$3)
       ON CONFLICT (theme_key) DO NOTHING RETURNING id`,
      [themeKey, rawTheme.title, rawTheme.hookTtsText],
    );
    if (!themeRows.length) ({ rows: themeRows } = await client.query('SELECT id FROM wyr_food_themes WHERE theme_key = $1 FOR UPDATE', [themeKey]));
    if (!themeRows.length) { summary.conflicts.push(`${themeKey}: theme row unavailable`); continue; }
    const themeId = themeRows[0].id;
    await client.query('UPDATE wyr_food_themes SET title = $1, hook_tts_text = $2, updated_at = now() WHERE id = $3', [rawTheme.title, rawTheme.hookTtsText, themeId]);

    const { rows: slotRows } = await client.query(
      `SELECT q.id, q.theme_id, q.theme_position, q.status, q.dedupe_key,
              EXISTS (SELECT 1 FROM wyr_video_questions vq WHERE vq.question_id = q.id) AS has_video_history
       FROM wyr_questions q WHERE q.theme_id = $1 ORDER BY q.theme_position FOR UPDATE`,
      [themeId],
    );
    const byPosition = new Map(slotRows.map(row => [Number(row.theme_position), row]));
    const occupied = new Set(byPosition.keys());

    for (const { index, fields } of prepared) {
      const desiredPosition = index + 1;
      const slot = byPosition.get(desiredPosition);
      const { rows: duplicateRows } = await client.query(
        'SELECT id, theme_id, theme_position, status, dedupe_key FROM wyr_questions WHERE dedupe_key = $1 FOR UPDATE',
        [fields.dedupeKey],
      );
      const duplicate = duplicateRows[0];
      if (slot?.dedupe_key === fields.dedupeKey) {
        if (slot.status === 'used') summary.preservedUsed += 1;
        else summary.unchanged += 1;
        continue;
      }

      if (slot?.status === 'ready' && !slot.has_video_history) {
        if (!duplicate || duplicate.id === slot.id) {
          const updated = await writeReadyRow(client, { id: slot.id, fields, sourceProvider, themeId, themePosition: desiredPosition });
          if (updated.rows.length) { slot.dedupe_key = fields.dedupeKey; summary.updatedReady += 1; continue; }
        } else if (duplicate.status === 'ready' && (duplicate.theme_id == null || Number(duplicate.theme_id) === Number(themeId))) {
          const removed = await client.query(
            `DELETE FROM wyr_questions WHERE id = $1 AND status = 'ready'
             AND NOT EXISTS (SELECT 1 FROM wyr_video_questions WHERE question_id = $1)
             RETURNING id`,
            [slot.id],
          );
          if (removed.rows.length) {
            const attached = await writeReadyRow(client, { id: duplicate.id, fields, sourceProvider, themeId, themePosition: desiredPosition });
            if (attached.rows.length) { byPosition.set(desiredPosition, { ...duplicate, theme_id: themeId, theme_position: desiredPosition }); summary.attached += 1; continue; }
          }
        }
        summary.conflicts.push(`${themeKey}:${desiredPosition}: ready slot could not be reconciled without a duplicate`);
        continue;
      }

      if (slot?.status === 'used') summary.preservedUsed += 1;
      if (duplicate) {
        if (duplicate.status === 'ready' && duplicate.theme_id == null) {
          const overflowPosition = findFreePosition(occupied);
          if (overflowPosition !== null) {
            const attached = await writeReadyRow(client, { id: duplicate.id, fields, sourceProvider, themeId, themePosition: overflowPosition });
            if (attached.rows.length) { occupied.add(overflowPosition); byPosition.set(overflowPosition, { ...duplicate, theme_id: themeId, theme_position: overflowPosition }); summary.attached += 1; continue; }
          }
        }
        // A USED duplicate remains terminal, and a duplicate owned by another theme is never
        // stolen. Either way, retain the occupied row and report the inventory conflict.
        summary.conflicts.push(`${themeKey}:${desiredPosition}: desired pair already belongs to another row`);
        continue;
      }

      const targetPosition = slot ? findFreePosition(occupied) : desiredPosition;
      if (targetPosition === null) { summary.conflicts.push(`${themeKey}:${desiredPosition}: no free reconciliation position`); continue; }
      const inserted = await insertReadyRow(client, { fields, sourceProvider, themeId, themePosition: targetPosition });
      if (inserted.rows.length) {
        occupied.add(targetPosition); byPosition.set(targetPosition, { id: inserted.rows[0].id, theme_id: themeId, theme_position: targetPosition, status: 'ready', dedupe_key: fields.dedupeKey }); summary.inserted += 1;
      } else summary.conflicts.push(`${themeKey}:${desiredPosition}: desired pair became unavailable during reconciliation`);
    }
  }

  await client.query(
    'INSERT INTO wyr_food_content_reconciliations (revision, summary) VALUES ($1, $2::jsonb) ON CONFLICT (revision) DO NOTHING',
    [revision, JSON.stringify(summary)],
  );
  return summary;
});

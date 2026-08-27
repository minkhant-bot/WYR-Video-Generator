// Focused test for cross-job image rotation only (see question-pool.js's recentUsedFoodImageIds/
// commitPlanUsage write side, image-picker.js's applyImageRotationPreference). Exercises the real
// write -> read -> rank round trip across two consecutive commits, via the same fake-DB harness
// pattern used throughout the rest of this test suite -- not a mock of the feature itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { commitPlanUsage, recentUsedFoodImageIds } from './question-pool.js';
import { applyImageRotationPreference } from './image-picker.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); } finally { __resetPoolForTests(); }
};

// A minimal 10-question plan/asset pair for commitPlanUsage -- only question 0 (Donut vs Bagel) is
// category:'food' with real image data; the other 9 are a different category purely to satisfy
// COMMITTED_QUESTION_COUNT=10 cheaply, and are skipped entirely by the food-only write guard.
const buildCommit = (fake, jobId, donutAsset) => {
  const questionIds = [];
  for (let index = 0; index < 10; index += 1) {
    const id = fake.state.questions.size + index + 1;
    fake.state.questions.set(id, {
      id, category: index === 0 ? 'food' : 'lifestyle', status: 'reserved', reserved_by_job: jobId,
      option_a_text: index === 0 ? 'Donut' : `Option A ${index}`, option_b_text: index === 0 ? 'Bagel' : `Option B ${index}`,
      used_count: 0, last_used_at: null,
    });
    questionIds.push(id);
  }
  const plan = {
    topic: 'test', hook: null,
    questions: questionIds.map((poolId, index) => ({
      index, poolId, category: index === 0 ? 'food' : 'lifestyle',
      optionA: { text: index === 0 ? 'Donut' : `Option A ${index}` },
      optionB: { text: index === 0 ? 'Bagel' : `Option B ${index}` },
    })),
  };
  const assets = [{ questionIndex: 0, slot: 'A', ...donutAsset }];
  return { plan, assets };
};

test('the same food label across two consecutive commits does not select the same provider_photo_id when an alternative candidate exists', () => withFakeDb(async fake => {
  // Commit 1: Donut's slot A image is provider photo "photo-A".
  const { plan: plan1, assets: assets1 } = buildCommit(fake, 'job-1', { provider: 'Pixabay', id: 'photo-A', sha256: 'hash-A' });
  await commitPlanUsage({ jobId: 'job-1', plan: plan1, duration: 45, assets: assets1 });

  const recentUsage = await recentUsedFoodImageIds(['donut']);
  assert.ok(recentUsage.has('donut::Pixabay:photo-A'), 'commitPlanUsage must persist the used image, readable via recentUsedFoodImageIds');

  // Simulate the SECOND job's ranked candidate pool for the same "Donut" slot: photo-A (already
  // used) ranks first on raw score alone -- exactly the reported production symptom, where the
  // same top-ranked provider result gets reselected forever without rotation -- while a fresh
  // alternative, photo-B, exists lower in the ranked pool.
  const state = {
    category: 'food', requestedFoodText: 'Donut', optionText: 'Donut', recentUsage,
    candidates: [
      { provider: 'Pixabay', id: 'photo-A', finalScore: 100 },
      { provider: 'Pixabay', id: 'photo-B', finalScore: 90 },
    ],
  };
  applyImageRotationPreference(state);
  assert.equal(state.candidates[0].id, 'photo-B', 'a fresh alternative must be preferred over the already-used photo when one exists');

  // Commit 2: the second job's selection (per the ranking above) picks photo-B for Donut.
  const { plan: plan2, assets: assets2 } = buildCommit(fake, 'job-2', { provider: 'Pixabay', id: 'photo-B', sha256: 'hash-B' });
  await commitPlanUsage({ jobId: 'job-2', plan: plan2, duration: 45, assets: assets2 });

  const recentUsageAfterSecondCommit = await recentUsedFoodImageIds(['donut']);
  assert.ok(recentUsageAfterSecondCommit.has('donut::Pixabay:photo-A'), 'photo-A usage from commit 1 must still be present');
  assert.ok(recentUsageAfterSecondCommit.has('donut::Pixabay:photo-B'), 'photo-B usage from commit 2 must now also be present');
  assert.notEqual(
    recentUsageAfterSecondCommit.get('donut::Pixabay:photo-A'),
    recentUsageAfterSecondCommit.get('donut::Pixabay:photo-B'),
    'the two commits must be distinguishable by used_at (proves this is a real two-commit history, not a single collapsed entry)',
  );
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedCandidates, selectImageCandidate } from './image-picker.js';

const selection = () => ({ total: 16, selectedCount: 0, slots: { Q1A: { key: 'Q1A', questionIndex: 0, slot: 'A', optionText: 'Teleport Anywhere', candidates: [{ candidateKey: 'Pexels:one|https://images.test/one.jpg', provider: 'Pexels', id: 'one', previewUrl: 'https://images.test/one.jpg' }, { candidateKey: 'Pixabay:two|https://images.test/two.jpg', provider: 'Pixabay', id: 'two', previewUrl: 'https://images.test/two.jpg' }], selectedId: null } } });

test('server-side candidate selection is slot-scoped and supports changing selection', () => {
  const state = selection();
  selectImageCandidate(state, 'Q1A', 'Pexels:one|https://images.test/one.jpg');
  assert.equal(state.selectedCount, 1); assert.equal(selectedCandidates(state)[0].selected.id, 'one');
  selectImageCandidate(state, 'Q1A', 'Pixabay:two|https://images.test/two.jpg');
  assert.equal(state.selectedCount, 1); assert.equal(selectedCandidates(state)[0].selected.id, 'two');
  assert.throws(() => selectImageCandidate(state, 'Q1B', 'Pixabay:two|https://images.test/two.jpg'), /Unknown image slot/);
  assert.throws(() => selectImageCandidate(state, 'Q1A', 'not-belonging-to-slot'), /does not belong/);
});

test('selection progress requires exactly one selected candidate per slot', () => {
  const state = selection(); assert.equal(selectedCandidates(state).length, 0);
  selectImageCandidate(state, 'Q1A', 'Pexels:one|https://images.test/one.jpg'); assert.equal(selectedCandidates(state).length, 1);
});

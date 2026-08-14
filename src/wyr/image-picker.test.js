import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_PROVIDER_ORDER, PixabayImageProvider, selectedCandidates, selectImageCandidate } from './image-picker.js';

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

test('Pixabay is the automatic primary and uses the official API shape', async () => {
  assert.deepEqual(IMAGE_PROVIDER_ORDER, ['Pixabay', 'Pexels']);
  const originalFetch = global.fetch;
  try {
    let requested;
    global.fetch = async url => { requested = new URL(url); return { ok: true, async json() { return { hits: [{ id: 7, imageWidth: 1600, imageHeight: 900, tags: 'person dragon fantasy', pageURL: 'https://pixabay.com/images/id-7/', largeImageURL: 'https://cdn.pixabay.com/7.jpg', webformatURL: 'https://cdn.pixabay.com/7-preview.jpg' }] }; } }; };
    const provider = new PixabayImageProvider({ apiKey: 'test-only', timeoutMs: 1000 }); const results = await provider.search('dragon', 1);
    assert.equal(requested.hostname, 'pixabay.com'); assert.equal(requested.searchParams.get('q'), 'dragon'); assert.equal(results[0].provider, 'Pixabay'); assert.equal(results[0].previewUrl, 'https://cdn.pixabay.com/7-preview.jpg');
  } finally { global.fetch = originalFetch; }
});

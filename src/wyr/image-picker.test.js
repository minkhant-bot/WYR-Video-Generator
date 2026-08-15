import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageSelection, IMAGE_PROVIDER_ORDER, PixabayImageProvider, selectedCandidates, selectImageCandidate } from './image-picker.js';

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

test('Pexels fallback still works when no Pixabay key is configured', async () => {
  const originalFetch = global.fetch; let counter = 0;
  try {
    global.fetch = async url => {
      const parsed = new URL(url); assert.equal(parsed.hostname, 'api.pexels.com'); counter += 1;
      return { ok: true, async json() { return { photos: [{ id: counter, width: 1600, height: 900, alt: 'person dragon fantasy cinematic', url: `https://pexels.test/${counter}`, photographer: 'Test', photographer_url: 'https://pexels.test/p', src: { large2x: `https://pexels.test/${counter}-large.jpg`, original: `https://pexels.test/${counter}.jpg` } }] }; } };
    };
    const plan = { questions: [{ index: 0, optionA: { text: 'Befriend a Dragon', searchQuery: 'dragon fantasy' }, optionB: { text: 'Explore Mars', searchQuery: 'mars planet' } }] };
    const config = { pixabayApiKey: '', pexelsApiKey: 'test-key', timeoutMs: 1000, pexelsConcurrency: 2 };
    const selection = await createImageSelection({ plan, config });
    assert.deepEqual(selection.providers, ['Pexels']);
    assert.equal(selection.slots.Q1A.candidates.every(candidate => candidate.provider === 'Pexels'), true);
    assert.ok(selection.slots.Q1A.selectedId);
    assert.ok(selection.slots.Q1B.selectedId);
  } finally { global.fetch = originalFetch; }
});

test('auto-selection logs a diagnostic line per slot with query, provider, and scores', async () => {
  const originalFetch = global.fetch; const originalInfo = console.info; let counter = 0; const logs = [];
  try {
    global.fetch = async () => { counter += 1; return { ok: true, async json() { return { photos: [{ id: counter, width: 1600, height: 900, alt: 'person dragon fantasy cinematic', url: `https://pexels.test/${counter}`, photographer: 'Test', photographer_url: 'https://pexels.test/p', src: { large2x: `https://pexels.test/${counter}-large.jpg`, original: `https://pexels.test/${counter}.jpg` } }] }; } }; };
    console.info = message => logs.push(message);
    const plan = { questions: [{ index: 0, optionA: { text: 'Befriend a Dragon', searchQuery: 'dragon fantasy' }, optionB: { text: 'Explore Mars', searchQuery: 'mars planet' } }] };
    await createImageSelection({ plan, config: { pixabayApiKey: '', pexelsApiKey: 'test-key', timeoutMs: 1000, pexelsConcurrency: 2 } });
    const resultLines = logs.filter(line => String(line).startsWith('WYR_SELECTION_RESULT'));
    assert.equal(resultLines.length, 2);
    assert.match(resultLines[0], /WYR_SELECTION_RESULT \| Q1A \| provider=Pexels \| query="[^"]*" \| finalScore=\d/);
  } finally { global.fetch = originalFetch; console.info = originalInfo; }
});

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
      // Echoes the actual searched query into the mocked candidate's alt text -- a real provider
      // result plausibly relevant to what was searched, not a fixed unrelated dragon photo for
      // every slot -- so this stays a meaningful check of the relevance gate rather than tripping it.
      const query = parsed.searchParams.get('query') || '';
      return { ok: true, async json() { return { photos: [{ id: counter, width: 1600, height: 900, alt: `${query} person cinematic photo`, url: `https://pexels.test/${counter}`, photographer: 'Test', photographer_url: 'https://pexels.test/p', src: { large2x: `https://pexels.test/${counter}-large.jpg`, original: `https://pexels.test/${counter}.jpg` } }] }; } };
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

test('DB-first image selection tries the deterministic option-specific subject query before broader/decorative fallback queries, and never calls Groq', async () => {
  const originalFetch = global.fetch; let counter = 0; const requestedUrls = [];
  try {
    global.fetch = async url => {
      requestedUrls.push(String(url));
      if (String(url).includes('groq.com')) throw new Error('DB-first image selection must never call Groq');
      counter += 1;
      return { ok: true, async json() { return { photos: [{ id: counter, width: 1600, height: 900, alt: 'treehouse forest wooden ladder', url: `https://pexels.test/${counter}`, photographer: 'Test', photographer_url: 'https://pexels.test/p', src: { large2x: `https://pexels.test/${counter}-large.jpg`, original: `https://pexels.test/${counter}.jpg` } }] }; } };
    };
    const plan = { questions: [{ index: 0, category: 'dream homes', optionA: { text: 'Live in a treehouse', searchQuery: '' }, optionB: { text: 'Live in a houseboat', searchQuery: '' } }] };
    const selection = await createImageSelection({ plan, config: { pixabayApiKey: '', pexelsApiKey: 'test-key', timeoutMs: 1000, pexelsConcurrency: 2 } });
    assert.equal(selection.slots.Q1A.queries[0], 'treehouse', 'the deterministic literal-subject query must be tried before any decorative/broader fallback query');
    assert.ok(selection.slots.Q1A.selectedId);
    assert.equal(requestedUrls.some(url => url.includes('groq.com')), false, 'normal DB-first image selection must make zero Groq calls');
  } finally { global.fetch = originalFetch; }
});

test('a fantasy-coded question still gets a stylized fallback query, but a realistic one does not', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, async json() { return { photos: [] }; } });
    const fantasyPlan = { questions: [{ index: 0, category: 'superpowers', optionA: { text: 'Fly through the sky', searchQuery: '' }, optionB: { text: 'Turn invisible', searchQuery: '' } }] };
    const realisticPlan = { questions: [{ index: 0, category: 'food', optionA: { text: 'Eat pizza forever', searchQuery: '' }, optionB: { text: 'Never eat pizza again', searchQuery: '' } }] };
    const fantasySelection = await createImageSelection({ plan: fantasyPlan, config: { pixabayApiKey: '', pexelsApiKey: 'test-key', timeoutMs: 1000, pexelsConcurrency: 2 } });
    const realisticSelection = await createImageSelection({ plan: realisticPlan, config: { pixabayApiKey: '', pexelsApiKey: 'test-key', timeoutMs: 1000, pexelsConcurrency: 2 } });
    assert.ok(fantasySelection.slots.Q1A.queries.some(query => query.includes('fantasy cinematic')), 'a fantasy-coded question may still use the stylized fallback query');
    assert.equal(realisticSelection.slots.Q1A.queries.some(query => query.includes('fantasy cinematic')), false, 'a realistic question must never get the fantasy-styled query');
  } finally { global.fetch = originalFetch; }
});

test('when the first (most specific) query returns nothing, a later broader query still succeeds', async () => {
  const originalFetch = global.fetch; let pixabayCalls = 0;
  try {
    global.fetch = async url => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'pixabay.com') return { ok: true, async json() { return { photos: [] }; } };
      pixabayCalls += 1;
      // The first two queries tried (most specific -> next fallback) come back empty; only the
      // third (a broader query further down the list) returns a usable candidate.
      if (pixabayCalls < 3) return { ok: true, async json() { return { hits: [] }; } };
      return { ok: true, async json() { return { hits: [{ id: 42, imageWidth: 1600, imageHeight: 900, tags: 'treehouse forest', pageURL: 'https://pixabay.com/images/id-42/', largeImageURL: 'https://cdn.pixabay.com/42.jpg' }] }; } };
    };
    const plan = { questions: [{ index: 0, category: 'dream homes', optionA: { text: 'Live in a treehouse', searchQuery: '' }, optionB: { text: 'Live in a houseboat', searchQuery: '' } }] };
    const selection = await createImageSelection({ plan, config: { pixabayApiKey: 'test-key', pexelsApiKey: '', timeoutMs: 1000, pexelsConcurrency: 2 } });
    assert.ok(pixabayCalls >= 3, 'the broader query must only be reached after the earlier ones came back empty');
    assert.ok(selection.slots.Q1A.selectedId, 'a candidate from the later, broader query must still be selected');
    assert.equal(selection.slots.Q1A.candidates.find(c => c.candidateKey === selection.slots.Q1A.selectedId).id, '42');
  } finally { global.fetch = originalFetch; }
});

// ---------------------------------------------------------------------------------------------
// Bounded gap-fill (Tiers 2-4): previously, runAutomaticPipeline threw IMAGE_SELECTION_EXHAUSTED
// the instant Tier 1's strict, fixed 8-query/18-call pass left ANY slot unfilled -- with zero
// broadening or retry (expandImageSelection/replaceImageSelection existed but were never called on
// the automatic/production path). These tests exercise the fillUnfilledSlot gap-fill this fix adds
// directly inside createImageSelection.
// ---------------------------------------------------------------------------------------------
const gapFillConfig = overrides => ({ pixabayApiKey: 'test-key', pexelsApiKey: '', timeoutMs: 1000, pexelsConcurrency: 2, imageRecoveryMaxRequests: 10, imageRecoveryMaxMs: 5000, imageRecoveryQueryRounds: 3, ...overrides });

test('Tier 1 candidates are all hard-rejected (watermarked) for its entire bounded call budget -- Tier 2\'s extra provider calls still succeed', async () => {
  const originalFetch = global.fetch; let callCount = 0;
  try {
    global.fetch = async url => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'pixabay.com') return { ok: true, async json() { return { hits: [] }; } };
      callCount += 1;
      // Tier 1 is hard-capped at 18 provider calls (MAX_PROVIDER_CALLS_PER_SLOT); every one of
      // those calls returns a shutterstock-watermarked preview (hard-rejected). Only calls beyond
      // that -- which only Tier 2's own extra budget can make -- return a clean, on-subject photo.
      const clean = callCount > 18;
      const id = clean ? 'clean-1' : `wm-${callCount}`;
      const tags = clean ? 'treehouse forest wooden ladder' : 'treehouse shutterstock watermark preview';
      return { ok: true, async json() { return { hits: [{ id, imageWidth: 1600, imageHeight: 900, tags, pageURL: `https://pixabay.com/images/id-${id}/`, largeImageURL: `https://cdn.pixabay.com/${id}.jpg` }] }; } };
    };
    const plan = { questions: [{ index: 0, category: 'dream homes', optionA: { text: 'Live in a treehouse', searchQuery: '' }, optionB: { text: 'Live in a mansion', searchQuery: '' } }] };
    const selection = await createImageSelection({ plan, config: gapFillConfig() });
    assert.ok(selection.slots.Q1A.selectedId, 'Tier 2 (extra provider calls beyond Tier 1\'s bounded budget) must fill the slot');
    const selected = selection.slots.Q1A.candidates.find(c => c.candidateKey === selection.slots.Q1A.selectedId);
    assert.equal(selected.id, 'clean-1');
    assert.ok(selection.slots.Q1A.gapFillTiers.some(t => t.tier === 'tier2_deeper_pages' && t.filled), 'the fill must be attributed to the tier-2 pass');
  } finally { global.fetch = originalFetch; }
});

test('Tier 1 candidates are all semantically wrong-subject (rejected by the dominant-subject gate) -- a Tier 3 subject-preserving broadened query succeeds', async () => {
  const originalFetch = global.fetch; let id = 1;
  try {
    global.fetch = async url => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'pixabay.com') return { ok: true, async json() { return { hits: [] }; } };
      const q = parsed.searchParams.get('q');
      id += 1;
      // Only the Tier-3 broadened query "treehouse photo" (bare dominant subject + generic
      // photographic suffix -- see image-picker.js's broadenedSubjectQueries) ever returns a
      // candidate that actually shows a treehouse; every other query (including Tier 1's own
      // deterministic "treehouse" query) returns an office photo that will fail the dominant-subject
      // gate outright.
      const tags = q === 'treehouse photo' ? 'treehouse forest wooden ladder' : 'office desk laptop computer keyboard';
      return { ok: true, async json() { return { hits: [{ id, imageWidth: 1600, imageHeight: 900, tags, pageURL: `https://pixabay.com/images/id-${id}/`, largeImageURL: `https://cdn.pixabay.com/${id}.jpg` }] }; } };
    };
    const plan = { questions: [{ index: 0, category: 'dream homes', optionA: { text: 'Live in a treehouse', searchQuery: '' }, optionB: { text: 'Live in a mansion', searchQuery: '' } }] };
    const selection = await createImageSelection({ plan, config: gapFillConfig() });
    assert.ok(selection.slots.Q1A.selectedId, 'Tier 3 (subject-preserving broadened query) must fill the slot');
    const selected = selection.slots.Q1A.candidates.find(c => c.candidateKey === selection.slots.Q1A.selectedId);
    assert.match(selected.title, /treehouse/, 'only the genuinely on-subject candidate may ever be selected');
    assert.equal(selection.slots.Q1A.queries.includes('treehouse photo'), true, 'the broadened query must have been added to the slot\'s query list');
    assert.ok(selection.slots.Q1A.gapFillTiers.some(t => t.tier === 'tier3_broadened_subject_queries' && t.filled), 'the fill must be attributed to the tier-3 broadened-query pass');
  } finally { global.fetch = originalFetch; }
});

test('the same wrong-subject candidate is returned by every query for a long stretch (deduped after its first miss, contributing nothing) -- a later, genuinely new and on-subject candidate still succeeds', async () => {
  const originalFetch = global.fetch; let callCount = 0;
  try {
    global.fetch = async url => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'pixabay.com') return { ok: true, async json() { return { hits: [] }; } };
      callCount += 1;
      // Calls 1-20 (spanning the whole of Tier 1's 18-call budget plus a couple of Tier 2 calls)
      // all return the EXACT same id=1, wrong-subject candidate -- the first occurrence is rejected
      // (wrong subject) and every repeat after that is deduped as a seen candidate, contributing
      // zero new pool entries either way. Only call 21 onward returns a genuinely different,
      // on-subject candidate (id=2).
      const id = callCount > 20 ? '2' : '1';
      const tags = callCount > 20 ? 'treehouse forest wooden ladder' : 'office desk laptop keyboard';
      return { ok: true, async json() { return { hits: [{ id, imageWidth: 1600, imageHeight: 900, tags, pageURL: `https://pixabay.com/images/id-${id}/`, largeImageURL: `https://cdn.pixabay.com/${id}.jpg` }] }; } };
    };
    const plan = { questions: [{ index: 0, category: 'dream homes', optionA: { text: 'Live in a treehouse', searchQuery: '' }, optionB: { text: 'Live in a mansion', searchQuery: '' } }] };
    const selection = await createImageSelection({ plan, config: gapFillConfig({ imageRecoveryMaxRequests: 10 }) });
    assert.ok(selection.slots.Q1A.selectedId, 'a later, genuinely distinct on-subject candidate must still be found and selected');
    const selected = selection.slots.Q1A.candidates.find(c => c.candidateKey === selection.slots.Q1A.selectedId);
    assert.equal(selected.id, '2');
    assert.equal(selection.slots.Q1A.candidates.some(c => c.id === '1'), false, 'the wrong-subject candidate must never enter the pool, deduped or not');
  } finally { global.fetch = originalFetch; }
});

test('a Tier-3 broadened query that returns BOTH a wrong-subject and a correct-subject candidate never selects the wrong one', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async url => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'pixabay.com') return { ok: true, async json() { return { hits: [] }; } };
      const q = parsed.searchParams.get('q');
      if (q !== 'treehouse photo') return { ok: true, async json() { return { hits: [] }; } };
      return {
        ok: true, async json() {
          return {
            hits: [
              { id: '10', imageWidth: 1600, imageHeight: 900, tags: 'office desk laptop keyboard', pageURL: 'https://pixabay.com/images/id-10/', largeImageURL: 'https://cdn.pixabay.com/10.jpg' },
              { id: '11', imageWidth: 1600, imageHeight: 900, tags: 'treehouse forest wooden ladder', pageURL: 'https://pixabay.com/images/id-11/', largeImageURL: 'https://cdn.pixabay.com/11.jpg' },
            ],
          };
        },
      };
    };
    const plan = { questions: [{ index: 0, category: 'dream homes', optionA: { text: 'Live in a treehouse', searchQuery: '' }, optionB: { text: 'Live in a mansion', searchQuery: '' } }] };
    const selection = await createImageSelection({ plan, config: gapFillConfig() });
    assert.ok(selection.slots.Q1A.selectedId);
    const selected = selection.slots.Q1A.candidates.find(c => c.candidateKey === selection.slots.Q1A.selectedId);
    assert.equal(selected.id, '11', 'the office-desk candidate must never be selected merely because it was returned by a broadened query');
    assert.equal(selection.slots.Q1A.candidates.some(c => c.id === '10'), false, 'the wrong-subject candidate must never even enter the ranked pool -- it must fail the dominant-subject gate');
  } finally { global.fetch = originalFetch; }
});

// ---------------------------------------------------------------------------------------------
// Live Railway failure reproduction: the exact two option texts reported exhausted in production
// ("savings doubled today", "spend freely grows") must now fill on TIER 1 (the strict, unmodified
// gate) once a genuinely on-subject candidate is available -- the abstract-word fix (image-query.js's
// NON_VISUAL_MODIFIER_WORDS, images.js's VISUAL_EXPANSIONS additions) must not require gap-fill at
// all for candidates that were always semantically relevant, only previously miscounted.
// ---------------------------------------------------------------------------------------------
test('the live Railway option "savings doubled today" fills on Tier 1 once a genuine savings candidate is returned', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async url => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'pixabay.com') return { ok: true, async json() { return { hits: [] }; } };
      return { ok: true, async json() { return { hits: [{ id: '501', imageWidth: 1600, imageHeight: 900, tags: 'piggy bank coins savings jar money', pageURL: 'https://pixabay.com/images/id-501/', largeImageURL: 'https://cdn.pixabay.com/501.jpg' }] }; } };
    };
    const plan = { questions: [{ index: 0, category: 'money', optionA: { text: 'savings doubled today', searchQuery: '' }, optionB: { text: 'spend freely grows', searchQuery: '' } }] };
    const selection = await createImageSelection({ plan, config: gapFillConfig() });
    assert.ok(selection.slots.Q1A.selectedId, 'a genuine savings candidate must be selected for "savings doubled today"');
    const selected = selection.slots.Q1A.candidates.find(c => c.candidateKey === selection.slots.Q1A.selectedId);
    assert.equal(selected.id, '501');
  } finally { global.fetch = originalFetch; }
});

test('the live Railway option "spend freely grows" fills on Tier 1 once a genuine shopping/spending candidate is returned', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async url => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'pixabay.com') return { ok: true, async json() { return { hits: [] }; } };
      return { ok: true, async json() { return { hits: [{ id: '502', imageWidth: 1600, imageHeight: 900, tags: 'person shopping bags cash spending money store', pageURL: 'https://pixabay.com/images/id-502/', largeImageURL: 'https://cdn.pixabay.com/502.jpg' }] }; } };
    };
    const plan = { questions: [{ index: 0, category: 'money', optionA: { text: 'savings doubled today', searchQuery: '' }, optionB: { text: 'spend freely grows', searchQuery: '' } }] };
    const selection = await createImageSelection({ plan, config: gapFillConfig() });
    assert.ok(selection.slots.Q1B.selectedId, 'a genuine shopping/spending candidate must be selected for "spend freely grows"');
    const selected = selection.slots.Q1B.candidates.find(c => c.candidateKey === selection.slots.Q1B.selectedId);
    assert.equal(selected.id, '502');
  } finally { global.fetch = originalFetch; }
});

test('an unrelated candidate is still rejected for the live Railway abstract option texts -- the fix never allows a wrong-subject fallback', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, async json() { return { hits: [{ id: '999', imageWidth: 1600, imageHeight: 900, tags: 'astronaut floating in outer space near space station', pageURL: 'https://pixabay.com/images/id-999/', largeImageURL: 'https://cdn.pixabay.com/999.jpg' }] }; } });
    const plan = { questions: [{ index: 0, category: 'money', optionA: { text: 'savings doubled today', searchQuery: '' }, optionB: { text: 'spend freely grows', searchQuery: '' } }] };
    const selection = await createImageSelection({ plan, config: gapFillConfig({ imageRecoveryMaxRequests: 6, imageRecoveryMaxMs: 3000 }) });
    assert.equal(selection.slots.Q1A.selectedId, null, 'an unrelated space photo must never be selected for "savings doubled today"');
    assert.equal(selection.slots.Q1B.selectedId, null, 'an unrelated space photo must never be selected for "spend freely grows"');
  } finally { global.fetch = originalFetch; }
});

test('when every tier is genuinely exhausted (provider has nothing usable at all), the slot fails clearly with a bounded, well-formed diagnostic report -- never an unrelated fallback image', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, async json() { return { hits: [] }; } });
    const plan = { questions: [{ index: 0, category: 'dream homes', optionA: { text: 'Live in a treehouse', searchQuery: '' }, optionB: { text: 'Live in a mansion', searchQuery: '' } }] };
    const started = Date.now();
    const selection = await createImageSelection({ plan, config: gapFillConfig({ imageRecoveryMaxRequests: 6, imageRecoveryMaxMs: 3000 }) });
    const elapsedMs = Date.now() - started;
    assert.equal(selection.slots.Q1A.selectedId, null);
    assert.equal(selection.selectedCount, 0);
    assert.ok(elapsedMs < 10_000, 'a genuinely-empty provider must fail fast, never hang waiting on an unbounded retry loop');

    const diag = selection.unfilledDiagnostics.find(d => d.slot === 'Q1A');
    assert.ok(diag, 'an unfilled slot must produce a diagnostic report');
    assert.equal(diag.scene, 1);
    assert.equal(diag.option, 'A');
    assert.equal(diag.optionText, 'Live in a treehouse');
    assert.equal(diag.dominantSubject, 'treehouse');
    assert.ok(Array.isArray(diag.queriesAttempted) && diag.queriesAttempted.length > 0);
    assert.ok(Array.isArray(diag.gapFillTiers) && diag.gapFillTiers.length > 0, 'diagnostics must record which gap-fill tiers were actually attempted');
    assert.ok(diag.gapFillTiers.every(t => t.filled === false));
    assert.equal(typeof diag.candidatesInspected, 'number');
    assert.equal(typeof diag.duplicatesRejected, 'number');
    assert.equal(typeof diag.semanticRelevanceRejected, 'number');
    assert.ok(diag.finalReason, 'a final, human-readable reason must be present');
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

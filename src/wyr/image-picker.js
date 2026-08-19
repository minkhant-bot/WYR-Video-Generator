import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PexelsImageProvider, assessImageCandidate, buildImageQueries, dominantSubjectWordsFor, inspectDownloadedImage } from './images.js';
import { fetchWithTimeout, mapWithConcurrency, log, retry } from './utils.js';
import { deterministicImageQueries } from './image-query.js';
import { isFantasyQuestion } from './content-engine.js';
import { computeSubjectAwareCrop } from './framing.js';
import { WYR_TEMPLATE } from './template.js';

export const IMAGE_PROVIDER_ORDER = Object.freeze(['Pixabay', 'Pexels']);
const REVIEW_POOL_SIZE = 8;
const MAX_PROVIDER_CALLS_PER_SLOT = 18;
// Bounded gap-fill budget for slots that Tier 1 (the strict, fixed 8-query/18-call pass above)
// left unfilled -- reuses the SAME config knobs the (otherwise dead-on-the-automatic-path)
// findAndDownloadImages recovery loop already exposes (WYR_IMAGE_RECOVERY_*), so ops can tune one
// consistent surface instead of two. Applied ONLY to slots still missing a selection after Tier 1,
// never to the whole batch, so a healthy 10/12 selection costs nothing extra.
const GAP_FILL_DEFAULTS = Object.freeze({ maxRequests: 24, maxWallClockMs: 45_000, queryRounds: 3 });
const GAP_FILL_TIER_CALLS = 18;

const identity = candidate =>
  `${candidate.provider}:${candidate.id}|${candidate.originalImageUrl || candidate.downloadUrl || ''}`;

export class PixabayImageProvider {
  constructor({ apiKey, timeoutMs }) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.name = 'Pixabay';
  }

  async search(query, page = 1) {
    if (!this.apiKey) return [];
    const url = new URL('https://pixabay.com/api/');
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('q', query);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '40');
    url.searchParams.set('safesearch', 'true');
    url.searchParams.set('orientation', 'horizontal');
    url.searchParams.set('image_type', 'all');

    const response = await fetchWithTimeout(url, {}, this.timeoutMs);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 180);
      throw new Error(`Pixabay search returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    const payload = await response.json();
    return (payload.hits || []).map((hit, position) => ({
      provider: this.name,
      id: String(hit.id),
      width: Number(hit.imageWidth),
      height: Number(hit.imageHeight),
      alt: String(hit.tags || ''),
      title: String(hit.tags || ''),
      sourceDomain: 'pixabay.com',
      sourcePageUrl: hit.pageURL,
      originalImageUrl: hit.largeImageURL || hit.webformatURL,
      downloadUrl: hit.largeImageURL || hit.webformatURL,
      previewUrl: hit.webformatURL || hit.previewURL,
      license: 'Pixabay Content License',
      licenseUrl: 'https://pixabay.com/service/license-summary/',
      usageRights: 'Pixabay Content License',
      position,
    })).filter(candidate =>
      candidate.downloadUrl &&
      candidate.width >= 750 &&
      candidate.height >= 450
    );
  }

  async downloadAsset(candidate, destination) {
    // Matches PexelsImageProvider's bounded retry (images.js) -- a transient network/5xx failure
    // on the PRIMARY provider must not be treated as permanent any more readily than the fallback is.
    await retry(async () => {
      const response = await fetchWithTimeout(candidate.downloadUrl, {}, this.timeoutMs);
      if (!response.ok) throw new Error(`Pixabay image download returned HTTP ${response.status}.`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        throw new Error(`Unexpected Pixabay asset content type: ${contentType || 'unknown'}.`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 10_000) throw new Error(`Downloaded Pixabay image is suspiciously small (${bytes.length} bytes).`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes);
    }, { attempts: 2, label: `download Pixabay photo ${candidate.id}` });
    return destination;
  }
}

const candidateForBrowser = candidate => ({
  ...candidate,
  previewUrl: candidate.previewUrl || candidate.thumbnailUrl || candidate.downloadUrl,
  originalImageUrl: candidate.originalImageUrl || candidate.downloadUrl,
});

const assessForReview = (candidate, option) => {
  const result = assessImageCandidate(candidate, option);
  return {
    ...candidate,
    validAsset: result.validAsset !== false,
    formatPass: result.formatPass !== false && result.validAsset !== false,
    // Whether this candidate cleared assessImageCandidate's full relevance gate (explicit visual
    // intent, dominant-subject-word coverage, minimum relevance score -- see images.js). Previously
    // this field didn't exist here at all, so reviewUsable below only checked format/size and NEVER
    // consulted relevance -- a candidate that matched nothing but an incidental filler word (e.g. a
    // sports car for "luxury trains", matched only on "luxury") was just as "usable" as a strong
    // match, and could still win as the least-bad option in a weak pool.
    accepted: result.accepted !== false && result.rejectionReasons?.length === 0,
    relevanceScore: Number(result.relevanceScore || 0),
    qualityScore: Number(result.qualityScore || 0),
    finalScore: Number(result.finalScore ?? result.qualityScore ?? 0),
    dominantCoverage: Number(result.dominantCoverage ?? 1),
    rejectionReasons: result.rejectionReasons || [],
    hardRejected: Boolean(result.hardRejected),
  };
};

const simpleVisualQuery = option => {
  const text = String(option.searchQuery || option.text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(would|rather|that|than|forever|whenever|every|your|you|with|without|have|become|choose)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.split(' ').slice(0, 6).join(' ');
};

// Most-specific-first: the curated/imported searchQuery (if any), then the deterministic literal
// subject of the option text (see image-query.js -- e.g. "treehouse" for "Live in a treehouse",
// "pizza" for "Eat pizza forever"), THEN the existing broader/decorative fallbacks
// (simpleVisualQuery, buildImageQueries' hardcoded phrase groups). The "fantasy cinematic" style
// suffix is reserved for questions actually classified as fantasy -- appending it to every
// realistic option (as before) biased Pixabay/Pexels toward stylized art instead of a literal photo.
const selectionQueries = (option, { category = '', fantasy = false } = {}) => {
  const deterministic = deterministicImageQueries(option, { category });
  const built = buildImageQueries(option);
  const simple = simpleVisualQuery(option);
  const subject = simple.split(' ').slice(-4).join(' ');
  // The stylized suffix is only meaningful (and only added) for fantasy-coded questions, so it's
  // placed right after the deterministic literal-subject queries -- high enough that a rich set of
  // broader/decorative fallbacks below it can't crowd it out of the bounded 8-query list.
  const stylized = fantasy && subject ? `${subject} fantasy cinematic` : '';
  return [...new Set([
    String(option.searchQuery || '').trim(),
    ...deterministic,
    stylized,
    simple,
    ...built,
    subject,
  ].filter(query => query && query.length >= 3))].slice(0, 8);
};

// Tier 3 (gap-fill only, never used for the initial Tier-1 pass): subject-preserving broadening
// for a slot that found NO usable candidate in the fixed Tier-1 query list. Anchored to
// dominantSubjectWordsFor -- the EXACT same word list images.js's assessImageCandidate requires
// >=50% coverage of -- so every variant here is guaranteed capable of clearing the dominant-subject
// gate; it only ever drops/reorders INCIDENTAL words (adjectives, actions, locations, temporal
// modifiers), never the mandatory core noun(s).
const broadenedSubjectQueries = optionText => {
  const words = dominantSubjectWordsFor(optionText);
  if (!words.length) return [];
  const bare = words.join(' ');
  const head = words[words.length - 1]; // rightmost word: typically the most specific/photographable noun
  return [...new Set([
    bare,
    head,
    `${bare} photo`,
    `${head} photo`,
    `${bare} real photo`,
  ].filter(query => query && query.length >= 3))];
};

const createProviders = config => {
  const providers = [];
  if (config.pixabayApiKey) {
    providers.push(new PixabayImageProvider({
      apiKey: config.pixabayApiKey,
      timeoutMs: config.timeoutMs,
    }));
  }
  if (config.pexelsApiKey) {
    providers.push(new PexelsImageProvider({
      apiKey: config.pexelsApiKey,
      timeoutMs: config.timeoutMs,
    }));
  }
  return providers;
};

const reviewUsable = candidate =>
  candidate.validAsset &&
  candidate.formatPass &&
  !candidate.hardRejected &&
  candidate.accepted &&
  Number(candidate.width) >= 750 &&
  Number(candidate.height) >= 450;

const sortPool = candidates => candidates.sort((a, b) =>
  (b.finalScore - a.finalScore) ||
  (b.relevanceScore - a.relevanceScore) ||
  (b.qualityScore - a.qualityScore) ||
  (a.position - b.position)
);

const selectBestAvailable = state => {
  const excluded = new Set(state.replacedIds || []);
  const candidate = state.candidates.find(item => !excluded.has(item.candidateKey));
  state.selectedId = candidate?.candidateKey || null;
  state.error = candidate ? null : (state.error || 'No usable images found.');
  return candidate || null;
};

const logSafe = value => String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(/\r?\n/g, ' ');
// Diagnostics for why a specific image won or lost, without dumping the full candidate pool.
const logSelectionResult = state => {
  const selected = state.candidates.find(candidate => candidate.candidateKey === state.selectedId);
  if (selected) {
    console.info(`WYR_SELECTION_RESULT | ${state.key} | provider=${selected.provider} | query="${logSafe(selected.queryUsed)}" | finalScore=${selected.finalScore} | relevanceScore=${selected.relevanceScore} | qualityScore=${selected.qualityScore} | conceptClarity=${selected.conceptClarity ?? 'n/a'} | specificity=${selected.specificity ?? 'n/a'} | candidatesConsidered=${state.candidates.length}`);
    return;
  }
  console.info(`WYR_SELECTION_RESULT | ${state.key} | NO CANDIDATE SELECTED | reason="${logSafe(state.error)}" | candidatesConsidered=${state.candidates.length} | providerRequestCount=${state.providerRequestCount}`);
};

// Buckets a rejected/dropped candidate into the diagnostic category a production failure report
// needs (see ImageSelectionExhaustedError below) -- never stores the full candidate, just a count,
// so an exhausted slot's diagnostics stay small regardless of how many candidates were inspected.
const classifyRejection = checked => {
  if (checked.hardRejected) return 'hardRejected';
  const reasons = checked.rejectionReasons || [];
  if (reasons.some(reason => reason.includes('dominant subject'))) return 'dominantSubjectRejected';
  if (reasons.some(reason => reason.includes('relevance score') || reason.includes('visual intent'))) return 'semanticRejected';
  return 'otherRejected';
};

const emptyDiagnostics = () => ({
  candidatesInspected: 0, duplicatesRejected: 0, hardRejected: 0,
  semanticRejected: 0, dominantSubjectRejected: 0, otherRejected: 0,
});

const fetchPoolForSlot = async (state, providers, config, minimumPool = REVIEW_POOL_SIZE, { maxCalls = MAX_PROVIDER_CALLS_PER_SLOT, deadline = Infinity } = {}) => {
  if (!providers.length) {
    state.error = 'No image provider is configured.';
    return state;
  }
  state.diagnostics = state.diagnostics || emptyDiagnostics();

  const seen = new Set(state.seen || []);
  let calls = 0;

  while (state.candidates.length < minimumPool && calls < maxCalls && Date.now() < deadline) {
    const provider = providers[state.providerIndex % providers.length];
    const query = state.queries[state.queryIndex % state.queries.length];
    const pageKey = `${provider.name}:${query}`;
    const page = (state.pages[pageKey] || 0) + 1;
    state.pages[pageKey] = page;

    try {
      const results = await provider.search(query, page);
      calls += 1;
      state.providerRequestCount += 1;

      for (const raw of results) {
        const checked = assessForReview(candidateForBrowser(raw), {
          text: state.optionText,
          searchQuery: query,
        });
        const key = identity(checked);
        if (seen.has(key)) { state.diagnostics.duplicatesRejected += 1; continue; }
        seen.add(key);
        state.seen.push(key);
        state.diagnostics.candidatesInspected += 1;

        if (!reviewUsable(checked)) { state.diagnostics[classifyRejection(checked)] += 1; continue; }

        state.candidates.push({
          ...checked,
          candidateKey: key,
          providerName: provider.name,
          queryUsed: query,
        });
      }
      sortPool(state.candidates);
      state.error = null;
    } catch (error) {
      calls += 1;
      state.providerRequestCount += 1;
      state.error = error.message;
    }

    state.providerIndex = (state.providerIndex + 1) % providers.length;
    if (state.providerIndex === 0) {
      state.queryIndex = (state.queryIndex + 1) % state.queries.length;
    }

    if (state.candidates.length >= minimumPool) break;
  }

  state.exhausted = state.candidates.length === 0 && calls >= maxCalls;
  return state;
};

// Tiers 2-4 (bounded gap-fill): reached ONLY for a slot Tier 1 left with zero selectable
// candidates. Each tier is a fresh, small provider-call budget so total extra latency for the
// common case (one or two stubborn slots) stays bounded, and the whole gap-fill run additionally
// respects a shared request-count/wall-clock ceiling (config.imageRecoveryMaxRequests/
// imageRecoveryMaxMs -- the same knobs already exposed for the legacy recovery path) so a
// genuinely-empty provider result can never turn into an unbounded retry loop.
const fillUnfilledSlot = async (state, providers, config) => {
  if (state.selectedId) return state;
  const maxRequests = config.imageRecoveryMaxRequests ?? GAP_FILL_DEFAULTS.maxRequests;
  const maxWallClockMs = config.imageRecoveryMaxMs ?? GAP_FILL_DEFAULTS.maxWallClockMs;
  const queryRounds = config.imageRecoveryQueryRounds ?? GAP_FILL_DEFAULTS.queryRounds;
  const deadline = Date.now() + maxWallClockMs;
  const requestsAtStart = state.providerRequestCount;
  const remainingBudget = () => Math.max(0, maxRequests - (state.providerRequestCount - requestsAtStart));
  state.gapFillTiers = [];
  const TOTAL_TIERS = 3;
  let tiersAttempted = 0;

  const runTier = async (label, extraQueries = []) => {
    tiersAttempted += 1;
    if (state.selectedId || Date.now() >= deadline || remainingBudget() <= 0) return;
    if (extraQueries.length) {
      const fresh = extraQueries.filter(query => !state.queries.includes(query));
      if (fresh.length) {
        state.queries.push(...fresh);
        state.queryIndex = state.queries.length - fresh.length; // try the new queries first, not after a full old cycle
      }
    }
    // A fair SHARE of whatever budget remains, not the whole thing: an earlier tier making no
    // progress (e.g. deeper pages of a query set a wrong-subject provider result keeps satisfying)
    // must never be able to spend the entire gap-fill budget and starve a later, more promising
    // tier (the subject-preserving broadened queries) of its own chance to run at all.
    const tiersLeft = TOTAL_TIERS - tiersAttempted + 1;
    const share = Math.max(1, Math.ceil(remainingBudget() / tiersLeft));
    const before = state.candidates.length;
    await fetchPoolForSlot(state, providers, config, before + REVIEW_POOL_SIZE, {
      maxCalls: Math.min(GAP_FILL_TIER_CALLS, share),
      deadline,
    });
    selectBestAvailable(state);
    state.gapFillTiers.push({ tier: label, queriesAdded: extraQueries, candidatesAfter: state.candidates.length, filled: Boolean(state.selectedId) });
  };

  // Tier 2: same subject-preserving query list, deeper provider pages -- catches results that only
  // show up past page 1 without changing what's being searched for.
  await runTier('tier2_deeper_pages');
  // Tier 3: broadened, dominant-subject-preserving query variants (bare subject, single head noun,
  // generic photographic suffixes) -- never drops the mandatory subject noun(s).
  if (!state.selectedId) await runTier('tier3_broadened_subject_queries', broadenedSubjectQueries(state.optionText).slice(0, queryRounds + 2));
  // Tier 4: one further round on top of tier 3's now-larger query set, in case a genuinely usable
  // candidate exists but only turns up on a later page of the broadened queries themselves.
  if (!state.selectedId) await runTier('tier4_broadened_deeper_pages');

  return state;
};

const updateSelectedCount = selection => {
  selection.selectedCount = Object.values(selection.slots)
    .filter(slot => slot.selectedId).length;
  return selection.selectedCount;
};

// Full per-slot diagnostic report for a slot that could not be filled -- everything Railway-failure
// triage needs (see ImageSelectionExhaustedError), with nothing secret in it: just option text,
// queries tried, and rejection counts. Reused for a selection-stage failure (below) and re-derived
// with download-stage counts merged in for a download-stage failure (downloadSelectedCandidates).
export const buildSlotDiagnostics = (state, reasonOverride = null) => {
  const diagnostics = state.diagnostics || emptyDiagnostics();
  return {
    slot: state.key,
    scene: state.questionIndex + 1,
    option: state.slot,
    optionText: state.optionText,
    dominantSubject: dominantSubjectWordsFor(state.optionText).join(' '),
    queriesAttempted: [...(state.queries || [])],
    gapFillTiers: state.gapFillTiers || [],
    candidatesInspected: diagnostics.candidatesInspected,
    duplicatesRejected: diagnostics.duplicatesRejected,
    downloadsFailed: state.downloadsFailed || 0,
    framingRejected: state.framingRejected || 0,
    semanticRelevanceRejected: diagnostics.semanticRejected + diagnostics.dominantSubjectRejected,
    hardRejected: diagnostics.hardRejected,
    otherRejected: diagnostics.otherRejected,
    finalReason: reasonOverride || (state.selectedId
      ? null
      : (state.error || 'No candidate cleared the relevance/quality gates within the bounded search budget.')),
  };
};

export const createImageSelection = async ({ plan, config }) => {
  const providers = createProviders(config);
  const slots = {};

  for (const question of plan.questions) {
    const fantasy = isFantasyQuestion(question);
    for (const slot of ['A', 'B']) {
      const key = `Q${question.index + 1}${slot}`;
      const option = slot === 'A' ? question.optionA : question.optionB;
      const state = {
        key,
        questionIndex: question.index,
        slot,
        optionText: option.text,
        queries: selectionQueries(option, { category: question.category, fantasy }),
        queryIndex: 0,
        providerIndex: 0,
        pages: {},
        candidates: [],
        seen: [],
        replacedIds: [],
        selectedId: null,
        exhausted: false,
        error: null,
        providerRequestCount: 0,
        diagnostics: emptyDiagnostics(),
      };

      // Tier 1: strict, fixed query list -- unchanged behavior/gates from before this fix.
      await fetchPoolForSlot(state, providers, config, REVIEW_POOL_SIZE);
      selectBestAvailable(state);
      slots[key] = state;
    }
  }

  // Tiers 2-4 (bounded gap-fill): only for slots Tier 1 left unfilled. This is what was previously
  // completely missing on the automatic/production path -- expandImageSelection/replaceImageSelection
  // already existed but were only ever wired to the manual-review HTTP endpoints, never called here,
  // so runAutomaticPipeline threw IMAGE_SELECTION_EXHAUSTED the instant Tier 1 left ANY slot short,
  // with zero broadening or retry. See pipeline.js's runAutomaticPipeline for where the final
  // (still-bounded) exhaustion check now lives.
  const unfilled = Object.values(slots).filter(state => !state.selectedId);
  for (const state of unfilled) {
    await fillUnfilledSlot(state, providers, config);
  }
  for (const state of Object.values(slots)) logSelectionResult(state);

  const selection = {
    mode: 'auto_review',
    pageSize: REVIEW_POOL_SIZE,
    total: Object.keys(slots).length,
    selectedCount: 0,
    slots,
    providers: providers.map(provider => provider.name),
  };
  updateSelectedCount(selection);
  selection.unfilledDiagnostics = Object.values(slots)
    .filter(state => !state.selectedId)
    .map(state => buildSlotDiagnostics(state));
  return selection;
};

export const expandImageSelection = async ({ selection, slotKey, config }) => {
  const state = selection.slots[slotKey];
  if (!state) throw new Error('Unknown image slot.');
  const providers = createProviders(config);
  const before = state.candidates.length;
  await fetchPoolForSlot(state, providers, config, before + REVIEW_POOL_SIZE);
  if (state.candidates.length === before && state.error) {
    throw new Error(`No more candidates for ${slotKey}: ${state.error}`);
  }
  return selection;
};

export const replaceImageSelection = async ({ selection, slotKey, config }) => {
  const state = selection.slots[slotKey];
  if (!state) throw new Error('Unknown image slot.');

  if (state.selectedId && !state.replacedIds.includes(state.selectedId)) {
    state.replacedIds.push(state.selectedId);
  }

  let replacement = selectBestAvailable(state);

  if (!replacement) {
    const providers = createProviders(config);
    const before = state.candidates.length;
    await fetchPoolForSlot(state, providers, config, before + REVIEW_POOL_SIZE);
    replacement = selectBestAvailable(state);
  }

  updateSelectedCount(selection);

  if (!replacement) {
    state.selectedId = null;
    updateSelectedCount(selection);
    throw new Error(state.error || `No more usable images found for ${slotKey}.`);
  }

  return selection;
};

export const selectImageCandidate = (selection, slotKey, candidateKey) => {
  const state = selection.slots[slotKey];
  if (!state) throw new Error('Unknown image slot.');
  const candidate = state.candidates.find(item => item.candidateKey === candidateKey);
  if (!candidate) throw new Error('Candidate does not belong to this image slot.');
  state.selectedId = candidate.candidateKey;
  state.error = null;
  updateSelectedCount(selection);
  return selection;
};

export const selectedCandidates = selection =>
  Object.values(selection.slots)
    .filter(slot => slot.selectedId)
    .map(slot => ({
      ...slot,
      selected: slot.candidates.find(candidate => candidate.candidateKey === slot.selectedId),
    }));

// Thrown only once EVERY candidate for a slot (the auto-selected one, the rest of its already-
// fetched pool, and one round of freshly-widened query/provider results) has failed download or
// validation -- distinct from other pipeline failures so the UI/logs can show a clear, specific
// cause instead of a generic error (see pipeline.js's error classification).
export class ImageSelectionExhaustedError extends Error {
  constructor(message, details = {}) { super(message); this.code = 'IMAGE_SELECTION_EXHAUSTED'; Object.assign(this, details); }
}

// Framing safety gate (see framing.js): computed from the REAL decoded dimensions (inspection.width/
// height), never the provider's declared width/height, which can be stale or simply wrong. An
// unsafe crop is treated exactly like a failed download/validation -- it throws here, so the
// existing candidate-by-candidate fallback in tryCandidate below moves on to the next ranked
// candidate instead of ever locking in a bad crop.
const downloadAndValidateCandidate = async ({ candidate, provider, item, assetsDir, computeCrop = computeSubjectAwareCrop }) => {
  const safeId = String(candidate.id).replace(/[^a-z0-9_-]/gi, '_');
  const filename = `${item.key.toLowerCase()}-${candidate.provider.toLowerCase()}-${safeId}.jpg`;
  const localPath = path.join(assetsDir, filename);
  try {
    await provider.downloadAsset(candidate, localPath);
    const inspection = await inspectDownloadedImage(localPath);
    if (!inspection.valid) throw new Error(`failed validation: ${inspection.reasons.join('; ')}`);
    const framing = await computeCrop({ localPath, sourceWidth: inspection.width, sourceHeight: inspection.height, targetWidth: WYR_TEMPLATE.layout.imageWidth, targetHeight: WYR_TEMPLATE.layout.imageHeight });
    if (!framing?.safe) throw new Error(framing?.reason || 'framing rejected: could not compute a safe crop for this image');
    return { localPath, filename, framing: { x: framing.x, y: framing.y, coverWidth: framing.coverWidth, coverHeight: framing.coverHeight } };
  } catch (error) {
    fs.rmSync(localPath, { force: true });
    throw error;
  }
};

// For EACH A/B slot: try the auto-selected candidate, then the rest of its already-ranked pool
// (specific query results first, broader-query results after -- the pool is already sorted by
// finalScore from fetchPoolForSlot), then -- only if that whole pool is exhausted -- widen the
// SAME bounded query/provider cycle for more candidates (reusing fetchPoolForSlot, so it keeps
// trying alternate/broader queries and the other provider) before finally failing that slot
// clearly. A candidate that fails is never retried (tracked in `failedKeys`), and a candidate
// whose bytes duplicate one already used for another slot is skipped, never both kept.
export const downloadSelectedCandidates = async ({ selection, assetsDir, config, computeCrop = computeSubjectAwareCrop }) => {
  const providers = new Map();
  if (config.pixabayApiKey) {
    providers.set('Pixabay', new PixabayImageProvider({
      apiKey: config.pixabayApiKey,
      timeoutMs: config.timeoutMs,
    }));
  }
  if (config.pexelsApiKey) {
    providers.set('Pexels', new PexelsImageProvider({
      apiKey: config.pexelsApiKey,
      timeoutMs: config.timeoutMs,
    }));
  }

  const chosen = selectedCandidates(selection);
  if (chosen.length !== selection.total) {
    throw new Error(`All ${selection.total} images must be ready before generation; ready ${chosen.length}/${selection.total}.`);
  }

  const usedCandidateKeys = new Set();
  const usedContentHashes = new Set();

  return mapWithConcurrency(chosen, config.pexelsConcurrency, async item => {
    const state = selection.slots[item.key];
    const failedKeys = new Set();
    let rank = 0; let lastError = null;

    const tryCandidate = async candidate => {
      if (!candidate || failedKeys.has(candidate.candidateKey) || usedCandidateKeys.has(candidate.candidateKey)) return null;
      const provider = providers.get(candidate.provider);
      if (!provider) { failedKeys.add(candidate.candidateKey); return null; }
      rank += 1;
      try {
        const { localPath, filename, framing } = await downloadAndValidateCandidate({ candidate, provider, item, assetsDir, computeCrop });
        const sha256 = createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
        if (usedContentHashes.has(sha256)) { fs.rmSync(localPath, { force: true }); throw new Error('duplicate image bytes already used for another slot'); }
        usedContentHashes.add(sha256); usedCandidateKeys.add(candidate.candidateKey);
        log('image.candidate_accepted', { slot: item.key, provider: candidate.provider, query: candidate.queryUsed, candidateRank: rank });
        return {
          ...candidate, questionIndex: item.questionIndex, slot: item.slot, text: item.optionText,
          queryUsed: candidate.queryUsed, localPath, filename, sha256, framing,
          selectedProvider: candidate.provider, selectedQuery: candidate.queryUsed,
          providerAttemptOrder: [...IMAGE_PROVIDER_ORDER], locked: false,
        };
      } catch (error) {
        failedKeys.add(candidate.candidateKey); lastError = error;
        state.diagnostics = state.diagnostics || emptyDiagnostics();
        if (/framing rejected/i.test(error.message)) state.framingRejected = (state.framingRejected || 0) + 1;
        else if (/duplicate image bytes/i.test(error.message)) state.diagnostics.duplicatesRejected += 1;
        else state.downloadsFailed = (state.downloadsFailed || 0) + 1;
        log('image.candidate_rejected', { slot: item.key, provider: candidate.provider, query: candidate.queryUsed, candidateRank: rank, reason: error.message });
        return null;
      }
    };

    let result = await tryCandidate(item.selected);
    if (!result) for (const candidate of state.candidates) { result = await tryCandidate(candidate); if (result) break; }
    if (!result) {
      const before = state.candidates.length;
      await fetchPoolForSlot(state, [...providers.values()], config, before + REVIEW_POOL_SIZE);
      for (const candidate of state.candidates.slice(before)) { result = await tryCandidate(candidate); if (result) break; }
    }
    if (!result) {
      // Tier 3/4 continuation (see fillUnfilledSlot): the known pool -- even widened -- is
      // exhausted purely at the download/validation/framing stage (item #8/#4 in the production
      // audit: failed downloads and framing rejections must trigger replacement searches, not an
      // immediate failure). Broaden to subject-preserving queries -- guaranteed to still satisfy
      // the dominant-subject gate -- for one more bounded round before finally giving up.
      const extraQueries = broadenedSubjectQueries(item.optionText).filter(query => !(state.queries || []).includes(query));
      if (extraQueries.length) {
        state.queries = state.queries || [];
        state.queries.push(...extraQueries);
        state.queryIndex = state.queries.length - extraQueries.length;
        const before = state.candidates.length;
        await fetchPoolForSlot(state, [...providers.values()], config, before + REVIEW_POOL_SIZE);
        for (const candidate of state.candidates.slice(before)) { result = await tryCandidate(candidate); if (result) break; }
      }
    }
    if (!result) {
      const reason = `${item.key}: every image candidate (${rank} tried) failed download or validation. Last error: ${lastError?.message || 'no candidates were available'}`;
      throw new ImageSelectionExhaustedError(reason, { ...buildSlotDiagnostics(state, reason), candidatesTried: rank });
    }
    return result;
  });
};

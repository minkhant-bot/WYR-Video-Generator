import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PexelsImageProvider, assessImageCandidate, buildImageQueries, inspectDownloadedImage } from './images.js';
import { fetchWithTimeout, mapWithConcurrency, log, retry } from './utils.js';
import { deterministicImageQueries } from './image-query.js';
import { isFantasyQuestion } from './content-engine.js';
import { computeSubjectAwareCrop } from './framing.js';
import { WYR_TEMPLATE } from './template.js';

export const IMAGE_PROVIDER_ORDER = Object.freeze(['Pixabay', 'Pexels']);
const REVIEW_POOL_SIZE = 8;
const MAX_PROVIDER_CALLS_PER_SLOT = 18;

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

const fetchPoolForSlot = async (state, providers, config, minimumPool = REVIEW_POOL_SIZE) => {
  if (!providers.length) {
    state.error = 'No image provider is configured.';
    return state;
  }

  const seen = new Set(state.seen || []);
  let calls = 0;

  while (state.candidates.length < minimumPool && calls < MAX_PROVIDER_CALLS_PER_SLOT) {
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
        if (seen.has(key)) continue;
        seen.add(key);
        state.seen.push(key);

        if (!reviewUsable(checked)) continue;

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

  state.exhausted = state.candidates.length === 0 && calls >= MAX_PROVIDER_CALLS_PER_SLOT;
  return state;
};

const updateSelectedCount = selection => {
  selection.selectedCount = Object.values(selection.slots)
    .filter(slot => slot.selectedId).length;
  return selection.selectedCount;
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
      };

      await fetchPoolForSlot(state, providers, config, REVIEW_POOL_SIZE);
      selectBestAvailable(state);
      logSelectionResult(state);
      slots[key] = state;
    }
  }

  const selection = {
    mode: 'auto_review',
    pageSize: REVIEW_POOL_SIZE,
    total: Object.keys(slots).length,
    selectedCount: 0,
    slots,
    providers: providers.map(provider => provider.name),
  };
  updateSelectedCount(selection);
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
    if (!result) throw new ImageSelectionExhaustedError(`${item.key}: every image candidate (${rank} tried) failed download or validation. Last error: ${lastError?.message || 'no candidates were available'}`, { slot: item.key, candidatesTried: rank });
    return result;
  });
};

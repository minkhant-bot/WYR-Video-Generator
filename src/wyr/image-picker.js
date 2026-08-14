import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PexelsImageProvider, assessImageCandidate, buildImageQueries, inspectDownloadedImage } from './images.js';
import { fetchWithTimeout, mapWithConcurrency } from './utils.js';

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
    const response = await fetchWithTimeout(candidate.downloadUrl, {}, this.timeoutMs);
    if (!response.ok) throw new Error(`Pixabay image download returned HTTP ${response.status}.`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      throw new Error(`Unexpected Pixabay asset content type: ${contentType || 'unknown'}.`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
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
    relevanceScore: Number(result.relevanceScore || 0),
    qualityScore: Number(result.qualityScore || 0),
    finalScore: Number(result.finalScore ?? result.qualityScore ?? 0),
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

const selectionQueries = option => {
  const built = buildImageQueries(option);
  const simple = simpleVisualQuery(option);
  const subject = simple.split(' ').slice(-4).join(' ');
  return [...new Set([
    String(option.searchQuery || '').trim(),
    simple,
    ...built,
    subject,
    subject ? `${subject} fantasy cinematic` : '',
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
    for (const slot of ['A', 'B']) {
      const key = `Q${question.index + 1}${slot}`;
      const option = slot === 'A' ? question.optionA : question.optionB;
      const state = {
        key,
        questionIndex: question.index,
        slot,
        optionText: option.text,
        queries: selectionQueries(option),
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

export const downloadSelectedCandidates = async ({ selection, assetsDir, config }) => {
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
  if (chosen.length !== 16) {
    throw new Error(`All 16 images must be ready before generation; ready ${chosen.length}/16.`);
  }

  const used = new Set();

  return mapWithConcurrency(chosen, config.pexelsConcurrency, async item => {
    const candidate = item.selected;
    if (!candidate || candidate.candidateKey !== item.selectedId) {
      throw new Error(`Selection changed for ${item.key}.`);
    }

    const provider = providers.get(candidate.provider);
    if (!provider) throw new Error(`Unsupported selected provider for ${item.key}: ${candidate.provider}.`);

    const filename = `${item.key.toLowerCase()}-${candidate.provider.toLowerCase()}.jpg`;
    const localPath = path.join(assetsDir, filename);

    await provider.downloadAsset(candidate, localPath);

    const inspection = await inspectDownloadedImage(localPath);
    if (!inspection.valid) {
      throw new Error(`${item.key} selected image failed validation: ${inspection.reasons.join('; ')}`);
    }

    const sha256 = createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
    if (used.has(sha256)) throw new Error(`Duplicate selected image bytes for ${item.key}.`);
    used.add(sha256);

    return {
      ...candidate,
      questionIndex: item.questionIndex,
      slot: item.slot,
      text: item.optionText,
      queryUsed: candidate.queryUsed,
      localPath,
      filename,
      sha256,
      selectedProvider: candidate.provider,
      selectedQuery: candidate.queryUsed,
      providerAttemptOrder: ['Pixabay', 'Pexels'],
      locked: false,
    };
  });
};

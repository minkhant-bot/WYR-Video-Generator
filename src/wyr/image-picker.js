import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PexelsImageProvider, assessImageCandidate, buildImageQueries, inspectDownloadedImage } from './images.js';
import { fetchWithTimeout, mapWithConcurrency } from './utils.js';

const PAGE_SIZE = 6;
const normalize = value => String(value || '').trim().toLowerCase();
const identity = candidate => `${candidate.provider}:${candidate.id}|${candidate.originalImageUrl || candidate.downloadUrl || ''}`;
const permittedOpenverse = license => /^(cc0|pdm|publicdomain|public domain)$/i.test(String(license || '').replace(/[-_]/g, ''));

export class PixabayImageProvider {
  constructor({ apiKey, timeoutMs }) { this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.name = 'Pixabay'; this.maxConcurrency = 2; }
  async search(query, page = 1) {
    if (!this.apiKey) return [];
    const url = new URL('https://pixabay.com/api/'); url.searchParams.set('key', this.apiKey); url.searchParams.set('q', query); url.searchParams.set('page', page); url.searchParams.set('per_page', '40'); url.searchParams.set('safesearch', 'true'); url.searchParams.set('orientation', 'horizontal');
    const payload = await (await fetchWithTimeout(url, {}, this.timeoutMs)).json();
    return (payload.hits || []).map((hit, position) => ({ provider: this.name, id: String(hit.id), width: Number(hit.imageWidth), height: Number(hit.imageHeight), alt: String(hit.tags || ''), title: String(hit.tags || ''), sourceDomain: 'pixabay.com', sourcePageUrl: hit.pageURL, originalImageUrl: hit.largeImageURL || hit.webformatURL, downloadUrl: hit.largeImageURL || hit.webformatURL, previewUrl: hit.webformatURL || hit.previewURL, license: 'Pixabay Content License', usageRights: 'Pixabay Content License', position })).filter(candidate => candidate.downloadUrl && candidate.width > 0 && candidate.height > 0);
  }
  async downloadAsset(candidate, destination) {
    const response = await fetchWithTimeout(candidate.downloadUrl, {}, this.timeoutMs); if (!response.ok) throw new Error(`Pixabay image download returned HTTP ${response.status}.`);
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer())); return destination;
  }
}

export class OpenverseImageProvider {
  constructor({ timeoutMs }) { this.timeoutMs = timeoutMs; this.name = 'Openverse'; this.maxConcurrency = 2; }
  async search(query, page = 1) {
    const url = new URL('https://api.openverse.org/v1/images/'); url.searchParams.set('q', query); url.searchParams.set('page', page); url.searchParams.set('page_size', '40');
    const payload = await (await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, this.timeoutMs)).json();
    return (payload.results || []).filter(result => permittedOpenverse(result.license)).map((result, position) => ({ provider: this.name, id: String(result.id || result.url), width: Number(result.width), height: Number(result.height), alt: String(result.title || result.creator || ''), title: String(result.title || ''), sourceDomain: (() => { try { return new URL(result.foreign_landing_url || result.url).hostname; } catch { return 'unknown'; } })(), sourcePageUrl: result.foreign_landing_url, originalImageUrl: result.url, downloadUrl: result.url, previewUrl: result.thumbnail || result.url, license: result.license, licenseUrl: result.license_url, usageRights: 'Openverse public-domain/CC0 result', position })).filter(candidate => candidate.downloadUrl && candidate.width >= 750 && candidate.height >= 450);
  }
  async downloadAsset(candidate, destination) {
    const response = await fetchWithTimeout(candidate.downloadUrl, {}, this.timeoutMs); if (!response.ok) throw new Error(`Openverse image download returned HTTP ${response.status}.`);
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer())); return destination;
  }
}

const candidateForBrowser = candidate => ({ ...candidate, previewUrl: candidate.previewUrl || candidate.thumbnailUrl || candidate.downloadUrl, originalImageUrl: candidate.originalImageUrl || candidate.downloadUrl });
const assess = (candidate, option) => { const result = assessImageCandidate(candidate, option); return { ...candidate, formatPass: result.formatPass !== false && result.validAsset, relevanceScore: result.relevanceScore, qualityScore: result.qualityScore, finalScore: result.finalScore ?? result.qualityScore, rejectionReasons: result.rejectionReasons, hardRejected: result.hardRejected }; };
const selectionQueries = option => [...new Set([String(option.searchQuery || option.text || '').trim(), ...buildImageQueries(option)])].filter(Boolean).slice(0, 4);

export const createImageSelection = async ({ plan, config }) => {
  const providers = [new PexelsImageProvider({ apiKey: config.pexelsApiKey, timeoutMs: config.timeoutMs }), new PixabayImageProvider({ apiKey: config.pixabayApiKey, timeoutMs: config.timeoutMs }), new OpenverseImageProvider({ timeoutMs: config.timeoutMs })].filter(provider => provider.name !== 'Pexels' || provider.apiKey || config.pexelsApiKey);
  const slots = {};
  for (const question of plan.questions) for (const slot of ['A', 'B']) {
    const key = `Q${question.index + 1}${slot}`; const option = slot === 'A' ? question.optionA : question.optionB; const queries = selectionQueries(option); const state = { key, questionIndex: question.index, slot, optionText: option.text, queries, queryIndex: 0, page: 1, candidates: [], seen: [], selectedId: null, exhausted: false, error: null };
    await fetchMoreForSlot(state, providers, PAGE_SIZE, config);
    slots[key] = state;
  }
  return { pageSize: PAGE_SIZE, total: Object.keys(slots).length, selectedCount: 0, slots, providers: providers.map(provider => provider.name) };
};

const fetchMoreForSlot = async (state, providers, count, config) => {
  const seen = new Set(state.seen); const target = state.candidates.length + count; let attempts = 0;
  while (state.candidates.length < target && attempts < providers.length * 2) {
    const provider = providers[attempts % providers.length]; const query = state.queries[state.queryIndex % state.queries.length];
    try {
      const results = await provider.search(query, state.page); state.page += 1; attempts += 1;
      for (const raw of results) { const checked = assess(candidateForBrowser(raw), { text: state.optionText }); const key = identity(checked); if (seen.has(key) || !checked.formatPass || checked.rejectionReasons?.length) continue; seen.add(key); state.seen.push(key); state.candidates.push({ ...checked, candidateKey: key, providerName: provider.name, queryUsed: query }); if (state.candidates.length >= target) break; }
      state.queryIndex += 1;
    } catch (error) { state.error = error.message; attempts += 1; state.queryIndex += 1; }
    if (state.candidates.length >= target) break;
  }
  state.candidates = state.candidates.slice(0, Math.max(count, state.candidates.length)); state.exhausted = attempts >= providers.length * 2 && state.candidates.length === 0;
  return state;
};

export const expandImageSelection = async ({ selection, slotKey, config }) => {
  const state = selection.slots[slotKey]; if (!state) throw new Error('Unknown image slot.');
  const providers = [new PexelsImageProvider({ apiKey: config.pexelsApiKey, timeoutMs: config.timeoutMs }), new PixabayImageProvider({ apiKey: config.pixabayApiKey, timeoutMs: config.timeoutMs }), new OpenverseImageProvider({ timeoutMs: config.timeoutMs })];
  const before = state.candidates.length; await fetchMoreForSlot(state, providers, PAGE_SIZE, config); if (state.candidates.length === before && state.error) throw new Error(`No more candidates for ${slotKey}: ${state.error}`); return selection;
};

export const selectImageCandidate = (selection, slotKey, candidateKey) => {
  const state = selection.slots[slotKey]; if (!state) throw new Error('Unknown image slot.'); const candidate = state.candidates.find(item => item.candidateKey === candidateKey); if (!candidate) throw new Error('Candidate does not belong to this image slot.');
  state.selectedId = candidate.candidateKey; selection.selectedCount = Object.values(selection.slots).filter(slot => slot.selectedId).length; return selection;
};

export const selectedCandidates = selection => Object.values(selection.slots).filter(slot => slot.selectedId).map(slot => ({ ...slot, selected: slot.candidates.find(candidate => candidate.candidateKey === slot.selectedId) }));

export const downloadSelectedCandidates = async ({ selection, assetsDir, config }) => {
  const providers = new Map([['Pexels', new PexelsImageProvider({ apiKey: config.pexelsApiKey, timeoutMs: config.timeoutMs })], ['Pixabay', new PixabayImageProvider({ apiKey: config.pixabayApiKey, timeoutMs: config.timeoutMs })], ['Openverse', new OpenverseImageProvider({ timeoutMs: config.timeoutMs })]]);
  const chosen = selectedCandidates(selection); if (chosen.length !== 16) throw new Error(`Select all 16 images before generation; selected ${chosen.length}/16.`);
  const used = new Set();
  return mapWithConcurrency(chosen, config.pexelsConcurrency, async item => {
    const candidate = item.selected; if (!candidate || candidate.candidateKey !== item.selectedId) throw new Error(`Selection changed for ${item.key}.`); const provider = providers.get(candidate.provider); if (!provider) throw new Error(`Unsupported selected provider for ${item.key}.`);
    const filename = `${item.key.toLowerCase()}-${candidate.provider.toLowerCase()}.jpg`; const localPath = path.join(assetsDir, filename); await provider.downloadAsset(candidate, localPath); const inspection = await inspectDownloadedImage(localPath); if (!inspection.valid) throw new Error(`${item.key} selected image failed validation: ${inspection.reasons.join('; ')}`); const sha256 = createHash('sha256').update(fs.readFileSync(localPath)).digest('hex'); if (used.has(sha256)) throw new Error(`Duplicate selected image bytes for ${item.key}.`); used.add(sha256);
    return { ...candidate, questionIndex: item.questionIndex, slot: item.slot, text: item.optionText, queryUsed: candidate.queryUsed, localPath, filename, sha256, selectedProvider: candidate.provider, selectedQuery: candidate.queryUsed, providerAttemptOrder: ['Pexels', 'Pixabay', 'Openverse'], locked: false };
  });
};

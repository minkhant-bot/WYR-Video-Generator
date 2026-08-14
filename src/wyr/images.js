import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchWithTimeout, log, mapWithConcurrency, retry } from './utils.js';

export class ImageProvider { async search() { throw new Error('ImageProvider.search must be implemented.'); } async downloadAsset() { throw new Error('ImageProvider.downloadAsset must be implemented.'); } }
export class PexelsImageProvider extends ImageProvider {
  constructor({ apiKey, timeoutMs }) { super(); this.apiKey = apiKey; this.timeoutMs = timeoutMs; }
  async search(query) {
    const url = new URL('https://api.pexels.com/v1/search'); url.searchParams.set('query', query); url.searchParams.set('per_page', '40'); url.searchParams.set('orientation', 'landscape');
    const response = await fetchWithTimeout(url, { headers: { Authorization: this.apiKey } }, this.timeoutMs);
    if (!response.ok) throw new Error(`Pexels search returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const payload = await response.json();
    return (payload.photos || []).map((photo, position) => ({ id: String(photo.id), provider: 'Pexels', width: Number(photo.width), height: Number(photo.height), alt: String(photo.alt || ''), title: String(photo.alt || ''), photographer: photo.photographer, photographerUrl: photo.photographer_url, photoUrl: photo.url, sourcePageUrl: photo.url, sourceDomain: 'pexels.com', originalImageUrl: photo.src?.original, downloadUrl: photo.src?.large2x || photo.src?.large || photo.src?.original, license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/', usageRights: 'Pexels License; review current terms before reuse', sha256: null, position })).filter(candidate => candidate.downloadUrl && candidate.width > 0 && candidate.height > 0);
  }
  async downloadAsset(candidate, destination) {
    await retry(async () => {
      const response = await fetchWithTimeout(candidate.downloadUrl, {}, this.timeoutMs);
      if (!response.ok) throw new Error(`Image download returned HTTP ${response.status}.`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) throw new Error(`Unexpected asset content type: ${contentType || 'unknown'}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 10_000) throw new Error(`Downloaded image is suspiciously small (${bytes.length} bytes).`);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes);
    }, { attempts: 2, label: `download Pexels photo ${candidate.id}` });
    return destination;
  }
}
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'at', 'with', 'for', 'your', 'you', 'become', 'be', 'own', 'have', 'anywhere', 'through', 'instantly']);
const VISUAL_EXPANSIONS = Object.freeze({
  minds: ['telepathy', 'brain', 'thoughts'], mind: ['telepathy', 'brain', 'thoughts'], read: ['reading'], future: ['fortune', 'crystal', 'vision'],
  teleport: ['teleportation', 'portal', 'gateway'], invisible: ['invisibility', 'transparent', 'disappearing'], invisibility: ['invisible', 'transparent', 'disappearing'],
  time: ['clock', 'temporal', 'vortex'], stop: ['stopped', 'frozen', 'freeze'], travel: ['traveler', 'journey'], dragon: ['fantasy', 'creature'], befriend: ['friendly', 'interacting'], portal: ['fantasy', 'doorway', 'gateway'], door: ['doorway', 'portal'],
  strangers: ['people', 'person', 'human'], double: ['doubling', 'multiply', 'multiplying'], bank: ['money', 'financial', 'wealth'], balance: ['account', 'money', 'wealth'],
});
const normalizeWords = value => String(value || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(word => word.length > 2 && !STOP_WORDS.has(word));
const uniqueWords = words => [...new Set(words)];
export const buildImageQueries = option => {
  const optionWords = normalizeWords(option.text); const supplied = normalizeWords(option.searchQuery);
  const expanded = uniqueWords(optionWords.flatMap(word => [word, ...(VISUAL_EXPANSIONS[word] || [])]));
  const has = word => optionWords.includes(word); let visualQueries = [];
  if (has('minds') || has('mind')) visualQueries = ['telepathy person reading thoughts', 'two people psychic mind connection', 'person seeing another person thoughts'];
  else if (has('double') && (has('bank') || has('balance'))) visualQueries = ['money multiplying in hands cinematic', 'cash magically doubling dramatic wealth', 'person surrounded by multiplying money cinematic'];
  else if (has('future')) visualQueries = ['person seeing future crystal ball', 'dramatic future vision cinematic', 'person viewing future scene'];
  else if (has('teleport')) visualQueries = ['person entering glowing teleportation portal', 'person stepping through portal cinematic', 'teleportation gateway person dramatic'];
  else if (has('invisible') || has('invisibility')) visualQueries = ['invisible person empty clothes disappearing', 'person becoming invisible cinematic', 'transparent human disappearing scene'];
  else if (has('stop') && has('time')) visualQueries = ['time frozen city people', 'person walking through frozen time', 'dramatic stopped time city scene'];
  else if (has('travel') && has('time')) visualQueries = ['person entering time portal', 'time traveler cinematic portal', 'person walking through temporal vortex'];
  else if (has('dragon')) visualQueries = ['person petting friendly dragon fantasy', 'human befriending cinematic dragon', 'person interacting with gentle dragon'];
  else if (has('portal') && has('door')) visualQueries = ['doorway opening into another world', 'person beside magical portal door', 'fantasy door to another dimension'];
  return [...new Set([
    ...visualQueries,
    supplied.slice(0, 7).join(' '),
    optionWords.slice(0, 5).join(' '),
    expanded.slice(0, 7).join(' '),
  ].filter(query => query.length >= 3))];
};

const candidateText = candidate => `${candidate.alt || ''} ${candidate.title || ''} ${candidate.credit || ''}`.toLowerCase();
const WATERMARK_PATTERN = /\b(watermark|watermarked|shutterstock|alamy|i\s*stock|dreamstime|depositphotos|123rf|getty images?|adobe stock|stock photo|freepik premium|impossible images)\b/i;
const WATERMARK_HOST_PATTERN = /(^|\.)(shutterstock\.com|alamy\.com|istockphoto\.com|dreamstime\.com|depositphotos\.com|123rf\.com|gettyimages\.com|stock\.adobe\.com|freepik\.com|vectorstock\.com|vecteezy\.com|craiyon\.com|impossibleimages\.ai|stablediffusionweb\.com)$/i;
const UNSUITABLE_SOURCE_HOST_PATTERN = /(^|\.)(youtube\.com|rivalskins\.com)$/i;
const UI_OR_TEXT_PATTERN = /\b(screenshot|user interface|dashboard|webpage|mobile app|social media post|meme|template|infographic|quote poster|text banner|logo design|typography)\b/i;
const MISLEADING_CONTEXT_PATTERN = /\b(camera|lens|olympus|t-?shirt|merchandise|product mockup|for sale|shop now|phone case|coffee mug|costume|toy|figurine|rageon|metaverse|second life|bargain center|grunge sign)\b/i;
const INAPPROPRIATE_PATTERN = /\b(nude|nudity|nsfw|porn|erotic|fetish|lingerie|bikini|sexualized|sexy)\b/i;
const WEAK_VISUAL_PATTERN = /\b(clip[ -]?art|simple icon|flat icon|vector icon|diagram|infographic|isolated product|product shot|corporate illustration|generic illustration|generic stock|wallet|calculator|credit card|bank card|card reader|brain model|brain in (?:a )?box)\b/i;
const IMPACT_PATTERN = /\b(cinematic|dramatic|glowing|neon|vibrant|surreal|fantasy|portal|gateway|vortex|frozen|shattered|massive|luxury|action|transformation|multiplying|doubling)\b/gi;
const PEXELS_MINIMUM_QUALITY = 72;
const MAX_RANKED_CANDIDATES = 8;
const candidateKeys = candidate => uniqueWords([candidate.provider && candidate.id ? `id:${candidate.provider}:${candidate.id}` : '', candidate.originalImageUrl ? `url:${candidate.originalImageUrl}` : '', candidate.downloadUrl ? `url:${candidate.downloadUrl.split('?')[0]}` : '', candidate.sha256 ? `sha256:${candidate.sha256}` : ''].filter(Boolean));
const fileHash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const optionConcepts = option => uniqueWords(normalizeWords(option.text).flatMap(word => [word, ...(VISUAL_EXPANSIONS[word] || [])]));
const containsAny = (tokens, words) => words.some(word => tokens.has(word));
const visualIntentGroups = option => {
  const words = normalizeWords(option.text); const has = word => words.includes(word);
  const groups = [];
  if (has('minds') || has('mind')) groups.push(['person', 'people', 'human', 'head', 'face'], ['telepathy', 'telepathic', 'thoughts', 'mind', 'brain', 'psychic'], ['two', 'another', 'others', 'connection', 'connected', 'communication', 'telepathy', 'telepathic']);
  else if (has('double') && (has('bank') || has('balance'))) groups.push(['money', 'cash', 'wealth', 'bank', 'account', 'balance']);
  else if (has('future')) groups.push(['person', 'people', 'human', 'man', 'woman', 'teller', 'seer'], ['future', 'vision', 'crystal', 'scrying', 'prophecy']);
  else if (has('teleport')) groups.push(['person', 'people', 'figure', 'human', 'man', 'woman', 'silhouette'], ['portal', 'gateway', 'teleport', 'teleportation']);
  else if (has('invisible') || has('invisibility')) groups.push(['person', 'people', 'human', 'man', 'woman', 'clothes', 'body'], ['invisible', 'invisibility', 'disappearing', 'transparent', 'empty']);
  else if (has('stop') && has('time')) groups.push(['time', 'clock', 'city', 'people', 'person'], ['frozen', 'freeze', 'stopped', 'suspended', 'shattered']);
  else if (has('travel') && has('time')) groups.push(['person', 'people', 'traveler', 'man', 'woman', 'figure', 'machine'], ['time', 'temporal', 'portal', 'vortex']);
  else if (has('dragon')) groups.push(['person', 'people', 'human', 'girl', 'boy', 'man', 'woman', 'princess', 'knight'], ['dragon', 'dragons']);
  else if (has('portal') && has('door')) groups.push(['door', 'doorway', 'gate', 'entrance'], ['world', 'portal', 'dimension', 'realm', 'landscape']);
  return groups;
};
const explicitVisualIntent = (option, tokens) => visualIntentGroups(option).every(group => containsAny(tokens, group));
const clampScore = value => Math.max(0, Math.min(100, Math.round(value * 10) / 10));
export const assessImageCandidate = (candidate, option) => {
  const rejectionReasons = []; const assetRejectionReasons = [];
  if (!candidate?.id || !candidate.downloadUrl) assetRejectionReasons.push('missing provider ID or image URL');
  if (!Number.isFinite(candidate?.width) || !Number.isFinite(candidate?.height) || candidate.width < 750 || candidate.height < 450) assetRejectionReasons.push('image is too small for the 750x450 slot');
  const searchableText = `${candidateText(candidate)} ${candidate.keywords || ''} ${candidate.downloadUrl || ''} ${candidate.originalImageUrl || ''} ${candidate.sourcePageUrl || ''}`;
  if (WATERMARK_PATTERN.test(searchableText) || WATERMARK_HOST_PATTERN.test(String(candidate.sourceDomain || ''))) assetRejectionReasons.push('obvious stock or website watermark risk detected');
  if (UNSUITABLE_SOURCE_HOST_PATTERN.test(String(candidate.sourceDomain || ''))) assetRejectionReasons.push('candidate source is likely a UI thumbnail or merchandise result');
  if (UI_OR_TEXT_PATTERN.test(searchableText)) assetRejectionReasons.push('candidate appears to be a screenshot, meme, UI, or text-dominated graphic');
  if (MISLEADING_CONTEXT_PATTERN.test(searchableText)) assetRejectionReasons.push('candidate describes merchandise or a misleading unrelated context');
  if (INAPPROPRIATE_PATTERN.test(searchableText)) assetRejectionReasons.push('candidate appears inappropriate or sexualized');
  rejectionReasons.push(...assetRejectionReasons);
  const concepts = optionConcepts(option); const textTokens = new Set(normalizeWords(candidateText(candidate))); const allTokens = new Set([...textTokens, ...normalizeWords(candidate.keywords)]);
  const matched = concepts.filter(concept => allTokens.has(concept));
  const core = normalizeWords(option.text); const coreMatched = core.filter(concept => textTokens.has(concept) || (VISUAL_EXPANSIONS[concept] || []).some(alias => textTokens.has(alias)));
  const relevance = concepts.length ? matched.length / concepts.length : 0;
  const coreCoverage = core.length ? coreMatched.length / core.length : 0;
  const intentGroups = visualIntentGroups(option); const intentCoverage = intentGroups.length ? intentGroups.filter(group => containsAny(allTokens, group)).length / intentGroups.length : coreCoverage;
  const targetRatio = 750 / 450; const ratio = candidate.width / candidate.height;
  const cropFit = Math.max(0, 1 - Math.abs(Math.log(ratio / targetRatio)) / 1.5);
  const resolution = Math.min(1, Math.min(candidate.width / 1600, candidate.height / 900));
  const relevanceScore = Math.round((coreCoverage * 60 + relevance * 20 + cropFit * 10 + resolution * 8 + Math.max(0, 2 - Number(candidate.position || 0) * 0.08)) * 10) / 10;
  const weakVisual = WEAK_VISUAL_PATTERN.test(searchableText); const impactMatches = searchableText.match(IMPACT_PATTERN)?.length || 0;
  const optionWords = normalizeWords(option.text); const bankGrowthRequired = optionWords.includes('double') && (optionWords.includes('bank') || optionWords.includes('balance'));
  const bankGrowthDepicted = !bankGrowthRequired || containsAny(allTokens, ['big', 'double', 'doubled', 'doubling', 'multiply', 'multiplying', 'increase', 'increasing', 'growth', 'growing', 'overflowing', 'surrounded', 'endless', 'abundance', 'raining', 'falling', 'pile', 'stacks']);
  const conceptClarity = clampScore(coreCoverage * 40 + intentCoverage * 60 - (bankGrowthDepicted ? 0 : 18));
  const specificity = clampScore(intentCoverage * 65 + Math.min(25, matched.length * 6) + coreCoverage * 10 - (weakVisual ? 22 : 0) - (bankGrowthDepicted ? 0 : 28));
  const visualImpact = clampScore(30 + Math.min(36, impactMatches * 9) + cropFit * 16 + resolution * 18 - (weakVisual ? 30 : 0));
  const wyrSuitability = clampScore(conceptClarity * 0.42 + specificity * 0.28 + visualImpact * 0.2 + cropFit * 10);
  const qualityScore = clampScore(conceptClarity * 0.34 + specificity * 0.28 + visualImpact * 0.2 + wyrSuitability * 0.18);
  if (!explicitVisualIntent(option, allTokens)) rejectionReasons.push('candidate does not explicitly represent the option visually');
  if (coreMatched.length === 0 || relevanceScore < 38) rejectionReasons.push(`relevance score ${relevanceScore.toFixed(1)} is below 38.0`);
  const accepted = rejectionReasons.length === 0;
  const pexelsQualityReasons = [];
  if (conceptClarity < 70) pexelsQualityReasons.push(`concept clarity ${conceptClarity.toFixed(1)} is below 70.0`);
  if (specificity < 65) pexelsQualityReasons.push(`specificity ${specificity.toFixed(1)} is below 65.0`);
  if (visualImpact < 50) pexelsQualityReasons.push(`visual impact ${visualImpact.toFixed(1)} is below 50.0`);
  if (qualityScore < PEXELS_MINIMUM_QUALITY) pexelsQualityReasons.push(`visual quality ${qualityScore.toFixed(1)} is below ${PEXELS_MINIMUM_QUALITY.toFixed(1)}`);
  if (!bankGrowthDepicted) pexelsQualityReasons.push('candidate does not depict money or wealth increasing, multiplying, or in dramatic abundance');
  if (weakVisual) pexelsQualityReasons.push('candidate is generic, object-only, clip-art-like, or stock-like');
  return { accepted, validAsset: assetRejectionReasons.length === 0, relevanceScore, qualityScore, conceptClarity, specificity, visualImpact, wyrSuitability, pexelsQualityPassed: accepted && pexelsQualityReasons.length === 0, pexelsQualityReasons, rejectionReasons, matchedConcepts: uniqueWords(coreMatched) };
};

const collectCandidateJobs = async ({ jobs, provider, providerLabel, concurrency, retrySearch }) => {
  const results = await mapWithConcurrency(jobs, Math.min(concurrency, provider.maxConcurrency || concurrency), async job => {
    try {
      const operation = () => provider.search(job.query);
      const candidates = retrySearch ? await retry(operation, { attempts: 2, label: `${providerLabel} image search for "${job.query}"` }) : await operation();
      return { ...job, candidates, error: null };
    } catch (error) { return { ...job, candidates: [], error }; }
  });
  for (const result of results) {
    const { state, query, candidates, error } = result;
    if (error) {
      state.searchAttempts.push({ provider: providerLabel, query, candidateCount: 0, error: error.message });
      state.providerErrors.push(`${providerLabel}: ${error.message}`); if (providerLabel !== 'Pexels') state.webProviderErrors.push(error.message); continue;
    }
    state.searchAttempts.push({ provider: providerLabel, query, candidateCount: candidates.length, error: null });
    for (const candidate of candidates) {
      const assessment = assessImageCandidate(candidate, state.option);
      const enriched = { ...candidate, provider: candidate.provider || providerLabel, query, relevanceScore: assessment.relevanceScore, qualityScore: assessment.qualityScore, conceptClarity: assessment.conceptClarity, specificity: assessment.specificity, visualImpact: assessment.visualImpact, wyrSuitability: assessment.wyrSuitability, pexelsQualityPassed: assessment.pexelsQualityPassed, pexelsQualityReasons: assessment.pexelsQualityReasons, matchedConcepts: assessment.matchedConcepts };
      if (assessment.validAsset) state.validCandidates.push(enriched);
      if (!assessment.accepted) state.rejections.push({ provider: enriched.provider, id: enriched.id, query, reasons: assessment.rejectionReasons });
      else state.candidates.push(enriched);
    }
  }
};

const collectCandidates = async ({ states, provider, providerLabel, concurrency, retrySearch, progressive = false }) => {
  if (!progressive) {
    await collectCandidateJobs({ jobs: states.flatMap(state => state.queries.map(query => ({ state, query }))), provider, providerLabel, concurrency, retrySearch });
    return;
  }
  const queryCount = Math.max(0, ...states.map(state => state.queries.length));
  for (let queryIndex = 0; queryIndex < queryCount; queryIndex += 1) {
    const jobs = states.filter(state => (queryIndex < 2 || state.candidates.length === 0) && state.queries[queryIndex]).map(state => ({ state, query: state.queries[queryIndex] }));
    if (!jobs.length) break;
    await collectCandidateJobs({ jobs, provider, providerLabel, concurrency, retrySearch });
  }
};

const rankedUnique = candidates => {
  const byIdentity = new Map();
  for (const candidate of candidates) {
    const identity = candidate.originalImageUrl || candidate.downloadUrl || `${candidate.provider}:${candidate.id}`;
    const current = byIdentity.get(identity);
    if (!current || candidate.qualityScore > current.qualityScore || (candidate.qualityScore === current.qualityScore && candidate.relevanceScore > current.relevanceScore)) byIdentity.set(identity, candidate);
  }
  return [...byIdentity.values()].sort((left, right) => right.qualityScore - left.qualityScore || right.relevanceScore - left.relevanceScore || left.position - right.position);
};
const conflicts = (candidate, used) => candidateKeys(candidate).some(key => used.has(key));
const reserve = (candidate, used) => candidateKeys(candidate).forEach(key => used.add(key));
const release = (candidate, used) => candidateKeys(candidate).forEach(key => used.delete(key));
const choose = (state, used) => state.pool.find(candidate => !state.failedKeys.has(candidateKeys(candidate).join('|')) && !conflicts(candidate, used));

export const findAndDownloadImages = async ({ plan, provider, webProvider = null, assetsDir, maxRetries, concurrency = 4, onProgress }) => {
  const options = plan.questions.flatMap(question => [{ questionIndex: question.index, slot: 'A', ...question.optionA }, { questionIndex: question.index, slot: 'B', ...question.optionB }]);
  const states = options.map((option, index) => ({ index, option, queries: buildImageQueries(option).slice(0, maxRetries + 1), candidates: [], validCandidates: [], webCandidates: [], selected: null, pool: [], failedKeys: new Set(), searchAttempts: [], providerErrors: [], webProviderErrors: [], rejections: [] }));
  await collectCandidates({ states, provider, providerLabel: 'Pexels', concurrency, retrySearch: true });
  for (const state of states) {
    const rankedPexels = rankedUnique(state.candidates.filter(candidate => candidate.provider === 'Pexels')).slice(0, MAX_RANKED_CANDIDATES);
    state.pexelsBestCandidate = rankedPexels[0] || null;
    state.pexelsCandidates = rankedPexels.filter(candidate => candidate.pexelsQualityPassed);
    state.pexelsFallbackCandidates = rankedPexels;
    state.pexelsGatePassed = state.pexelsCandidates.length > 0;
  }

  const used = new Set();
  for (const state of states) {
    const strong = state.pexelsCandidates.find(candidate => !conflicts(candidate, used));
    if (strong) { state.selected = strong; reserve(strong, used); }
  }
  const needsWeb = states.filter(state => !state.selected);
  for (const state of needsWeb) state.webFallbackRequired = true;
  if (webProvider && needsWeb.length) {
    for (const state of needsWeb) { state.candidates = []; state.validCandidates = []; }
    await collectCandidates({ states: needsWeb, provider: webProvider, providerLabel: webProvider.name || 'Web image search', concurrency, retrySearch: false, progressive: true });
    for (const state of needsWeb) state.webCandidates = rankedUnique(state.candidates.filter(candidate => candidate.provider !== 'Pexels')).slice(0, MAX_RANKED_CANDIDATES);
  }
  for (const state of needsWeb) {
    state.pool = rankedUnique([...state.webCandidates, ...state.pexelsFallbackCandidates]);
    const selected = choose(state, used);
    if (selected) { state.selected = selected; reserve(selected, used); }
    const fallbackReason = state.webProviderErrors.length ? state.webProviderErrors.join('; ') : state.webCandidates.length ? null : 'web image search returned no relevant usable candidates';
    if (fallbackReason) log('image.web_fallback_unavailable', { question: state.option.questionIndex + 1, slot: state.option.slot, reason: fallbackReason, usingPexels: state.selected?.provider === 'Pexels' });
  }
  for (const state of states.filter(state => state.selected)) if (!state.pool.length) state.pool = state.pexelsFallbackCandidates;

  let completed = 0; const usedContentHashes = new Set();
  const downloadSelections = async initialStates => {
    let pending = initialStates.filter(state => state.selected);
    while (pending.length) {
      const results = await mapWithConcurrency(pending, concurrency, async state => {
        const selected = state.selected; const downloader = selected.provider === 'Pexels' ? provider : webProvider;
        const safeId = String(selected.id).replace(/[^a-z0-9_-]/gi, '_');
        const filename = `q${String(state.option.questionIndex + 1).padStart(2, '0')}-${state.option.slot.toLowerCase()}-${selected.provider === 'Pexels' ? 'pexels' : 'web'}-${safeId}.jpg`; const localPath = path.join(assetsDir, filename);
        try { await downloader.downloadAsset(selected, localPath); return { ok: true, state, filename, localPath, contentHash: fileHash(localPath) }; }
        catch (error) { fs.rmSync(localPath, { force: true }); return { ok: false, state, error }; }
      });
      pending = [];
      for (const result of results) {
        const state = result.state;
        if (result.ok && !usedContentHashes.has(result.contentHash)) { state.selected.sha256 = result.contentHash; usedContentHashes.add(result.contentHash); used.add(`sha256:${result.contentHash}`); state.filename = result.filename; state.localPath = result.localPath; completed += 1; onProgress?.(completed, options.length); continue; }
        if (result.ok) { fs.rmSync(result.localPath, { force: true }); result.error = new Error('downloaded bytes duplicate an image already selected'); }
        state.rejections.push({ provider: state.selected.provider, id: state.selected.id, query: state.selected.query, reasons: [`broken or unreachable image: ${result.error.message}`] });
        release(state.selected, used); state.failedKeys.add(candidateKeys(state.selected).join('|')); state.selected = choose(state, used);
        if (state.selected) { reserve(state.selected, used); pending.push(state); }
      }
    }
  };
  await downloadSelections(states);
  const brokenPexelsStates = states.filter(state => !state.localPath && !state.webFallbackRequired && webProvider);
  if (brokenPexelsStates.length) {
    for (const state of brokenPexelsStates) { state.webFallbackRequired = true; state.candidates = []; state.validCandidates = []; }
    await collectCandidates({ states: brokenPexelsStates, provider: webProvider, providerLabel: webProvider.name || 'Web image search', concurrency, retrySearch: false, progressive: true });
    for (const state of brokenPexelsStates) { state.webCandidates = rankedUnique(state.candidates).slice(0, MAX_RANKED_CANDIDATES); state.pool = state.webCandidates; state.selected = choose(state, used); if (state.selected) reserve(state.selected, used); }
    await downloadSelections(brokenPexelsStates);
  }
  const missing = states.find(state => !state.localPath);
  if (missing) throw new Error(`No downloadable relevant image found for question ${missing.option.questionIndex + 1}, option ${missing.option.slot}. Pexels and optional web fallback were exhausted.`);
  const selections = states.map(state => ({
    ...state.option, ...state.selected, queryUsed: state.selected.query, searchAttempts: state.searchAttempts, rejectionReasons: state.rejections,
    webFallbackRequired: Boolean(state.webFallbackRequired), pexelsPassed: state.pexelsGatePassed,
    pexelsBestCandidate: state.pexelsBestCandidate ? { id: state.pexelsBestCandidate.id, query: state.pexelsBestCandidate.query, alt: state.pexelsBestCandidate.alt, qualityScore: state.pexelsBestCandidate.qualityScore, conceptClarity: state.pexelsBestCandidate.conceptClarity, specificity: state.pexelsBestCandidate.specificity, visualImpact: state.pexelsBestCandidate.visualImpact, wyrSuitability: state.pexelsBestCandidate.wyrSuitability, passed: state.pexelsBestCandidate.pexelsQualityPassed, reasons: state.pexelsBestCandidate.pexelsQualityReasons } : null,
    fallbackReason: state.selected.provider === 'Pexels' && state.webFallbackRequired ? (state.webProviderErrors.join('; ') || 'web image search returned no relevant downloadable candidate') : null, localPath: state.localPath, filename: state.filename,
  }));
  const identities = selections.flatMap(candidateKeys);
  if (new Set(identities).size !== identities.length) throw new Error('Image selection produced duplicate provider IDs, URLs, or content hashes.');
  return selections;
};

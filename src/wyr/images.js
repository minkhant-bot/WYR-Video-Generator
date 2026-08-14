import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fetchWithTimeout, log, mapWithConcurrency, retry, writeJsonAtomic } from './utils.js';
import { assertFontAvailable, resolveFfmpegPath } from './runtime.js';

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

const CONTROL_WORDS = new Set(['control', 'command', 'create', 'make', 'become', 'have', 'own', 'read', 'see', 'stop', 'travel', 'befriend', 'ride', 'live', 'walk', 'fly', 'turn', 'change']);
export const buildAlternateImageQueries = option => {
  const words = normalizeWords(option.text); const nouns = words.filter(word => !CONTROL_WORDS.has(word));
  const primary = nouns.length ? nouns.join(' ') : words.join(' ');
  const controlling = words.some(word => ['control', 'command', 'create', 'make', 'change'].includes(word));
  return [...new Set([
    controlling ? `person controlling ${primary} objects levitating cinematic` : `person interacting with ${primary} cinematic`,
    `human surrounded by ${primary} dramatic scene`,
    `person using ${primary}${controlling ? ' power' : ''} science fiction cinematic`,
  ].map(query => query.trim()).filter(query => query.length >= 3))];
};

const candidateText = candidate => `${candidate.alt || ''} ${candidate.title || ''} ${candidate.credit || ''}`.toLowerCase();
const WATERMARK_PATTERN = /\b(watermark|watermarked|shutterstock|alamy|i\s*stock|dreamstime|depositphotos|123rf|getty images?|adobe stock|stock photo|freepik premium|impossible images)\b/i;
const WATERMARK_HOST_PATTERN = /(^|\.)(shutterstock\.com|alamy\.com|istockphoto\.com|dreamstime\.com|depositphotos\.com|123rf\.com|gettyimages\.com|stock\.adobe\.com|freepik\.com|vectorstock\.com|vecteezy\.com|craiyon\.com|impossibleimages\.ai|stablediffusionweb\.com)$/i;
const UNSUITABLE_SOURCE_HOST_PATTERN = /(^|\.)(youtube\.com|rivalskins\.com)$/i;
const UI_OR_TEXT_PATTERN = /\b(screenshot|user interface|dashboard|webpage|mobile app|social media post|meme|template|infographic|quote poster|text banner|logo design|typography)\b/i;
const MISLEADING_CONTEXT_PATTERN = /\b(camera|lens|olympus|t-?shirt|merchandise|product mockup|for sale|shop now|phone case|coffee mug|costume|toy|figurine|rageon|metaverse|second life|bargain center|grunge sign)\b/i;
const INAPPROPRIATE_PATTERN = /\b(nude|nudity|nsfw|porn|erotic|fetish|lingerie|bikini|sexualized|sexy)\b/i;
const SOURCE_QUALITY_PATTERN = /\b(meme(?:generator)?|quote(?:s)?|infographic|diagram|chart|screenshot|template|mockup|product(?:[ -]?listing)?|ui|user[ -]?interface|advertisement|advertising|poster|presentation|slide)\b/i;
const WEAK_VISUAL_PATTERN = /\b(clip[ -]?art|simple icon|flat icon|vector icon|diagram|infographic|isolated product|product shot|corporate illustration|generic illustration|generic stock|wallet|calculator|credit card|bank card|card reader|brain model|brain in (?:a )?box)\b/i;
const CORPORATE_WEAK_PATTERN = /\b(corporate|business meeting|office team|businessman at desk|finance illustration|corporate stock|generic office|financial presentation)\b/i;
const IMPACT_PATTERN = /\b(cinematic|dramatic|glowing|neon|vibrant|surreal|fantasy|portal|gateway|vortex|frozen|shattered|massive|luxury|action|transformation|multiplying|doubling)\b/gi;
export const PEXELS_MINIMUM_QUALITY = 72;
const MAX_RANKED_CANDIDATES = 8;
export const IMAGE_SELECTION_DEFAULTS = Object.freeze({ providerOrder: ['Pexels', 'DuckDuckGo Images'], minimumWidth: 750, minimumHeight: 450, pexelsQualityThreshold: PEXELS_MINIMUM_QUALITY, maxRankedCandidates: MAX_RANKED_CANDIDATES });
export const IMAGE_RECOVERY_DEFAULTS = Object.freeze({ alternateQueryRounds: 3, maxProviderRequests: 24, maxWallClockMs: 45_000 });
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
  if (UI_OR_TEXT_PATTERN.test(searchableText) || SOURCE_QUALITY_PATTERN.test(searchableText)) assetRejectionReasons.push('candidate appears to be a meme, infographic, screenshot, UI, ad, template, or text-dominated graphic');
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
  const weakVisual = WEAK_VISUAL_PATTERN.test(searchableText); const corporateWeak = CORPORATE_WEAK_PATTERN.test(searchableText); const impactMatches = searchableText.match(IMPACT_PATTERN)?.length || 0;
  const optionWords = normalizeWords(option.text); const bankGrowthRequired = optionWords.includes('double') && (optionWords.includes('bank') || optionWords.includes('balance'));
  const bankGrowthDepicted = !bankGrowthRequired || containsAny(allTokens, ['big', 'double', 'doubled', 'doubling', 'multiply', 'multiplying', 'increase', 'increasing', 'growth', 'growing', 'overflowing', 'surrounded', 'endless', 'abundance', 'raining', 'falling', 'pile', 'stacks']);
  const conceptClarity = clampScore(coreCoverage * 40 + intentCoverage * 60 - (bankGrowthDepicted ? 0 : 18));
  const specificity = clampScore(intentCoverage * 65 + Math.min(25, matched.length * 6) + coreCoverage * 10 - (weakVisual ? 22 : 0) - (corporateWeak ? 14 : 0) - (bankGrowthDepicted ? 0 : 28));
  const visualImpact = clampScore(30 + Math.min(36, impactMatches * 9) + cropFit * 16 + resolution * 18 - (weakVisual ? 30 : 0) - (corporateWeak ? 18 : 0));
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
  if (corporateWeak) pexelsQualityReasons.push('candidate is generic corporate or finance stock imagery for a concept needing a stronger visual');
  return { accepted, validAsset: assetRejectionReasons.length === 0, relevanceScore, qualityScore, conceptClarity, specificity, visualImpact, wyrSuitability, pexelsQualityPassed: accepted && pexelsQualityReasons.length === 0, pexelsQualityReasons, rejectionReasons, matchedConcepts: uniqueWords(coreMatched) };
};

const runImageProbe = (binary, args) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; let stderr = '';
  child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); }); child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(`${output}\n${stderr}`) : reject(new Error(`FFmpeg image validation exited with code ${code}: ${stderr.slice(-1000)}`)));
});
const statValue = (output, name) => { const match = output.match(new RegExp(`lavfi\\.signalstats\\.${name}=(-?[0-9.]+)`)); return match ? Number(match[1]) : NaN; };
const probeDimensions = output => { const match = output.match(/\bs:(\d+)x(\d+)\b/); return match ? { width: Number(match[1]), height: Number(match[2]) } : null; };
export const classifyImageStats = ({ width, height, yMin, yMax, yAvg, edgeYAvg, stdev }) => {
  const reasons = [];
  if (!Number.isFinite(width) || !Number.isFinite(height)) reasons.push('decoded dimensions were unavailable');
  else if (width < 750 || height < 450) reasons.push('decoded image is too small for the 750x450 slot');
  if (![yMin, yMax, yAvg, edgeYAvg].every(Number.isFinite)) reasons.push('decoded image statistics were unavailable');
  else {
    const range = yMax - yMin;
    if (range <= 6 || (yMax < 24 && yAvg < 8) || (yMin > 247 && yAvg > 248)) reasons.push('image is blank, near-black, near-white, or overwhelmingly uniform');
    if (Number.isFinite(stdev) && stdev < 2.5 && range < 24) reasons.push('image has near-zero contrast and appears to be a placeholder');
    if (edgeYAvg < 0.15 && range < 48) reasons.push('image has no meaningful edge/detail structure');
  }
  return { valid: reasons.length === 0, reasons, width, height, yMin, yMax, yAvg, edgeYAvg, stdev };
};
export const inspectDownloadedImage = async (localPath, { binary = resolveFfmpegPath() } = {}) => {
  const rawOutput = await runImageProbe(binary, ['-hide_banner', '-v', 'info', '-i', localPath, '-vf', 'signalstats,metadata=print:file=-,showinfo', '-frames:v', '1', '-f', 'null', '-']);
  const edgeOutput = await runImageProbe(binary, ['-hide_banner', '-v', 'error', '-i', localPath, '-vf', 'edgedetect=low=0.1:high=0.4,signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-']);
  const dimensions = probeDimensions(rawOutput) || {};
  return classifyImageStats({ ...dimensions, yMin: statValue(rawOutput, 'YMIN'), yMax: statValue(rawOutput, 'YMAX'), yAvg: statValue(rawOutput, 'YAVG'), edgeYAvg: statValue(edgeOutput, 'YAVG'), stdev: Number(rawOutput.match(/stdev:\[(-?[0-9.]+)/)?.[1]) });
};

const collectCandidateJobs = async ({ jobs, provider, providerLabel, concurrency, retrySearch, phase = 'normal' }) => {
  const results = await mapWithConcurrency(jobs, Math.min(concurrency, provider.maxConcurrency || concurrency), async job => {
    try {
      const operation = () => { job.state.providerRequestCount += 1; return provider.search(job.query); };
      const candidates = retrySearch ? await retry(operation, { attempts: 2, label: `${providerLabel} image search for "${job.query}"` }) : await operation();
      return { ...job, candidates, error: null };
    } catch (error) { return { ...job, candidates: [], error }; }
  });
  for (const result of results) {
    const { state, query, candidates, error } = result;
    if (error) {
      state.searchAttempts.push({ phase, provider: providerLabel, query, candidateCount: 0, error: error.message });
      state.providerErrors.push(`${providerLabel}: ${error.message}`); if (providerLabel !== 'Pexels') state.webProviderErrors.push(error.message); continue;
    }
    state.searchAttempts.push({ phase, provider: providerLabel, query, candidateCount: candidates.length, error: null });
    for (const candidate of candidates) {
      const assessment = assessImageCandidate(candidate, state.option);
      const enriched = { ...candidate, provider: candidate.provider || providerLabel, query, relevanceScore: assessment.relevanceScore, qualityScore: assessment.qualityScore, conceptClarity: assessment.conceptClarity, specificity: assessment.specificity, visualImpact: assessment.visualImpact, wyrSuitability: assessment.wyrSuitability, pexelsQualityPassed: assessment.pexelsQualityPassed, pexelsQualityReasons: assessment.pexelsQualityReasons, matchedConcepts: assessment.matchedConcepts };
      state.candidateDiagnostics.push({ provider: enriched.provider, id: enriched.id, query, sourceDomain: enriched.sourceDomain, width: enriched.width, height: enriched.height, qualityScore: enriched.qualityScore, relevanceScore: enriched.relevanceScore, accepted: assessment.accepted, validAsset: assessment.validAsset, reasons: assessment.rejectionReasons });
      if (assessment.validAsset) state.validCandidates.push(enriched);
      if (!assessment.accepted) state.rejections.push({ provider: enriched.provider, id: enriched.id, query, reasons: assessment.rejectionReasons });
      else state.candidates.push(enriched);
    }
  }
};

const collectCandidates = async ({ states, provider, providerLabel, concurrency, retrySearch, progressive = false, phase = 'normal' }) => {
  if (!progressive) {
    await collectCandidateJobs({ jobs: states.flatMap(state => state.queries.map(query => ({ state, query }))), provider, providerLabel, concurrency, retrySearch, phase });
    return;
  }
  const queryCount = Math.max(0, ...states.map(state => state.queries.length));
  for (let queryIndex = 0; queryIndex < queryCount; queryIndex += 1) {
    const jobs = states.filter(state => (queryIndex < 2 || state.candidates.length === 0) && state.queries[queryIndex]).map(state => ({ state, query: state.queries[queryIndex] }));
    if (!jobs.length) break;
    await collectCandidateJobs({ jobs, provider, providerLabel, concurrency, retrySearch, phase });
  }
};

const providerRank = provider => IMAGE_SELECTION_DEFAULTS.providerOrder.indexOf(provider) < 0 ? IMAGE_SELECTION_DEFAULTS.providerOrder.length : IMAGE_SELECTION_DEFAULTS.providerOrder.indexOf(provider);
const sizeScore = candidate => Math.min(1, Math.min(Number(candidate.width) / 1600, Number(candidate.height) / 900));
export const compareImageCandidates = (left, right) => {
  const quality = Number(right.qualityScore || 0) - Number(left.qualityScore || 0); if (quality) return quality;
  const relevance = Number(right.relevanceScore || 0) - Number(left.relevanceScore || 0); if (relevance) return relevance;
  const size = sizeScore(right) - sizeScore(left); if (size) return size;
  const provider = providerRank(left.provider) - providerRank(right.provider); if (provider) return provider;
  const leftKey = `${left.originalImageUrl || left.downloadUrl || ''}\u0000${left.provider || ''}\u0000${left.id || ''}`;
  const rightKey = `${right.originalImageUrl || right.downloadUrl || ''}\u0000${right.provider || ''}\u0000${right.id || ''}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};
const rankedUnique = candidates => {
  const byIdentity = new Map();
  for (const candidate of candidates) {
    const identity = candidate.originalImageUrl || candidate.downloadUrl || `${candidate.provider}:${candidate.id}`;
    const current = byIdentity.get(identity);
    if (!current || compareImageCandidates(candidate, current) < 0) byIdentity.set(identity, candidate);
  }
  return [...byIdentity.values()].sort(compareImageCandidates);
};
const conflicts = (candidate, used) => candidateKeys(candidate).some(key => used.has(key));
const reserve = (candidate, used) => candidateKeys(candidate).forEach(key => used.add(key));
const release = (candidate, used) => candidateKeys(candidate).forEach(key => used.delete(key));
const choose = (state, used) => state.pool.find(candidate => !state.failedKeys.has(candidateKeys(candidate).join('|')) && !conflicts(candidate, used));

export const findAndDownloadImages = async ({ plan, provider, webProvider = null, visualQueryProvider = null, assetsDir, maxRetries, concurrency = 4, onProgress, imageInspector = inspectDownloadedImage, recovery = IMAGE_RECOVERY_DEFAULTS }) => {
  const options = plan.questions.flatMap(question => [{ questionIndex: question.index, slot: 'A', ...question.optionA }, { questionIndex: question.index, slot: 'B', ...question.optionB }]);
  const recoveryConfig = { ...IMAGE_RECOVERY_DEFAULTS, ...recovery };
  const states = options.map((option, index) => ({ index, option, queries: buildImageQueries(option).slice(0, maxRetries + 1), candidates: [], validCandidates: [], webCandidates: [], selected: null, pool: [], failedKeys: new Set(), searchAttempts: [], providerErrors: [], webProviderErrors: [], rejections: [], candidateDiagnostics: [], providerRequestCount: 0, recoveryQueries: [] }));
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
        try {
          await downloader.downloadAsset(selected, localPath);
          const inspection = await imageInspector(localPath, selected);
          if (!inspection?.valid) throw new Error(`downloaded image rejected: ${inspection?.reasons?.join('; ') || 'image failed visual-content validation'}`);
          if (Number.isFinite(inspection.width)) selected.width = inspection.width;
          if (Number.isFinite(inspection.height)) selected.height = inspection.height;
          return { ok: true, state, filename, localPath, contentHash: fileHash(localPath), inspection };
        }
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
  const failedStates = states.filter(state => !state.localPath);
  for (const state of failedStates) {
    const recoveryStartedAt = Date.now(); const deadline = recoveryStartedAt + recoveryConfig.maxWallClockMs;
    const canRecover = () => state.providerRequestCount < recoveryConfig.maxProviderRequests && Date.now() < deadline;
    const searchRecoveryProvider = async (query, recoveryProvider, providerLabel) => {
      if (!recoveryProvider || !canRecover()) return false;
      await collectCandidateJobs({ jobs: [{ state, query }], provider: recoveryProvider, providerLabel, concurrency: 1, retrySearch: false, phase: 'recovery' });
      return true;
    };
    const tryRecoveryCandidates = async () => {
      if (Date.now() >= deadline) return false;
      state.pool = rankedUnique([...state.candidates, ...state.pexelsFallbackCandidates]);
      state.selected = choose(state, used);
      if (state.selected) reserve(state.selected, used);
      await downloadSelections([state]);
      return Boolean(state.localPath);
    };
    const alternateQueries = buildAlternateImageQueries(state.option).slice(0, recoveryConfig.alternateQueryRounds);
    for (const query of alternateQueries) {
      if (!canRecover()) break;
      state.recoveryQueries.push(query);
      await searchRecoveryProvider(query, provider, 'Pexels (recovery)');
      await searchRecoveryProvider(query, webProvider, webProvider?.name ? `${webProvider.name} (recovery)` : 'Web image search (recovery)');
    }
    if (await tryRecoveryCandidates()) continue;
    if (visualQueryProvider && typeof visualQueryProvider.generateVisualQueries === 'function' && canRecover()) {
      const groqQuery = `visual reformulation for option: ${state.option.text}`;
      state.providerRequestCount += 1;
      try {
        const reformulated = await visualQueryProvider.generateVisualQueries({ optionText: state.option.text, attemptedQueries: [...state.queries, ...state.recoveryQueries], maxQueries: recoveryConfig.alternateQueryRounds });
        state.searchAttempts.push({ phase: 'recovery', provider: 'Groq visual reformulation', query: groqQuery, candidateCount: reformulated.length, error: null });
        for (const query of reformulated) {
          if (!canRecover()) break;
          state.recoveryQueries.push(query);
          await searchRecoveryProvider(query, provider, 'Pexels (Groq recovery)');
          await searchRecoveryProvider(query, webProvider, webProvider?.name ? `${webProvider.name} (Groq recovery)` : 'Web image search (Groq recovery)');
        }
      } catch (error) {
        state.searchAttempts.push({ phase: 'recovery', provider: 'Groq visual reformulation', query: groqQuery, candidateCount: 0, error: error.message });
        state.providerErrors.push(`Groq visual reformulation: ${error.message}`);
      }
      if (await tryRecoveryCandidates()) continue;
    }
    state.recoveryElapsedMs = Date.now() - recoveryStartedAt;
  }
  const missing = states.find(state => !state.localPath);
  if (missing) {
    const attempts = missing.searchAttempts.map(attempt => `${attempt.phase || 'normal'} ${attempt.provider} query="${attempt.query}" candidates=${attempt.candidateCount}${attempt.error ? ` error=${attempt.error}` : ''}`).join(' | ') || 'none';
    const reasons = missing.rejections.flatMap(rejection => rejection.reasons || []).concat(missing.candidateDiagnostics.flatMap(candidate => candidate.reasons || [])).filter(Boolean);
    throw new Error(`No downloadable relevant image found for question ${missing.option.questionIndex + 1}, option ${missing.option.slot} (${missing.option.text}). Pexels and optional web fallback were exhausted. Queries attempted: ${missing.searchAttempts.map(attempt => attempt.query).join(' | ') || 'none'}. Provider attempts: ${attempts}. Candidate rejection reasons: ${[...new Set(reasons)].join('; ') || 'none'}. Request count: ${missing.providerRequestCount}. Recovery elapsed: ${missing.recoveryElapsedMs ?? recoveryConfig.maxWallClockMs}ms.`);
  }
  const selections = states.map(state => ({
    ...state.option, ...state.selected, queryUsed: state.selected.query, searchAttempts: state.searchAttempts, rejectionReasons: state.rejections, candidateDiagnostics: state.candidateDiagnostics,
    queryOrder: state.queries, recoveryQueries: state.recoveryQueries, candidateCount: state.searchAttempts.reduce((sum, attempt) => sum + attempt.candidateCount, 0), providerRequestCount: state.providerRequestCount, recoveryElapsedMs: state.recoveryElapsedMs || 0,
    webFallbackRequired: Boolean(state.webFallbackRequired), pexelsPassed: state.pexelsGatePassed,
    pexelsBestCandidate: state.pexelsBestCandidate ? { id: state.pexelsBestCandidate.id, query: state.pexelsBestCandidate.query, alt: state.pexelsBestCandidate.alt, qualityScore: state.pexelsBestCandidate.qualityScore, conceptClarity: state.pexelsBestCandidate.conceptClarity, specificity: state.pexelsBestCandidate.specificity, visualImpact: state.pexelsBestCandidate.visualImpact, wyrSuitability: state.pexelsBestCandidate.wyrSuitability, passed: state.pexelsBestCandidate.pexelsQualityPassed, reasons: state.pexelsBestCandidate.pexelsQualityReasons } : null,
    fallbackReason: state.selected.provider === 'Pexels' && state.webFallbackRequired ? (state.webProviderErrors.join('; ') || 'web image search returned no relevant downloadable candidate') : null, localPath: state.localPath, filename: state.filename,
  }));
  const identities = selections.flatMap(candidateKeys);
  if (new Set(identities).size !== identities.length) throw new Error('Image selection produced duplicate provider IDs, URLs, or content hashes.');
  return selections;
};

const copyAndVerify = (source, destination, expectedHash) => {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Selected image is missing: ${source}`);
  const actualHash = fileHash(source); if (expectedHash && actualHash !== expectedHash) throw new Error(`Selected image hash mismatch before render: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination);
  const copiedHash = fileHash(destination); if (copiedHash !== actualHash) throw new Error(`Selected image hash mismatch after locking: ${destination}`);
  return copiedHash;
};

export const lockSelectedImageAssets = ({ assets, workspace }) => {
  if (!Array.isArray(assets) || !assets.length) throw new Error('Cannot lock an empty image selection.');
  const selectedDir = path.join(workspace, 'review', 'selected-images');
  const locked = assets.map(asset => {
    const filename = path.basename(asset.localPath || asset.filename || `${asset.questionIndex}-${asset.slot}.jpg`);
    const localPath = path.join(selectedDir, filename);
    const sha256 = copyAndVerify(asset.localPath, localPath, asset.sha256);
    return { ...asset, localPath, filename, sha256, locked: true };
  });
  writeJsonAtomic(path.join(workspace, 'review', 'selected-images.json'), locked.map(asset => ({ ...asset, localPath: path.relative(workspace, asset.localPath) })));
  return locked;
};

const runReviewCommand = (binary, args) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); }); child.once('error', reject);
  child.once('close', code => code === 0 ? resolve() : reject(new Error(`Image review contact sheet command failed (${code}): ${stderr}`)));
});
const reviewFilterPath = file => file.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''");
export const createImageReviewArtifacts = async ({ assets, workspace, ffmpeg = resolveFfmpegPath() }) => {
  const selectedDir = path.join(workspace, 'review', 'selected-images'); const contactPath = path.join(workspace, 'review', 'contact-sheet.jpg'); fs.mkdirSync(selectedDir, { recursive: true });
  const font = assertFontAvailable();
  const tilePaths = [];
  try {
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index]; const tile = path.join(workspace, 'review', `.tile-${index}.jpg`); const text = path.join(workspace, 'review', `.tile-${index}.txt`);
      fs.writeFileSync(text, `${asset.optionText || asset.text || `Question ${asset.questionIndex + 1} ${asset.slot}`}\nProvider: ${asset.provider}\nQuery: ${asset.queryUsed}\nSource: ${asset.sourceDomain || 'unknown'}`);
      const filter = `scale=360:230:force_original_aspect_ratio=increase,crop=360:230,pad=360:360:0:0:black,drawtext=fontfile=${reviewFilterPath(font)}:textfile='${reviewFilterPath(text)}':fontcolor=white:fontsize=16:line_spacing=3:x=8:y=240`;
      await runReviewCommand(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', asset.localPath, '-vf', filter, '-frames:v', '1', tile]); tilePaths.push(tile);
    }
    const args = []; for (const tile of tilePaths) args.push('-i', tile);
    const layout = assets.map((_, index) => `${(index % 4) * 360}_${Math.floor(index / 4) * 360}`).join('|');
    await runReviewCommand(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args, '-filter_complex', `xstack=inputs=${assets.length}:layout=${layout}:fill=black`, '-q:v', '2', contactPath]);
  } finally {
    for (let index = 0; index < assets.length; index += 1) { fs.rmSync(path.join(workspace, 'review', `.tile-${index}.jpg`), { force: true }); fs.rmSync(path.join(workspace, 'review', `.tile-${index}.txt`), { force: true }); }
  }
  return { selectedImagesDir: selectedDir, contactSheetPath: contactPath };
};

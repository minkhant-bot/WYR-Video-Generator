import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchWithTimeout } from './utils.js';

const DUCKDUCKGO_SEARCH_URL = 'https://duckduckgo.com/';
const DUCKDUCKGO_IMAGES_URL = 'https://duckduckgo.com/i.js';
const COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const COMMONS_USER_AGENT = 'WYRVideoGenerator/1.0 (automated food-video image selection; https://github.com/)';
const BLOCK_PATTERN = /captcha|verify you are human|unusual traffic|automated quer(?:y|ies)|anomaly-modal|challenge-platform/i;
const VQD_PATTERNS = [/vqd=["']([^"']+)/i, /vqd=([\d-]+)/i];
const sourceDomain = value => { try { return new URL(value).hostname.toLowerCase(); } catch { return 'unknown'; } };
const candidateId = result => String(result.image_token || createHash('sha256').update(String(result.image || '')).digest('hex'));
const foodSubjectFromQuery = query => {
  const value = String(query || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/\b(?:isolated white background product photo|single food close up white background|isolated food photography|isolated food photo|close up food photography|close up food photo|plated dish close up|food photography|real food photo|food photo)\b/.test(value)) return '';
  return value
    .split(/\b(?:isolated white background product photo|single food close up white background|isolated food photography|isolated food photo|close up food photography|close up food photo|plated dish close up|food photography|real food photo|food photo)\b/)[0]
    .replace(/\bno people\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};
const normalizedWords = value => String(value || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(word => word.length > 1);

export class WebImageProvider {
  async search() { throw new Error('WebImageProvider.search must be implemented.'); }
  async downloadAsset() { throw new Error('WebImageProvider.downloadAsset must be implemented.'); }
}

export class DuckDuckGoImageProvider extends WebImageProvider {
  constructor({ timeoutMs = 12_000, fetcher = fetchWithTimeout, maxSearchRequests = 64, maxDownloadRequests = 64 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.fetcher = fetcher;
    this.maxSearchRequests = maxSearchRequests;
    this.maxDownloadRequests = maxDownloadRequests;
    this.searchRequests = 0;
    this.downloadRequests = 0;
    this.name = 'DuckDuckGo Images';
    // The endpoint is unofficial. Serial requests avoid hammering it and make
    // Railway jobs less likely to trigger datacenter-IP throttling.
    this.maxConcurrency = 1;
  }

  async request(url, options, kind) {
    const counter = kind === 'download' ? 'downloadRequests' : 'searchRequests';
    const maximum = kind === 'download' ? this.maxDownloadRequests : this.maxSearchRequests;
    if (this[counter] >= maximum) throw new Error(`DuckDuckGo ${kind} request limit of ${maximum} was reached.`);
    this[counter] += 1;
    const response = await this.fetcher(url, options, this.timeoutMs);
    if ([403, 429].includes(response.status)) throw new Error(`DuckDuckGo ${kind} blocked with HTTP ${response.status}; no aggressive retry will be attempted.`);
    if (!response.ok) throw new Error(`DuckDuckGo ${kind} returned HTTP ${response.status}.`);
    return response;
  }

  async search(query) {
    const literalFoodSubject = foodSubjectFromQuery(query);
    if (literalFoodSubject) {
      try {
        const commonsUrl = new URL(COMMONS_API_URL);
        const isolatedStyleSearch = /\b(?:isolated|white background|product photo|single food)\b/i.test(String(query || ''));
        const commonsSearch = isolatedStyleSearch ? `${literalFoodSubject} white background` : literalFoodSubject;
        for (const [key, value] of Object.entries({ action: 'query', generator: 'search', gsrsearch: commonsSearch, gsrnamespace: '6', gsrlimit: '24', prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '2000', format: 'json', origin: '*' })) commonsUrl.searchParams.set(key, value);
        const commonsResponse = await this.request(commonsUrl, { headers: { 'User-Agent': COMMONS_USER_AGENT, Accept: 'application/json' } }, 'search');
        const commonsPayload = await commonsResponse.json();
        const subjectWords = normalizedWords(literalFoodSubject);
        const commonsCandidates = Object.values(commonsPayload.query?.pages || {}).flatMap((page, position) => {
          const info = page.imageinfo?.[0];
          const title = String(page.title || '').replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '').replaceAll('_', ' ');
          const titleWords = new Set(normalizedWords(title));
          if (!info?.url || !Number.isFinite(Number(info.width)) || !Number.isFinite(Number(info.height)) || !/^image\/(?:jpeg|png|webp)$/i.test(String(info.mime || ''))) return [];
          if (!subjectWords.every(word => titleWords.has(word) || [...titleWords].some(titleWord => titleWord.startsWith(word) || word.startsWith(titleWord)))) return [];
          const license = String(info.extmetadata?.LicenseShortName?.value || 'Wikimedia Commons');
          return [{
            id: createHash('sha256').update(String(info.url)).digest('hex'), provider: this.name, providerSource: 'Wikimedia Commons',
            width: Number(info.width), height: Number(info.height), alt: `${literalFoodSubject} photograph - ${title}`, title: `${literalFoodSubject} photograph - ${title}`, keywords: `${literalFoodSubject} food photograph`,
            originalImageUrl: info.url, downloadUrl: info.url, thumbnailUrl: info.thumburl || null,
            sourcePageUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`, sourceDomain: 'commons.wikimedia.org', photoUrl: info.descriptionurl || null,
            photographer: 'Wikimedia Commons contributor', photographerUrl: info.descriptionurl || null,
            license, licenseUrl: info.extmetadata?.LicenseUrl?.value || null, usageRights: `${license}; verify attribution on the source page`, credit: null,
            sha256: null, mimeType: info.mime, position,
          }];
        });
        if (commonsCandidates.length >= (isolatedStyleSearch ? 1 : 5)) return commonsCandidates;
      } catch {
        // Commons is a quality-first FOOD pass, not a new point of failure. The existing bounded
        // DuckDuckGo search below remains the recovery path when it is unavailable or too sparse.
      }
    }
    const searchUrl = new URL(DUCKDUCKGO_SEARCH_URL);
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('iax', 'images');
    searchUrl.searchParams.set('ia', 'images');
    const searchResponse = await this.request(searchUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } }, 'search');
    const html = await searchResponse.text();
    if (BLOCK_PATTERN.test(html)) throw new Error('DuckDuckGo image search returned a CAPTCHA or blocking page.');
    const vqd = VQD_PATTERNS.map(pattern => html.match(pattern)?.[1]).find(Boolean);
    if (!vqd) throw new Error('DuckDuckGo image search did not return its required request token (possibly blocked).');

    const imagesUrl = new URL(DUCKDUCKGO_IMAGES_URL);
    imagesUrl.searchParams.set('l', 'us-en');
    imagesUrl.searchParams.set('o', 'json');
    imagesUrl.searchParams.set('q', query);
    imagesUrl.searchParams.set('vqd', vqd);
    imagesUrl.searchParams.set('f', ',,,,,');
    imagesUrl.searchParams.set('p', '1');
    const imagesResponse = await this.request(imagesUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: searchUrl.toString() } }, 'search');
    const body = await imagesResponse.text();
    if (BLOCK_PATTERN.test(body)) throw new Error('DuckDuckGo image results returned a CAPTCHA or blocking page.');
    let payload;
    try { payload = JSON.parse(body); } catch { throw new Error('DuckDuckGo image results were not valid JSON (possibly blocked).'); }
    return (payload.results || []).flatMap((result, position) => {
      const width = Number(result.width); const height = Number(result.height);
      if (!result.image || !result.url || !Number.isFinite(width) || !Number.isFinite(height)) return [];
      return [{
        id: candidateId(result), provider: this.name, providerSource: result.source || 'web-wide index',
        width, height, alt: String(result.title || ''), title: String(result.title || ''), keywords: String(result.title || ''),
        originalImageUrl: result.image, downloadUrl: result.image, thumbnailUrl: result.thumbnail || null,
        sourcePageUrl: result.url, sourceDomain: sourceDomain(result.url), photoUrl: result.url,
        photographer: 'Unknown', photographerUrl: null,
        license: 'unknown', licenseUrl: null, usageRights: 'unknown — verify with the source owner before reuse', credit: null,
        sha256: null, mimeType: result.encoding_format || null, position,
      }];
    });
  }

  async downloadAsset(candidate, destination) {
    let response; let lastError;
    const assetUrl = candidate.sourceDomain === 'commons.wikimedia.org' && candidate.thumbnailUrl
      ? candidate.thumbnailUrl
      : candidate.downloadUrl;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const commonsAsset = candidate.sourceDomain === 'commons.wikimedia.org';
        response = await this.request(assetUrl, { headers: { 'User-Agent': commonsAsset ? COMMONS_USER_AGENT : USER_AGENT, Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8', ...(commonsAsset ? {} : { Referer: candidate.sourcePageUrl || DUCKDUCKGO_SEARCH_URL }) } }, 'download');
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2 && /HTTP 429|timed out/i.test(error.message)) await new Promise(resolve => setTimeout(resolve, 350));
      }
    }
    if (!response) throw lastError;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) throw new Error(`Unexpected web image content type: ${contentType || 'unknown'}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 10_000) throw new Error(`Downloaded web image is suspiciously small (${bytes.length} bytes).`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    return destination;
  }
}

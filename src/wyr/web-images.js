import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchWithTimeout } from './utils.js';

const DUCKDUCKGO_SEARCH_URL = 'https://duckduckgo.com/';
const DUCKDUCKGO_IMAGES_URL = 'https://duckduckgo.com/i.js';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BLOCK_PATTERN = /captcha|verify you are human|unusual traffic|automated quer(?:y|ies)|anomaly-modal|challenge-platform/i;
const VQD_PATTERNS = [/vqd=["']([^"']+)/i, /vqd=([\d-]+)/i];
const sourceDomain = value => { try { return new URL(value).hostname.toLowerCase(); } catch { return 'unknown'; } };
const candidateId = result => String(result.image_token || createHash('sha256').update(String(result.image || '')).digest('hex'));

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
    const response = await this.request(candidate.downloadUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8', Referer: candidate.sourcePageUrl || DUCKDUCKGO_SEARCH_URL } }, 'download');
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) throw new Error(`Unexpected web image content type: ${contentType || 'unknown'}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 10_000) throw new Error(`Downloaded web image is suspiciously small (${bytes.length} bytes).`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    return destination;
  }
}

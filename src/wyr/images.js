import fs from 'node:fs';
import path from 'node:path';
import { fetchWithTimeout, retry } from './utils.js';

export class ImageProvider { async search() { throw new Error('ImageProvider.search must be implemented.'); } async downloadAsset() { throw new Error('ImageProvider.downloadAsset must be implemented.'); } }
export class PexelsImageProvider extends ImageProvider {
  constructor({ apiKey, timeoutMs }) { super(); this.apiKey = apiKey; this.timeoutMs = timeoutMs; }
  async search(query) {
    const url = new URL('https://api.pexels.com/v1/search'); url.searchParams.set('query', query); url.searchParams.set('per_page', '40'); url.searchParams.set('orientation', 'landscape');
    const response = await fetchWithTimeout(url, { headers: { Authorization: this.apiKey } }, this.timeoutMs);
    if (!response.ok) throw new Error(`Pexels search returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const payload = await response.json();
    return (payload.photos || []).map((photo, position) => ({ id: String(photo.id), width: Number(photo.width), height: Number(photo.height), alt: String(photo.alt || ''), photographer: photo.photographer, photographerUrl: photo.photographer_url, photoUrl: photo.url, downloadUrl: photo.src?.original || photo.src?.large2x || photo.src?.large, position })).filter(candidate => candidate.downloadUrl && candidate.width > 0 && candidate.height > 0);
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
const queryWords = query => new Set(query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(word => word.length > 2));
const scoreCandidate = (candidate, query) => {
  const targetRatio = 750 / 450; const ratio = candidate.width / candidate.height;
  const cropScore = Math.max(0, 25 - Math.abs(Math.log(ratio / targetRatio)) * 18);
  const resolutionScore = Math.min(35, Math.min(candidate.width / 1600, candidate.height / 900) * 25);
  const words = queryWords(query); const alt = candidate.alt.toLowerCase(); const relevanceScore = [...words].filter(word => alt.includes(word)).length * 8;
  return cropScore + resolutionScore + relevanceScore + Math.max(0, 30 - candidate.position * 1.2);
};
const rewriteQuery = (query, optionText, attempt) => {
  const words = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (attempt === 1) return [...new Set(words.filter(word => !['luxury', 'beautiful', 'amazing', 'photo'].includes(word)))].slice(0, 5).join(' ');
  const optionWords = optionText.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(word => word.length > 2 && !['would', 'rather', 'every', 'always', 'have', 'your'].includes(word));
  return [...new Set([...words.slice(0, 2), ...optionWords])].slice(0, 5).join(' ');
};
export const findAndDownloadImages = async ({ plan, provider, assetsDir, maxRetries, onProgress }) => {
  const used = new Set(); const selections = [];
  const options = plan.questions.flatMap(question => [{ questionIndex: question.index, slot: 'A', ...question.optionA }, { questionIndex: question.index, slot: 'B', ...question.optionB }]);
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]; let selected; let finalQuery = option.searchQuery; const searchAttempts = [];
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      finalQuery = attempt === 0 ? option.searchQuery : rewriteQuery(option.searchQuery, option.text, attempt);
      if (!finalQuery) continue;
      const candidates = await retry(() => provider.search(finalQuery), { attempts: 2, label: `image search for "${finalQuery}"` });
      const usable = candidates.filter(candidate => !used.has(candidate.id) && Math.min(candidate.width, candidate.height) >= 900 && Math.max(candidate.width, candidate.height) >= 1600);
      selected = usable.sort((left, right) => scoreCandidate(right, finalQuery) - scoreCandidate(left, finalQuery))[0];
      searchAttempts.push({ attempt: attempt + 1, query: finalQuery, candidates: candidates.length, usableCandidates: usable.length, selectedId: selected?.id || null });
      if (selected) break;
    }
    if (!selected) throw new Error(`No acceptable unique image found for question ${option.questionIndex + 1}, option ${option.slot} after ${maxRetries + 1} search attempt(s).`);
    used.add(selected.id);
    const filename = `q${String(option.questionIndex + 1).padStart(2, '0')}-${option.slot.toLowerCase()}-${selected.id}.jpg`; const localPath = path.join(assetsDir, filename);
    await provider.downloadAsset(selected, localPath);
    selections.push({ ...option, queryUsed: finalQuery, searchAttempts, provider: 'Pexels', ...selected, localPath, filename }); onProgress?.(index + 1, options.length);
  }
  return selections;
};

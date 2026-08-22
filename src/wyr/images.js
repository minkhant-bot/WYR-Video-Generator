import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fetchWithTimeout, log, mapWithConcurrency, retry, writeJsonAtomic } from './utils.js';
import { assertFontAvailable, resolveFfmpegPath } from './runtime.js';
import { computeSubjectAwareCrop } from './framing.js';
import { WYR_TEMPLATE } from './template.js';
import { coreSubjectWords, NON_VISUAL_MODIFIER_WORDS } from './image-query.js';

export class ImageProvider { async search() { throw new Error('ImageProvider.search must be implemented.'); } async downloadAsset() { throw new Error('ImageProvider.downloadAsset must be implemented.'); } }
export class PexelsImageProvider extends ImageProvider {
  constructor({ apiKey, timeoutMs }) { super(); this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.name = 'Pexels'; }
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
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'at', 'with', 'for', 'your', 'you', 'become', 'be', 'own', 'have', 'anywhere', 'through', 'instantly', 'take', 'takes', 'taking', 'win', 'wins', 'winning', 'everywhere', 'every', 'price', 'prices', 'priced', 'limit', 'limits', 'limited', 'unlimited', 'cost', 'costs']);
const VISUAL_EXPANSIONS = Object.freeze({
  minds: ['telepathy', 'brain', 'thoughts'], mind: ['telepathy', 'brain', 'thoughts'], read: ['reading'], future: ['fortune', 'crystal', 'vision'],
  // "disappearing" removed as an invisibility alias/evidence word (below and in visualIntentGroups):
  // it's a common, loosely-associated word in generic dramatic/fantasy "transformation" art (see the
  // "fantasy portrait woman disappearing ghostly transformation art" candidate that wrongly passed
  // for "Turn invisible instantly") that doesn't actually depict transparency/invisibility. "invisible"
  // /"invisibility"/"transparent" remain -- if no candidate genuinely shows one of those, the slot
  // correctly falls through to the existing question-replacement flow instead of accepting a vague
  // fantasy-art match.
  teleport: ['teleportation', 'portal', 'gateway'], invisible: ['invisibility', 'transparent'], invisibility: ['invisible', 'transparent'],
  time: ['clock', 'temporal', 'vortex'], stop: ['stopped', 'frozen', 'freeze'], travel: ['traveler', 'journey'], dragon: ['fantasy', 'creature'], befriend: ['friendly', 'interacting'], portal: ['fantasy', 'doorway', 'gateway'], door: ['doorway', 'portal'],
  strangers: ['people', 'person', 'human'], bank: ['money', 'financial', 'wealth'], balance: ['account', 'money', 'wealth'],
  // "rainforest" is an unambiguous biome noun (unlike a proper-noun geographic qualifier such as
  // "Amazon", which is left untouched here since it also names an unrelated company and is rarely
  // used as an image-provider tag even for genuine Amazon-rainforest photos) -- real stock-photo alt
  // text/tags for a rainforest scene routinely say "jungle" or "tropical" instead of the literal
  // word "rainforest" itself. This is what let a real treehouse-in-jungle/tropical-forest photo
  // clear the dominant-subject gate for "Live in a treehouse in the Amazon rainforest forever"
  // (reproduced from the live Railway IMAGE_SELECTION_EXHAUSTED diagnostics -- see images.test.js).
  rainforest: ['jungle', 'tropical'],
  // Abstract financial/change verbs -- a real photo can never literally BE "doubled" or "grows",
  // but it can genuinely show growth/savings/shopping imagery, so these are matchable via a
  // concrete synonym (exactly like "double"/"bank"/"balance" above) instead of ever being counted
  // as a required-but-unmatchable literal word. This is what let a real "savings" photo finally
  // clear the dominant-subject/relevance gates for the live Railway option "savings doubled
  // today" (which kept "doubled" as a required word, unlike "today" -- see
  // NON_VISUAL_MODIFIER_WORDS in image-query.js for words dropped outright instead) and a
  // "shopping/spending" photo for "spend freely grows". Listed as first-alias-first so
  // firstVisualSynonym (used to build a concrete-concept search query) picks the most literal noun.
  double: ['growth', 'doubling', 'multiply', 'multiplying'], doubles: ['growth', 'doubling', 'multiply', 'multiplying'],
  doubled: ['growth', 'doubling', 'multiply', 'multiplying'], doubling: ['growth', 'double', 'multiply', 'multiplying'],
  grow: ['growth', 'increase', 'rising'], grows: ['growth', 'increase', 'rising'], growing: ['growth', 'increase', 'rising'], grew: ['growth', 'increase', 'rising'], grown: ['growth', 'increase', 'rising'],
  increase: ['growth', 'rising', 'money'], increases: ['growth', 'rising', 'money'], increasing: ['growth', 'rising', 'money'], increased: ['growth', 'rising', 'money'],
  multiply: ['multiplying', 'doubling', 'growth'], multiplies: ['multiplying', 'doubling', 'growth'], multiplying: ['multiply', 'doubling', 'growth'], multiplied: ['multiply', 'doubling', 'growth'],
  spend: ['shopping', 'spending', 'cash'], spends: ['shopping', 'spending', 'cash'], spending: ['shopping', 'cash', 'purchase'], spent: ['shopping', 'spending', 'cash'],
  save: ['savings', 'bank', 'piggybank'], saves: ['savings', 'bank', 'piggybank'], saving: ['savings', 'bank', 'piggybank'], saved: ['savings', 'bank', 'piggybank'],
  earn: ['income', 'salary', 'money'], earns: ['income', 'salary', 'money'], earning: ['income', 'salary', 'money'], earned: ['income', 'salary', 'money'],
  // "paid" alone (e.g. "Get paid daily, small amounts" / "Get paid yearly, one lump") never
  // literally appears in a stock photo's tags -- the genuine visual concept is money/cash/a
  // paycheck, exactly like "earn"/"save"/"spend" above. Without this alias, PURE_FILLER_WORDS
  // removing "daily"/"small"/"amounts"/"yearly"/"one"/"lump" from the dominant-subject list left
  // "paid" as the sole literal requirement, which no real payment photo is ever tagged with.
  paid: ['money', 'cash', 'paycheck'], pay: ['money', 'cash', 'paycheck'], pays: ['money', 'cash', 'paycheck'], paying: ['money', 'cash', 'paycheck'],
  // "city" is a real, literal word real stock photos ARE tagged with, but provider alt text just as
  // often says "urban" or names a "street"/"downtown" scene instead -- this only matters once city
  // is the option's ONLY meaningful subject (e.g. "Get lost in a new city", after PURE_FILLER_WORDS
  // removes "lost"/"new"), where the literal word alone was too narrow a requirement.
  city: ['urban', 'street', 'downtown'],
  // "flight(s)" and "flying" don't share a stem ("flight" vs "fly"), so a genuine airplane photo
  // tagged "airplane flying" or "passenger plane" would otherwise never match the literal word
  // "flight(s)" required by the option text -- paired with the new flight/flights visualIntentGroups
  // entry above (requiring actual airplane/aircraft/airport evidence), this lets a real airplane
  // photo pass while a paraglider/hang-glider "flight" still fails that stricter intent check.
  flight: ['airplane', 'plane', 'flying'], flights: ['airplane', 'plane', 'flying'],
});
// The single most literal, search-friendly synonym for a word (falls back to the word itself when
// there's no mapping, so a concrete noun like "savings" or "treehouse" passes through unchanged).
// Used to build a concrete-concept search query variant for abstract option text -- see
// image-picker.js's selectionQueries/broadenedSubjectQueries -- WITHOUT ever touching the option
// text shown on screen.
export const firstVisualSynonym = word => VISUAL_EXPANSIONS[word]?.[0] || word;
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
  // These literal/cinematic framings apply to every concept, not just the ~15 hardcoded phrase
  // groups above — most real options (e.g. "infinite passive income", "personal drone farm") never
  // match a hardcoded group, and without this pack they only ever got the raw supplied/optionWords
  // query, which is often too abstract for Pexels/Pixabay to return a literal, relevant photo for.
  const literalPack = optionWords.length ? [
    `${optionWords.slice(0, 5).join(' ')} cinematic visual scene`,
    `${optionWords.slice(0, 5).join(' ')} literal scene photograph`,
    `person experiencing ${optionWords.slice(0, 5).join(' ')} cinematic`,
    `${optionWords.slice(0, 4).join(' ')} real photo`,
  ] : [];
  return [...new Set([
    ...visualQueries,
    supplied.slice(0, 7).join(' '),
    optionWords.slice(0, 5).join(' '),
    expanded.slice(0, 7).join(' '),
    ...literalPack,
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
const HARD_FORMAT_PATTERN = /\b(article|news|blog|thumbnail|video|youtube|watch|screenshot|website|browser|app|user interface|dashboard|infographic|poster|banner|ad|advertisement|promotional?|promo|quote card|quote poster|meme|template|job listing|careers?|marketplace|auction|product listing|product page|shop|listing|play button|stream)\b/gi;
// Flat/schematic non-photographic art -- WEAK_VISUAL_PATTERN below only ever nudges the SCORE down
// for these, never actually blocks acceptance (reviewUsable/accepted don't consult
// pexelsQualityPassed), which let an "illustration graphic" candidate for "Read minds instantly"
// pass with zero rejection reasons. Deliberately narrow: catches flat/vector/hand-drawn/schematic
// art styles only -- "digital art"/"concept art"/"3d render"/"artwork"/"fantasy art" are left alone,
// since those remain the only kind of imagery that can ever exist for genuinely fantasy-coded
// subjects (dragon, unicorn, teleportation portal) that this pipeline already relies on finding.
const ILLUSTRATION_ART_PATTERN = /\b(illustration|illustrated|clip[ -]?art|cartoon|line art|line drawing|vector art|vector graphic)\b/i;
const HARD_DOMAIN_PATTERN = /(^|\.)(etsy|scale\.jobs|jobs|careers|marketplace|auction|auctions|01net|cbs8)(\.|$)|(^|\.)(auctions\.)?yahoo\.co\.jp$/i;
const HARD_LAYOUT_PATTERN = /\b(card layout|text graphic|text-heavy|text heavy|graphic design|social post|press release|promo image|article image)\b/i;
const WEAK_VISUAL_PATTERN = /\b(clip[ -]?art|simple icon|flat icon|vector icon|line icon|silhouette icon|button icon|symbol icon|diagram|infographic|isolated product|product shot|corporate illustration|generic illustration|generic stock|wallet|calculator|credit card|bank card|card reader|brain model|brain in (?:a )?box)\b/i;
const GENERIC_TECH_ABSTRACTION_PATTERN = /\b(cloud icon|upload icon|download icon|gear icon|network icon|circuit board|abstract technology|digital network|data flow|binary code|matrix code|generic technology|tech background|futuristic background|abstract background|glowing network|node network|connection lines|abstract data|generic diagram|flowchart|pie chart|bar chart|symbol only|isolated symbol|generic symbol)\b/i;
const CORPORATE_WEAK_PATTERN = /\b(corporate|business meeting|office team|businessman at desk|finance illustration|corporate stock|generic office|financial presentation)\b/i;
const IMPACT_PATTERN = /\b(cinematic|dramatic|glowing|neon|vibrant|surreal|fantasy|fantasy art|concept art|digital art|3d render|artwork|portal|gateway|vortex|frozen|shattered|massive|luxury|action|transformation|multiplying|doubling)\b/gi;

// Ranking-only semantic signal (see computeSemanticRankAdjustment below): folded ONLY into
// finalScore, which never appears in a rejectionReasons check -- accepted/hardRejected keep
// depending exclusively on relevanceScore/coreCoverage/dominantCoverage/intentCoverage/
// spendSaveConflict, exactly as before. This never rejects a technically-valid candidate; it only
// changes which already-valid candidate wins sortPool's ordering (image-picker.js), addressing
// "technically valid but semantically weak/misleading" picks (a flower/cat/nature photo for an
// unrelated wardrobe/accessory option, a generic arrow graphic for "rewind time") without touching
// any acceptance threshold.
const GENERIC_OFFTOPIC_NATURE_PATTERN = /\b(flower\w*|floral|petal\w*|blossom\w*|bouquet|leaf|leaves|foliage|houseplant|succulent)\b/;
const GENERIC_ANIMAL_PATTERN = /\b(cat|kitten|kitty|dog|puppy|bird|birds|wildlife|squirrel|butterfly|rabbit|bunny)\b/;
const GENERIC_ARROW_SYMBOL_PATTERN = /\b(arrow|arrows|directional\s+sign|road\s+sign)\b/;
const ABSTRACT_METAPHOR_PATTERN = /\b(abstract|conceptual|metaphor\w*|symbolic)\b/;
const HUMAN_EVIDENCE_PATTERN = /\b(person|people|man|men|woman|women|girl|boy|human|couple|friends|family|group)\b/;
const GROUP_EVIDENCE_PATTERN = /\b(friends|group|team|together|couple|crowd|people)\b/;
const PHOTOGRAPHIC_EVIDENCE_PATTERN = /\b(photo|photograph|photography|candid)\b/;
const NON_PHOTOGRAPHIC_EVIDENCE_PATTERN = /\b(render|rendering|cgi|digital\s+art|3d\s+model|painting|drawing)\b/;
// Verbs whose CORE meaning is a visible human action -- when the option itself asks for one of
// these, a candidate that actually shows a person doing it is a stronger, more immediately-
// recognizable match than an equally "on-keyword" object-only or scenery-only shot.
const HUMAN_ACTION_VERBS = new Set(['wear', 'wears', 'wearing', 'ride', 'rides', 'riding', 'cycle', 'cycles', 'cycling', 'walk', 'walks', 'walking', 'dance', 'dances', 'dancing', 'hug', 'hugs', 'hugging', 'kiss', 'kisses', 'kissing', 'hold', 'holds', 'holding', 'carry', 'carries', 'carrying', 'drive', 'drives', 'driving', 'swim', 'swims', 'swimming', 'run', 'runs', 'running', 'sing', 'sings', 'singing', 'eat', 'eats', 'eating', 'drink', 'drinks', 'drinking']);
// Explicit multi-person context: an option naming friends/family/group/together implies the
// candidate should show more than one person, not a single isolated subject.
const GROUP_CONTEXT_WORDS = new Set(['friends', 'friend', 'family', 'group', 'team', 'together', 'crowd', 'partner', 'couple']);
const computeSemanticRankAdjustment = (optionWords, searchableText) => {
  let adjustment = 0;
  // Off-topic filler imagery (flowers, generic animals, arrows, abstract/metaphorical art) is only
  // penalized when the OPTION's own words never actually call for it, so a genuine "explore a
  // garden"/"pet a cat"/"rewind time" (if ever literally about an arrow) option is unaffected.
  if (GENERIC_OFFTOPIC_NATURE_PATTERN.test(searchableText) && !optionWords.some(word => GENERIC_OFFTOPIC_NATURE_PATTERN.test(word))) adjustment -= 22;
  if (GENERIC_ANIMAL_PATTERN.test(searchableText) && !optionWords.some(word => GENERIC_ANIMAL_PATTERN.test(word))) adjustment -= 22;
  if (GENERIC_ARROW_SYMBOL_PATTERN.test(searchableText) && !optionWords.some(word => GENERIC_ARROW_SYMBOL_PATTERN.test(word))) adjustment -= 18;
  if (ABSTRACT_METAPHOR_PATTERN.test(searchableText) && !optionWords.some(word => ABSTRACT_METAPHOR_PATTERN.test(word))) adjustment -= 14;
  // Human action / recognizable-subject and group-context bonuses.
  if (optionWords.some(word => HUMAN_ACTION_VERBS.has(word)) && HUMAN_EVIDENCE_PATTERN.test(searchableText)) adjustment += 12;
  if (optionWords.some(word => GROUP_CONTEXT_WORDS.has(word))) adjustment += GROUP_EVIDENCE_PATTERN.test(searchableText) ? 12 : -10;
  // Mild photographic-realism preference: illustration/fantasy-art is handled elsewhere and never
  // hard-rejected for fantasy content -- this only nudges a real photo above an otherwise-equal
  // render/CGI/painting result.
  if (PHOTOGRAPHIC_EVIDENCE_PATTERN.test(searchableText)) adjustment += 6;
  else if (NON_PHOTOGRAPHIC_EVIDENCE_PATTERN.test(searchableText)) adjustment -= 6;
  return adjustment;
};

export const PEXELS_MINIMUM_QUALITY = 72;
const MAX_RANKED_CANDIDATES = 8;
export const IMAGE_SELECTION_DEFAULTS = Object.freeze({ providerOrder: ['DuckDuckGo Images', 'Pexels'], minimumWidth: 750, minimumHeight: 450, pexelsQualityThreshold: PEXELS_MINIMUM_QUALITY, maxRankedCandidates: MAX_RANKED_CANDIDATES, minimumFinalScore: 62, minimumCandidateMargin: 4 });
export const IMAGE_RECOVERY_DEFAULTS = Object.freeze({ alternateQueryRounds: 3, maxProviderRequests: 24, maxWallClockMs: 45_000 });
const candidateKeys = candidate => uniqueWords([candidate.provider && candidate.id ? `id:${candidate.provider}:${candidate.id}` : '', candidate.originalImageUrl ? `url:${candidate.originalImageUrl}` : '', candidate.downloadUrl ? `url:${candidate.downloadUrl.split('?')[0]}` : '', candidate.sha256 ? `sha256:${candidate.sha256}` : ''].filter(Boolean));
const fileHash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const optionConcepts = option => uniqueWords(normalizeWords(option.text).flatMap(word => [word, ...(VISUAL_EXPANSIONS[word] || [])]));
const containsAny = (tokens, words) => words.some(word => tokens.has(word));
// Minimal suffix stemming, used ONLY for the dominant-subject match below -- real provider alt
// text/tags routinely use a different inflection than the option text ("riding"/"rider",
// "train"/"trains"), and exact-string matching would otherwise force a real, on-subject photo to
// fail the same gate meant to catch genuinely wrong subjects. Words of length <=4 are left alone to
// avoid over-stemming short, already-ambiguous words (e.g. "car", "day").
const stem = word => {
  if (word.length <= 4) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  let base = word;
  if (base.endsWith('ing') || base.endsWith('ers')) base = base.slice(0, -3);
  else if (base.endsWith('er') || base.endsWith('ed') || base.endsWith('es')) base = base.slice(0, -2);
  else if (base.endsWith('s')) base = base.slice(0, -1);
  // Collapses a doubled final consonant left behind by suffix removal (e.g. "shopping" -> "shopp"
  // -> "shop", "running" -> "runn" -> "run") so a candidate's inflected form still stem-matches the
  // option text's word ("shop"/"shopping"), the same class of gap as "train"/"trains".
  if (base.length > 3 && base[base.length - 1] === base[base.length - 2] && !'aeiou'.includes(base[base.length - 1])) base = base.slice(0, -1);
  return base;
};
const visualIntentGroups = option => {
  const words = normalizeWords(option.text); const has = word => words.includes(word);
  const groups = [];
  if (has('minds') || has('mind')) groups.push(['person', 'people', 'human', 'head', 'face'], ['telepathy', 'telepathic', 'thoughts', 'mind', 'brain', 'psychic'], ['two', 'another', 'others', 'connection', 'connected', 'communication', 'telepathy', 'telepathic']);
  else if (has('double') && (has('bank') || has('balance'))) groups.push(['money', 'cash', 'wealth', 'bank', 'account', 'balance']);
  else if (has('future')) groups.push(['person', 'people', 'human', 'man', 'woman', 'teller', 'seer'], ['future', 'vision', 'crystal', 'scrying', 'prophecy']);
  else if (has('teleport')) groups.push(['person', 'people', 'figure', 'human', 'man', 'woman', 'silhouette'], ['portal', 'gateway', 'teleport', 'teleportation']);
  else if (has('invisible') || has('invisibility')) groups.push(['person', 'people', 'human', 'man', 'woman', 'clothes', 'body'], ['invisible', 'invisibility', 'transparent']);
  else if (has('stop') && has('time')) groups.push(['time', 'clock', 'city', 'people', 'person'], ['frozen', 'freeze', 'stopped', 'suspended', 'shattered']);
  else if (has('travel') && has('time')) groups.push(['person', 'people', 'traveler', 'man', 'woman', 'figure', 'machine'], ['time', 'temporal', 'portal', 'vortex']);
  else if (has('dragon')) groups.push(['person', 'people', 'human', 'girl', 'boy', 'man', 'woman', 'princess', 'knight'], ['dragon', 'dragons']);
  else if (has('portal') && has('door')) groups.push(['door', 'doorway', 'gate', 'entrance'], ['world', 'portal', 'dimension', 'realm', 'landscape']);
  else if (has('jet')) groups.push(['jet', 'airplane', 'aircraft', 'plane'], ['sky', 'clouds', 'flight', 'flying']);
  // "flight(s)" alone (unlike "jet" above) has no dedicated evidence requirement, so any candidate
  // merely tagged "flight"/"flying" -- including paragliding, hang-gliding, skydiving, or birds --
  // could satisfy the option's dominant-subject coverage without ever showing an airplane. Requires
  // literal airplane/aircraft/airport evidence, the same distinction images.js's own module comment
  // asks for ("airplane flight vs paragliding").
  else if (has('flight') || has('flights')) groups.push(['airplane', 'plane', 'aircraft', 'jet', 'airport', 'runway']);
  else if (has('yacht')) groups.push(['yacht', 'boat', 'ship', 'vessel'], ['ocean', 'sea', 'water', 'sailing']);
  // 'tree' (singular) and 'jungle'/'rainforest'/'tropical' added to the forest-setting bucket: real
  // provider alt text for a genuine treehouse photo routinely says "built in a large tree" (singular,
  // no stem-matching applied in this gate) or names the specific forest type ("rainforest", "jungle",
  // "tropical") instead of the bare word "forest" -- see images.test.js's treehouse false-rejection
  // case, reproduced from the live Railway IMAGE_SELECTION_EXHAUSTED diagnostics.
  else if (has('treehouse')) groups.push(['treehouse', 'treehouse', 'house'], ['forest', 'trees', 'tree', 'canopy', 'village', 'jungle', 'rainforest', 'tropical']);
  else if (has('mars')) groups.push(['mars', 'planet', 'space', 'astronaut'], ['red', 'landscape', 'surface', 'planet']);
  else if (has('ocean') || has('whale') || has('trench')) groups.push(['ocean', 'sea', 'underwater', 'whale', 'submarine'], ['deep', 'trench', 'marine', 'water', 'dive']);
  else if (has('unicorn')) groups.push(['unicorn', 'horse', 'creature'], ['wish', 'magic', 'fantasy', 'person', 'people']);
  return groups;
};
// Generic container/setting nouns (a "city," a "day," "the world") are real words but not
// visually distinctive subjects on their own -- almost any photo can plausibly be read as
// depicting "a city" or "a day," so letting one satisfy 50% coverage on a 2-word subject (e.g.
// "motorbike city") let a parked-car photo with no motorbike in it pass on "city" alone.
const WEAK_SUBJECT_WORDS = new Set(['city', 'town', 'place', 'area', 'day', 'time', 'world', 'life', 'way', 'thing', 'things']);
// Pure filler words: size/intensity adjectives, frequency/period words, and vague quantity/state
// words that carry NO visual meaning of their own -- unlike WEAK_SUBJECT_WORDS above (a "city" or
// "day" is at least a minimally depictable setting, so it's kept as a last-resort anchor below),
// these can NEVER anchor the dominant-subject requirement, not even when nothing else is left. This
// is the demonstrated root cause behind real production images that matched the wrong subject: "Get
// lost in a new city" reduced to requiring only "lost"/"new" (an animal photo passed by coincidence);
// "Get paid daily, small amounts" / "Get paid yearly, one lump" reduced to "daily"/"small"/"amounts"
// or "yearly"/"one"/"lump" (a generic street/landscape photo passed with zero money imagery); "Big
// house, huge mortgage" let "big"/"huge" alone satisfy 50% coverage with no house ever required.
const PURE_FILLER_WORDS = new Set(['big', 'huge', 'large', 'giant', 'massive', 'small', 'tiny', 'little', 'daily', 'weekly', 'monthly', 'yearly', 'annual', 'annually', 'new', 'old', 'lost', 'one', 'single', 'extra', 'amounts', 'amount', 'lump']);
// The option's DOMINANT, mandatory-to-depict subject noun(s) -- image-query.js's connector-stripped
// literal subject with pure filler words removed first (never usable as the sole requirement, see
// PURE_FILLER_WORDS above), then weak/generic container nouns removed IF a stronger word survives
// (falling back to the container noun, then finally to the unfiltered list, so the requirement stays
// anchored to the most meaningful words actually available). Exported so the image search query
// builder (image-picker.js's Tier-3 broadening) can generate broader queries that are GUARANTEED to
// still satisfy the exact same dominant-subject gate enforced below, instead of drifting onto a
// different, unverified notion of "the subject".
export const dominantSubjectWordsFor = optionText => {
  const rawDominantSubjectWords = coreSubjectWords(optionText);
  const meaningfulWords = rawDominantSubjectWords.filter(word => !PURE_FILLER_WORDS.has(word));
  const strongSubjectWords = meaningfulWords.filter(word => !WEAK_SUBJECT_WORDS.has(word));
  if (strongSubjectWords.length) return strongSubjectWords;
  if (meaningfulWords.length) return meaningfulWords;
  return rawDominantSubjectWords;
};
const explicitVisualIntent = (option, tokens) => visualIntentGroups(option).every(group => containsAny(tokens, group));
const visualIntentCoverage = (option, tokens) => { const groups = visualIntentGroups(option); return groups.length ? groups.filter(group => containsAny(tokens, group)).length / groups.length : 1; };
const clampScore = value => Math.max(0, Math.min(100, Math.round(value * 10) / 10));
export const assessImageCandidate = (candidate, option) => {
  const rejectionReasons = []; const assetRejectionReasons = [];
  if (!candidate?.id || !candidate.downloadUrl) assetRejectionReasons.push('missing provider ID or image URL');
  if (!Number.isFinite(candidate?.width) || !Number.isFinite(candidate?.height) || candidate.width < 750 || candidate.height < 450) assetRejectionReasons.push('image is too small for the 750x450 slot');
  const searchableText = `${candidateText(candidate)} ${candidate.keywords || ''} ${candidate.downloadUrl || ''} ${candidate.originalImageUrl || ''} ${candidate.sourcePageUrl || ''}`;
  const sourceDomain = String(candidate.sourceDomain || '').toLowerCase();
  const hardFormatEvidence = `${searchableText} ${sourceDomain}`;
  const hardRejectionReasons = [];
  if (!Number.isFinite(candidate?.width) || !Number.isFinite(candidate?.height) || candidate.width < 750 || candidate.height < 450) hardRejectionReasons.push('hard-rejected: low-resolution or corrupt candidate (too small for the 750x450 slot)');
  const hardFormatMatches = [...hardFormatEvidence.matchAll(HARD_FORMAT_PATTERN)].map(match => match[0].toLowerCase());
  const hardLayoutMatch = hardFormatEvidence.match(HARD_LAYOUT_PATTERN)?.[0]?.toLowerCase();
  if (hardFormatMatches.length || hardLayoutMatch) hardRejectionReasons.push(`hard-rejected: candidate metadata indicates ${[...new Set([...hardFormatMatches, hardLayoutMatch].filter(Boolean))].join(', ')} / text-heavy or promotional format`);
  const illustrationMatch = hardFormatEvidence.match(ILLUSTRATION_ART_PATTERN)?.[0]?.toLowerCase();
  if (illustrationMatch) hardRejectionReasons.push(`hard-rejected: candidate is flat/vector/hand-drawn art (${illustrationMatch}), not a real photograph`);
  if (HARD_DOMAIN_PATTERN.test(sourceDomain)) hardRejectionReasons.push(`hard-rejected: high-risk source domain ${sourceDomain}`);
  if (WATERMARK_PATTERN.test(hardFormatEvidence) || WATERMARK_HOST_PATTERN.test(sourceDomain)) hardRejectionReasons.push('hard-rejected: obvious watermark or stock-preview source');
  rejectionReasons.push(...hardRejectionReasons);
  if (hardRejectionReasons.length) return { accepted: false, hardRejected: true, hardRejectionReasons, formatPass: false, validAsset: assetRejectionReasons.length === 0, relevanceScore: 0, qualityScore: 0, finalScore: 0, conceptClarity: 0, specificity: 0, visualImpact: 0, wyrSuitability: 0, pexelsQualityPassed: false, pexelsQualityReasons: hardRejectionReasons, rejectionReasons, matchedConcepts: [] };
  if (WATERMARK_PATTERN.test(searchableText) || WATERMARK_HOST_PATTERN.test(String(candidate.sourceDomain || ''))) assetRejectionReasons.push('obvious stock or website watermark risk detected');
  if (UNSUITABLE_SOURCE_HOST_PATTERN.test(String(candidate.sourceDomain || ''))) assetRejectionReasons.push('candidate source is likely a UI thumbnail or merchandise result');
  if (UI_OR_TEXT_PATTERN.test(searchableText) || SOURCE_QUALITY_PATTERN.test(searchableText)) assetRejectionReasons.push('candidate appears to be a meme, infographic, screenshot, UI, ad, template, or text-dominated graphic');
  if (MISLEADING_CONTEXT_PATTERN.test(searchableText)) assetRejectionReasons.push('candidate describes merchandise or a misleading unrelated context');
  if (INAPPROPRIATE_PATTERN.test(searchableText)) assetRejectionReasons.push('candidate appears inappropriate or sexualized');
  rejectionReasons.push(...assetRejectionReasons);
  const concepts = optionConcepts(option); const textTokens = new Set(normalizeWords(candidateText(candidate))); const allTokens = new Set([...textTokens, ...normalizeWords(candidate.keywords)]);
  const textStems = new Set([...textTokens].map(stem)); const allStems = new Set([...allTokens].map(stem));
  // Stem-aware (see `stem` above): a candidate's inflected wording ("riding"/"flying"/"trains")
  // still counts as matching the option text's own form ("ride"/"fly"/"train") instead of forcing
  // an exact string match that real provider alt text/tags routinely miss.
  const matched = concepts.filter(concept => allTokens.has(concept) || allStems.has(stem(concept)));
  // NON_VISUAL_MODIFIER_WORDS and PURE_FILLER_WORDS excluded here too (not just from the
  // dominant-subject list below): these are pure manner/time adverbs ("today", "freely") or pure
  // filler adjectives/quantity words ("daily", "small", "amounts" -- see PURE_FILLER_WORDS above)
  // that no real photo is ever tagged with, so leaving them in `core` only shrinks coreCoverage for
  // every candidate regardless of how on-subject it is -- e.g. "savings doubled today" previously
  // required matching "today" (an impossible word for coreCoverage) alongside "savings", capping a
  // perfect savings photo's coreCoverage at 2/3 instead of a genuinely achievable 1/1; the same gap
  // left a genuinely on-subject cash/payment photo for "Get paid daily, small amounts" unable to
  // ever clear the relevance-score gate, since "daily"/"small"/"amounts" can never be matched by
  // any real candidate. Concrete nouns are NEVER removed here -- only words with zero possible
  // visual representation.
  const core = normalizeWords(option.text).filter(word => !NON_VISUAL_MODIFIER_WORDS.has(word) && !PURE_FILLER_WORDS.has(word));
  const coreMatched = core.filter(concept => textTokens.has(concept) || textStems.has(stem(concept)) || (VISUAL_EXPANSIONS[concept] || []).some(alias => textTokens.has(alias)));
  const relevance = concepts.length ? matched.length / concepts.length : 0;
  const coreCoverage = core.length ? coreMatched.length / core.length : 0;
  // The DOMINANT subject match: unlike `core` above (every non-stopword in the option text, so an
  // incidental filler word like "luxury" alone can satisfy coreMatched.length>0 for "luxury trains
  // everywhere"), this uses image-query.js's connector-stripped literal subject words (e.g. just
  // ["luxury", "trains"]) and requires at least half of THOSE to actually appear in the candidate's
  // text/tags. This is what stops a technically-valid but wrong-subject image (a sports car for
  // "luxury trains", a parked car for "ride a motorbike") from clearing the relevance gate merely
  // because one unrelated filler word happened to match.
  const dominantSubjectWords = dominantSubjectWordsFor(option.text);
  const dominantMatched = dominantSubjectWords.filter(word => textTokens.has(word) || textStems.has(stem(word)) || (VISUAL_EXPANSIONS[word] || []).some(alias => textTokens.has(alias)));
  const dominantCoverage = dominantSubjectWords.length ? dominantMatched.length / dominantSubjectWords.length : 1;
  const intentGroups = visualIntentGroups(option); const intentCoverage = intentGroups.length ? visualIntentCoverage(option, allTokens) : 1;
  const targetRatio = 750 / 450; const ratio = candidate.width / candidate.height;
  const cropFit = Math.max(0, 1 - Math.abs(Math.log(ratio / targetRatio)) / 1.5);
  const resolution = Math.min(1, Math.min(candidate.width / 1600, candidate.height / 900));
  const weakVisual = WEAK_VISUAL_PATTERN.test(searchableText) || GENERIC_TECH_ABSTRACTION_PATTERN.test(searchableText); const corporateWeak = CORPORATE_WEAK_PATTERN.test(searchableText); const impactMatches = searchableText.match(IMPACT_PATTERN)?.length || 0;
  const relevanceScore = Math.round((coreCoverage * 60 + relevance * 20 + cropFit * 10 + resolution * 8 + Math.max(0, 2 - Number(candidate.position || 0) * 0.08)) * 10) / 10;
  const optionWords = normalizeWords(option.text); const bankGrowthRequired = optionWords.includes('double') && (optionWords.includes('bank') || optionWords.includes('balance'));
  const bankGrowthDepicted = !bankGrowthRequired || containsAny(allTokens, ['big', 'double', 'doubled', 'doubling', 'multiply', 'multiplying', 'increase', 'increasing', 'growth', 'growing', 'overflowing', 'surrounded', 'endless', 'abundance', 'raining', 'falling', 'pile', 'stacks']);
  // Semantic-opposite guard: "spend" and "save" are opposite actions, but a neutral shared object
  // noun (e.g. "coin") can satisfy the generic 50% dominant-subject coverage either way, letting a
  // piggy-bank/savings photo pass for a SPENDING option. Only fires when the option explicitly asks
  // for spending AND the candidate shows save-specific evidence with no spend-specific evidence --
  // a candidate showing neither, or showing genuine spending evidence, is unaffected.
  const spendRequired = ['spend', 'spends', 'spending', 'spent'].some(word => optionWords.includes(word));
  const spendSaveConflict = spendRequired
    && containsAny(allTokens, ['piggybank', 'piggy', 'savings', 'saving', 'jar'])
    && !containsAny(allTokens, ['shopping', 'spending', 'purchase', 'purchasing', 'paying', 'buy', 'buying', 'receipt', 'checkout', 'cart']);
  const conceptClarity = clampScore(coreCoverage * 40 + intentCoverage * 60 - (bankGrowthDepicted ? 0 : 18) - (weakVisual ? 20 : 0));
  const specificity = clampScore(intentCoverage * 65 + Math.min(25, matched.length * 6) + coreCoverage * 10 - (weakVisual ? 32 : 0) - (corporateWeak ? 14 : 0) - (bankGrowthDepicted ? 0 : 28));
  const visualImpact = clampScore(30 + Math.min(36, impactMatches * 9) + cropFit * 16 + resolution * 18 - (weakVisual ? 34 : 0) - (corporateWeak ? 18 : 0));
  const wyrSuitability = clampScore(conceptClarity * 0.42 + specificity * 0.28 + visualImpact * 0.2 + cropFit * 10);
  const qualityScore = clampScore(conceptClarity * 0.34 + specificity * 0.28 + visualImpact * 0.2 + wyrSuitability * 0.18);
  // semanticRankAdjustment (see computeSemanticRankAdjustment above) is folded ONLY into finalScore,
  // the ranking composite sortPool (image-picker.js) sorts by first -- it never appears in
  // rejectionReasons/accepted, so this cannot loosen or tighten what counts as a valid candidate,
  // only which already-valid candidate wins ordering.
  const semanticRankAdjustment = computeSemanticRankAdjustment(optionWords, searchableText);
  const finalScore = clampScore(relevanceScore * 0.42 + conceptClarity * 0.28 + qualityScore * 0.30 + semanticRankAdjustment);
  if (!explicitVisualIntent(option, allTokens) || intentCoverage < 0.67) rejectionReasons.push('candidate does not explicitly represent the required visual intent');
  if (coreMatched.length === 0 || relevanceScore < 44) rejectionReasons.push(`relevance score ${relevanceScore.toFixed(1)} is below 44.0`);
  if (dominantSubjectWords.length && dominantCoverage < 0.5) rejectionReasons.push(`candidate does not show the option's dominant subject (${dominantSubjectWords.join(' ')}); matched only ${dominantMatched.join(', ') || 'none'}`);
  if (spendSaveConflict) rejectionReasons.push("candidate depicts saving/piggy-bank imagery, the opposite of the option's spending concept");
  const accepted = rejectionReasons.length === 0;
  const pexelsQualityReasons = [];
  if (conceptClarity < 70) pexelsQualityReasons.push(`concept clarity ${conceptClarity.toFixed(1)} is below 70.0`);
  if (specificity < 65) pexelsQualityReasons.push(`specificity ${specificity.toFixed(1)} is below 65.0`);
  if (visualImpact < 50) pexelsQualityReasons.push(`visual impact ${visualImpact.toFixed(1)} is below 50.0`);
  if (qualityScore < PEXELS_MINIMUM_QUALITY) pexelsQualityReasons.push(`visual quality ${qualityScore.toFixed(1)} is below ${PEXELS_MINIMUM_QUALITY.toFixed(1)}`);
  if (!bankGrowthDepicted) pexelsQualityReasons.push('candidate does not depict money or wealth increasing, multiplying, or in dramatic abundance');
  if (weakVisual) pexelsQualityReasons.push('candidate is generic, object-only, clip-art-like, or stock-like');
  if (corporateWeak) pexelsQualityReasons.push('candidate is generic corporate or finance stock imagery for a concept needing a stronger visual');
  return { accepted, hardRejected: hardRejectionReasons.length > 0, hardRejectionReasons, formatPass: assetRejectionReasons.length === 0, validAsset: assetRejectionReasons.length === 0, relevanceScore, qualityScore, finalScore, conceptClarity, specificity, visualImpact, wyrSuitability, pexelsQualityPassed: accepted && pexelsQualityReasons.length === 0, pexelsQualityReasons, rejectionReasons, matchedConcepts: uniqueWords(coreMatched), dominantSubjectWords, dominantCoverage };
};

const runImageProbe = (binary, args) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; let stderr = '';
  child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); }); child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(`${output}\n${stderr}`) : reject(new Error(`FFmpeg image validation exited with code ${code}: ${stderr.slice(-1000)}`)));
});
const statValue = (output, name) => { const match = output.match(new RegExp(`lavfi\\.signalstats\\.${name}=(-?[0-9.]+)`)); return match ? Number(match[1]) : NaN; };
const probeDimensions = output => { const match = output.match(/\bs:(\d+)x(\d+)\b/); return match ? { width: Number(match[1]), height: Number(match[2]) } : null; };
// Fraction of the frame that sits within a narrow band of its single most common gray level --
// a direct, pixel-level (not keyword/metadata) stand-in for "how much of this image is one flat
// background color". Clipart/text-on-flat-background graphics, isolated product cutouts on plain
// white, and stock imagery whose background merges into the template's red/blue panel all share
// this signature (one dominant color filling most of the frame) regardless of how sharp or
// high-contrast the small foreground subject/text is -- which is why edgeYAvg alone (see below)
// cannot reliably catch them: a bold, high-contrast "10%" on a huge flat background can score AS
// HIGH on average edge intensity as a genuinely detailed photo, because the metric only measures
// edge intensity where edges exist, never how much of the frame has no detail at all.
const FLAT_FRACTION_ANALYSIS_SIZE = 64;
const FLAT_FRACTION_TOLERANCE = 6;
export const readGrayscaleHistogram = async (localPath, { binary = resolveFfmpegPath(), size = FLAT_FRACTION_ANALYSIS_SIZE } = {}) => {
  const child = spawn(binary, ['-hide_banner', '-v', 'error', '-i', localPath, '-vf', `scale=${size}:${size}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-frames:v', '1', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let stderr = '';
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => { stderr += String(chunk); });
  const buffer = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`FFmpeg histogram probe exited with code ${code}: ${stderr.slice(-500)}`))); });
  const expected = size * size;
  if (buffer.length < expected) throw new Error(`Histogram probe produced ${buffer.length} bytes, expected ${expected}.`);
  const bins = new Array(256).fill(0);
  for (let i = 0; i < expected; i += 1) bins[buffer[i]] += 1;
  return { bins, sampleCount: expected };
};
export const computeFlatBackgroundFraction = ({ bins, sampleCount }, tolerance = FLAT_FRACTION_TOLERANCE) => {
  if (!sampleCount) return 0;
  let best = 0;
  for (let center = 0; center < 256; center += 1) {
    let sum = 0;
    for (let level = Math.max(0, center - tolerance); level <= Math.min(255, center + tolerance); level += 1) sum += bins[level];
    if (sum > best) best = sum;
  }
  return best / sampleCount;
};
export const FLAT_BACKGROUND_FRACTION_THRESHOLD = 0.7;
export const classifyImageStats = ({ width, height, yMin, yMax, yAvg, edgeYAvg, stdev, flatBackgroundFraction }) => {
  const reasons = [];
  if (!Number.isFinite(width) || !Number.isFinite(height)) reasons.push('hard-rejected: decoded dimensions were unavailable (corrupt image)');
  else if (width < 750 || height < 450) reasons.push('hard-rejected: decoded image is too small for the 750x450 slot');
  if (![yMin, yMax, yAvg, edgeYAvg].every(Number.isFinite)) reasons.push('decoded image statistics were unavailable');
  else {
    const range = yMax - yMin;
    if (range <= 6 || (yMax < 24 && yAvg < 8) || (yMin > 247 && yAvg > 248)) reasons.push('hard-rejected: image is blank, near-black, near-white, or overwhelmingly uniform');
    if (Number.isFinite(stdev) && stdev < 2.5 && range < 24) reasons.push('hard-rejected: image has near-zero contrast and appears to be a placeholder');
    // edgedetect+signalstats YAVG runs roughly 0-3 in practice (edges are sparse bright pixels on an
    // otherwise-black frame), not the 0-255 scale of a plain luma average -- thresholds below are
    // calibrated to that observed scale, not the yAvg/stdev scale used elsewhere in this function.
    if (edgeYAvg < 0.05 && range < 48) reasons.push('image has no meaningful edge/detail structure');
    const aspectRatio = width / height;
    if (aspectRatio >= 2.2 && edgeYAvg > 1.1) reasons.push('hard-rejected: pixel layout resembles a dense text/banner graphic');
    if (Number.isFinite(stdev) && stdev < 18 && edgeYAvg > 0.6) reasons.push('hard-rejected: near-uniform background with text-like high-contrast foreground');
    if (Number.isFinite(flatBackgroundFraction) && flatBackgroundFraction >= FLAT_BACKGROUND_FRACTION_THRESHOLD) reasons.push(`hard-rejected: ${Math.round(flatBackgroundFraction * 100)}% of the frame is a single flat background color -- looks like clipart, an isolated product cutout, or a text/percentage graphic rather than a real-world photographic scene`);
  }
  return { valid: reasons.length === 0, reasons, width, height, yMin, yMax, yAvg, edgeYAvg, stdev, flatBackgroundFraction };
};
export const inspectDownloadedImage = async (localPath, { binary = resolveFfmpegPath() } = {}) => {
  const rawOutput = await runImageProbe(binary, ['-hide_banner', '-v', 'info', '-i', localPath, '-vf', 'signalstats,metadata=print:file=-,showinfo', '-frames:v', '1', '-f', 'null', '-']);
  const edgeOutput = await runImageProbe(binary, ['-hide_banner', '-v', 'error', '-i', localPath, '-vf', 'edgedetect=low=0.1:high=0.4,signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-']);
  const dimensions = probeDimensions(rawOutput) || {};
  const histogram = await readGrayscaleHistogram(localPath, { binary });
  return classifyImageStats({ ...dimensions, yMin: statValue(rawOutput, 'YMIN'), yMax: statValue(rawOutput, 'YMAX'), yAvg: statValue(rawOutput, 'YAVG'), edgeYAvg: statValue(edgeOutput, 'YAVG'), stdev: Number(rawOutput.match(/stdev:\[(-?[0-9.]+)/)?.[1]), flatBackgroundFraction: computeFlatBackgroundFraction(histogram) });
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
      const enriched = { ...candidate, provider: candidate.provider || providerLabel, query, relevanceScore: assessment.relevanceScore, qualityScore: assessment.qualityScore, finalScore: assessment.finalScore, conceptClarity: assessment.conceptClarity, specificity: assessment.specificity, visualImpact: assessment.visualImpact, wyrSuitability: assessment.wyrSuitability, pexelsQualityPassed: assessment.pexelsQualityPassed, pexelsQualityReasons: assessment.pexelsQualityReasons, matchedConcepts: assessment.matchedConcepts };
      state.candidateDiagnostics.push({ provider: enriched.provider, id: enriched.id, query, sourceDomain: enriched.sourceDomain, width: enriched.width, height: enriched.height, formatPass: assessment.formatPass, qualityScore: enriched.qualityScore, relevanceScore: enriched.relevanceScore, finalScore: enriched.finalScore, accepted: assessment.accepted, validAsset: assessment.validAsset, reasons: assessment.rejectionReasons });
      if (assessment.hardRejected) console.info(`WYR_IMAGE_HARD_REJECT | question=${state.option.questionIndex + 1} | slot=${state.option.slot} | provider=${enriched.provider === 'DuckDuckGo Images' ? 'DuckDuckGo' : enriched.provider} | domain=${enriched.sourceDomain || 'unknown'} | query="${String(query).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(/\r?\n/g, ' ')}" | rejectionReason="${assessment.hardRejectionReasons.join('; ')}"`);
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
  const finalScore = Number(right.finalScore || 0) - Number(left.finalScore || 0); if (finalScore) return finalScore;
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
const chooseStrongCandidate = (state, candidates, used) => {
  const ranked = rankedUnique(candidates).filter(candidate => !conflicts(candidate, used));
  const [top, second] = ranked;
  if (!top || Number(top.finalScore || 0) < IMAGE_SELECTION_DEFAULTS.minimumFinalScore) return null;
  if (second && Number(top.finalScore || 0) - Number(second.finalScore || 0) < IMAGE_SELECTION_DEFAULTS.minimumCandidateMargin && Number(second.finalScore || 0) < 78) return null;
  return top;
};

export const findAndDownloadImages = async ({ plan, provider, webProvider = null, visualQueryProvider = null, assetsDir, maxRetries, concurrency = 4, onProgress, imageInspector = inspectDownloadedImage, computeCrop = computeSubjectAwareCrop, recovery = IMAGE_RECOVERY_DEFAULTS }) => {
  const options = plan.questions.flatMap(question => [{ questionIndex: question.index, slot: 'A', ...question.optionA }, { questionIndex: question.index, slot: 'B', ...question.optionB }]);
  const recoveryConfig = { ...IMAGE_RECOVERY_DEFAULTS, ...recovery };
  const states = options.map((option, index) => ({ index, option, queries: buildImageQueries(option).slice(0, Math.max(4, maxRetries + 1)), candidates: [], validCandidates: [], webCandidates: [], selected: null, pool: [], failedKeys: new Set(), searchAttempts: [], providerErrors: [], webProviderErrors: [], rejections: [], candidateDiagnostics: [], providerRequestCount: 0, recoveryQueries: [], providerAttemptOrder: [...IMAGE_SELECTION_DEFAULTS.providerOrder], webProviderAttempted: false, fallbackReason: null }));
  const used = new Set();
  const webLabel = webProvider?.name || 'DuckDuckGo Images';
  if (webProvider) {
    await collectCandidates({ states, provider: webProvider, providerLabel: webLabel, concurrency, retrySearch: false, progressive: true });
    for (const state of states) { state.webProviderAttempted = true; state.webCandidates = rankedUnique(state.candidates.filter(candidate => candidate.provider !== 'Pexels')).slice(0, MAX_RANKED_CANDIDATES); }
  }
  for (const state of states) {
    const strongWeb = chooseStrongCandidate(state, state.webCandidates || [], used);
    if (strongWeb) { state.selected = strongWeb; reserve(strongWeb, used); }
  }
  const needsPexels = states.filter(state => !state.selected);
  const selectPexelsCandidates = state => {
    const rankedPexels = rankedUnique(state.candidates.filter(candidate => candidate.provider === 'Pexels')).slice(0, MAX_RANKED_CANDIDATES);
    state.pexelsBestCandidate = rankedPexels[0] || null;
    state.pexelsCandidates = rankedPexels.filter(candidate => candidate.pexelsQualityPassed);
    state.pexelsFallbackCandidates = rankedPexels;
    state.pexelsGatePassed = state.pexelsCandidates.length > 0;
    state.pool = state.pexelsCandidates;
    const strongPexels = chooseStrongCandidate(state, state.pexelsCandidates, used);
    if (strongPexels) { state.selected = strongPexels; reserve(strongPexels, used); }
    state.pexelsSearched = true;
  };
  if (needsPexels.length) {
    await collectCandidates({ states: needsPexels, provider, providerLabel: 'Pexels', concurrency, retrySearch: true });
    for (const state of needsPexels) selectPexelsCandidates(state);
  }
  for (const state of needsPexels) {
    if (state.selected?.provider === 'Pexels') {
      const fallbackReason = !webProvider ? 'DuckDuckGo Images provider unavailable' : state.webProviderErrors.length ? state.webProviderErrors.join('; ') : state.webCandidates?.length ? 'DuckDuckGo Images candidates were unavailable for selection' : 'DuckDuckGo Images returned no acceptable candidate';
      state.fallbackReason = fallbackReason;
      log('image.web_fallback_unavailable', { question: state.option.questionIndex + 1, slot: state.option.slot, reason: fallbackReason, usingPexels: true });
    }
  }
  for (const state of states.filter(state => state.selected && !state.pool.length)) state.pool = state.webCandidates?.length ? state.webCandidates : [state.selected];

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
          // Framing safety gate: compute where the crop would land before committing to this
          // candidate. A candidate whose subject can't be kept safely in frame (extreme aspect
          // ratio, or the best crop window still loses most of the image's detail) is rejected here
          // -- same as a broken download -- so the existing pool/fallback logic below just moves on
          // to the next ranked candidate instead of ever rendering a bad crop.
          const framing = await computeCrop({ localPath, sourceWidth: selected.width, sourceHeight: selected.height, targetWidth: WYR_TEMPLATE.layout.imageWidth, targetHeight: WYR_TEMPLATE.layout.imageHeight });
          if (!framing?.safe) throw new Error(framing?.reason || 'framing rejected: could not compute a safe crop for this image');
          selected.framing = { x: framing.x, y: framing.y, coverWidth: framing.coverWidth, coverHeight: framing.coverHeight };
          return { ok: true, state, filename, localPath, contentHash: fileHash(localPath), inspection };
        }
        catch (error) { fs.rmSync(localPath, { force: true }); if (/hard-rejected/i.test(error.message)) console.info(`WYR_IMAGE_HARD_REJECT | question=${state.option.questionIndex + 1} | slot=${state.option.slot} | provider=${selected.provider === 'DuckDuckGo Images' ? 'DuckDuckGo' : selected.provider} | domain=${selected.sourceDomain || 'unknown'} | query="${String(selected.query || '').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(/\r?\n/g, ' ')}" | rejectionReason="${error.message.replaceAll('"', '\\"').replaceAll(/\r?\n/g, ' ')}"`); return { ok: false, state, error }; }
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
  const brokenWebStates = states.filter(state => !state.localPath && !state.pexelsSearched && webProvider);
  if (brokenWebStates.length) {
    for (const state of brokenWebStates) { state.candidates = []; state.validCandidates = []; }
    await collectCandidates({ states: brokenWebStates, provider, providerLabel: 'Pexels', concurrency, retrySearch: true });
    for (const state of brokenWebStates) {
      state.candidates = state.candidates.filter(candidate => candidate.provider === 'Pexels');
      selectPexelsCandidates(state);
      if (state.selected) state.pool = state.pexelsCandidates;
      if (state.selected?.provider === 'Pexels') {
        const failedWebDownload = state.rejections.find(rejection => rejection.provider === 'DuckDuckGo Images');
        state.fallbackReason = failedWebDownload ? `DuckDuckGo Images candidate failed: ${failedWebDownload.reasons.join('; ')}` : 'DuckDuckGo Images candidate failed during download';
      }
    }
    await downloadSelections(brokenWebStates);
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
      const rankedRecovery = rankedUnique([...state.candidates, ...state.pexelsFallbackCandidates]);
      state.pool = [
        ...rankedRecovery.filter(candidate => candidate.provider === 'DuckDuckGo Images'),
        ...rankedRecovery.filter(candidate => candidate.provider === 'Pexels'),
      ];
      state.selected = choose(state, used);
      if (state.selected) reserve(state.selected, used);
      await downloadSelections([state]);
      return Boolean(state.localPath);
    };
    const alternateQueries = buildAlternateImageQueries(state.option).slice(0, recoveryConfig.alternateQueryRounds);
    for (const query of alternateQueries) {
      if (!canRecover()) break;
      state.recoveryQueries.push(query);
      await searchRecoveryProvider(query, webProvider, webProvider?.name ? `${webProvider.name} (recovery)` : 'Web image search (recovery)');
      await searchRecoveryProvider(query, provider, 'Pexels (recovery)');
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
          await searchRecoveryProvider(query, webProvider, webProvider?.name ? `${webProvider.name} (Groq recovery)` : 'Web image search (Groq recovery)');
          await searchRecoveryProvider(query, provider, 'Pexels (Groq recovery)');
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
    providerAttemptOrder: state.providerAttemptOrder, selectedProvider: state.selected.provider, selectedQuery: state.selected.query, fallbackReason: state.fallbackReason,
    webFallbackRequired: state.webProviderAttempted, pexelsPassed: Boolean(state.pexelsGatePassed),
    pexelsBestCandidate: state.pexelsBestCandidate ? { id: state.pexelsBestCandidate.id, query: state.pexelsBestCandidate.query, alt: state.pexelsBestCandidate.alt, qualityScore: state.pexelsBestCandidate.qualityScore, conceptClarity: state.pexelsBestCandidate.conceptClarity, specificity: state.pexelsBestCandidate.specificity, visualImpact: state.pexelsBestCandidate.visualImpact, wyrSuitability: state.pexelsBestCandidate.wyrSuitability, passed: state.pexelsBestCandidate.pexelsQualityPassed, reasons: state.pexelsBestCandidate.pexelsQualityReasons } : null,
    localPath: state.localPath, filename: state.filename,
  }));
  for (const state of states) {
    const topCandidates = [...state.candidateDiagnostics].sort((left, right) => Number(right.finalScore || 0) - Number(left.finalScore || 0)).slice(0, 3);
    for (const candidate of topCandidates) console.info(`WYR_IMAGE_CANDIDATE_SCORE | question=${state.option.questionIndex + 1} | slot=${state.option.slot} | provider=${candidate.provider === 'DuckDuckGo Images' ? 'DuckDuckGo' : candidate.provider} | domain=${candidate.sourceDomain || 'unknown'} | query="${String(candidate.query || '').replaceAll('"', '\\"')}" | formatPass=${candidate.formatPass} | relevanceScore=${candidate.relevanceScore} | qualityScore=${candidate.qualityScore} | finalScore=${candidate.finalScore} | rejectionReason="${(candidate.reasons || []).join('; ').replaceAll('"', '\\"')}"`);
  }
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
      fs.writeFileSync(text, `${asset.optionText || asset.text || `Question ${asset.questionIndex + 1} ${asset.slot}`}\nProvider: ${asset.provider}\nQuery: ${asset.queryUsed}\nSource: ${asset.sourceDomain || 'unknown'}${asset.hardRejectionReason ? `\nHard reject: ${asset.hardRejectionReason}` : ''}`);
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

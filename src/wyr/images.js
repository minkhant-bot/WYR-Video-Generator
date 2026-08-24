import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fetchWithTimeout, log, mapWithConcurrency, retry, writeJsonAtomic } from './utils.js';
import { assertFontAvailable, resolveFfmpegPath } from './runtime.js';
import { computeSubjectAwareCrop, renderableCrop } from './framing.js';
import { WYR_TEMPLATE } from './template.js';
import { coreSubjectWords, NON_VISUAL_MODIFIER_WORDS } from './image-query.js';

export class ImageProvider { async search() { throw new Error('ImageProvider.search must be implemented.'); } async downloadAsset() { throw new Error('ImageProvider.downloadAsset must be implemented.'); } }
export class PexelsImageProvider extends ImageProvider {
  constructor({ apiKey, timeoutMs }) { super(); this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.name = 'Pexels'; }
  async search(query) {
    const url = new URL('https://api.pexels.com/v1/search'); url.searchParams.set('query', query); url.searchParams.set('per_page', '40'); url.searchParams.set('orientation', 'landscape'); url.searchParams.set('size', 'medium');
    const response = await fetchWithTimeout(url, { headers: { Authorization: this.apiKey } }, this.timeoutMs);
    if (!response.ok) throw new Error(`Pexels search returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const payload = await response.json();
    return (payload.photos || []).map((photo, position) => ({ id: String(photo.id), provider: 'Pexels', width: Number(photo.width), height: Number(photo.height), alt: String(photo.alt || ''), title: String(photo.alt || ''), description: String(photo.alt || ''), semanticMetadata: String(photo.alt || ''), pageTitle: String(photo.url || '').split('/').filter(Boolean).at(-1) || '', photographer: photo.photographer, photographerUrl: photo.photographer_url, photoUrl: photo.url, sourcePageUrl: photo.url, sourceDomain: 'pexels.com', originalImageUrl: photo.src?.original, downloadUrl: photo.src?.large2x || photo.src?.large || photo.src?.original, license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/', usageRights: 'Pexels License; review current terms before reuse', sha256: null, position })).filter(candidate => candidate.downloadUrl && candidate.width > 0 && candidate.height > 0);
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
  if (String(option?.category || '').trim().toLowerCase() === 'food') {
    const subject = (supplied.length ? supplied : optionWords).slice(0, 5).join(' ');
    return [...new Set([
      `${subject} isolated white background product photo no people`,
      `${subject} single food close up white background`,
      `${subject} isolated food photography no people`,
      `${subject} close up food photography no people`,
      `${subject} real food photo no people`,
      `${subject} plated dish close up no people`,
      subject,
    ].filter(query => query.length >= 3))];
  }
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

// FOOD-specific product-photo ladder. Clean isolated searches lead, while broader real-food and
// plated-dish phrases remain later fallbacks so a scarce subject never fails solely because an
// ideal white-background photograph was unavailable.
export const buildFoodPhotoRecoveryQueries = option => {
  if (String(option?.category || '').trim().toLowerCase() !== 'food') return [];
  const supplied = normalizeWords(option?.searchQuery || '').slice(0, 5);
  const literal = normalizeWords(option?.text || '').filter(word => !CONTROL_WORDS.has(word)).slice(0, 5);
  const subject = (supplied.length ? supplied : literal).join(' ');
  if (!subject) return [];
  return [...new Set([
    `${subject} isolated white background product photo no people`,
    `${subject} single food close up white background`,
    `${subject} isolated food photography no people`,
    `${subject} close up food photography no people`,
    `${subject} real food photo no people`,
    `${subject} plated dish close up no people`,
  ])];
};

const candidateText = candidate => `${candidate.alt || ''} ${candidate.title || ''} ${candidate.credit || ''}`.toLowerCase();
const WATERMARK_PATTERN = /\b(watermark|watermarked|shutterstock|alamy|i\s*stock|istock|dreamstime|depositphotos|123rf|getty\s*images?|gettyimages|adobe stock|stock photo|freepik premium|impossible images)\b/i;
// Preview libraries use regional storefronts (for example gettyimages.co.uk) and separate CDN
// hosts. Matching only the .com storefront allowed an obviously watermarked Getty preview into
// the rendered food sample.
const WATERMARK_HOST_PATTERN = /(^|\.)(shutterstock\.com|alamy\.com|istockphoto\.com|dreamstime\.com|depositphotos\.com|123rf\.com|gettyimages\.(?:com|[a-z]{2}|co\.[a-z]{2})|media\.gettyimages\.com|stock\.adobe\.com|freepik\.com|vectorstock\.com|vecteezy\.com|craiyon\.com|impossibleimages\.ai|stablediffusionweb\.com)$/i;
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
// Search engines frequently return app-store/product screenshots for food prompts. These are
// colorful and detailed enough to pass pixel statistics, so reject explicit game/UI evidence in
// metadata before it can compete with real food photography.
const GAME_GRAPHIC_PATTERN = /\b(video game|mobile game|cooking game|restaurant game|chef game|food game|gameplay|game screenshot|game app|simulator game|kitchen crush|master chef game|jeux? de cuisine|jeu de restaurant)\b/i;
// Question/article thumbnails may use a photograph underneath but still carry large editorial
// copy. Keep this narrow to headline phrasing that strongly signals embedded text.
const EMBEDDED_TEXT_GRAPHIC_PATTERN = /\b(what if (?:we|you)|would you rather|did you know)\b/i;
// FOOD videos have a much narrower visual contract than the general/fantasy generator: the image
// must be a literal food photograph, with the dish itself as the subject. Provider metadata is the
// only semantic evidence available before download, so reject strong evidence of the failure
// classes observed in real renders instead of allowing a repeated food keyword to score them to
// 100. These rules are deliberately FOOD-only; fantasy/non-food options retain their existing art
// and human-scene behavior.
const FOOD_NON_PHOTO_PATTERN = /\b(ai[ -]?generated|generative ai|nightcafe|surreal|emoji|emoticon|sticker|clip[ -]?art|cartoon|illustration|illustrated|vector|digital art|concept art|3d render|rendered|cgi|painting|drawing|art print|wall art|fine art|wallpapers?|backgrounds? free download)\b/i;
const FOOD_HUMAN_PATTERN = /\b(person|people|man|men|woman|women|boy|girl|child|children|family|couple|crowd|chef|cook|baker|barista|waiter|waitress|hands?|holding|eating|biting|drinking)\b/i;
const FOOD_VENUE_PATTERN = /\b(storefront|shopfront|restaurant|cafe|café|diner|dining room|sushi bar|food truck|market stall|vendor|commercial kitchen|restaurant interior|display case|waffle house|shop|outlet|branch|nagar)\b/i;
const FOOD_EDITORIAL_PATTERN = /\b(wedding|bride|groom|wedding film|production still|movie scene|film still|logo|headline|typography|text overlay|menu board|editorial graphic)\b/i;
const FOOD_PRODUCT_PATTERN = /\b(marketplace|product packaging|packaged food|retail package|boxed product|packet|wrapper|grocery product|product listing|for sale|buy online|shop now|merchandise|burger king|mcdonald'?s|wendy'?s|restaurant chain)\b/i;
const FOOD_CLEAN_STUDIO_PATTERN = /\b(isolated|white background|off[ -]?white background|neutral background|plain background|transparent background|transparent png|png cutout|food cutout|product photo|product photography|product shot|single food|studio photo|close[ -]?up)\b/i;
const FOOD_VISIBLE_BACKGROUND_PATTERN = /\b(restaurant table|table setting|dining table|wooden table|rustic table|plate on table|kitchen counter|kitchen interior|room interior|restaurant interior|food spread|buffet|scenery|outdoors?)\b/i;
const FOOD_CONFLICTING_DISH_PATTERN = /\b(poutine|tater tots?|combo platter|sampler platter|novelty cake|funny style|affogato|rhubarb|pistachio and raspberry|batter|waffle iron|raw dough|uncooked)\b/i;
const FOOD_UNSUITABLE_HOST_PATTERN = /(^|\.)(nightcafe\.studio|fineartamerica\.com|emojis\.com|redbubble\.com|deviantart\.com|artstation\.com|citypng\.com|pngtree\.com|designbundles\.net|wallpapers\.com|wallpapercrafter\.com|wallpapercave\.com|wallpaperflare\.com|etsy\.com|walmart\.com|target\.com|ebay\.(?:com|co\.[a-z]{2}|[a-z]{2})|alibaba\.com|aliexpress\.com|instacart\.com|amazon\.(?:com(?:\.[a-z]{2})?|co\.[a-z]{2}|[a-z]{2}))$/i;

// Exact FOOD identities only: these groups express spelling/name equivalence, never fuzzy
// similarity between distinct dishes. For compounds the final dish/form remains mandatory.
const FOOD_IDENTITY_SYNONYM_GROUPS = Object.freeze([
  ['fries', 'french fries'], ['donut', 'doughnut'], ['soda', 'soft drink'],
  ['omelet', 'omelette'], ['mac and cheese', 'macaroni and cheese', 'mac cheese'],
  ['ice cream', 'icecream'], ['hot dog', 'hotdog'],
  ['mozzarella sticks', 'mozzarella stick', 'cheese sticks', 'cheese stick'],
  ['chicken tenders', 'chicken tender', 'chicken strips', 'chicken strip'],
  ['chicken wings', 'chicken wing', 'buffalo wings', 'buffalo wing', 'hot wings', 'hot wing'],
  ['onion rings', 'onion ring'], ['spring rolls', 'spring roll'], ['egg rolls', 'egg roll'],
  ['sausage rolls', 'sausage roll'], ['hash browns', 'hash brown'], ['tater tots', 'tater tot'],
  ['potato wedges', 'potato wedge'],
]);
const FOOD_IDENTITY_TERMS = new Set([
  'bagel', 'biscuit', 'bread', 'brownie', 'burger', 'burrito', 'cake', 'candy', 'cereal',
  'cheesecake', 'chicken', 'chili', 'chocolate', 'cobbler', 'coffee', 'cookie', 'curry',
  'cupcake', 'donut', 'doughnut', 'dumpling', 'fish', 'fries', 'hot dog', 'ice cream',
  'lasagna', 'lobster', 'mac and cheese', 'meatball', 'muffin', 'nachos', 'noodles',
  'omelet', 'omelette', 'pancake', 'pasta', 'pie', 'pizza', 'pretzel', 'pudding', 'quesadilla',
  'rice', 'salad', 'sandwich', 'sausage', 'smoothie', 'soda', 'soft drink', 'soup', 'steak',
  'sushi', 'taco', 'toast', 'waffle', 'wrap', 'mozzarella sticks', 'chicken tenders',
  'chicken wings', 'onion rings', 'spring rolls', 'egg rolls', 'sausage rolls', 'hash browns',
  'tater tots', 'potato wedges',
]);
const FOOD_MULTIWORD_BASES = [...new Set(FOOD_IDENTITY_SYNONYM_GROUPS.flat())]
  .filter(term => term.includes(' ')).sort((left, right) => right.split(' ').length - left.split(' ').length);
const FOOD_METADATA_NON_DISH_PATTERN = /\b(car|vehicle|phone|computer|laptop|chair|furniture|building|street|landscape|portrait|person|people|restaurant|cafe|shop|store|venue|kitchen interior|menu|logo|toy|pet|dog|cat)\b/i;
const FOOD_LABEL_FILLER = new Set(['and', 'with', 'style', 'classic', 'loaded', 'grilled', 'fried', 'baked', 'roasted', 'fresh', 'spicy', 'sweet', 'savory']);
const FOOD_EXCLUSIVE_MODIFIER_GROUPS = Object.freeze([
  ['chicken', 'beef', 'pork', 'fish', 'shrimp', 'lobster', 'turkey', 'ham', 'bacon', 'sausage', 'salmon', 'tuna', 'bean', 'cheese', 'mushroom'],
  ['apple', 'banana', 'blueberry', 'cherry', 'chocolate', 'lemon', 'lime', 'mango', 'orange', 'peach', 'pineapple', 'raspberry', 'strawberry', 'vanilla', 'caramel'],
]);
const semanticNormalize = value => String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const singularFoodTerm = value => {
  const term = semanticNormalize(value);
  if (term === 'fries') return 'fries';
  if (/^(?:cookies|brownies|smoothies|pies)$/.test(term)) return term.slice(0, -1);
  if (term.endsWith('ies')) return `${term.slice(0, -3)}y`;
  if (term.endsWith('oes')) return term.slice(0, -2);
  if (term.endsWith('ses') || term.endsWith('xes') || term.endsWith('zes') || term.endsWith('ches') || term.endsWith('shes')) return term.slice(0, -2);
  if (term.length > 4 && term.endsWith('s')) return term.slice(0, -1);
  return term;
};
const phrasePresent = (text, phrase) => {
  const textWords = semanticNormalize(text).split(' ').filter(Boolean);
  const phraseWords = semanticNormalize(phrase).split(' ').filter(Boolean);
  if (!phraseWords.length || phraseWords.length > textWords.length) return false;
  for (let index = 0; index <= textWords.length - phraseWords.length; index += 1) {
    if (phraseWords.every((word, offset) => singularFoodTerm(textWords[index + offset]) === singularFoodTerm(word))) return true;
  }
  return false;
};
const aliasesForFoodIdentity = base => {
  const normalized = semanticNormalize(base);
  const group = FOOD_IDENTITY_SYNONYM_GROUPS.find(items => items.some(item => singularFoodTerm(item) === singularFoodTerm(normalized)));
  return [...new Set((group || [normalized]).flatMap(item => [semanticNormalize(item), singularFoodTerm(item)]).filter(Boolean))];
};
const requestedFoodIdentity = option => {
  const label = semanticNormalize(option?.text || option?.searchQuery || '');
  const special = FOOD_MULTIWORD_BASES.find(term => label === term || label.endsWith(` ${term}`));
  const lastWord = label.split(' ').filter(Boolean).at(-1) || '';
  const base = special || singularFoodTerm(lastWord);
  const baseAliases = aliasesForFoodIdentity(base);
  const modifierWords = label.split(' ').filter(word => word.length > 2 && !FOOD_LABEL_FILLER.has(word) && !baseAliases.some(alias => alias.split(' ').includes(word)));
  return { label, base, baseAliases, modifierWords };
};
const urlFilename = value => {
  try { return decodeURIComponent(new URL(value).pathname.split('/').filter(Boolean).at(-1) || ''); }
  catch { return ''; }
};
const candidateSemanticMetadata = candidate => {
  // semanticMetadata lets providers separate source-authored text from query-derived display alt
  // text, so an injected search phrase cannot prove its own relevance.
  if (Object.hasOwn(candidate || {}, 'semanticMetadata')) return semanticNormalize([candidate.semanticMetadata, candidate.description, candidate.tags, candidate.pageTitle, candidate.sourceFilename].flat().filter(Boolean).join(' '));
  const explicit = [candidate?.title, candidate?.description, candidate?.alt, candidate?.tags, candidate?.keywords, candidate?.pageTitle, candidate?.sourceFilename]
    .flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean).join(' ');
  if (explicit.trim()) return semanticNormalize(explicit);
  return semanticNormalize([urlFilename(candidate?.sourcePageUrl), urlFilename(candidate?.originalImageUrl), urlFilename(candidate?.downloadUrl)].filter(Boolean).join(' '));
};

export const assessFoodImageSemanticRelevance = (candidate, option) => {
  const requested = requestedFoodIdentity(option);
  const metadata = candidateSemanticMetadata(candidate);
  if (!requested.base || !metadata) return { accepted: true, decision: 'ambiguous', ...requested, metadata, reason: 'metadata is insufficient and has no strong conflict' };
  const baseMatched = requested.baseAliases.some(alias => phrasePresent(metadata, alias));
  if (baseMatched) {
    for (const group of FOOD_EXCLUSIVE_MODIFIER_GROUPS) {
      const requestedGroupModifiers = requested.modifierWords.filter(word => group.includes(singularFoodTerm(word)));
      if (!requestedGroupModifiers.length || requestedGroupModifiers.some(word => phrasePresent(metadata, word))) continue;
      const conflictingModifier = group.find(word => phrasePresent(metadata, word));
      if (conflictingModifier) return { accepted: false, decision: 'reject', ...requested, metadata, conflictingModifier, reason: `metadata matches requested base food "${requested.base}" but identifies a conflicting modifier (${conflictingModifier})` };
    }
    return { accepted: true, decision: 'match', ...requested, metadata, reason: `metadata explicitly matches requested base food "${requested.base}"` };
  }
  const matchedModifiers = requested.modifierWords.filter(word => phrasePresent(metadata, word));
  if (matchedModifiers.length) return { accepted: false, decision: 'reject', ...requested, metadata, matchedModifiers, reason: `requested base food "${requested.base}" is absent; metadata matches modifier only (${matchedModifiers.join(', ')})` };
  const conflictingFoods = [...FOOD_IDENTITY_TERMS]
    .filter(term => !requested.baseAliases.some(alias => singularFoodTerm(alias) === singularFoodTerm(term)))
    .filter(term => phrasePresent(metadata, term));
  if (conflictingFoods.length) return { accepted: false, decision: 'reject', ...requested, metadata, conflictingFoods, reason: `requested base food "${requested.base}" is absent; metadata identifies a different food (${conflictingFoods.slice(0, 3).join(', ')})` };
  const nonDishMatch = metadata.match(FOOD_METADATA_NON_DISH_PATTERN)?.[0]?.toLowerCase();
  if (nonDishMatch) return { accepted: false, decision: 'reject', ...requested, metadata, reason: `requested base food "${requested.base}" is absent; metadata identifies a non-dish subject (${nonDishMatch})` };
  return { accepted: true, decision: 'ambiguous', ...requested, metadata, reason: 'metadata is ambiguous but does not conflict with the requested food' };
};
const WEAK_VISUAL_PATTERN = /\b(clip[ -]?art|simple icon|flat icon|vector icon|line icon|silhouette icon|button icon|symbol icon|diagram|infographic|isolated product|product shot|corporate illustration|generic illustration|generic stock|wallet|calculator|credit card|bank card|card reader|brain model|brain in (?:a )?box)\b/i;
const GENERIC_TECH_ABSTRACTION_PATTERN = /\b(cloud icon|upload icon|download icon|gear icon|network icon|circuit board|abstract technology|digital network|data flow|binary code|matrix code|generic technology|tech background|futuristic background|abstract background|glowing network|node network|connection lines|abstract data|generic diagram|flowchart|pie chart|bar chart|symbol only|isolated symbol|generic symbol)\b/i;
const CORPORATE_WEAK_PATTERN = /\b(corporate|business meeting|office team|businessman at desk|finance illustration|corporate stock|generic office|financial presentation|handshake|suit|office|meeting|teamwork)\b/i;
// Gate for CORPORATE_WEAK_PATTERN above: a genuinely business/work-themed option ("Own a
// successful company", "Get your dream job") legitimately wants office/meeting/handshake imagery,
// so the generic-stock-business penalty only applies when the option itself isn't about business
// or work -- checked against both the display text and the search query, so a curated DB
// searchQuery like "modern office skyscraper building" for "Own a successful company" is exempted
// the same way the option text itself would be.
const BUSINESS_CONTEXT_PATTERN = /\b(business|company|corporate|office|work|job|career|ceo|entrepreneur|startup|bank|finance|financial|executive|boardroom)\b/i;
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
// Strengthened per real render/digital-art/cutout false-accepts observed in production ("grim
// reaper digital artwork" for "Own a treasure chest", "3D-rendered gold bars" for "Be a
// billionaire at 65", "euro note cutout on plain white background" for "Own a safe full of
// cash") -- broadened beyond the original render/rendering/cgi/digital art/3d model/painting/
// drawing list to also catch bare "3d", illustration/illustrated, artwork, fantasy, isolated, and
// the cutout/mockup phrasing real provider tags use for non-photographic or studio-isolated
// results. Still ranking-only (see computeSemanticRankAdjustment) -- never a hard rejection -- so
// a genuinely fantasy-coded option (dragon, portal, teleportation) with no real photo available
// still gets its only-available fantasy-art candidate selected, just correctly ranked below any
// literal photographic alternative in the same pool instead of being treated as equal or better.
const NON_PHOTOGRAPHIC_EVIDENCE_PATTERN = /\b(render|rendered|rendering|3d|cgi|digital\s+art|illustration|illustrated|artwork|fantasy|isolated|white\s+background|studio\s+cutout|product\s+cutout|mockup|3d\s+model|painting|drawing)\b/;
// Verbs whose CORE meaning is a visible human action -- when the option itself asks for one of
// these, a candidate that actually shows a person doing it is a stronger, more immediately-
// recognizable match than an equally "on-keyword" object-only or scenery-only shot.
const HUMAN_ACTION_VERBS = new Set(['wear', 'wears', 'wearing', 'ride', 'rides', 'riding', 'cycle', 'cycles', 'cycling', 'walk', 'walks', 'walking', 'dance', 'dances', 'dancing', 'hug', 'hugs', 'hugging', 'kiss', 'kisses', 'kissing', 'hold', 'holds', 'holding', 'carry', 'carries', 'carrying', 'drive', 'drives', 'driving', 'swim', 'swims', 'swimming', 'run', 'runs', 'running', 'sing', 'sings', 'singing', 'eat', 'eats', 'eating', 'drink', 'drinks', 'drinking']);
// Explicit multi-person context: an option naming friends/family/group/together implies the
// candidate should show more than one person, not a single isolated subject.
const GROUP_CONTEXT_WORDS = new Set(['friends', 'friend', 'family', 'group', 'team', 'together', 'crowd', 'partner', 'couple']);
const computeSemanticRankAdjustment = (optionWords, searchableText, headNounMatched = false, foodOption = false) => {
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
  // Photographic-realism preference: illustration/fantasy-art is handled elsewhere and never
  // hard-rejected for fantasy content -- this only ranks a real photo above an otherwise-equal
  // render/CGI/cutout/artwork result. Raised from -6 to -32 (see NON_PHOTOGRAPHIC_EVIDENCE_PATTERN
  // above): a mild nudge wasn't enough to stop a non-photographic candidate from outranking a
  // genuine photo already in the same accepted pool -- this is still ranking-only, never a hard
  // rejection, so it can't cause a slot to come up empty the way strengthening a hard-reject
  // pattern could.
  if (PHOTOGRAPHIC_EVIDENCE_PATTERN.test(searchableText)) adjustment += 6;
  else if (NON_PHOTOGRAPHIC_EVIDENCE_PATTERN.test(searchableText) && !(foodOption && FOOD_CLEAN_STUDIO_PATTERN.test(searchableText))) adjustment -= 32;
  if (foodOption) {
    if (FOOD_CLEAN_STUDIO_PATTERN.test(searchableText)) adjustment += 24;
    if (FOOD_VISIBLE_BACKGROUND_PATTERN.test(searchableText)) adjustment -= 22;
  }
  // Literal-subject bonus: reward a candidate whose tags/alt-text literally contain the head noun
  // of the search query that actually found it (e.g. "supercars" should beat an "engine" close-up
  // for "Have a garage of supercars"; "clothes" should beat a "sewing machine" for "Have a room of
  // designer clothes") -- the concrete word the search itself was built around, not just any word
  // from the option's broader display text. Computed by the caller (assessImageCandidate) using
  // the same textTokens/textStems/stem machinery already used for dominantMatched below.
  if (headNounMatched) adjustment += 16;
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
  const foodOption = String(option?.category || '').trim().toLowerCase() === 'food';
  const foodSemanticRelevance = foodOption ? assessFoodImageSemanticRelevance(candidate, option) : null;
  if (!Number.isFinite(candidate?.width) || !Number.isFinite(candidate?.height) || candidate.width < 750 || candidate.height < 450) hardRejectionReasons.push('hard-rejected: low-resolution or corrupt candidate (too small for the 750x450 slot)');
  const hardFormatMatches = [...hardFormatEvidence.matchAll(HARD_FORMAT_PATTERN)].map(match => match[0].toLowerCase());
  const hardLayoutMatch = hardFormatEvidence.match(HARD_LAYOUT_PATTERN)?.[0]?.toLowerCase();
  if (hardFormatMatches.length || hardLayoutMatch) hardRejectionReasons.push(`hard-rejected: candidate metadata indicates ${[...new Set([...hardFormatMatches, hardLayoutMatch].filter(Boolean))].join(', ')} / text-heavy or promotional format`);
  if (HARD_DOMAIN_PATTERN.test(sourceDomain)) hardRejectionReasons.push(`hard-rejected: high-risk source domain ${sourceDomain}`);
  if (WATERMARK_PATTERN.test(hardFormatEvidence) || WATERMARK_HOST_PATTERN.test(sourceDomain)) hardRejectionReasons.push('hard-rejected: obvious watermark or stock-preview source');
  if (foodOption) {
    const illustrationMatch = hardFormatEvidence.match(ILLUSTRATION_ART_PATTERN)?.[0]?.toLowerCase();
    if (illustrationMatch) hardRejectionReasons.push(`hard-rejected: food candidate is flat/vector/hand-drawn art (${illustrationMatch}), not a real food photograph`);
    const gameGraphicMatch = hardFormatEvidence.match(GAME_GRAPHIC_PATTERN)?.[0]?.toLowerCase();
    if (gameGraphicMatch) hardRejectionReasons.push(`hard-rejected: food candidate is a game/app graphic (${gameGraphicMatch}), not food photography`);
    const embeddedTextMatch = hardFormatEvidence.match(EMBEDDED_TEXT_GRAPHIC_PATTERN)?.[0]?.toLowerCase();
    if (embeddedTextMatch) hardRejectionReasons.push(`hard-rejected: food candidate metadata indicates an embedded-text editorial graphic (${embeddedTextMatch})`);
    if (FOOD_UNSUITABLE_HOST_PATTERN.test(sourceDomain)) hardRejectionReasons.push(`hard-rejected: food candidate comes from an art, emoji, or marketplace source (${sourceDomain})`);
    const nonPhotoMatch = hardFormatEvidence.match(FOOD_NON_PHOTO_PATTERN)?.[0]?.toLowerCase();
    if (nonPhotoMatch) hardRejectionReasons.push(`hard-rejected: food candidate is non-photographic (${nonPhotoMatch})`);
    const humanMatch = hardFormatEvidence.match(FOOD_HUMAN_PATTERN)?.[0]?.toLowerCase();
    if (humanMatch) hardRejectionReasons.push(`hard-rejected: food candidate includes a person or eating interaction (${humanMatch})`);
    const venueMatch = hardFormatEvidence.match(FOOD_VENUE_PATTERN)?.[0]?.toLowerCase();
    if (venueMatch) hardRejectionReasons.push(`hard-rejected: food candidate depicts a venue rather than the literal dish (${venueMatch})`);
    const editorialMatch = hardFormatEvidence.match(FOOD_EDITORIAL_PATTERN)?.[0]?.toLowerCase();
    if (editorialMatch) hardRejectionReasons.push(`hard-rejected: food candidate has editorial or unrelated scene context (${editorialMatch})`);
    const productMatch = hardFormatEvidence.match(FOOD_PRODUCT_PATTERN)?.[0]?.toLowerCase();
    if (productMatch) hardRejectionReasons.push(`hard-rejected: food candidate is marketplace or product-packaging imagery (${productMatch})`);
    const conflictingDishMatch = hardFormatEvidence.match(FOOD_CONFLICTING_DISH_PATTERN)?.[0]?.toLowerCase();
    if (conflictingDishMatch && !String(option?.text || '').toLowerCase().includes(conflictingDishMatch)) hardRejectionReasons.push(`hard-rejected: food candidate is a mixed, novelty, or conflicting dish (${conflictingDishMatch}), not a clear literal photo of the requested food`);
  }
  rejectionReasons.push(...hardRejectionReasons);
  if (hardRejectionReasons.length) return { accepted: false, hardRejected: true, hardRejectionReasons, formatPass: false, validAsset: assetRejectionReasons.length === 0, relevanceScore: 0, qualityScore: 0, finalScore: 0, conceptClarity: 0, specificity: 0, visualImpact: 0, wyrSuitability: 0, pexelsQualityPassed: false, pexelsQualityReasons: hardRejectionReasons, rejectionReasons, matchedConcepts: [] };
  if (WATERMARK_PATTERN.test(searchableText) || WATERMARK_HOST_PATTERN.test(String(candidate.sourceDomain || ''))) assetRejectionReasons.push('obvious stock or website watermark risk detected');
  if (UNSUITABLE_SOURCE_HOST_PATTERN.test(String(candidate.sourceDomain || ''))) assetRejectionReasons.push('candidate source is likely a UI thumbnail or merchandise result');
  const sourceQualityRisk = SOURCE_QUALITY_PATTERN.test(searchableText);
  const cleanFoodProductPhoto = foodOption && FOOD_CLEAN_STUDIO_PATTERN.test(searchableText) && !FOOD_PRODUCT_PATTERN.test(searchableText);
  if (UI_OR_TEXT_PATTERN.test(searchableText) || (sourceQualityRisk && !cleanFoodProductPhoto)) assetRejectionReasons.push('candidate appears to be a meme, infographic, screenshot, UI, ad, template, or text-dominated graphic');
  if (MISLEADING_CONTEXT_PATTERN.test(searchableText)) assetRejectionReasons.push('candidate describes merchandise or a misleading unrelated context');
  if (INAPPROPRIATE_PATTERN.test(searchableText)) assetRejectionReasons.push('candidate appears inappropriate or sexualized');
  rejectionReasons.push(...assetRejectionReasons);
  if (foodSemanticRelevance?.decision === 'reject') rejectionReasons.push(`food semantic relevance rejected: ${foodSemanticRelevance.reason}`);
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
  // Literal-subject bonus input (see computeSemanticRankAdjustment): the head noun of the search
  // query that actually found this candidate -- image-query.js's coreSubjectWords already strips
  // leading verbs/stopwords, so the LAST word left is the concrete noun the query was built
  // around ("supercars" for a "have a garage of supercars" query, "clothes" for "designer
  // clothes"). Matched the same stem-aware way as dominantMatched above.
  const searchQueryCoreWords = coreSubjectWords(option.searchQuery || '');
  const searchQueryHeadNoun = searchQueryCoreWords[searchQueryCoreWords.length - 1] || '';
  const headNounMatched = Boolean(searchQueryHeadNoun) && (textTokens.has(searchQueryHeadNoun) || textStems.has(stem(searchQueryHeadNoun)));
  const intentGroups = visualIntentGroups(option); const intentCoverage = intentGroups.length ? visualIntentCoverage(option, allTokens) : 1;
  const targetRatio = 750 / 450; const ratio = candidate.width / candidate.height;
  const cropFit = Math.max(0, 1 - Math.abs(Math.log(ratio / targetRatio)) / 1.5);
  const resolution = Math.min(1, Math.min(candidate.width / 1600, candidate.height / 900));
  const weakVisual = (WEAK_VISUAL_PATTERN.test(searchableText) || GENERIC_TECH_ABSTRACTION_PATTERN.test(searchableText))
    && !(foodOption && FOOD_CLEAN_STUDIO_PATTERN.test(searchableText));
  // See BUSINESS_CONTEXT_PATTERN above: a genuinely business/work-themed option is exempt from the
  // generic-stock-business penalty, checked against both the display text and the search query.
  const queryIsBusinessRelated = BUSINESS_CONTEXT_PATTERN.test(`${option.text || ''} ${option.searchQuery || ''}`);
  const corporateWeak = CORPORATE_WEAK_PATTERN.test(searchableText) && !queryIsBusinessRelated;
  const impactMatches = searchableText.match(IMPACT_PATTERN)?.length || 0;
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
  const semanticRankAdjustment = computeSemanticRankAdjustment(optionWords, searchableText, headNounMatched, foodOption);
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
  return { accepted, hardRejected: hardRejectionReasons.length > 0, hardRejectionReasons, formatPass: assetRejectionReasons.length === 0, validAsset: assetRejectionReasons.length === 0, relevanceScore, qualityScore, finalScore, conceptClarity, specificity, visualImpact, wyrSuitability, pexelsQualityPassed: accepted && pexelsQualityReasons.length === 0, pexelsQualityReasons, rejectionReasons, matchedConcepts: uniqueWords(coreMatched), dominantSubjectWords, dominantCoverage, foodSemanticRelevance };
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
export const classifyImageStats = ({ width, height, yMin, yMax, yAvg, edgeYAvg, stdev, flatBackgroundFraction }, { foodMode = false } = {}) => {
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
    if (Number.isFinite(flatBackgroundFraction) && flatBackgroundFraction >= (foodMode ? 0.9 : FLAT_BACKGROUND_FRACTION_THRESHOLD)) reasons.push(`hard-rejected: ${Math.round(flatBackgroundFraction * 100)}% of the frame is a single flat background color -- the visible subject is too small or the image resembles a text/graphic placeholder`);
  }
  return { valid: reasons.length === 0, reasons, width, height, yMin, yMax, yAvg, edgeYAvg, stdev, flatBackgroundFraction };
};
export const inspectDownloadedImage = async (localPath, { binary = resolveFfmpegPath(), foodMode = false } = {}) => {
  const rawOutput = await runImageProbe(binary, ['-hide_banner', '-v', 'info', '-i', localPath, '-vf', 'signalstats,metadata=print:file=-,showinfo', '-frames:v', '1', '-f', 'null', '-']);
  const edgeOutput = await runImageProbe(binary, ['-hide_banner', '-v', 'error', '-i', localPath, '-vf', 'edgedetect=low=0.1:high=0.4,signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-']);
  const dimensions = probeDimensions(rawOutput) || {};
  const histogram = await readGrayscaleHistogram(localPath, { binary });
  return classifyImageStats({ ...dimensions, yMin: statValue(rawOutput, 'YMIN'), yMax: statValue(rawOutput, 'YMAX'), yAvg: statValue(rawOutput, 'YAVG'), edgeYAvg: statValue(edgeOutput, 'YAVG'), stdev: Number(rawOutput.match(/stdev:\[(-?[0-9.]+)/)?.[1]), flatBackgroundFraction: computeFlatBackgroundFraction(histogram) }, { foodMode });
};

// FOOD images receive a small subject-aware zoom during framing. Validate effective resolution
// against that FINAL cover geometry rather than imposing a landscape-only source-size rule: a
// sufficiently dense square/portrait remains valid, while a nominally 750x450 source cannot be
// silently enlarged into the 960x600 production slot. A tiny allowance absorbs integer rounding
// and harmless resampling; anything beyond it is material upscaling.
export const MAX_FOOD_EFFECTIVE_UPSCALE = 1.08;
export const assessFoodEffectiveResolution = ({ sourceWidth, sourceHeight, framing }) => {
  const scaleX = Number(framing?.coverWidth) / Number(sourceWidth);
  const scaleY = Number(framing?.coverHeight) / Number(sourceHeight);
  const upscaleFactor = Math.max(scaleX, scaleY);
  const valid = [scaleX, scaleY, upscaleFactor].every(Number.isFinite) && scaleX > 0 && scaleY > 0 && upscaleFactor <= MAX_FOOD_EFFECTIVE_UPSCALE;
  return {
    valid, upscaleFactor,
    reason: valid ? null : `hard-rejected: decoded FOOD image would require ${Number.isFinite(upscaleFactor) ? upscaleFactor.toFixed(2) : 'unknown'}x effective upscaling after crop/zoom (maximum ${MAX_FOOD_EFFECTIVE_UPSCALE.toFixed(2)}x)`,
  };
};

const FOOD_SHARPNESS_WIDTH = 480;
const FOOD_SHARPNESS_HEIGHT = 300;
const FOOD_BACKGROUND_DISTANCE = 20;
const FOOD_BACKGROUND_LUMA_GAP = 16;
// Mean absolute Laplacian on useful subject pixels at half-slot resolution. Real photos and crisp
// isolated product shots normally sit comfortably above this; the deliberately low floor only
// rejects strongly blurred/preview-like subjects.
export const MIN_FOOD_SUBJECT_SHARPNESS = 3;
const median = values => {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] || 0;
};
export const computeFoodSubjectSharpness = ({ buffer, width = FOOD_SHARPNESS_WIDTH, height = FOOD_SHARPNESS_HEIGHT }) => {
  const expected = width * height * 3;
  if (!Buffer.isBuffer(buffer) || buffer.length < expected) return { valid: false, score: NaN, usefulFraction: 0, reason: 'decoded FOOD sharpness pixels were unavailable' };
  const cornerSize = Math.max(4, Math.round(Math.min(width, height) * 0.04));
  const corners = [];
  for (const [startX, startY] of [[0, 0], [width - cornerSize, 0], [0, height - cornerSize], [width - cornerSize, height - cornerSize]]) {
    for (let y = startY; y < startY + cornerSize; y += 1) for (let x = startX; x < startX + cornerSize; x += 1) {
      const offset = (y * width + x) * 3;
      corners.push([buffer[offset], buffer[offset + 1], buffer[offset + 2]]);
    }
  }
  const background = [0, 1, 2].map(channel => median(corners.map(sample => sample[channel])));
  const backgroundLuma = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2];
  const subject = new Uint8Array(width * height); const luma = new Float64Array(width * height);
  let subjectPixels = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const pixel = y * width + x; const offset = pixel * 3;
    const red = buffer[offset]; const green = buffer[offset + 1]; const blue = buffer[offset + 2];
    const value = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    luma[pixel] = value;
    const differsFromBackground = Math.hypot(red - background[0], green - background[1], blue - background[2]) > FOOD_BACKGROUND_DISTANCE || value < backgroundLuma - FOOD_BACKGROUND_LUMA_GAP;
    if (differsFromBackground) { subject[pixel] = 1; subjectPixels += 1; }
  }
  const detail = [];
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const pixel = y * width + x;
    // Erode the mask by one pixel so the high-contrast outline between a product and a white field
    // cannot make an otherwise blurred subject look sharp.
    if (!subject[pixel] || !subject[pixel - 1] || !subject[pixel + 1] || !subject[pixel - width] || !subject[pixel + width]) continue;
    detail.push(Math.abs(4 * luma[pixel] - luma[pixel - 1] - luma[pixel + 1] - luma[pixel - width] - luma[pixel + width]));
  }
  const usefulFraction = subjectPixels / (width * height);
  const score = detail.length ? detail.reduce((sum, value) => sum + value, 0) / detail.length : 0;
  const valid = detail.length >= width * height * 0.005 && score >= MIN_FOOD_SUBJECT_SHARPNESS;
  return { valid, score, usefulFraction, sampleCount: detail.length, reason: valid ? null : `hard-rejected: decoded FOOD subject appears visibly blurred or lacks useful crop detail (sharpness ${score.toFixed(2)}, minimum ${MIN_FOOD_SUBJECT_SHARPNESS.toFixed(2)})` };
};

const readFoodCropPixels = async ({ localPath, framing, targetWidth, targetHeight, binary = resolveFfmpegPath() }) => {
  const filter = `scale=${Math.round(framing.coverWidth)}:${Math.round(framing.coverHeight)},crop=${targetWidth}:${targetHeight}:${Math.round(framing.x)}:${Math.round(framing.y)},scale=${FOOD_SHARPNESS_WIDTH}:${FOOD_SHARPNESS_HEIGHT}:flags=area,format=rgb24`;
  const child = spawn(binary, ['-hide_banner', '-v', 'error', '-i', localPath, '-vf', filter, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-frames:v', '1', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let stderr = '';
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`FFmpeg FOOD sharpness analysis exited with code ${code}: ${stderr.slice(-500)}`)));
  });
};

// Single post-download authority shared by the automatic Pixabay/Pexels path and the optional
// Wikimedia/DuckDuckGo path. Every rejection is returned to the caller, whose existing candidate
// loop then continues to the next ranked candidate/provider unchanged.
export const validateDownloadedImageForRender = async ({
  localPath, option, targetWidth = WYR_TEMPLATE.layout.imageWidth, targetHeight = WYR_TEMPLATE.layout.imageHeight,
  binary = resolveFfmpegPath(), inspectImage = (filename, settings) => inspectDownloadedImage(filename, settings), computeCrop = computeSubjectAwareCrop,
} = {}) => {
  const foodMode = String(option?.category || '').trim().toLowerCase() === 'food';
  const inspection = await inspectImage(localPath, { binary, foodMode });
  if (!inspection?.valid) return { valid: false, reasons: inspection?.reasons || ['downloaded image failed visual-content validation'], inspection, framing: null };
  const framing = await computeCrop({ localPath, sourceWidth: inspection.width, sourceHeight: inspection.height, targetWidth, targetHeight });
  if (!framing?.safe) return { valid: false, reasons: [framing?.reason || 'framing rejected: could not compute a safe crop for this image'], inspection, framing };
  if (!foodMode) return { valid: true, reasons: [], inspection, framing };
  const resolution = assessFoodEffectiveResolution({ sourceWidth: inspection.width, sourceHeight: inspection.height, framing });
  if (!resolution.valid) return { valid: false, reasons: [resolution.reason], inspection, framing, resolution };
  const sharpnessPixels = await readFoodCropPixels({ localPath, framing, targetWidth, targetHeight, binary });
  const sharpness = computeFoodSubjectSharpness({ buffer: sharpnessPixels });
  if (!sharpness.valid) return { valid: false, reasons: [sharpness.reason], inspection, framing, resolution, sharpness };
  return { valid: true, reasons: [], inspection, framing, resolution, sharpness };
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
      const foodLiteralQueryRank = String(state.option.category || '').trim().toLowerCase() === 'food'
        ? Math.max(0, 100 - Math.max(0, state.queries.indexOf(query)))
        : 0;
      const enriched = { ...candidate, provider: candidate.provider || providerLabel, query, foodLiteralQueryRank, relevanceScore: assessment.relevanceScore, qualityScore: assessment.qualityScore, finalScore: assessment.finalScore, conceptClarity: assessment.conceptClarity, specificity: assessment.specificity, visualImpact: assessment.visualImpact, wyrSuitability: assessment.wyrSuitability, pexelsQualityPassed: assessment.pexelsQualityPassed, pexelsQualityReasons: assessment.pexelsQualityReasons, matchedConcepts: assessment.matchedConcepts };
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
  const literalFoodQuery = Number(right.foodLiteralQueryRank || 0) - Number(left.foodLiteralQueryRank || 0); if (literalFoodQuery) return literalFoodQuery;
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

export const findAndDownloadImages = async ({ plan, provider, webProvider = null, visualQueryProvider = null, assetsDir, maxRetries, concurrency = 4, onProgress, imageInspector = (localPath, _candidate, option) => inspectDownloadedImage(localPath, { foodMode: String(option?.category || '').trim().toLowerCase() === 'food' }), computeCrop = computeSubjectAwareCrop, recovery = IMAGE_RECOVERY_DEFAULTS }) => {
  const options = plan.questions.flatMap(question => [
    { questionIndex: question.index, slot: 'A', category: question.category, ...question.optionA },
    { questionIndex: question.index, slot: 'B', category: question.category, ...question.optionB },
  ]);
  const recoveryConfig = { ...IMAGE_RECOVERY_DEFAULTS, ...recovery };
  const states = options.map((option, index) => ({ index, option, queries: buildImageQueries(option).slice(0, Math.max(4, maxRetries + 1)), candidates: [], validCandidates: [], webCandidates: [], selected: null, pool: [], failedKeys: new Set(), searchAttempts: [], providerErrors: [], webProviderErrors: [], rejections: [], candidateDiagnostics: [], providerRequestCount: 0, recoveryQueries: [], providerAttemptOrder: [...IMAGE_SELECTION_DEFAULTS.providerOrder], webProviderAttempted: false, fallbackReason: null }));
  const used = new Set();
  const webLabel = webProvider?.name || 'DuckDuckGo Images';
  if (webProvider) {
    await collectCandidates({ states, provider: webProvider, providerLabel: webLabel, concurrency, retrySearch: false, progressive: true });
    for (const state of states) { state.webProviderAttempted = true; state.webCandidates = rankedUnique(state.candidates.filter(candidate => candidate.provider !== 'Pexels')).slice(0, MAX_RANKED_CANDIDATES); }
  }
  for (const state of states) {
    // Curated stock-photo results are more reliable for literal FOOD imagery than unrestricted web
    // results. Keep the already-fetched web candidates as recovery candidates, but let Pexels win
    // first refusal for FOOD slots. Non-food provider ordering is unchanged.
    if (String(state.option.category || '').trim().toLowerCase() === 'food') continue;
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
          const quality = await validateDownloadedImageForRender({
            localPath, option: state.option, computeCrop,
            inspectImage: (filename, settings) => imageInspector(filename, selected, state.option, settings),
          });
          if (!quality.valid) throw new Error(`downloaded image rejected: ${quality.reasons.join('; ')}`);
          selected.width = quality.inspection.width; selected.height = quality.inspection.height;
          selected.framing = renderableCrop(quality.framing);
          return { ok: true, state, filename, localPath, contentHash: fileHash(localPath), inspection: quality.inspection };
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
    const alternateQueries = [...new Set([
      ...buildFoodPhotoRecoveryQueries(state.option),
      ...buildAlternateImageQueries(state.option),
    ])].slice(0, recoveryConfig.alternateQueryRounds);
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

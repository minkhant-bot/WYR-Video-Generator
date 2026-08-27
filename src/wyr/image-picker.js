import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PexelsImageProvider, assessFoodImageSemanticRelevance, assessImageCandidate, buildFoodPhotoRecoveryQueries, buildImageQueries as buildFallbackImageQueries, dominantSubjectWordsFor, firstVisualSynonym, validateDownloadedImageForRender } from './images.js';
import { fetchWithTimeout, mapWithConcurrency, log, retry } from './utils.js';
import { buildImageQueries, deterministicImageQueries, withFoodSearchContext } from './image-query.js';
import { isFantasyQuestion } from './content-engine.js';
import { computeSubjectAwareCrop, renderableCrop } from './framing.js';
import { WYR_TEMPLATE } from './template.js';
import { GroqContentProvider } from './content.js';
import { normalizeFoodOption } from './food-themes.js';

export const IMAGE_PROVIDER_ORDER = Object.freeze(['Pixabay', 'Pexels']);
const REVIEW_POOL_SIZE = 8;
const MAX_PROVIDER_CALLS_PER_SLOT = 18;
// Tier 0 (see fetchCoreQueryTier below): how many usable candidates image-query.js's short,
// literal buildImageQueries queries must clear before the broader/older selectionQueries fallback
// list (and its own Tier-1 provider budget) is skipped entirely for a slot.
const CORE_QUERY_USABLE_THRESHOLD = 5;
// Bounded gap-fill budget for slots that Tier 1 (the strict, fixed 8-query/18-call pass above)
// left unfilled -- reuses the SAME config knobs the (otherwise dead-on-the-automatic-path)
// findAndDownloadImages recovery loop already exposes (WYR_IMAGE_RECOVERY_*), so ops can tune one
// consistent surface instead of two. Applied ONLY to slots still missing a selection after Tier 1,
// never to the whole batch, so a healthy 10/12 selection costs nothing extra.
const GAP_FILL_DEFAULTS = Object.freeze({ maxRequests: 24, maxWallClockMs: 45_000, queryRounds: 3 });
const GAP_FILL_TIER_CALLS = 18;

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
    url.searchParams.set('image_type', 'photo');
    url.searchParams.set('min_width', '1280');

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
      tags: String(hit.tags || ''),
      semanticMetadata: String(hit.tags || ''),
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
// The option's dominant subject with any abstract, non-literally-photographable word (e.g.
// "doubled", "grows", "spend") swapped for its single most concrete visual synonym (see
// images.js's firstVisualSynonym/VISUAL_EXPANSIONS) -- a real noun like "savings" or "treehouse"
// passes through completely unchanged. Only the SEARCH representation is affected; option.text
// (shown on screen) is never touched.
const concreteSubjectQuery = optionText => dominantSubjectWordsFor(optionText).map(firstVisualSynonym).join(' ').trim();

const selectionQueries = (option, { category = '', fantasy = false } = {}) => {
  const deterministic = deterministicImageQueries(option, { category });
  if (String(category || '').trim().toLowerCase() === 'food') {
    return [...new Set([
      String(option.searchQuery || '').trim(),
      ...deterministic,
      ...buildFoodPhotoRecoveryQueries({ ...option, category }),
    ].map(query => withFoodSearchContext(query, category)).filter(query => query && query.length >= 3))].slice(0, 8);
  }
  const built = buildFallbackImageQueries(option);
  const simple = simpleVisualQuery(option);
  const subject = simple.split(' ').slice(-4).join(' ');
  // The stylized suffix is only meaningful (and only added) for fantasy-coded questions, so it's
  // placed right after the deterministic literal-subject queries -- high enough that a rich set of
  // broader/decorative fallbacks below it can't crowd it out of the bounded 8-query list.
  const stylized = fantasy && subject ? `${subject} fantasy cinematic` : '';
  // Placed right after the deterministic query, ahead of the broader/decorative fallbacks, so an
  // abstract option (e.g. "savings doubled today" -> "savings growth") gets a genuinely concrete
  // search term early instead of only reaching one during bounded Tier-3 gap-fill.
  const concrete = concreteSubjectQuery(option.text);
  return [...new Set([
    String(option.searchQuery || '').trim(),
    ...deterministic,
    concrete,
    stylized,
    simple,
    ...built,
    subject,
  ].map(query => withFoodSearchContext(query, category)).filter(query => query && query.length >= 3))].slice(0, 8);
};

// Tier 3 (gap-fill only, never used for the initial Tier-1 pass): subject-preserving broadening
// for a slot that found NO usable candidate in the fixed Tier-1 query list. Anchored to
// dominantSubjectWordsFor -- the EXACT same word list images.js's assessImageCandidate requires
// >=50% coverage of -- so every variant here is guaranteed capable of clearing the dominant-subject
// gate; it only ever drops/reorders INCIDENTAL words (adjectives, actions, locations, temporal
// modifiers), never the mandatory core noun(s).
const broadenedSubjectQueries = optionText => {
  const words = dominantSubjectWordsFor(optionText);
  if (!words.length) return [];
  const bare = words.join(' ');
  const head = words[words.length - 1]; // rightmost word: typically the most specific/photographable noun
  // Concrete-synonym variants (e.g. "spend grows" -> "shopping growth"): abstract action words
  // replaced with their most literal visual synonym, still anchored to the same dominant subject.
  const concreteWords = words.map(firstVisualSynonym);
  const concreteBare = concreteWords.join(' ');
  const concreteHead = concreteWords[concreteWords.length - 1];
  return [...new Set([
    bare,
    head,
    `${bare} photo`,
    `${head} photo`,
    `${bare} real photo`,
    concreteBare,
    `${concreteBare} photo`,
    concreteHead,
    `${concreteHead} photo`,
  ].filter(query => query && query.length >= 3))];
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
  (Number(b.foodLiteralQueryRank || 0) - Number(a.foodLiteralQueryRank || 0)) ||
  (b.finalScore - a.finalScore) ||
  (b.relevanceScore - a.relevanceScore) ||
  (b.qualityScore - a.qualityScore) ||
  (a.position - b.position)
);

// Cross-job image rotation (see question-pool.js's recentUsedFoodImageIds): a stable reorder
// layered on top of sortPool's existing relevance/quality ranking, never a rejection -- a
// candidate is never removed from the pool for having been used before, only moved behind fresh
// ones, so a food label with a genuinely thin candidate pool still fills its slot (same
// deprioritize-not-exclude principle as the motif/theme/pair-key cooldowns in question-pool.js).
// Among candidates that ARE in the rotation history, the least-recently-used one sorts first, so
// exhausting every fresh candidate degrades to "the one used longest ago" rather than failing.
export const applyImageRotationPreference = state => {
  const foodOption = String(state.category || '').trim().toLowerCase() === 'food';
  if (!foodOption || !state.recentUsage?.size || !state.candidates.length) return;
  const foodLabel = normalizeFoodOption(state.requestedFoodText || state.optionText);
  const usedAt = candidate => state.recentUsage.get(`${foodLabel}::${candidate.provider}:${candidate.id}`);
  state.candidates.sort((a, b) => {
    const usedAtA = usedAt(a); const usedAtB = usedAt(b);
    if ((usedAtA !== undefined) !== (usedAtB !== undefined)) return usedAtA !== undefined ? 1 : -1;
    if (usedAtA !== undefined && usedAtB !== undefined) return usedAtA - usedAtB;
    return 0; // neither has rotation history -- preserve sortPool's existing relevance/quality order
  });
};

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

// Buckets a rejected/dropped candidate into the diagnostic category a production failure report
// needs (see ImageSelectionExhaustedError below) -- never stores the full candidate, just a count,
// so an exhausted slot's diagnostics stay small regardless of how many candidates were inspected.
const classifyRejection = checked => {
  if (checked.hardRejected) return 'hardRejected';
  const reasons = checked.rejectionReasons || [];
  if (reasons.some(reason => reason.includes('food semantic relevance'))) return 'semanticRejected';
  if (reasons.some(reason => reason.includes('dominant subject'))) return 'dominantSubjectRejected';
  if (reasons.some(reason => reason.includes('relevance score') || reason.includes('visual intent'))) return 'semanticRejected';
  return 'otherRejected';
};

const emptyDiagnostics = () => ({
  candidatesInspected: 0, duplicatesRejected: 0, hardRejected: 0,
  semanticRejected: 0, dominantSubjectRejected: 0, otherRejected: 0,
});

const fetchPoolForSlot = async (state, providers, config, minimumPool = REVIEW_POOL_SIZE, { maxCalls = MAX_PROVIDER_CALLS_PER_SLOT, deadline = Infinity, assessmentText = null } = {}) => {
  if (!providers.length) {
    state.error = 'No image provider is configured.';
    return state;
  }
  state.diagnostics = state.diagnostics || emptyDiagnostics();

  const seen = new Set(state.seen || []);
  let calls = 0;

  while (state.candidates.length < minimumPool && calls < maxCalls && Date.now() < deadline) {
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
        // assessmentText (Tier 5 only, see fillUnfilledSlot): candidates found via a Groq-derived
        // concrete visual phrase are gate-checked against THAT concrete phrase, not the original
        // (possibly non-photographable, e.g. "debt erased") option text -- reusing the exact same
        // dominant-subject/relevance machinery, just pointed at the semantically-translated
        // concept. state.optionText (shown on screen) itself is never modified anywhere.
        const checked = assessForReview(candidateForBrowser(raw), {
          text: String(state.category || '').trim().toLowerCase() === 'food' ? state.requestedFoodText || state.optionText : assessmentText || state.optionText,
          searchQuery: query,
          category: state.category,
        });
        const key = identity(checked);
        if (seen.has(key)) { state.diagnostics.duplicatesRejected += 1; continue; }
        seen.add(key);
        state.seen.push(key);
        state.diagnostics.candidatesInspected += 1;

        if (!reviewUsable(checked)) { state.diagnostics[classifyRejection(checked)] += 1; continue; }

        state.candidates.push({
          ...checked,
          candidateKey: key,
          providerName: provider.name,
          queryUsed: query,
          foodLiteralQueryRank: String(state.category || '').trim().toLowerCase() === 'food'
            ? Math.max(0, 100 - Math.max(0, state.queries.indexOf(query)))
            : 0,
        });
      }
      sortPool(state.candidates);
      applyImageRotationPreference(state);
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

  state.exhausted = state.candidates.length === 0 && calls >= maxCalls;
  return state;
};

// Tier 0: image-query.js's short, literal noun-phrase queries (specific -> single noun ->
// category), tried BEFORE the older/broader selectionQueries fallback list. A long raw option
// phrase used as-is returns almost no real Pixabay/Pexels hits, so this fetches with the most
// specific query first (one page per provider) and only escalates to the next, broader query if
// the previous one didn't clear CORE_QUERY_USABLE_THRESHOLD usable candidates. Reuses
// fetchPoolForSlot as-is, so every candidate found here still goes through the exact same
// assessImageCandidate/sortPool ranking as every other tier -- this only changes what gets
// searched for, never how a result is scored or accepted. state.queries/state.candidates are left
// populated on the state for the caller to merge onto (never reset), so a caller that falls
// through to the old Tier-1 pass afterward continues from here instead of starting over.
const fetchCoreQueryTier = async (state, providers, config) => {
  const coreQueries = [...state.queries];
  let usedQuery = null;
  for (let index = 0; index < coreQueries.length; index += 1) {
    usedQuery = coreQueries[index];
    state.queryIndex = index;
    await fetchPoolForSlot(state, providers, config, CORE_QUERY_USABLE_THRESHOLD, { maxCalls: providers.length });
    if (state.candidates.length >= CORE_QUERY_USABLE_THRESHOLD) break;
  }
  console.info(`[IMG] "${logSafe(state.optionText)}" -> q0="${logSafe(coreQueries[0] || '')}" q1="${logSafe(coreQueries[1] || '')}" used="${logSafe(usedQuery || '')}" got=${state.candidates.length}`);
  return state.candidates.length >= CORE_QUERY_USABLE_THRESHOLD;
};

// Tiers 2-4 (bounded gap-fill): reached ONLY for a slot Tier 1 left with zero selectable
// candidates. Each tier is a fresh, small provider-call budget so total extra latency for the
// common case (one or two stubborn slots) stays bounded, and the whole gap-fill run additionally
// respects a shared request-count/wall-clock ceiling (config.imageRecoveryMaxRequests/
// imageRecoveryMaxMs -- the same knobs already exposed for the legacy recovery path) so a
// genuinely-empty provider result can never turn into an unbounded retry loop.
const fillUnfilledSlot = async (state, providers, config, visualQueryProvider = null) => {
  if (state.selectedId) return state;
  const maxRequests = config.imageRecoveryMaxRequests ?? GAP_FILL_DEFAULTS.maxRequests;
  const maxWallClockMs = config.imageRecoveryMaxMs ?? GAP_FILL_DEFAULTS.maxWallClockMs;
  const queryRounds = config.imageRecoveryQueryRounds ?? GAP_FILL_DEFAULTS.queryRounds;
  const deadline = Date.now() + maxWallClockMs;
  const requestsAtStart = state.providerRequestCount;
  const remainingBudget = () => Math.max(0, maxRequests - (state.providerRequestCount - requestsAtStart));
  state.gapFillTiers = [];
  // Tiers 2-4 are always attempted; Tier 5 (Groq semantic repair) only exists when a
  // visualQueryProvider was actually supplied -- the fair-share division below must count it too,
  // or tiers 2-4 would exhaust the ENTIRE budget among themselves and leave literally nothing for
  // Tier 5 to ever run with.
  const TOTAL_TIERS = visualQueryProvider ? 4 : 3;
  let tiersAttempted = 0;

  const runTier = async (label, extraQueries = []) => {
    tiersAttempted += 1;
    if (state.selectedId || Date.now() >= deadline || remainingBudget() <= 0) return;
    const scopedQueries = extraQueries.map(query => withFoodSearchContext(query, state.category));
    if (scopedQueries.length) {
      const fresh = scopedQueries.filter(query => !state.queries.includes(query));
      if (fresh.length) {
        state.queries.push(...fresh);
        state.queryIndex = state.queries.length - fresh.length; // try the new queries first, not after a full old cycle
      }
    }
    // A fair SHARE of whatever budget remains, not the whole thing: an earlier tier making no
    // progress (e.g. deeper pages of a query set a wrong-subject provider result keeps satisfying)
    // must never be able to spend the entire gap-fill budget and starve a later, more promising
    // tier (the subject-preserving broadened queries) of its own chance to run at all.
    const tiersLeft = TOTAL_TIERS - tiersAttempted + 1;
    const share = Math.max(1, Math.ceil(remainingBudget() / tiersLeft));
    const before = state.candidates.length;
    await fetchPoolForSlot(state, providers, config, before + REVIEW_POOL_SIZE, {
      maxCalls: Math.min(GAP_FILL_TIER_CALLS, share),
      deadline,
    });
    selectBestAvailable(state);
    state.gapFillTiers.push({ tier: label, queriesAdded: scopedQueries, candidatesAfter: state.candidates.length, filled: Boolean(state.selectedId) });
  };

  // Tier 2: same subject-preserving query list, deeper provider pages -- catches results that only
  // show up past page 1 without changing what's being searched for.
  await runTier('tier2_deeper_pages');
  // Tier 3: broadened, dominant-subject-preserving query variants (bare subject, single head noun,
  // generic photographic suffixes) -- never drops the mandatory subject noun(s).
  if (!state.selectedId) {
    const recoveryQueries = [
      ...broadenedSubjectQueries(state.optionText),
      ...buildFoodPhotoRecoveryQueries({ text: state.optionText, searchQuery: state.optionText, category: state.category }),
    ];
    await runTier('tier3_broadened_subject_queries', [...new Set(recoveryQueries)].slice(0, queryRounds + 2));
  }
  // Tier 4: one further round on top of tier 3's now-larger query set, in case a genuinely usable
  // candidate exists but only turns up on a later page of the broadened queries themselves.
  if (!state.selectedId) await runTier('tier4_broadened_deeper_pages');

  // Tier 5 (semantic visual concept -- last resort, bounded to ONE Groq call per stuck slot):
  // Tiers 1-4 are all LITERAL word extraction/broadening -- they can only ever search for words
  // that already appear in the option text, so a genuinely non-photographable option (e.g. "All
  // your debt erased today" -- "erased" cannot be literally photographed, and no finite hand-
  // maintained synonym dictionary can ever cover every abstract verb English has) will exhaust
  // every literal tier no matter how much they're broadened. Tier 5 instead asks Groq -- already
  // part of this pipeline's content-generation stack -- to translate the option's MEANING into
  // concrete, photographable phrases ("person reviewing paid bills financial paperwork relief"),
  // then gate-checks candidates against THAT concrete phrase (see fetchPoolForSlot's
  // assessmentText) instead of the original abstract words. This is the general fix: instead of a
  // human enumerating abstract-word->synonym mappings one at a time (which just breaks again on
  // the next unmapped verb, as "erased" proved), the SAME semantic-translation step now runs for
  // ANY option, in ANY domain, that literal extraction can't handle -- bounded to exactly one
  // Groq call, only for slots that are still stuck after every free/local tier.
  if (!state.selectedId && visualQueryProvider && typeof visualQueryProvider.generateVisualQueries === 'function' && Date.now() < deadline && remainingBudget() > 0) {
    tiersAttempted += 1;
    let phrases = [];
    try {
      phrases = await visualQueryProvider.generateVisualQueries({ optionText: state.optionText, attemptedQueries: state.queries, maxQueries: Math.max(1, queryRounds) });
    } catch (error) {
      state.semanticVisualConceptError = error.message;
    }
    state.semanticVisualConcept = phrases.join('; ') || null;
    for (const rawPhrase of phrases) {
      const phrase = withFoodSearchContext(rawPhrase, state.category);
      if (state.selectedId || Date.now() >= deadline || remainingBudget() <= 0) break;
      if (!state.queries.includes(phrase)) { state.queries.push(phrase); state.queryIndex = state.queries.length - 1; }
      const before = state.candidates.length;
      await fetchPoolForSlot(state, providers, config, before + REVIEW_POOL_SIZE, {
        maxCalls: Math.min(GAP_FILL_TIER_CALLS, remainingBudget()),
        deadline,
        assessmentText: phrase,
      });
      selectBestAvailable(state);
    }
    state.gapFillTiers.push({ tier: 'tier5_semantic_visual_concept', queriesAdded: phrases, candidatesAfter: state.candidates.length, filled: Boolean(state.selectedId) });
  }

  return state;
};

const updateSelectedCount = selection => {
  selection.selectedCount = Object.values(selection.slots)
    .filter(slot => slot.selectedId).length;
  return selection.selectedCount;
};

// Full per-slot diagnostic report for a slot that could not be filled -- everything Railway-failure
// triage needs (see ImageSelectionExhaustedError), with nothing secret in it: just option text,
// queries tried, and rejection counts. Reused for a selection-stage failure (below) and re-derived
// with download-stage counts merged in for a download-stage failure (downloadSelectedCandidates).
export const buildSlotDiagnostics = (state, reasonOverride = null) => {
  const diagnostics = state.diagnostics || emptyDiagnostics();
  return {
    slot: state.key,
    scene: state.questionIndex + 1,
    option: state.slot,
    optionText: state.optionText,
    dominantSubject: dominantSubjectWordsFor(state.optionText).join(' '),
    providersAttempted: [...(state.providersAttempted || [])],
    queriesAttempted: [...(state.queries || [])],
    gapFillTiers: state.gapFillTiers || [],
    candidatesInspected: diagnostics.candidatesInspected,
    duplicatesRejected: diagnostics.duplicatesRejected,
    downloadsFailed: state.downloadsFailed || 0,
    framingRejected: state.framingRejected || 0,
    semanticRelevanceRejected: diagnostics.semanticRejected + diagnostics.dominantSubjectRejected,
    hardRejected: diagnostics.hardRejected,
    otherRejected: diagnostics.otherRejected,
    semanticVisualConcept: state.semanticVisualConcept || null,
    finalReason: reasonOverride || (state.selectedId
      ? null
      : (state.error || 'No candidate cleared the relevance/quality gates within the bounded search budget.')),
  };
};

// Renders buildSlotDiagnostics' per-slot report into the concise, human-readable block that
// pipeline.js attaches to a failed job's error/log output -- everything a Railway-log triage needs
// (scene/option/subject/queries/provider+rejection counts/final reason) with nothing secret in it:
// every field here originates from option text, search queries, or plain counters, never a URL,
// key, or connection string. Bounded so a pathological number of unfilled slots (or a runaway query
// list) can never blow up the job's stored error message.
const MAX_DIAGNOSTICS_REPORT_LENGTH = 6000;
const MAX_QUERIES_LISTED = 20;
export const formatUnfilledSlotDiagnostics = unfilledDiagnostics => {
  if (!Array.isArray(unfilledDiagnostics) || !unfilledDiagnostics.length) return '';
  const blocks = unfilledDiagnostics.map((diag, index) => {
    const queries = diag.queriesAttempted || [];
    const queriesShown = queries.slice(0, MAX_QUERIES_LISTED).map(logSafe).join(', ');
    const queriesSuffix = queries.length > MAX_QUERIES_LISTED ? `, … (+${queries.length - MAX_QUERIES_LISTED} more)` : '';
    return [
      `[${index + 1}] Scene ${diag.scene}, Option ${diag.option} -- "${logSafe(diag.optionText)}"`,
      `    Dominant subject: ${logSafe(diag.dominantSubject) || '(none)'}`,
      `    Providers attempted: ${(diag.providersAttempted || []).join(', ') || '(none configured)'}`,
      `    Queries attempted (${queries.length}): ${queriesShown}${queriesSuffix}`,
      `    Candidates inspected: ${diag.candidatesInspected}`,
      `    Semantic/relevance rejects: ${diag.semanticRelevanceRejected}`,
      `    Hard rejects: ${diag.hardRejected}`,
      `    Duplicates: ${diag.duplicatesRejected}`,
      `    Download failures: ${diag.downloadsFailed}`,
      `    Framing rejects: ${diag.framingRejected}`,
      `    Final reason: ${logSafe(diag.finalReason) || '(unknown)'}`,
    ].join('\n');
  });
  const report = `Missing slots (${unfilledDiagnostics.length}):\n\n${blocks.join('\n\n')}`;
  return report.length > MAX_DIAGNOSTICS_REPORT_LENGTH
    ? `${report.slice(0, MAX_DIAGNOSTICS_REPORT_LENGTH)}\n… (truncated)`
    : report;
};

// Tier 5's Groq client (see fillUnfilledSlot) -- built once from config, exactly like
// createProviders(config) builds the image providers, so createImageSelection stays a single
// self-contained entry point. Returns null (Tier 5 silently skipped, zero behavior change) when
// no Groq key is configured -- Tiers 1-4 alone are unaffected either way.
const createVisualQueryProvider = config =>
  config.groqApiKey ? new GroqContentProvider({ apiKey: config.groqApiKey, model: config.groqModel, timeoutMs: config.timeoutMs }) : null;

export const createImageSelection = async ({ plan, config, visualQueryProvider = createVisualQueryProvider(config), recentUsage = new Map() }) => {
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
        category: question.category,
        recentUsage,
        // The semantic-relevance target for image matching/query-broadening/diagnostics is the
        // option's explicit visualSubject (a concrete, photographable description -- see
        // content-engine.js's deriveVisualSubject) when one is available, else the hand-written
        // DB searchQuery the image was actually fetched with (falling back to option.text only
        // when neither exists) -- keeps the dominant-subject-word gate pointed at the SAME text
        // driving the search, instead of a separately-derived display text that can diverge from
        // it. displayText itself is never touched -- it still flows separately, unchanged, into
        // the actual rendered video via plan.questions[i].optionA/B.text (see media.js).
        optionText: option.visualSubject || option.searchQuery || option.text,
        requestedFoodText: String(question.category || '').trim().toLowerCase() === 'food' ? option.text : null,
        // Tier 0's queries: the hand-written DB searchQuery first when present (never pre-empted
        // by a rule-derived guess), then buildImageQueries' short literal fallback queries. The
        // older/broader selectionQueries list is only appended if Tier 0 comes up short.
        queries: [...new Set((String(question.category || '').trim().toLowerCase() === 'food'
          ? [
              ...buildImageQueries(option.visualSubject || option.text, question.category),
              withFoodSearchContext(option.searchQuery, question.category),
            ]
          : [
              withFoodSearchContext(option.searchQuery, question.category),
              ...buildImageQueries(option.visualSubject || option.text, question.category),
            ])
          .map(query => withFoodSearchContext(query, question.category)).filter(Boolean))],
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
        diagnostics: emptyDiagnostics(),
        providersAttempted: providers.map(provider => provider.name),
      };

      // Tier 0: short, literal core-noun queries, fetched first (see fetchCoreQueryTier). Only
      // falls through to the older, broader Tier-1 query list if Tier 0 alone didn't clear
      // CORE_QUERY_USABLE_THRESHOLD usable candidates -- merges onto whatever Tier 0 already found
      // rather than restarting, and passes every candidate through the same unchanged ranking.
      const coreSatisfied = await fetchCoreQueryTier(state, providers, config);
      if (!coreSatisfied) {
        // Tier 1: strict, fixed query list -- unchanged behavior/gates from before this fix.
        const fallbackQueries = selectionQueries(option, { category: question.category, fantasy });
        for (const query of fallbackQueries) if (!state.queries.includes(query)) state.queries.push(query);
        await fetchPoolForSlot(state, providers, config, REVIEW_POOL_SIZE);
      }
      selectBestAvailable(state);
      slots[key] = state;
    }
  }

  // Tiers 2-4 (bounded gap-fill): only for slots Tier 1 left unfilled. This is what was previously
  // completely missing on the automatic/production path -- expandImageSelection/replaceImageSelection
  // already existed but were only ever wired to the manual-review HTTP endpoints, never called here,
  // so runAutomaticPipeline threw IMAGE_SELECTION_EXHAUSTED the instant Tier 1 left ANY slot short,
  // with zero broadening or retry. See pipeline.js's runAutomaticPipeline for where the final
  // (still-bounded) exhaustion check now lives.
  const unfilled = Object.values(slots).filter(state => !state.selectedId);
  for (const state of unfilled) {
    await fillUnfilledSlot(state, providers, config, visualQueryProvider);
  }
  for (const state of Object.values(slots)) logSelectionResult(state);

  const selection = {
    mode: 'auto_review',
    pageSize: REVIEW_POOL_SIZE,
    total: Object.keys(slots).length,
    selectedCount: 0,
    slots,
    providers: providers.map(provider => provider.name),
  };
  updateSelectedCount(selection);
  selection.unfilledDiagnostics = Object.values(slots)
    .filter(state => !state.selectedId)
    .map(state => buildSlotDiagnostics(state));
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
    const quality = await validateDownloadedImageForRender({ localPath, option: item, computeCrop });
    if (!quality.valid) throw new Error(`failed validation: ${quality.reasons.join('; ')}`);
    return { localPath, filename, width: quality.inspection.width, height: quality.inspection.height, framing: renderableCrop(quality.framing) };
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
        if (String(state.category || '').trim().toLowerCase() === 'food') {
          const semantic = assessFoodImageSemanticRelevance(candidate, { text: state.requestedFoodText || item.optionText, searchQuery: candidate.queryUsed, category: 'food' });
          if (!semantic.accepted) throw new Error(`food semantic relevance rejected before download: ${semantic.reason}`);
        }
        const { localPath, filename, width, height, framing } = await downloadAndValidateCandidate({ candidate, provider, item, assetsDir, computeCrop });
        const sha256 = createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
        if (usedContentHashes.has(sha256)) { fs.rmSync(localPath, { force: true }); throw new Error('duplicate image bytes already used for another slot'); }
        usedContentHashes.add(sha256); usedCandidateKeys.add(candidate.candidateKey);
        log('image.candidate_accepted', { slot: item.key, provider: candidate.provider, query: candidate.queryUsed, candidateRank: rank });
        return {
          ...candidate, width, height, questionIndex: item.questionIndex, slot: item.slot, text: item.optionText,
          queryUsed: candidate.queryUsed, localPath, filename, sha256, framing,
          selectedProvider: candidate.provider, selectedQuery: candidate.queryUsed,
          providerAttemptOrder: [...IMAGE_PROVIDER_ORDER], locked: false,
        };
      } catch (error) {
        failedKeys.add(candidate.candidateKey); lastError = error;
        state.diagnostics = state.diagnostics || emptyDiagnostics();
        if (/framing rejected/i.test(error.message)) state.framingRejected = (state.framingRejected || 0) + 1;
        else if (/duplicate image bytes/i.test(error.message)) state.diagnostics.duplicatesRejected += 1;
        else state.downloadsFailed = (state.downloadsFailed || 0) + 1;
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
    if (!result) {
      // Tier 3/4 continuation (see fillUnfilledSlot): the known pool -- even widened -- is
      // exhausted purely at the download/validation/framing stage (item #8/#4 in the production
      // audit: failed downloads and framing rejections must trigger replacement searches, not an
      // immediate failure). Broaden to subject-preserving queries -- guaranteed to still satisfy
      // the dominant-subject gate -- for one more bounded round before finally giving up.
      const extraQueries = [
        ...broadenedSubjectQueries(item.optionText),
        ...buildFoodPhotoRecoveryQueries({ text: item.optionText, searchQuery: item.optionText, category: state.category }),
      ]
        .map(query => withFoodSearchContext(query, state.category))
        .filter(query => !(state.queries || []).includes(query));
      if (extraQueries.length) {
        state.queries = state.queries || [];
        state.queries.push(...extraQueries);
        state.queryIndex = state.queries.length - extraQueries.length;
        const before = state.candidates.length;
        await fetchPoolForSlot(state, [...providers.values()], config, before + REVIEW_POOL_SIZE);
        for (const candidate of state.candidates.slice(before)) { result = await tryCandidate(candidate); if (result) break; }
      }
    }
    if (!result) {
      const reason = `${item.key}: every image candidate (${rank} tried) failed download or validation. Last error: ${lastError?.message || 'no candidates were available'}`;
      const diagnostics = buildSlotDiagnostics(state, reason);
      const message = `${reason}\n\n${formatUnfilledSlotDiagnostics([diagnostics])}`;
      throw new ImageSelectionExhaustedError(message, { ...diagnostics, candidatesTried: rank });
    }
    return result;
  });
};

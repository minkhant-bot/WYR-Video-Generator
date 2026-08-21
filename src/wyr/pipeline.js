import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, log, redactConnectionSecrets } from './utils.js';
import { assertProviderConfig } from './config.js';
import { GroqContentProvider, addIllustrativePercentages } from './content.js';
import { ContentHistoryStore, generateProductionPlan, isFantasyQuestion, questionMotifs } from './content-engine.js';
import { PexelsImageProvider, findAndDownloadImages, createImageReviewArtifacts, IMAGE_SELECTION_DEFAULTS, lockSelectedImageAssets } from './images.js';
import { DuckDuckGoImageProvider } from './web-images.js';
import { buildComposition, DurationVerificationError, renderVideo, verifyVideo } from './media.js';
import { buildCountdownSchedule, buildSceneTimeline, buildSfxSchedule, createLocalSfx, generateVoiceovers } from './audio.js';
import { createFixturePlan, createFixtureAssets } from './fixtures.js';
import { buildSlotDiagnostics, createImageSelection, downloadSelectedCandidates, formatUnfilledSlotDiagnostics } from './image-picker.js';
import { rowToQuestion } from './pool-selection.js';
import { selectContentPlan } from './content-source.js';
import { commitPlanUsage, releaseQuestionReservation, releaseReservation, reserveReplacementQuestion } from './question-pool.js';

// Disposable per-job temp artifacts (raw downloaded images, TTS mp3s, rendered scene segments) --
// always scoped to path.join(job.workspace, ...), never anything outside a job's own directory.
// Deliberately excludes 'output' (a failed job never has a verified MP4 there anyway) and never
// touches the job.json record itself, so diagnostics (plan.json, timeline.json, etc. written
// earlier via writeJsonAtomic) survive for debugging a failure.
const DISPOSABLE_JOB_SUBDIRS = ['assets', 'audio', 'render'];
const cleanupFailedJobArtifacts = job => {
  for (const dir of DISPOSABLE_JOB_SUBDIRS) {
    try { fs.rmSync(path.join(job.workspace, dir), { recursive: true, force: true }); }
    catch (error) { log('job.cleanup_failed', { jobId: job.id, dir, message: error.message }); }
  }
};

// Fallback classification for the (rare) error that reaches here without its own explicit `.code`
// -- keyed by the LAST stage the job reported before failing. Errors that already carry a `.code`
// (ContentPoolExhaustedError, DurationBudgetExceededError, TtsGenerationError,
// ImageSelectionExhaustedError, ...) always win; this only backstops genuinely uncoded errors
// (e.g. a raw FFmpeg/render Error) so the UI still gets a useful high-level category.
const STAGE_FALLBACK_ERROR_CODES = {
  generating_content: 'QUESTION_POOL_EXHAUSTED',
  searching_images: 'IMAGE_SELECTION_EXHAUSTED',
  downloading_assets: 'IMAGE_SELECTION_EXHAUSTED',
  generating_voice: 'TTS_FAILED',
  building_timeline: 'RENDER_FAILED',
  rendering: 'RENDER_FAILED',
  verifying: 'OUTPUT_VERIFICATION_FAILED',
};
const classifyJobError = (error, stage) => error?.code || STAGE_FALLBACK_ERROR_CODES[stage] || 'JOB_FAILED';

// Bounds what reaches the client: never a multi-KB FFmpeg stderr dump or a stack trace, just a
// short, single-line summary. The FULL message/stack is still logged server-side (job.failed
// below) -- this only shapes what publicJob() exposes over the API.
const MAX_CLIENT_ERROR_MESSAGE_LENGTH = 240;
const sanitizeErrorForClient = message => {
  const flattened = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!flattened) return 'The job failed unexpectedly.';
  return flattened.length > MAX_CLIENT_ERROR_MESSAGE_LENGTH ? `${flattened.slice(0, MAX_CLIENT_ERROR_MESSAGE_LENGTH)}…` : flattened;
};
// IMAGE_SELECTION_EXHAUSTED's message carries its own bounded per-slot diagnostics report (see
// image-picker.js's formatUnfilledSlotDiagnostics) -- deliberately multi-line and longer than the
// generic single-line cap above, so a Railway-log reader can actually see which slots failed and
// why instead of just a one-line summary. Still bounded (formatUnfilledSlotDiagnostics caps itself
// at 6000 chars), and only line breaks/repeated blank lines are normalized here -- no content is
// dropped that formatUnfilledSlotDiagnostics didn't already truncate.
const MAX_DIAGNOSTIC_ERROR_MESSAGE_LENGTH = 6500;
const sanitizeDiagnosticErrorForClient = message => {
  const normalized = String(message ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return 'The job failed unexpectedly.';
  return normalized.length > MAX_DIAGNOSTIC_ERROR_MESSAGE_LENGTH ? `${normalized.slice(0, MAX_DIAGNOSTIC_ERROR_MESSAGE_LENGTH)}…` : normalized;
};

// Shared by every production job-runner catch block below: releases any DB reservation, cleans up
// disposable temp artifacts, classifies the failure into a high-level UI error code, logs full
// diagnostics server-side, and records a bounded, secret-free error message on the job.
const handleJobFailure = async ({ job, store, error, poolReserved = false }) => {
  const stage = store.get(job.id)?.stage;
  if (poolReserved) await releaseReservation(job.id).catch(releaseError => log('pool.release_failed', { jobId: job.id, message: redactConnectionSecrets(releaseError.message) }));
  cleanupFailedJobArtifacts(job);
  const errorCode = classifyJobError(error, stage);
  // A DB error (e.g. selectContentPlan/commitPlanUsage/releaseReservation hitting a connection
  // failure mid-job) can interpolate DATABASE_URL, password included, into error.message/.stack --
  // the same class of leak startup.js already guards migration errors against. This is the general
  // job-failure path, reached by EVERY job, and `error` is logged AND (via sanitizeErrorForClient
  // below) sent verbatim to the unauthenticated GET /api/jobs/:id response, so it must be redacted
  // here too, not just at startup.
  const safeMessage = redactConnectionSecrets(error.message); const safeStack = redactConnectionSecrets(error.stack);
  log('job.failed', { jobId: job.id, stage, errorCode, message: safeMessage, stack: safeStack });
  const clientMessage = errorCode === 'IMAGE_SELECTION_EXHAUSTED' ? sanitizeDiagnosticErrorForClient(safeMessage) : sanitizeErrorForClient(safeMessage);
  store.update(job.id, { status: 'failed', stage: 'failed', error: clientMessage, errorCode });
};

const relativeMetadata = (items, workspace) => items.map(item => ({ ...item, localPath: path.relative(workspace, item.localPath) }));
// The one authoritative, whole-video duration gate: 60s minus 1.5s headroom, matching the product
// requirement that the finished video stay safely under the 60s Shorts limit. Per-scene duration is
// no longer capped in isolation (see audio.js's buildSceneTimeline) -- a scene with unusually long
// narration is fine as long as the OTHER scenes leave enough room in this shared total.
export const PRODUCTION_DURATION_CEILING_SECONDS = 58.5;
// Exported (and kept pure/synchronous) so it can be tested directly against a hand-built timeline,
// without needing a real or stubbed TTS call: proves the global ceiling -- and only the global
// ceiling -- can raise DURATION_BUDGET_EXCEEDED, regardless of how long any single scene is.
export const assertWithinProductionDurationCeiling = timeline => {
  if (timeline.totalDuration > PRODUCTION_DURATION_CEILING_SECONDS) {
    throw new DurationVerificationError(`Projected total duration ${timeline.totalDuration.toFixed(3)}s across all ${timeline.scenes.length} scenes exceeds the ${PRODUCTION_DURATION_CEILING_SECONDS}s safe production ceiling.`, { totalDuration: timeline.totalDuration, sceneCount: timeline.scenes.length });
  }
  return true;
};
// Synthesizes real narration for every scene (no pre-TTS budget/compression -- that estimate, used
// only to bias which already-ready questions get selected from the pool, is advisory; see
// question-pool.js/duration-estimate.js), builds the timeline from those REAL measured durations,
// and checks the result against the one authoritative whole-video ceiling above. A pure TTS failure
// (audio couldn't be produced at all) keeps its own TTS_FAILED classification instead of being
// relabeled as a duration problem.
const buildProductionVoiceTimeline = async ({ plan, config, workspace, onProgress }) => {
  const voiceovers = await generateVoiceovers({ plan, audioDir: path.join(workspace, 'audio'), voice: config.edgeVoice, rate: config.edgeVoiceRate, timeoutMs: config.ttsTimeoutMs, concurrency: config.ttsConcurrency, onProgress });
  const timeline = buildSceneTimeline({ voiceovers, baseDuration: config.secondsPerQuestion, voicePaddingSeconds: config.voicePaddingSeconds });
  assertWithinProductionDurationCeiling(timeline);
  return { voiceovers, timeline };
};
const plainLogValue = value => String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(/\r?\n/g, ' ');
const logSelectedImageDiagnostics = (assets, jobId) => {
  for (const asset of assets) {
    const provider = asset.selectedProvider === 'DuckDuckGo Images' ? 'DuckDuckGo' : asset.selectedProvider || asset.provider || 'unknown';
    console.info(`WYR_SELECTED_IMAGE | Q${asset.questionIndex + 1}${asset.slot} | provider=${provider} | domain=${plainLogValue(asset.sourceDomain || 'unknown')} | option="${plainLogValue(asset.text)}" | query="${plainLogValue(asset.selectedQuery || asset.queryUsed)}" | quality=${asset.qualityScore ?? 'unknown'} | relevance=${asset.relevanceScore ?? 'unknown'} | fallback="${plainLogValue(asset.fallbackReason || '')}"`);
  }
  const selectedCounts = assets.reduce((counts, asset) => {
    const provider = asset.selectedProvider || asset.provider;
    if (provider === 'DuckDuckGo Images') counts.DuckDuckGo += 1;
    if (provider === 'Pexels') counts.Pexels += 1;
    return counts;
  }, { DuckDuckGo: 0, Pexels: 0 });
  const rejected = assets.reduce((count, asset) => count + (asset.candidateDiagnostics?.filter(candidate => !candidate.accepted || !candidate.validAsset).length || 0) + (asset.rejectionReasons?.length || 0), 0);
  console.info(`WYR_IMAGE_JOB_SUMMARY | jobId=${plainLogValue(jobId)} | selected=${assets.length} | DuckDuckGo=${selectedCounts.DuckDuckGo} | Pexels=${selectedCounts.Pexels} | rejected=${rejected}`);
};

export const runPipeline = async ({ job, store, config, preparedPlan = null, selectionState = null, preparedAssets = null, poolReserved = false }) => {
  const update = changes => store.update(job.id, changes);
  try {
    assertProviderConfig(config); log('job.started', { jobId: job.id, contentProvider: 'groq', model: config.groqModel, imageProvider: 'DuckDuckGo Images', imageFallbackProvider: 'Pexels', webImageFallback: config.webImageFallbackEnabled ? 'DuckDuckGo Images' : 'disabled', providerOrder: IMAGE_SELECTION_DEFAULTS.providerOrder, imageRequestTimeoutMs: config.timeoutMs, imageSearchRetries: config.imageSearchRetries, imageCandidateLimit: IMAGE_SELECTION_DEFAULTS.maxRankedCandidates, imageQualityThreshold: IMAGE_SELECTION_DEFAULTS.pexelsQualityThreshold, imageMinimumResolution: `${IMAGE_SELECTION_DEFAULTS.minimumWidth}x${IMAGE_SELECTION_DEFAULTS.minimumHeight}`, imageRecoveryQueryRounds: config.imageRecoveryQueryRounds, imageRecoveryMaxRequests: config.imageRecoveryMaxRequests, imageRecoveryMaxMs: config.imageRecoveryMaxMs, voice: config.edgeVoice, pexelsConcurrency: config.pexelsConcurrency, ttsConcurrency: config.ttsConcurrency, sceneRenderConcurrency: config.sceneRenderConcurrency, ffmpegThreads: config.ffmpegThreads });
    update({ status: 'generating_content', stage: 'generating_content', progress: 5 });
    const provider = new GroqContentProvider({ apiKey: config.groqApiKey, model: config.groqModel, timeoutMs: config.timeoutMs });
    const historyStore = new ContentHistoryStore(config.contentHistoryPath);
    const generated = preparedPlan ? null : await generateProductionPlan({ provider, historyStore, questionCount: config.questionCount, maxAttempts: config.contentGenerationRetries, rateLimitPolicy: { maxRetries: config.groqRateLimitRetries, maxWaitMs: config.groqRateLimitMaxWaitMs } });
    const plan = preparedPlan || addIllustrativePercentages(generated); writeJsonAtomic(path.join(job.workspace, 'plan.json'), plan); update({ topic: plan.topic, progress: 14 });

    const imageSelectionStarted = Date.now();
    // preparedAssets is set only by runAutomaticPipeline, which already ran selection AND download
    // itself (with per-question replacement on exhaustion -- see downloadImagesWithReplacement) --
    // skip both here (including the searching_images/downloading_assets progress updates, already
    // reported by the caller) rather than downloading a second time. The manual-review caller
    // (wyr-server.js) still passes selectionState (no pool reservation, replacement not
    // applicable), and prepareImageSelection's own debug path still passes neither, exactly as
    // before this change.
    let selectedAssets;
    if (preparedAssets) {
      selectedAssets = preparedAssets;
    } else {
      update({ status: 'searching_images', stage: 'searching_images', progress: 16 });
      const imageProvider = new PexelsImageProvider({ apiKey: config.pexelsApiKey, timeoutMs: config.timeoutMs });
      const webImageProvider = config.webImageFallbackEnabled ? new DuckDuckGoImageProvider({ timeoutMs: Math.min(config.timeoutMs, 12_000) }) : null;
      selectedAssets = selectionState
        ? await downloadSelectedCandidates({ selection: selectionState, assetsDir: path.join(job.workspace, 'assets'), config })
        : await findAndDownloadImages({ plan, provider: imageProvider, webProvider: webImageProvider, visualQueryProvider: provider, assetsDir: path.join(job.workspace, 'assets'), maxRetries: config.imageSearchRetries, concurrency: config.pexelsConcurrency, recovery: { alternateQueryRounds: config.imageRecoveryQueryRounds, maxProviderRequests: config.imageRecoveryMaxRequests, maxWallClockMs: config.imageRecoveryMaxMs }, onProgress: (done, total) => update({ status: 'downloading_assets', stage: 'downloading_assets', progress: 18 + Math.round(done / total * 28) }) });
    }
    const imageSelectionMs = Date.now() - imageSelectionStarted;
    if (selectedAssets.length !== plan.questions.length * 2) throw new Error(`Expected ${plan.questions.length * 2} selected images before locking; received ${selectedAssets.length}.`);
    const assets = lockSelectedImageAssets({ assets: selectedAssets, workspace: job.workspace });
    await createImageReviewArtifacts({ assets, workspace: job.workspace });
    log('image.selection.completed', { jobId: job.id, durationMs: imageSelectionMs, selectedCount: assets.length, providerOrder: IMAGE_SELECTION_DEFAULTS.providerOrder, candidateLimits: { maxRankedCandidates: IMAGE_SELECTION_DEFAULTS.maxRankedCandidates, maxSearchQueries: config.imageSearchRetries + 1 }, qualityThreshold: IMAGE_SELECTION_DEFAULTS.pexelsQualityThreshold, minimumResolution: `${IMAGE_SELECTION_DEFAULTS.minimumWidth}x${IMAGE_SELECTION_DEFAULTS.minimumHeight}`, requestTimeoutMs: config.timeoutMs, webFallbackEnabled: config.webImageFallbackEnabled });
    for (const asset of assets) log('image.selected', { jobId: job.id, question: asset.questionIndex + 1, slot: asset.slot, option: asset.text, providerAttemptOrder: asset.providerAttemptOrder, selectedProvider: asset.selectedProvider, selectedQuery: asset.selectedQuery, sourceDomain: asset.sourceDomain, candidateCount: asset.candidateCount, fallbackReason: asset.fallbackReason, sha256: asset.sha256 });
    const providerIds = assets.map(asset => `${asset.provider}:${asset.id}`); const sourceUrls = assets.map(asset => asset.originalImageUrl || asset.downloadUrl);
    if (assets.length !== plan.questions.length * 2 || new Set(providerIds).size !== assets.length || new Set(sourceUrls).size !== assets.length) throw new Error(`Expected ${plan.questions.length * 2} unique images; received ${assets.length}.`);
    writeJsonAtomic(path.join(job.workspace, 'assets.json'), relativeMetadata(assets, job.workspace));
    const providers = [...new Set(assets.map(asset => asset.provider))];
    writeJsonAtomic(path.join(job.workspace, 'credits.json'), { provider: providers.length === 1 ? providers[0] : 'Mixed', providers, photos: assets.map(asset => ({ question: asset.questionIndex + 1, slot: asset.slot, id: asset.id, provider: asset.provider, photographer: asset.photographer, photographerUrl: asset.photographerUrl, photoUrl: asset.sourcePageUrl || asset.photoUrl, sourcePageUrl: asset.sourcePageUrl, originalImageUrl: asset.originalImageUrl, sourceDomain: asset.sourceDomain, width: asset.width, height: asset.height, license: asset.license || 'unknown', licenseUrl: asset.licenseUrl || null, usageRights: asset.usageRights || 'unknown', sha256: asset.sha256, queryUsed: asset.queryUsed })) });

    update({ status: 'generating_voice', stage: 'generating_voice', progress: 49 });
    const { voiceovers, timeline } = await buildProductionVoiceTimeline({ plan, config, workspace: job.workspace, onProgress: (done, total) => update({ progress: 49 + Math.round(done / total * 16) }) });
    writeJsonAtomic(path.join(job.workspace, 'voiceovers.json'), relativeMetadata(voiceovers, job.workspace));

    update({ status: 'building_timeline', stage: 'building_timeline', progress: 67 });
    log('timeline.built', { jobId: job.id, totalDuration: timeline.totalDuration, sceneCount: timeline.scenes.length, productionDurationCeiling: PRODUCTION_DURATION_CEILING_SECONDS });
    const sfx = await createLocalSfx({ audioDir: path.join(job.workspace, 'audio') });
    const sfxSchedule = buildSfxSchedule(timeline); const countdownSchedule = buildCountdownSchedule(timeline);
    writeJsonAtomic(path.join(job.workspace, 'timeline.json'), timeline); writeJsonAtomic(path.join(job.workspace, 'sfx.json'), { provider: sfx.provider, slide: { ...sfx.slide, localPath: path.relative(job.workspace, sfx.slide.localPath) }, reveal: { ...sfx.reveal, localPath: path.relative(job.workspace, sfx.reveal.localPath) }, whoosh: { ...sfx.whoosh, localPath: path.relative(job.workspace, sfx.whoosh.localPath) }, tick: { ...sfx.tick, localPath: path.relative(job.workspace, sfx.tick.localPath) }, schedule: sfxSchedule, countdownSchedule });
    buildComposition({ plan, assets, timeline, voiceovers, sfx, workspace: job.workspace });

    update({ status: 'rendering', stage: 'rendering', progress: 71 });
    const outputPath = await renderVideo({ plan, assets, timeline, voiceovers, sfx, sfxSchedule, countdownSchedule, workspace: job.workspace, sceneConcurrency: config.sceneRenderConcurrency, ffmpegThreads: config.ffmpegThreads, onProgress: (done, total) => update({ progress: 71 + Math.round(done / total * 22) }) });
    update({ status: 'verifying', stage: 'verifying', progress: 95 });
    const verification = await verifyVideo(outputPath, { expectedSceneCount: plan.questions.length, expectedDuration: timeline.totalDuration, renderDir: path.join(job.workspace, 'render'), timeline, sfxSchedule, countdownSchedule });
    writeJsonAtomic(path.join(job.workspace, 'verification.json'), verification);
    update({ status: 'completed', stage: 'completed', progress: 100, outputPath, verification }); logSelectedImageDiagnostics(assets, job.id); log('job.completed', { jobId: job.id, outputPath, verification });
    // Pool bookkeeping only happens after a verified final MP4 -- a render/verify failure above
    // never increments used_count, and the reservation is released instead (see the catch block).
    if (poolReserved) await commitPlanUsage({ jobId: job.id, plan, duration: verification.duration ?? timeline.totalDuration }).catch(error => log('pool.commit_failed', { jobId: job.id, message: error.message }));
  } catch (error) {
    await handleJobFailure({ job, store, error, poolReserved });
  }
};

// Internal/debug only: generates content and an image selection, then stops for human review
// (reviewing_images) instead of rendering. Not used by the normal production entry point
// (POST /api/jobs uses runAutomaticPipeline below) — kept only for manual debugging of image
// selection via the /selection, /images/:slot, /replace, /select, and /more endpoints.
export const prepareImageSelection = async ({ job, store, config }) => {
  const update = changes => store.update(job.id, changes);
  try {
    assertProviderConfig(config);
    update({ status: 'generating_content', stage: 'generating_content', progress: 5 });
    const provider = new GroqContentProvider({ apiKey: config.groqApiKey, model: config.groqModel, timeoutMs: config.timeoutMs });
    const historyStore = new ContentHistoryStore(config.contentHistoryPath);
    const generated = await generateProductionPlan({ provider, historyStore, questionCount: config.questionCount, maxAttempts: config.contentGenerationRetries, rateLimitPolicy: { maxRetries: config.groqRateLimitRetries, maxWaitMs: config.groqRateLimitMaxWaitMs } });
    const plan = addIllustrativePercentages(generated); writeJsonAtomic(path.join(job.workspace, 'plan.json'), plan); update({ topic: plan.topic, progress: 18 });
    update({ status: 'searching_images', stage: 'searching_images', progress: 22 });
    const selection = await createImageSelection({ plan, config });
    update({ status: 'reviewing_images', stage: 'reviewing_images', progress: 35, selection });
  } catch (error) {
    await handleJobFailure({ job, store, error });
  }
};

// Bounded: an initial attempt plus exactly one retry with a fresh already-ready question set. Only
// reached if the COMPLETE scene timeline -- built from every scene's REAL measured narration --
// still doesn't fit PRODUCTION_DURATION_CEILING_SECONDS; ordinary per-scene variance is absorbed by
// buildSceneTimeline/assertWithinProductionDurationCeiling and never gets here at all.
const MAX_DURATION_RETRY_ATTEMPTS = 2;

// Thrown only after the bounded per-question replacement loop below (replaceUnfillableQuestions)
// still couldn't assemble a complete plan -- distinct from ContentPoolExhaustedError's
// CONTENT_POOL_EMPTY (thrown by content-source.js when the pool doesn't even have enough READY
// rows to start a selection at all): this means enough rows existed, but too many of them
// individually failed image selection for the bounded replacement budget to resolve.
export class QuestionReplacementExhaustedError extends Error {
  constructor(message, details = {}) { super(message); this.code = 'CONTENT_POOL_EXHAUSTED'; Object.assign(this, details); }
}

// Bounded per-question recovery for image-selection exhaustion: a question that can't obtain both
// valid, relevant option images (after createImageSelection's own full Tier 1-5 fallback search --
// see the comment that used to sit at the old immediate-throw call site below) is rejected from the
// plan and swapped for another already-READY question from the pool, rather than either failing the
// whole job immediately or ever accepting an unrelated filler image. A replacement question's images
// still go through the EXACT same createImageSelection pipeline as every other question -- no
// relevance/quality gate is bypassed or weakened for it. Bounded to config.questionReplacementMaxAttempts
// (env WYR_MAX_QUESTION_REPLACEMENT_ATTEMPTS, default 12 -- see config.js) total swaps across the
// whole job (not per-question), so a pool that's pathologically full of unfillable questions can
// never loop forever; if the budget runs out, or the pool has no more candidates to offer, the
// caller fails clearly with CONTENT_POOL_EXHAUSTED instead of looping.
const unfilledQuestionIndexes = selection => new Set((selection.unfilledDiagnostics || []).map(diagnostic => diagnostic.scene - 1));
// rejectedPoolIds/attempts are optional so the SAME job-wide budget/never-reoffer set can be
// threaded in from a later stage (see downloadImagesWithReplacement below, which re-enters this loop
// after a DOWNLOAD-stage -- not just a selection-stage -- exhaustion) without ever resetting either.
const replaceUnfillableQuestions = async ({ job, config, plan, selection, selectImages, rejectedPoolIds = new Set(), attempts = 0 }) => {
  let currentPlan = plan; let currentSelection = selection;
  let wordingRejectedCount = plan.contentQuality?.wordingRejectedCount || 0;
  const maxAttempts = config.questionReplacementMaxAttempts;
  while (currentSelection.selectedCount !== currentSelection.total && attempts < maxAttempts) {
    const badIndex = [...unfilledQuestionIndexes(currentSelection)][0];
    const badQuestion = currentPlan.questions[badIndex];
    attempts += 1;
    log('content.question_replacement_attempt', { jobId: job.id, questionIndex: badIndex, rejectedPoolId: badQuestion.poolId, attempt: attempts, maxAttempts });
    // Release THIS question only -- never consumed as 'used', and never re-offered to this same
    // job again (rejectedPoolIds, folded into excludeIds below). The other already-reserved
    // questions in this job are left completely untouched.
    rejectedPoolIds.add(badQuestion.poolId);
    await releaseQuestionReservation({ jobId: job.id, poolId: badQuestion.poolId });
    const excludeIds = [...new Set([...currentPlan.questions.map(question => question.poolId), ...rejectedPoolIds])];
    const otherQuestions = currentPlan.questions.filter((_, index) => index !== badIndex);
    const inPlanMotifs = new Set(otherQuestions.flatMap(question => questionMotifs(question)));
    const fantasyCapReached = otherQuestions.some(question => isFantasyQuestion(question));
    const { candidate: replacementRow, wordingRejectedCount: skippedForWording } = await reserveReplacementQuestion({ jobId: job.id, excludeIds, inPlanMotifs, fantasyCapReached });
    wordingRejectedCount += skippedForWording;
    if (!replacementRow) { log('content.question_replacement_unavailable', { jobId: job.id, questionIndex: badIndex, attempt: attempts }); break; }
    const replacementQuestion = rowToQuestion(replacementRow, badIndex);
    const nextQuestions = currentPlan.questions.map((question, index) => (index === badIndex ? replacementQuestion : question));
    const nextPlan = addIllustrativePercentages({ ...currentPlan, questions: nextQuestions });
    const miniSelection = await selectImages({ plan: { questions: [nextPlan.questions[badIndex]] }, config });
    const nextSlots = { ...currentSelection.slots, ...miniSelection.slots };
    const selectedCount = Object.values(nextSlots).filter(slot => slot.selectedId).length;
    const unfilledDiagnostics = Object.values(nextSlots).filter(slot => !slot.selectedId).map(slot => buildSlotDiagnostics(slot));
    currentPlan = nextPlan;
    currentSelection = { ...currentSelection, slots: nextSlots, selectedCount, unfilledDiagnostics };
    log('content.question_replaced', { jobId: job.id, questionIndex: badIndex, newPoolId: replacementRow.id, selectedCount, total: currentSelection.total, attempt: attempts });
  }
  return { plan: currentPlan, selection: currentSelection, attempts, wordingRejectedCount, rejectedPoolIds };
};

// Final image-acquisition stage for the automatic path: downloads/validates every already-selected
// candidate (image-picker.js's downloadSelectedCandidates -- the EXACT same relevance/quality/
// framing gates as selection; nothing here weakens or bypasses them). This is a SEPARATE stage from
// selection above, and previously its own IMAGE_SELECTION_EXHAUSTED (thrown per-slot once that
// slot's own candidate pool -- even widened -- fails download/validation for every ranked
// candidate; see image-picker.js) escaped straight to the client instead of ever reaching
// replaceUnfillableQuestions, because runPipeline called it internally, after
// replaceUnfillableQuestions had already finished. A slot that exhausts HERE is now treated exactly
// like an unfilled SELECTION slot: that one question is rejected and swapped via
// replaceUnfillableQuestions (sharing the SAME job-wide attempts budget and rejected-question set),
// then downloading is retried against the resulting fully-selected plan. IMAGE_SELECTION_EXHAUSTED
// is therefore never surfaced while replacement attempts remain; only a genuinely exhausted
// replacement budget (or a pool with nothing left to offer) falls through to the caller's existing
// CONTENT_POOL_EXHAUSTED path -- see runAutomaticPipeline below, which applies the identical
// `selectedCount !== total` check to this stage's result as it already does for selection.
const downloadImagesWithReplacement = async ({ job, config, plan, selection, selectImages, rejectedPoolIds, attempts, wordingRejectedCount }) => {
  let currentPlan = plan; let currentSelection = selection; let currentAttempts = attempts; let currentWordingRejectedCount = wordingRejectedCount;
  for (;;) {
    try {
      const assets = await downloadSelectedCandidates({ selection: currentSelection, assetsDir: path.join(job.workspace, 'assets'), config });
      return { assets, plan: currentPlan, selection: currentSelection, attempts: currentAttempts, wordingRejectedCount: currentWordingRejectedCount };
    } catch (error) {
      const badIndex = Number(error?.scene) - 1;
      if (error?.code !== 'IMAGE_SELECTION_EXHAUSTED' || !Number.isInteger(badIndex) || !currentPlan.questions[badIndex]) throw error;
      log('content.image_download_exhausted', { jobId: job.id, questionIndex: badIndex, slot: error.option, attempt: currentAttempts + 1, maxAttempts: config.questionReplacementMaxAttempts });
      // Reset just this question's two slots back to unfilled so replaceUnfillableQuestions' own
      // loop -- which already knows how to keep swapping if a REPLACEMENT also fails selection --
      // picks it up exactly like any other unfilled slot, sharing the same attempts/rejectedPoolIds.
      const badSlotKeys = Object.keys(currentSelection.slots).filter(key => currentSelection.slots[key].questionIndex === badIndex);
      const resetSlots = { ...currentSelection.slots };
      for (const key of badSlotKeys) resetSlots[key] = { ...resetSlots[key], selectedId: null };
      const resetSelection = { ...currentSelection, slots: resetSlots, selectedCount: Object.values(resetSlots).filter(slot => slot.selectedId).length };
      const wordingBaseBefore = currentPlan.contentQuality?.wordingRejectedCount || 0;
      const replaced = await replaceUnfillableQuestions({ job, config, plan: currentPlan, selection: resetSelection, selectImages, rejectedPoolIds, attempts: currentAttempts });
      currentAttempts = replaced.attempts;
      currentWordingRejectedCount += replaced.wordingRejectedCount - wordingBaseBefore;
      currentPlan = replaced.plan; currentSelection = replaced.selection;
      if (currentSelection.selectedCount !== currentSelection.total) {
        return { assets: null, plan: currentPlan, selection: currentSelection, attempts: currentAttempts, wordingRejectedCount: currentWordingRejectedCount };
      }
      // Selection is fully filled again (either the original bad question's own replacement, or a
      // chain of replacements if a replacement itself also failed selection) -- loop back and retry
      // downloadSelectedCandidates against the complete, now-valid selection.
    }
  }
};
// Normal production entry point: selects config.questionCount diverse, pre-validated questions
// straight from the PostgreSQL pool (see content-source.js) -- no live Groq call in the common
// case -- automatically searches/scores/selects all of that plan's images, two per question (same
// createImageSelection auto-selection used by the debug path above — Pixabay primary, Pexels
// fallback, unchanged scoring), then immediately hands off to the existing runPipeline to lock
// assets, generate voice, build the timeline, render, and verify. No human approval step; never
// stops at reviewing_images.
//
// `runJobPipeline`/`selectPlan`/`selectImages` are injectable (default to the real implementations)
// purely so the bounded duration-retry control flow below can be exercised in tests without a real
// TTS/image-provider round trip.
export const runAutomaticPipeline = async ({ job, store, config, runJobPipeline = runPipeline, selectPlan = selectContentPlan, selectImages = createImageSelection }) => {
  const update = changes => store.update(job.id, changes);
  let poolReserved = false;
  try {
    assertProviderConfig(config);
    for (let attempt = 1; attempt <= MAX_DURATION_RETRY_ATTEMPTS; attempt += 1) {
      update({ status: 'generating_content', stage: 'generating_content', progress: 5 });
      let plan = await selectPlan({ job, config });
      poolReserved = true;
      writeJsonAtomic(path.join(job.workspace, 'plan.json'), plan); update({ topic: plan.topic, progress: 18 });
      update({ status: 'searching_images', stage: 'searching_images', progress: 22 });
      let selection = await selectImages({ plan, config });
      let wordingRejectedCount = plan.contentQuality?.wordingRejectedCount || 0;
      let imageReplacementAttempts = 0;
      let rejectedPoolIds = new Set();
      if (selection.selectedCount !== selection.total) {
        // selectImages (createImageSelection) already ran its own bounded Tiers 2-5 gap-fill for
        // every slot that came out of its strict Tier-1 pass unfilled -- see image-picker.js's
        // fillUnfilledSlot, including Tier 5's Groq-based semantic-to-visual-concept translation
        // for options whose literal wording is not photographable at all (e.g. "erased", "grows")
        // -- so reaching here means those tiers were genuinely exhausted for whichever question(s)
        // still have an unfilled slot, not that they were never attempted. A question that can't
        // obtain both valid images is rejected and replaced with another READY question (see
        // replaceUnfillableQuestions above) rather than failing the whole job or ever accepting an
        // unrelated filler image.
        const result = await replaceUnfillableQuestions({ job, config, plan, selection, selectImages });
        plan = result.plan; selection = result.selection; imageReplacementAttempts = result.attempts; wordingRejectedCount = result.wordingRejectedCount; rejectedPoolIds = result.rejectedPoolIds;
      }
      // Concise, secret-free counters only -- never raw error messages/stacks from elsewhere in the
      // job (those could carry a redacted-but-still-sensitive DB error; see
      // redactConnectionSecrets/handleJobFailure) and never anything from config/credentials.
      const throwContentPoolExhausted = () => {
        const unfilledDiagnostics = selection.unfilledDiagnostics || [];
        const unfilledQuestionCount = unfilledQuestionIndexes(selection).size;
        const validQuestionsAssembled = plan.questions.length - unfilledQuestionCount;
        log('content.question_replacement_exhausted', { jobId: job.id, selectedCount: selection.selectedCount, total: selection.total, unfilledDiagnostics, wordingRejectedCount, imageReplacementAttempts });
        const summary = `CONTENT_POOL_EXHAUSTED: Could not assemble ${config.questionCount} quality-valid questions with ${selection.total} relevant usable images.`;
        const diagnostics = `wording-rejected: ${wordingRejectedCount}, image-rejected: ${imageReplacementAttempts}, replacement attempts used: ${imageReplacementAttempts}/${config.questionReplacementMaxAttempts}, valid questions assembled: ${validQuestionsAssembled}/${config.questionCount}, valid images assembled: ${selection.selectedCount}/${selection.total}`;
        const diagnosticsReport = formatUnfilledSlotDiagnostics(unfilledDiagnostics);
        const message = [summary, diagnostics, diagnosticsReport].filter(Boolean).join('\n\n');
        throw new QuestionReplacementExhaustedError(message, { selectedCount: selection.selectedCount, unfilledSlots: unfilledDiagnostics.map(diag => diag.slot), unfilledDiagnostics, wordingRejectedCount, imageRejectedCount: imageReplacementAttempts, replacementAttemptsUsed: imageReplacementAttempts, validQuestionsAssembled, validImagesAssembled: selection.selectedCount });
      };
      if (selection.selectedCount !== selection.total) throwContentPoolExhausted();
      // Final image acquisition (download + validate the already-selected candidates). Any
      // slot-level IMAGE_SELECTION_EXHAUSTED here is handled the SAME way as a selection-stage
      // exhaustion above -- swap the question via replaceUnfillableQuestions and retry -- so it
      // never reaches the client while replacement attempts remain (see
      // downloadImagesWithReplacement). Only a genuinely exhausted replacement budget falls through
      // to the identical CONTENT_POOL_EXHAUSTED path used above.
      update({ status: 'downloading_assets', stage: 'downloading_assets', progress: 30 });
      const downloadResult = await downloadImagesWithReplacement({ job, config, plan, selection, selectImages, rejectedPoolIds, attempts: imageReplacementAttempts, wordingRejectedCount });
      plan = downloadResult.plan; selection = downloadResult.selection; imageReplacementAttempts = downloadResult.attempts; wordingRejectedCount = downloadResult.wordingRejectedCount;
      if (selection.selectedCount !== selection.total) throwContentPoolExhausted();
      await runJobPipeline({ job, store, config, preparedPlan: plan, preparedAssets: downloadResult.assets, poolReserved });
      const result = store.get(job.id);
      if (result?.status !== 'failed' || result?.errorCode !== 'DURATION_BUDGET_EXCEEDED' || attempt === MAX_DURATION_RETRY_ATTEMPTS) return;
      // The complete scene timeline didn't fit the safe ceiling even with every scene at its real
      // narration length. Retry once with a fresh already-ready question set from the pool --
      // never a rewrite/regeneration of question text, never a Groq call. runJobPipeline's own
      // failure handling already released this attempt's reservation and cleaned up its temp
      // assets, so the next loop iteration starts from a clean slate.
      poolReserved = false;
      log('duration.global_budget_retry', { jobId: job.id, attempt, previousError: result.error });
    }
  } catch (error) {
    await handleJobFailure({ job, store, error, poolReserved });
  }
};

export const runFixturePipeline = async ({ job, store, config }) => {
  const update = changes => store.update(job.id, changes);
  try {
    update({ status: 'downloading_assets', stage: 'downloading_assets', progress: 10 });
    const plan = createFixturePlan(config.questionCount); const assets = await createFixtureAssets({ assetsDir: path.join(job.workspace, 'assets'), count: config.questionCount });
    if (assets.length !== config.questionCount * 2) throw new Error(`Fixture must contain ${config.questionCount * 2} images; found ${assets.length}.`);
    writeJsonAtomic(path.join(job.workspace, 'plan.json'), plan); writeJsonAtomic(path.join(job.workspace, 'assets.json'), assets);
    update({ topic: plan.topic, progress: 40, status: 'building_timeline', stage: 'building_timeline' });
    buildComposition({ plan, assets, duration: config.secondsPerQuestion, workspace: job.workspace });
    update({ status: 'rendering', stage: 'rendering', progress: 55 });
    const outputPath = await renderVideo({ plan, assets, duration: config.secondsPerQuestion, workspace: job.workspace, sceneConcurrency: config.sceneRenderConcurrency, ffmpegThreads: config.ffmpegThreads, onProgress: (done, total) => update({ progress: 55 + Math.round(done / total * 40) }) });
    update({ status: 'verifying', stage: 'verifying', progress: 96 });
    const verification = await verifyVideo(outputPath, { expectedSceneCount: plan.questions.length, expectedDuration: plan.questions.length * config.secondsPerQuestion, renderDir: path.join(job.workspace, 'render') });
    writeJsonAtomic(path.join(job.workspace, 'verification.json'), verification); update({ status: 'completed', stage: 'completed', progress: 100, outputPath, verification });
  } catch (error) { update({ status: 'failed', stage: 'failed', error: error.message }); }
};

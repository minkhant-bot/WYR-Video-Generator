import path from 'node:path';
import { writeJsonAtomic, log } from './utils.js';
import { assertProviderConfig } from './config.js';
import { GroqContentProvider, addIllustrativePercentages } from './content.js';
import { ContentHistoryStore, generateProductionPlan } from './content-engine.js';
import { PexelsImageProvider, findAndDownloadImages, createImageReviewArtifacts, IMAGE_SELECTION_DEFAULTS, lockSelectedImageAssets } from './images.js';
import { DuckDuckGoImageProvider } from './web-images.js';
import { buildComposition, renderVideo, verifyVideo } from './media.js';
import { buildCountdownSchedule, buildSceneTimeline, buildSfxSchedule, createLocalSfx, generateVoiceovers } from './audio.js';
import { createFixturePlan, createFixtureAssets } from './fixtures.js';

const relativeMetadata = (items, workspace) => items.map(item => ({ ...item, localPath: path.relative(workspace, item.localPath) }));

export const runPipeline = async ({ job, store, config }) => {
  const update = changes => store.update(job.id, changes);
  try {
    assertProviderConfig(config); log('job.started', { jobId: job.id, contentProvider: 'groq', model: config.groqModel, imageProvider: 'pexels', webImageFallback: config.webImageFallbackEnabled ? 'DuckDuckGo Images' : 'disabled', providerOrder: IMAGE_SELECTION_DEFAULTS.providerOrder, imageRequestTimeoutMs: config.timeoutMs, imageSearchRetries: config.imageSearchRetries, imageCandidateLimit: IMAGE_SELECTION_DEFAULTS.maxRankedCandidates, imageQualityThreshold: IMAGE_SELECTION_DEFAULTS.pexelsQualityThreshold, imageMinimumResolution: `${IMAGE_SELECTION_DEFAULTS.minimumWidth}x${IMAGE_SELECTION_DEFAULTS.minimumHeight}`, imageRecoveryQueryRounds: config.imageRecoveryQueryRounds, imageRecoveryMaxRequests: config.imageRecoveryMaxRequests, imageRecoveryMaxMs: config.imageRecoveryMaxMs, voice: config.edgeVoice, pexelsConcurrency: config.pexelsConcurrency, ttsConcurrency: config.ttsConcurrency, sceneRenderConcurrency: config.sceneRenderConcurrency, ffmpegThreads: config.ffmpegThreads });
    update({ status: 'generating_content', stage: 'generating_content', progress: 5 });
    const provider = new GroqContentProvider({ apiKey: config.groqApiKey, model: config.groqModel, timeoutMs: config.timeoutMs });
    const historyStore = new ContentHistoryStore(config.contentHistoryPath);
    const generated = await generateProductionPlan({ provider, historyStore, questionCount: config.questionCount, maxAttempts: config.contentGenerationRetries, rateLimitPolicy: { maxRetries: config.groqRateLimitRetries, maxWaitMs: config.groqRateLimitMaxWaitMs } });
    const plan = addIllustrativePercentages(generated); writeJsonAtomic(path.join(job.workspace, 'plan.json'), plan); update({ topic: plan.topic, progress: 14 });

    update({ status: 'searching_images', stage: 'searching_images', progress: 16 });
    const imageProvider = new PexelsImageProvider({ apiKey: config.pexelsApiKey, timeoutMs: config.timeoutMs });
    const webImageProvider = config.webImageFallbackEnabled ? new DuckDuckGoImageProvider({ timeoutMs: Math.min(config.timeoutMs, 12_000) }) : null;
    const imageSelectionStarted = Date.now();
    const selectedAssets = await findAndDownloadImages({ plan, provider: imageProvider, webProvider: webImageProvider, visualQueryProvider: provider, assetsDir: path.join(job.workspace, 'assets'), maxRetries: config.imageSearchRetries, concurrency: config.pexelsConcurrency, recovery: { alternateQueryRounds: config.imageRecoveryQueryRounds, maxProviderRequests: config.imageRecoveryMaxRequests, maxWallClockMs: config.imageRecoveryMaxMs }, onProgress: (done, total) => update({ status: 'downloading_assets', stage: 'downloading_assets', progress: 18 + Math.round(done / total * 28) }) });
    const imageSelectionMs = Date.now() - imageSelectionStarted;
    if (selectedAssets.length !== plan.questions.length * 2) throw new Error(`Expected ${plan.questions.length * 2} selected images before locking; received ${selectedAssets.length}.`);
    const assets = lockSelectedImageAssets({ assets: selectedAssets, workspace: job.workspace });
    await createImageReviewArtifacts({ assets, workspace: job.workspace });
    log('image.selection.completed', { jobId: job.id, durationMs: imageSelectionMs, selectedCount: assets.length, providerOrder: IMAGE_SELECTION_DEFAULTS.providerOrder, candidateLimits: { maxRankedCandidates: IMAGE_SELECTION_DEFAULTS.maxRankedCandidates, maxSearchQueries: config.imageSearchRetries + 1 }, qualityThreshold: IMAGE_SELECTION_DEFAULTS.pexelsQualityThreshold, minimumResolution: `${IMAGE_SELECTION_DEFAULTS.minimumWidth}x${IMAGE_SELECTION_DEFAULTS.minimumHeight}`, requestTimeoutMs: config.timeoutMs, webFallbackEnabled: config.webImageFallbackEnabled });
    for (const asset of assets) log('image.selected', { jobId: job.id, question: asset.questionIndex + 1, slot: asset.slot, option: asset.text, provider: asset.provider, query: asset.queryUsed, sourceDomain: asset.sourceDomain, candidateCount: asset.candidateCount, fallbackReason: asset.fallbackReason, sha256: asset.sha256 });
    const providerIds = assets.map(asset => `${asset.provider}:${asset.id}`); const sourceUrls = assets.map(asset => asset.originalImageUrl || asset.downloadUrl);
    if (assets.length !== plan.questions.length * 2 || new Set(providerIds).size !== assets.length || new Set(sourceUrls).size !== assets.length) throw new Error(`Expected ${plan.questions.length * 2} unique images; received ${assets.length}.`);
    writeJsonAtomic(path.join(job.workspace, 'assets.json'), relativeMetadata(assets, job.workspace));
    const providers = [...new Set(assets.map(asset => asset.provider))];
    writeJsonAtomic(path.join(job.workspace, 'credits.json'), { provider: providers.length === 1 ? providers[0] : 'Mixed', providers, photos: assets.map(asset => ({ question: asset.questionIndex + 1, slot: asset.slot, id: asset.id, provider: asset.provider, photographer: asset.photographer, photographerUrl: asset.photographerUrl, photoUrl: asset.sourcePageUrl || asset.photoUrl, sourcePageUrl: asset.sourcePageUrl, originalImageUrl: asset.originalImageUrl, sourceDomain: asset.sourceDomain, width: asset.width, height: asset.height, license: asset.license || 'unknown', licenseUrl: asset.licenseUrl || null, usageRights: asset.usageRights || 'unknown', sha256: asset.sha256, queryUsed: asset.queryUsed })) });

    update({ status: 'generating_voice', stage: 'generating_voice', progress: 49 });
    const voiceovers = await generateVoiceovers({ plan, audioDir: path.join(job.workspace, 'audio'), voice: config.edgeVoice, rate: config.edgeVoiceRate, timeoutMs: config.ttsTimeoutMs, concurrency: config.ttsConcurrency, onProgress: (done, total) => update({ progress: 49 + Math.round(done / total * 16) }) });
    writeJsonAtomic(path.join(job.workspace, 'voiceovers.json'), relativeMetadata(voiceovers, job.workspace));

    update({ status: 'building_timeline', stage: 'building_timeline', progress: 67 });
    const timeline = buildSceneTimeline({ voiceovers, baseDuration: config.secondsPerQuestion, voicePaddingSeconds: config.voicePaddingSeconds, maximumSceneDuration: config.maximumSceneDuration });
    const sfx = await createLocalSfx({ audioDir: path.join(job.workspace, 'audio') });
    const sfxSchedule = buildSfxSchedule(timeline); const countdownSchedule = buildCountdownSchedule(timeline);
    writeJsonAtomic(path.join(job.workspace, 'timeline.json'), timeline); writeJsonAtomic(path.join(job.workspace, 'sfx.json'), { provider: sfx.provider, entrance: { ...sfx.entrance, localPath: path.relative(job.workspace, sfx.entrance.localPath) }, reveal: { ...sfx.reveal, localPath: path.relative(job.workspace, sfx.reveal.localPath) }, transition: { ...sfx.transition, localPath: path.relative(job.workspace, sfx.transition.localPath) }, countdownSequence: { ...sfx.countdownSequence, localPath: path.relative(job.workspace, sfx.countdownSequence.localPath) }, schedule: sfxSchedule, countdownSchedule });
    buildComposition({ plan, assets, timeline, voiceovers, sfx, workspace: job.workspace });

    update({ status: 'rendering', stage: 'rendering', progress: 71 });
    const outputPath = await renderVideo({ plan, assets, timeline, voiceovers, sfx, sfxSchedule, countdownSchedule, workspace: job.workspace, sceneConcurrency: config.sceneRenderConcurrency, ffmpegThreads: config.ffmpegThreads, onProgress: (done, total) => update({ progress: 71 + Math.round(done / total * 22) }) });
    update({ status: 'verifying', stage: 'verifying', progress: 95 });
    const verification = await verifyVideo(outputPath, { expectedSceneCount: plan.questions.length, expectedDuration: timeline.totalDuration, renderDir: path.join(job.workspace, 'render'), timeline, sfxSchedule, countdownSchedule });
    writeJsonAtomic(path.join(job.workspace, 'verification.json'), verification);
    update({ status: 'completed', stage: 'completed', progress: 100, outputPath, verification }); log('job.completed', { jobId: job.id, outputPath, verification });
  } catch (error) {
    log('job.failed', { jobId: job.id, stage: store.get(job.id)?.stage, message: error.message, stack: error.stack }); update({ status: 'failed', stage: 'failed', error: error.message });
  }
};

export const runFixturePipeline = async ({ job, store, config }) => {
  const update = changes => store.update(job.id, changes);
  try {
    update({ status: 'downloading_assets', stage: 'downloading_assets', progress: 10 });
    const plan = createFixturePlan(); const assets = await createFixtureAssets({ assetsDir: path.join(job.workspace, 'assets') });
    if (assets.length !== 16) throw new Error(`Fixture must contain 16 images; found ${assets.length}.`);
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

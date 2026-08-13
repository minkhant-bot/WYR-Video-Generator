import path from 'node:path';
import { writeJsonAtomic, log } from './utils.js';
import { assertProviderConfig } from './config.js';
import { GroqContentProvider, addIllustrativePercentages } from './content.js';
import { PexelsImageProvider, findAndDownloadImages } from './images.js';
import { buildComposition, renderVideo, verifyVideo } from './media.js';
import { buildCountdownSchedule, buildSceneTimeline, buildSfxSchedule, createLocalSfx, generateVoiceovers } from './audio.js';
import { createFixturePlan, createFixtureAssets } from './fixtures.js';

const relativeMetadata = (items, workspace) => items.map(item => ({ ...item, localPath: path.relative(workspace, item.localPath) }));

export const runPipeline = async ({ job, store, config }) => {
  const update = changes => store.update(job.id, changes);
  try {
    assertProviderConfig(config); log('job.started', { jobId: job.id, contentProvider: 'groq', model: config.groqModel, imageProvider: 'pexels', voice: config.edgeVoice });
    update({ status: 'generating_content', stage: 'generating_content', progress: 5 });
    const generated = await new GroqContentProvider({ apiKey: config.groqApiKey, model: config.groqModel, timeoutMs: config.timeoutMs }).generatePlan(config.questionCount);
    const plan = addIllustrativePercentages(generated); writeJsonAtomic(path.join(job.workspace, 'plan.json'), plan); update({ topic: plan.topic, progress: 14 });

    update({ status: 'searching_images', stage: 'searching_images', progress: 16 });
    const imageProvider = new PexelsImageProvider({ apiKey: config.pexelsApiKey, timeoutMs: config.timeoutMs });
    const assets = await findAndDownloadImages({ plan, provider: imageProvider, assetsDir: path.join(job.workspace, 'assets'), maxRetries: config.imageSearchRetries, onProgress: (done, total) => update({ status: 'downloading_assets', stage: 'downloading_assets', progress: 18 + Math.round(done / total * 28) }) });
    if (assets.length !== plan.questions.length * 2 || new Set(assets.map(asset => asset.id)).size !== assets.length) throw new Error(`Expected ${plan.questions.length * 2} unique Pexels photos; received ${assets.length}.`);
    writeJsonAtomic(path.join(job.workspace, 'assets.json'), relativeMetadata(assets, job.workspace));
    writeJsonAtomic(path.join(job.workspace, 'credits.json'), { provider: 'Pexels', providerUrl: 'https://www.pexels.com', photos: assets.map(asset => ({ question: asset.questionIndex + 1, slot: asset.slot, id: asset.id, photographer: asset.photographer, photographerUrl: asset.photographerUrl, photoUrl: asset.photoUrl, queryUsed: asset.queryUsed })) });

    update({ status: 'generating_voice', stage: 'generating_voice', progress: 49 });
    const voiceovers = await generateVoiceovers({ plan, audioDir: path.join(job.workspace, 'audio'), voice: config.edgeVoice, rate: config.edgeVoiceRate, timeoutMs: config.ttsTimeoutMs, onProgress: (done, total) => update({ progress: 49 + Math.round(done / total * 16) }) });
    writeJsonAtomic(path.join(job.workspace, 'voiceovers.json'), relativeMetadata(voiceovers, job.workspace));

    update({ status: 'building_timeline', stage: 'building_timeline', progress: 67 });
    const timeline = buildSceneTimeline({ voiceovers, baseDuration: config.secondsPerQuestion, voicePaddingSeconds: config.voicePaddingSeconds, maximumSceneDuration: config.maximumSceneDuration });
    const sfx = await createLocalSfx({ audioDir: path.join(job.workspace, 'audio') });
    const sfxSchedule = buildSfxSchedule(timeline); const countdownSchedule = buildCountdownSchedule(timeline);
    writeJsonAtomic(path.join(job.workspace, 'timeline.json'), timeline); writeJsonAtomic(path.join(job.workspace, 'sfx.json'), { provider: sfx.provider, entrance: { ...sfx.entrance, localPath: path.relative(job.workspace, sfx.entrance.localPath) }, reveal: { ...sfx.reveal, localPath: path.relative(job.workspace, sfx.reveal.localPath) }, transition: { ...sfx.transition, localPath: path.relative(job.workspace, sfx.transition.localPath) }, tick: { ...sfx.tick, localPath: path.relative(job.workspace, sfx.tick.localPath) }, schedule: sfxSchedule, countdownSchedule });
    buildComposition({ plan, assets, timeline, voiceovers, sfx, workspace: job.workspace });

    update({ status: 'rendering', stage: 'rendering', progress: 71 });
    const outputPath = await renderVideo({ plan, assets, timeline, voiceovers, sfx, sfxSchedule, countdownSchedule, workspace: job.workspace, onProgress: (done, total) => update({ progress: 71 + Math.round(done / total * 22) }) });
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
    const outputPath = await renderVideo({ plan, assets, duration: config.secondsPerQuestion, workspace: job.workspace, onProgress: (done, total) => update({ progress: 55 + Math.round(done / total * 40) }) });
    update({ status: 'verifying', stage: 'verifying', progress: 96 });
    const verification = await verifyVideo(outputPath, { expectedSceneCount: plan.questions.length, expectedDuration: plan.questions.length * config.secondsPerQuestion, renderDir: path.join(job.workspace, 'render') });
    writeJsonAtomic(path.join(job.workspace, 'verification.json'), verification); update({ status: 'completed', stage: 'completed', progress: 100, outputPath, verification });
  } catch (error) { update({ status: 'failed', stage: 'failed', error: error.message }); }
};

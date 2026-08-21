import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mapWithConcurrency, writeJsonAtomic } from './utils.js';
import { fitOptionText, WYR_TEMPLATE } from './template.js';
import { assertFontAvailable, resolveFfmpegPath, resolveFfprobePath } from './runtime.js';
import { assertCompleteCountdownSchedule, assertCompleteSfxSchedule, buildCountdownSchedule, buildSfxSchedule, SFX_EVENT_TYPES } from './audio.js';
import { getAudioSpec } from './audio-spec.js';

const ffmpegPath = resolveFfmpegPath();
const ffprobePath = resolveFfprobePath();

const run = (binary, args, label) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-12_000); }); child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(stderr) : reject(new Error(`${label} exited with code ${code}: ${stderr.slice(-4000)}`)));
});
const filterPath = file => file.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''");
export const assertLockedImageAssets = assets => {
  if (!Array.isArray(assets) || !assets.length) return true;
  const locked = assets.filter(asset => asset.locked);
  if (locked.length === 0) return true;
  if (locked.length !== assets.length) throw new Error('Rendering cannot mix locked and unlocked image assets.');
  for (const asset of locked) {
    if (!asset.localPath || !fs.existsSync(asset.localPath)) throw new Error(`Locked image asset is missing: ${asset.localPath || asset.filename}`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(asset.localPath)).digest('hex');
    if (!asset.sha256 || hash !== asset.sha256) throw new Error(`Locked image asset hash mismatch: ${asset.localPath}`);
  }
  return true;
};
const createTextMeasurer = ({ renderDir, font, namespace }) => {
  const cache = new Map(); const measureDir = path.join(renderDir, 'measure', namespace); fs.mkdirSync(measureDir, { recursive: true });
  return async (text, fontSize) => {
    const key = `${fontSize}:${text}`; if (cache.has(key)) return cache.get(key);
    const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 20); const textFile = path.join(measureDir, `${id}.txt`);
    if (!fs.existsSync(textFile)) fs.writeFileSync(textFile, text);
    const stderr = await run(ffmpegPath, ['-hide_banner', '-v', 'info', '-f', 'lavfi', '-i', 'color=c=black:s=4096x256:d=0.04', '-vf', `drawtext=fontfile=${font}:textfile='${filterPath(textFile)}':expansion=none:fontsize=${fontSize}:fontcolor=white:x=0:y=0,bbox=min_val=16`, '-frames:v', '1', '-f', 'null', '-'], 'measure option text');
    const match = stderr.match(/Parsed_bbox[^\n]*\bw:(\d+)\s+h:/); if (!match) throw new Error(`Could not measure option text at ${fontSize}px.`);
    const width = Number(match[1]) + Math.ceil(fontSize * 0.1); cache.set(key, width); return width;
  };
};
const activeAlpha = ({ start, fadeIn, end, fadeOut }) => `'clip((t-${start})/${fadeIn},0,1)*clip((${end}-t)/${fadeOut},0,1)'`;
// Single-layer, subject-aware framing: scale to fully cover the slot (preserving aspect ratio, never
// stretching) and crop exactly once. When a `crop` offset was already computed for this asset (see
// framing.js/images.js -- the offset that keeps the most on-image detail, biased to protect a
// head/face on vertical crops), scale to that exact cover size and cut the window at that offset. If
// no crop was computed (e.g. a locked asset from an older run, or a test double), fall back to a
// plain centered crop -- still single-layer, still no blur/letterbox, just not subject-aware.
export const buildFramedImageChain = ({ input, width, height, fps, outLabel, chainId, crop = null }) => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new TypeError('Framed image chain requires a positive width and height.');
  const hasCrop = crop && Number.isFinite(crop.coverWidth) && Number.isFinite(crop.coverHeight) && Number.isFinite(crop.x) && Number.isFinite(crop.y);
  const scaleAndCrop = hasCrop
    ? `scale=${Math.round(crop.coverWidth)}:${Math.round(crop.coverHeight)},crop=${width}:${height}:${Math.round(crop.x)}:${Math.round(crop.y)}`
    : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`;
  return [
    `[${input}]loop=loop=-1:size=1:start=0,setpts=N/${fps}/TB,${scaleAndCrop},setsar=1,format=rgba[${outLabel}]`,
  ];
};
export const buildStillImageInputArgs = (localPath, fps = WYR_TEMPLATE.canvas.fps) => {
  if (typeof localPath !== 'string' || !localPath) throw new TypeError('Still-image input requires a local file path.');
  if (!Number.isFinite(fps) || fps <= 0) throw new TypeError('Still-image input requires a positive frame rate.');
  return ['-i', localPath];
};
const renderSegment = async ({ question, assets, index, duration, timeline, renderDir, ffmpegThreads }) => {
  const a = assets.find(asset => asset.questionIndex === index && asset.slot === 'A'); const b = assets.find(asset => asset.questionIndex === index && asset.slot === 'B');
  if (!a || !b) throw new Error(`Missing render assets for question ${index + 1}.`);
  const font = assertFontAvailable();
  const measureText = createTextMeasurer({ renderDir, font, namespace: `q${String(index + 1).padStart(2, '0')}` });
  const [aFit, bFit] = await Promise.all([fitOptionText({ text: question.optionA.text, measureText }), fitOptionText({ text: question.optionB.text, measureText })]);
  const prefix = path.join(renderDir, `q${index + 1}`); const aText = `${prefix}-a.txt`; const bText = `${prefix}-b.txt`; const aPercentText = `${prefix}-a-percent.txt`; const bPercentText = `${prefix}-b-percent.txt`;
  fs.writeFileSync(aText, aFit.text); fs.writeFileSync(bText, bFit.text);
  fs.writeFileSync(aPercentText, question.optionA.percentage == null ? '' : `${question.optionA.percentage}%`);
  fs.writeFileSync(bPercentText, question.optionB.percentage == null ? '' : `${question.optionB.percentage}%`);
  writeJsonAtomic(`${prefix}-layout.json`, { optionA: aFit, optionB: bFit, textBox: { width: WYR_TEMPLATE.layout.textWidth, height: WYR_TEMPLATE.layout.textHeight } });
  const { canvas, layout, timing, typography } = WYR_TEMPLATE;
  const output = path.join(renderDir, `segment-${String(index).padStart(2, '0')}.mp4`);
  const contentEnd = timeline?.contentEnd ?? Math.min(timing.transitionOutStart, duration - timing.transitionOutDuration);
  const revealTime = timeline?.revealTime ?? timing.percentageReveal;
  const answerEnd = Math.min(revealTime, contentEnd);
  const aWinner = Number(question.optionA.percentage) >= Number(question.optionB.percentage);
  const bWinner = Number(question.optionB.percentage) > Number(question.optionA.percentage);
  const incomingDuration = index === 0 ? timing.initialEntranceDuration : timing.transitionSlideDuration;
  const slideDistance = (canvas.width + layout.imageWidth) / 2;
  // Ease-out (decelerate into place) instead of a constant-speed linear slide -- a purely cosmetic
  // change to the shape of the existing entrance ramp (still starts at 0, still reaches exactly 1 at
  // t=incomingDuration, still clipped/held at 1 afterward), so every already-settled frame this
  // motion feeds into (image position, OR-circle position, percentage motion) is pixel-identical to
  // before once the brief entrance window has passed. Restrained on purpose: no overshoot/bounce.
  const rawIncomingProgress = `clip(t/${incomingDuration},0,1)`;
  const incomingProgress = `(1-(1-${rawIncomingProgress})*(1-${rawIncomingProgress}))`;
  const outgoingProgress = `clip((t-${contentEnd})/${timing.transitionSlideDuration},0,1)`;
  const topMotion = `-${slideDistance}*(1-${incomingProgress})+${slideDistance}*${outgoingProgress}`;
  const bottomMotion = `${slideDistance}*(1-${incomingProgress})-${slideDistance}*${outgoingProgress}`;
  const optionEntranceStart = index === 0 ? -0.01 : 0;
  const optionAlphaA = activeAlpha({ start: optionEntranceStart, fadeIn: 0.01, end: answerEnd, fadeOut: timing.percentageRevealDuration });
  const optionAlphaB = activeAlpha({ start: optionEntranceStart, fadeIn: 0.01, end: answerEnd, fadeOut: timing.percentageRevealDuration });
  const percentAlpha = activeAlpha({ start: revealTime, fadeIn: timing.percentageRevealDuration, end: contentEnd + timing.transitionSlideDuration, fadeOut: timing.transitionSlideDuration });
  // Restrained "pop-in" emphasis: fontsize (a drawtext option ffmpeg re-evaluates every frame, same
  // expression mechanism as the x/y motion above) ramps from slightly undersized up to the fitted
  // size across the same short entrance window the image/box already uses, then holds exactly at
  // baseSize -- so every already-tested static-frame read of rendered text size is unaffected once
  // the brief entrance has passed. text_h/text_w-based centering (below) already reads the CURRENT
  // frame's rendered size each frame, so no other formula needs to change for this to stay centered.
  const popFontSize = (baseSize, start, popDuration, startScale) => `'round(${baseSize}*(${startScale}+${1 - startScale}*clip((t-${start})/${popDuration},0,1)))'`;
  const optionFontSizeA = popFontSize(aFit.fontSize, optionEntranceStart, incomingDuration, 0.88);
  const optionFontSizeB = popFontSize(bFit.fontSize, optionEntranceStart, incomingDuration, 0.88);
  // Reveal "payoff": percentages pop in slightly OVERSIZED (118%) and settle to their normal size
  // within a fifth of a second -- a quick "result hit" rather than the number simply appearing at
  // rest. Purely a fontsize ramp layered onto the existing percentAlpha fade-in/out and motion; no
  // new SFX, no change to revealTime/countdown sync, no added pause after the reveal.
  const percentPopDuration = 0.22;
  const percentFontSize = popFontSize(typography.percentageSize, revealTime, percentPopDuration, 1.18);
  const textLayer = ({ textFile, fontSize, x, y, alphaExpression }) => [
    `drawtext=fontfile=${font}:textfile='${filterPath(textFile)}':expansion=none:fontsize=${fontSize}:line_spacing=${typography.lineSpacing}:fontcolor=0x19D8EE:x=${x}-4:y=${y}+(${layout.textHeight}-text_h)/2+4:boxw=${layout.textWidth}:text_align=C:alpha=${alphaExpression}`,
    `drawtext=fontfile=${font}:textfile='${filterPath(textFile)}':expansion=none:fontsize=${fontSize}:line_spacing=${typography.lineSpacing}:fontcolor=0xF45A78:x=${x}+4:y=${y}+(${layout.textHeight}-text_h)/2+4:boxw=${layout.textWidth}:text_align=C:alpha=${alphaExpression}`,
    `drawtext=fontfile=${font}:textfile='${filterPath(textFile)}':expansion=none:fontsize=${fontSize}:line_spacing=${typography.lineSpacing}:fontcolor=white:borderw=7:bordercolor=black:x=${x}:y=${y}+(${layout.textHeight}-text_h)/2:boxw=${layout.textWidth}:text_align=C:alpha=${alphaExpression}`,
  ];
  const percentLayer = ({ textFile, winner, y, motion }) => `drawtext=fontfile=${font}:textfile='${filterPath(textFile)}':expansion=none:fontsize=${percentFontSize}:fontcolor=${winner ? '0x00F044' : 'white'}:borderw=7:bordercolor=black:shadowcolor=0xF45A78:shadowx=5:shadowy=5:x='(w-text_w)/2+${motion}':y=${y}+(${layout.textHeight}-text_h)/2:alpha=${percentAlpha}`;
  const filter = [
    ...buildFramedImageChain({ input: '0:v', width: layout.imageWidth, height: layout.imageHeight, fps: canvas.fps, outLabel: 'aimg', chainId: 'a', crop: a.framing }),
    ...buildFramedImageChain({ input: '1:v', width: layout.imageWidth, height: layout.imageHeight, fps: canvas.fps, outLabel: 'bimg', chainId: 'b', crop: b.framing }),
    `color=c=${layout.topColor}:s=${canvas.width}x${canvas.height}:r=${canvas.fps}:d=${duration},drawbox=x=0:y=${canvas.height / 2}:w=${canvas.width}:h=${canvas.height / 2}:color=${layout.bottomColor}:t=fill,drawbox=x=0:y=${layout.separatorY}:w=${canvas.width}:h=${layout.separatorHeight}:color=black:t=fill[base]`,
    `[base][aimg]overlay=x='(W-w)/2+${topMotion}':y=${layout.topImageY}:format=auto[tmpa]`,
    `[tmpa][bimg]overlay=x='(W-w)/2+${bottomMotion}':y=${layout.bottomImageY}:format=auto[tmpb]`,
    `color=c=black@0:s=${layout.orSize}x${layout.orSize}:r=${canvas.fps}:d=${duration},format=rgba,geq=r=0:g=0:b=0:a='if(lte((X-${layout.orSize / 2})*(X-${layout.orSize / 2})+(Y-${layout.orSize / 2})*(Y-${layout.orSize / 2}),${layout.orSize / 2}*${layout.orSize / 2}),255,0)'[orcircle]`,
    `[tmpb][orcircle]overlay=x=(W-w)/2:y=${canvas.height / 2}-${layout.orSize / 2}[withor]`,
    `[withor]${[
      ...textLayer({ textFile: aText, fontSize: optionFontSizeA, x: `'${layout.textX}+${topMotion}'`, y: layout.topTextY, alphaExpression: optionAlphaA }),
      ...textLayer({ textFile: bText, fontSize: optionFontSizeB, x: `'${layout.textX}+${bottomMotion}'`, y: layout.bottomTextY, alphaExpression: optionAlphaB }),
      percentLayer({ textFile: aPercentText, winner: aWinner, y: layout.topPercentageY, motion: topMotion }),
      percentLayer({ textFile: bPercentText, winner: bWinner, y: layout.bottomPercentageY, motion: bottomMotion }),
      `drawtext=fontfile=${font}:text='OR':fontsize=${typography.orSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-5`,
      'setrange=limited,format=yuv420p[out]',
    ].join(',')}`,
  ].join(';');
  const stillInputs = [a, b].flatMap(asset => buildStillImageInputArgs(asset.localPath, canvas.fps));
  const encode = getAudioSpec().encode;
  // 'veryfast', not 'ultrafast': x264's ultrafast preset forces cabac=0, which makes High profile
  // physically impossible -- libx264 silently downgrades to Constrained Baseline regardless of
  // -profile:v. veryfast keeps CABAC enabled (so High/level 4.2 actually apply) at a modest, still
  // fast encode-speed cost.
  await run(ffmpegPath, ['-y', ...stillInputs, '-filter_complex', filter, '-map', '[out]', '-an', '-r', String(canvas.fps), '-c:v', 'libx264', '-threads', String(ffmpegThreads), '-preset', 'veryfast', '-profile:v', encode.profile, '-level', encode.level, '-b:v', encode.videoBitrate, '-maxrate', encode.maxrate, '-bufsize', encode.bufsize, '-t', String(duration), output], `render segment ${index + 1}`);
  return output;
};
// Renders the inter-scene gap by freezing the outgoing scene's own last rendered frame for the gap
// duration, instead of cutting to solid black -- encoded with the exact same profile/level/pixel-
// format as the scene segments (see renderSegment) so the concat demuxer's `-c copy` step below can
// splice it in without a re-encode or a stream mismatch. Video-only (no `-an` needed); the mixed
// audio track stays silent here on its own because no voice/SFX/countdown event is ever scheduled
// inside a gap window (see audio.js's buildSceneTimeline gapAfter).
const buildFreezeGapSegment = async ({ renderDir, sourceSegment, seconds, index, ffmpegThreads }) => {
  const { canvas } = WYR_TEMPLATE; const encode = getAudioSpec().encode;
  const frame = path.join(renderDir, `gap-${String(index).padStart(2, '0')}-frame.png`);
  await run(ffmpegPath, ['-y', '-sseof', '-0.1', '-i', sourceSegment, '-update', '1', '-frames:v', '1', frame], `extract freeze frame for scene ${index + 1}`);
  const output = path.join(renderDir, `gap-${String(index).padStart(2, '0')}.mp4`);
  await run(ffmpegPath, ['-y', '-loop', '1', '-i', frame, '-t', String(seconds), '-r', String(canvas.fps), '-an', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-threads', String(ffmpegThreads), '-preset', 'veryfast', '-profile:v', encode.profile, '-level', encode.level, '-b:v', encode.videoBitrate, '-maxrate', encode.maxrate, '-bufsize', encode.bufsize, output], `render inter-scene freeze gap for scene ${index + 1}`);
  return output;
};
// Interleaves the per-scene freeze-gap clip between consecutive scene segments, driven entirely by
// each scene's own `gapAfter` (0 on the final scene, per buildSceneTimeline) -- never before the
// first scene, never trailing the last one. A `timeline` without per-scene `gapAfter` (e.g. the
// fixture path's plain duration-only calls) falls through unchanged, so fixture rendering keeps its
// existing back-to-back concatenation. `gapSegmentPath` may be a plain path (reused for every gap)
// or a `(index) => path` function (one gap clip per scene) -- renderVideo below uses the latter.
export const buildConcatSegmentList = ({ segments, timeline, gapSegmentPath }) => {
  if (!timeline?.scenes?.some(scene => scene.gapAfter > 0)) return segments;
  const gapPathFor = typeof gapSegmentPath === 'function' ? gapSegmentPath : () => gapSegmentPath;
  return segments.flatMap((segment, index) => timeline.scenes[index]?.gapAfter > 0 ? [segment, gapPathFor(index)] : [segment]);
};
export const buildComposition = ({ plan, assets, duration, timeline, voiceovers = [], sfx = null, workspace }) => {
  const composition = { width: WYR_TEMPLATE.canvas.width, height: WYR_TEMPLATE.canvas.height, fps: WYR_TEMPLATE.canvas.fps, secondsPerQuestion: timeline ? null : duration, totalDuration: timeline?.totalDuration ?? plan.questions.length * duration, timing: WYR_TEMPLATE.timing, layout: WYR_TEMPLATE.layout, typography: WYR_TEMPLATE.typography, slots: ['A_IMAGE', 'A_TEXT', 'A_PERCENT', 'B_IMAGE', 'B_TEXT', 'B_PERCENT', 'OR'], percentages: plan.percentages, sfx: sfx ? { provider: sfx.provider, slide: sfx.slide.filename, reveal: sfx.reveal.filename, whoosh: sfx.whoosh.filename, tick: sfx.tick.filename } : null, questions: plan.questions.map((question, index) => ({ index, optionA: question.optionA, optionB: question.optionB, A_IMAGE: assets.find(asset => asset.questionIndex === index && asset.slot === 'A')?.filename, B_IMAGE: assets.find(asset => asset.questionIndex === index && asset.slot === 'B')?.filename, narration: voiceovers.find(item => item.questionIndex === index)?.filename || null, scene: timeline?.scenes[index] || { duration } })) };
  writeJsonAtomic(path.join(workspace, 'composition.json'), composition); return composition;
};
const assertReadableNonEmptyFile = (localPath, label) => {
  if (!localPath || !fs.existsSync(localPath)) throw new Error(`Required render input is missing: ${label}.`);
  if (!fs.statSync(localPath).isFile() || fs.statSync(localPath).size <= 0) throw new Error(`Required render input is empty or unreadable: ${label}.`);
};
const SFX_ASSET_NAMES = Object.freeze(['slide', 'reveal', 'whoosh', 'tick']);
export const assertProductionAudioInputs = ({ plan, voiceovers = [], timeline, sfx }) => {
  if ((voiceovers.length && voiceovers.length !== plan.questions.length) || !timeline || !sfx || SFX_ASSET_NAMES.some(name => !sfx[name]?.localPath)) throw new Error('Production audio rendering requires a timeline and all local SFX files, plus one voice file per scene when narration is enabled.');
  // Catches a deleted/corrupted/never-written file with a clear message before the expensive
  // multi-input FFmpeg mix starts, instead of a cryptic FFmpeg "No such file or directory" failure.
  for (const voiceover of voiceovers) assertReadableNonEmptyFile(voiceover.localPath, `voiceover for scene ${voiceover.questionIndex + 1}`);
  for (const name of SFX_ASSET_NAMES) assertReadableNonEmptyFile(sfx[name].localPath, `${name} SFX`);
  return true;
};
const measurePeakDbfs = mediaPath => {
  const result = spawnSync(ffmpegPath, ['-i', mediaPath, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = result.stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  return match ? Number(match[1]) : null;
};
// EBU R128 measurement of a REAL, already-muxed media file's audio track -- used both to verify the
// final MP4 (not an intermediate WAV) hits config/audio-spec.json's mix.targetIntegratedLufs, and to
// report before/after numbers. loudnorm's single-pass analysis mode (no measured_I/... supplied)
// reports what it measured in its own `input_*` fields; those, not any `output_*` field, describe
// the file actually on disk.
export const measureIntegratedLoudness = mediaPath => {
  const result = spawnSync(ffmpegPath, ['-i', mediaPath, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = result.stderr.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
  if (!match) return null;
  const stats = JSON.parse(match[0]);
  const integratedLufs = Number(stats.input_i); const truePeakDb = Number(stats.input_tp); const loudnessRange = Number(stats.input_lra); const threshold = Number(stats.input_thresh);
  if (![integratedLufs, truePeakDb, loudnessRange, threshold].every(Number.isFinite)) return null;
  return { integratedLufs, truePeakDb, loudnessRange, threshold };
};
// Measures each voiceover file's own peak and returns the `volume=` multiplier that brings it to
// targetPeakDbfs in the mix -- narration loudness varies take to take, so a fixed multiplier alone
// can't guarantee a consistent target level the way it can for the pre-normalized SFX assets.
export const computeNarrationVolumes = (voiceovers, targetPeakDbfs) => voiceovers.map(voiceover => {
  const measured = measurePeakDbfs(voiceover.localPath);
  if (measured === null || !Number.isFinite(measured)) return 1;
  return Number((10 ** ((targetPeakDbfs - measured) / 20)).toFixed(4));
});
export const renderSceneSegments = async ({ plan, assets, duration, timeline, renderDir, sceneConcurrency = 2, ffmpegThreads = 4, onProgress, renderScene = renderSegment }) => {
  if (!Number.isInteger(ffmpegThreads) || ffmpegThreads < 1) throw new TypeError('FFmpeg threads must be a positive integer.');
  assertLockedImageAssets(assets);
  let completed = 0;
  return mapWithConcurrency(plan.questions, sceneConcurrency, async (question, index) => {
    const scene = timeline?.scenes[index]; const sceneDuration = scene?.duration ?? duration;
    const segment = await renderScene({ question, assets, index, duration: sceneDuration, timeline: scene, renderDir, ffmpegThreads });
    completed += 1; onProgress?.(completed, plan.questions.length); return segment;
  });
};
// Pure (no ffmpeg spawn) construction of the narration+SFX mix filter graph -- deliberately
// extracted from renderVideo so the input ordering, adelay timestamps, and amix label wiring can
// be verified deterministically in tests against ANY scene count, without needing a real ffmpeg
// render for every case. Input order (and therefore stream indices) is: [0]=video, then one input
// per voiceover, then one input per SFX_EVENT_TYPES entry, then the tick SFX -- renderVideo pushes
// '-i' arguments in this exact same order, so inputOrder's indices are the real ffmpeg stream
// indices used by the filters below. `normalize=0` on amix plus explicit per-input `volume=`
// weights (computed from real measured peaks, see computeNarrationVolumes/sfx-synth.js) is what
// keeps narration and SFX at their intended target levels instead of amix auto-attenuating
// everything as more inputs are added.
export const buildAudioMixPlan = ({ voiceoverCount, timeline, sfx, schedule, countdown, totalDuration, voiceoverVolumes = [], loudnessTarget = getAudioSpec().mix }) => {
  const inputOrder = ['video'];
  const filters = [`anullsrc=r=48000:cl=stereo,atrim=duration=${totalDuration}[bed]`];
  const mixLabels = ['[bed]'];
  for (let index = 0; index < voiceoverCount; index += 1) {
    inputOrder.push(`voiceover${index}`);
    const delay = Math.round((timeline.scenes[index].start + timeline.scenes[index].voiceStart) * 1000);
    const volume = voiceoverVolumes[index] ?? 1;
    filters.push(`[${index + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${volume},adelay=delays=${delay}:all=1[v${index}]`); mixLabels.push(`[v${index}]`);
  }
  const sfxInputIndexByType = {};
  for (const type of SFX_EVENT_TYPES) {
    const inputIndex = inputOrder.length; sfxInputIndexByType[type] = inputIndex; inputOrder.push(`sfx:${type}`);
    const typeEvents = schedule.events.filter(event => event.type === type);
    filters.push(`[${inputIndex}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${sfx[type].volume},asplit=${typeEvents.length}${typeEvents.map((_, index) => `[${type}${index}raw]`).join('')}`);
    for (let index = 0; index < typeEvents.length; index += 1) {
      const label = `${type}${index}`; const delay = Math.round(typeEvents[index].timestamp * 1000);
      filters.push(`[${label}raw]adelay=delays=${delay}:all=1[${label}]`); mixLabels.push(`[${label}]`);
    }
  }
  const tickInputIndex = inputOrder.length; inputOrder.push('sfx:tick');
  filters.push(`[${tickInputIndex}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${sfx.tick.volume},asplit=${countdown.events.length}${countdown.events.map((_, index) => `[tick${index}raw]`).join('')}`);
  for (let index = 0; index < countdown.events.length; index += 1) {
    const label = `tick${index}`; const delay = Math.round(countdown.events[index].timestamp * 1000);
    filters.push(`[${label}raw]adelay=delays=${delay}:all=1[${label}]`); mixLabels.push(`[${label}]`);
  }
  // Final-output loudness normalization: applied ONCE, after every voice+SFX input has already been
  // mixed together at its own intended relative level (normalize=0 above keeps amix from
  // auto-attenuating as inputs are added) -- so loudnorm's single overall gain curve moves the whole
  // mix up or down together and never changes the narration-vs-SFX balance. EBU R128 loudnorm (not a
  // blind volume=/gain multiply) targets integrated loudness while its own true-peak limiter (TP)
  // keeps the result from clipping; the trailing alimiter is a hard backstop in case loudnorm's
  // single-pass estimate overshoots slightly. Target values live in config/audio-spec.json's `mix`
  // section, not hardcoded here (see audio-spec.js's module comment).
  const { targetIntegratedLufs, truePeakCeilingDb, loudnessRangeTarget } = loudnessTarget;
  filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:normalize=0[premix]`);
  filters.push(`[premix]loudnorm=I=${targetIntegratedLufs}:TP=${truePeakCeilingDb}:LRA=${loudnessRangeTarget}:print_format=summary[normalized]`);
  filters.push(`[normalized]alimiter=limit=0.90:attack=5:release=50,atrim=duration=${totalDuration}[aout]`);
  return { inputOrder, filters, mixLabels, sfxInputIndexByType, tickInputIndex };
};

export const renderVideo = async ({ plan, assets, duration, timeline, voiceovers = [], sfx = null, sfxSchedule = null, countdownSchedule = null, workspace, sceneConcurrency = 2, ffmpegThreads = 4, onProgress, narrationPeakDbfs = -3 }) => {
  assertLockedImageAssets(assets);
  const renderDir = path.join(workspace, 'render');
  const segments = await renderSceneSegments({ plan, assets, duration, timeline, renderDir, sceneConcurrency, ffmpegThreads, onProgress });
  const gapIndices = timeline?.scenes ? timeline.scenes.flatMap((scene, index) => scene.gapAfter > 0 ? [index] : []) : [];
  const gapSegmentByIndex = {};
  for (const index of gapIndices) gapSegmentByIndex[index] = await buildFreezeGapSegment({ renderDir, sourceSegment: segments[index], seconds: timeline.blankGapSeconds, index, ffmpegThreads });
  const concatSegments = buildConcatSegmentList({ segments, timeline, gapSegmentPath: index => gapSegmentByIndex[index] });
  const concatFile = path.join(renderDir, 'segments.txt'); fs.writeFileSync(concatFile, `${concatSegments.map(segment => `file '${path.basename(segment)}'`).join('\n')}\n`);
  const silentVideo = path.join(renderDir, 'video.mp4'); await run(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', silentVideo], 'concatenate segments');
  const totalDuration = timeline?.totalDuration ?? plan.questions.length * duration; const output = path.join(workspace, 'output', 'would-you-rather.mp4');
  if (voiceovers.length || (timeline && sfx)) {
    assertProductionAudioInputs({ plan, voiceovers, timeline, sfx });
    const schedule = sfxSchedule || buildSfxSchedule(timeline); assertCompleteSfxSchedule({ timeline, events: schedule.events });
    const countdown = countdownSchedule || buildCountdownSchedule(timeline); assertCompleteCountdownSchedule({ timeline, events: countdown.events });
    const voiceoverVolumes = computeNarrationVolumes(voiceovers, narrationPeakDbfs);
    const mixPlan = buildAudioMixPlan({ voiceoverCount: voiceovers.length, timeline, sfx, schedule, countdown, totalDuration, voiceoverVolumes });
    const inputs = ['-y', '-i', silentVideo];
    for (const voiceover of voiceovers) inputs.push('-i', voiceover.localPath);
    for (const type of SFX_EVENT_TYPES) inputs.push('-i', sfx[type].localPath);
    inputs.push('-i', sfx.tick.localPath);
    await run(ffmpegPath, [...inputs, '-filter_complex', mixPlan.filters.join(';'), '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', String(totalDuration), '-movflags', '+faststart', output], 'mix narration and SFX');
  } else {
    // Debug/fixture path only (see fixtures.js) -- never used by production DB-first generation,
    // which always has a real timeline+sfx and takes the branch above. No production output ever
    // gets background music.
    await run(ffmpegPath, ['-y', '-i', silentVideo, '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${totalDuration}`, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', output], 'mux fixture video');
  }
  return output;
};
const rate = value => { const [numerator, denominator] = String(value || '').split('/').map(Number); return denominator ? numerator / denominator : Number(value); };
// Authoritative, independent of expectedDuration matching: a >=60s output must never be reported as a
// successful Shorts render, regardless of what the timeline predicted going in.
export const SHORTS_DURATION_LIMIT_SECONDS = 60;
export class DurationVerificationError extends Error {
  constructor(message, details = {}) { super(message); this.code = 'DURATION_BUDGET_EXCEEDED'; Object.assign(this, details); }
}
export const verifyVideo = async (output, { expectedSceneCount, expectedDuration, renderDir, timeline, sfxSchedule, countdownSchedule } = {}) => {
  const stat = fs.statSync(output); if (!stat.isFile() || stat.size <= 0) throw new Error('Output is not a non-empty regular file.'); let stdout = '';
  await new Promise((resolve, reject) => { const child = spawn(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`FFprobe exited with code ${code}: ${stderr}`))); });
  const metadata = JSON.parse(stdout); const video = metadata.streams?.find(stream => stream.codec_type === 'video'); const audio = metadata.streams?.find(stream => stream.codec_type === 'audio'); const duration = Number(metadata.format?.duration);
  if (!video) throw new Error('Verification failed: video stream is missing.'); if (!audio) throw new Error('Verification failed: expected audio stream is missing.'); if (video.width !== 1080 || video.height !== 1920) throw new Error(`Verification failed: expected 1080x1920, received ${video.width}x${video.height}.`); if (Math.abs(rate(video.avg_frame_rate || video.r_frame_rate) - 30) > 0.01) throw new Error(`Verification failed: expected 30fps, received ${video.avg_frame_rate || video.r_frame_rate}.`); if (video.codec_name !== 'h264') throw new Error(`Verification failed: expected H.264, received ${video.codec_name}.`); if (audio.codec_name !== 'aac') throw new Error(`Verification failed: expected AAC, received ${audio.codec_name}.`); if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Verification failed: invalid duration ${metadata.format?.duration}.`);
  if (duration >= SHORTS_DURATION_LIMIT_SECONDS) throw new DurationVerificationError(`Verification failed: final duration ${duration.toFixed(3)}s is at or above the ${SHORTS_DURATION_LIMIT_SECONDS.toFixed(1)}s Shorts limit and cannot be published as a successful short.`);
  if (Number.isFinite(expectedDuration) && Math.abs(duration - expectedDuration) > 0.15) throw new Error(`Verification failed: expected approximately ${expectedDuration.toFixed(3)}s, received ${duration.toFixed(3)}s.`);
  if (expectedSceneCount !== undefined) {
    if (!Number.isInteger(expectedSceneCount) || expectedSceneCount <= 0) throw new Error('Verification failed: expected scene count is invalid.');
    if (!renderDir) throw new Error('Verification failed: render directory is required to verify scene inclusion.');
    for (let index = 0; index < expectedSceneCount; index += 1) { const segment = path.join(renderDir, `segment-${String(index).padStart(2, '0')}.mp4`); if (!fs.existsSync(segment) || fs.statSync(segment).size <= 0) throw new Error(`Verification failed: rendered scene ${index + 1} is missing.`); }
  }
  let sfx = null;
  if (timeline || sfxSchedule) {
    if (!timeline || !sfxSchedule) throw new Error('Verification failed: both timeline and SFX schedule are required for SFX verification.');
    assertCompleteSfxSchedule({ timeline, events: sfxSchedule.events });
    sfx = { eventCount: sfxSchedule.events.length, maxEventsPerScene: SFX_EVENT_TYPES.length, events: sfxSchedule.events };
  }
  let countdown = null;
  if (timeline || countdownSchedule) {
    if (!timeline || !countdownSchedule) throw new Error('Verification failed: both timeline and countdown schedule are required for countdown verification.');
    assertCompleteCountdownSchedule({ timeline, events: countdownSchedule.events });
    countdown = { eventCount: countdownSchedule.events.length, ticksPerScene: countdownSchedule.ticksPerScene, events: countdownSchedule.events };
  }
  return { fileSize: stat.size, duration, width: video.width, height: video.height, fps: rate(video.avg_frame_rate || video.r_frame_rate), pixelFormat: video.pix_fmt, videoCodec: video.codec_name, audioCodec: audio.codec_name, hasVideo: true, hasAudio: true, sceneCount: expectedSceneCount ?? null, sfx, countdown };
};

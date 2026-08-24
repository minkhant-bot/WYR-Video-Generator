import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mapWithConcurrency, writeJsonAtomic } from './utils.js';
import { fitOptionText, WYR_TEMPLATE } from './template.js';
import { assertFontAvailable, resolveFfmpegPath, resolveFfprobePath } from './runtime.js';
import { assertCompleteCountdownSchedule, assertCompleteSfxSchedule, buildCountdownSchedule, buildSfxSchedule, SFX_EVENT_TYPES } from './audio.js';
import { getAudioSpec } from './audio-spec.js';
import { hookAssets } from './hook.js';

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
const framedScaleAndCrop = ({ width, height, crop }) => {
  const hasCrop = crop && Number.isFinite(crop.coverWidth) && Number.isFinite(crop.coverHeight) && Number.isFinite(crop.x) && Number.isFinite(crop.y);
  return hasCrop
    ? `scale=${Math.round(crop.coverWidth)}:${Math.round(crop.coverHeight)},crop=${width}:${height}:${Math.round(crop.x)}:${Math.round(crop.y)}`
    : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`;
};
// Single-layer, subject-aware framing: scale to fully cover the slot (preserving aspect ratio, never
// stretching) and crop exactly once. When a `crop` offset was already computed for this asset (see
// framing.js/images.js -- the food-centered offset plus any safe adaptive zoom), scale to that exact
// source-derived cover size and cut the window at that offset. If
// no crop was computed (e.g. a locked asset from an older run, or a test double), fall back to a
// plain centered crop -- still single-layer, still no blur/letterbox, just not subject-aware.
export const buildFramedImageChain = ({ input, width, height, fps, outLabel, chainId, crop = null }) => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new TypeError('Framed image chain requires a positive width and height.');
  const scaleAndCrop = framedScaleAndCrop({ width, height, crop });
  const brightness = Number.isFinite(crop?.brightness) ? Math.max(-0.01, Math.min(0.02, crop.brightness)) : 0.006;
  const gamma = Number.isFinite(crop?.gamma) ? Math.max(0.98, Math.min(1.03, crop.gamma)) : 1.01;
  // A deliberately restrained, identical food-photo treatment for both slots. gamma_weight keeps
  // the small midtone lift away from highlights; the low unsharp amount restores crispness lost in
  // scaling without producing visible halos.
  const enhancement = `eq=saturation=1.07:contrast=1.025:brightness=${brightness.toFixed(3)}:gamma=${gamma.toFixed(3)}:gamma_weight=0.85,unsharp=5:5:0.30:3:3:0`;
  return [
    `[${input}]loop=loop=-1:size=1:start=0,setpts=N/${fps}/TB,${scaleAndCrop},${enhancement},setsar=1,format=rgba[${outLabel}]`,
  ];
};
export const buildStillImageInputArgs = (localPath, fps = WYR_TEMPLATE.canvas.fps) => {
  if (typeof localPath !== 'string' || !localPath) throw new TypeError('Still-image input requires a local file path.');
  if (!Number.isFinite(fps) || fps <= 0) throw new TypeError('Still-image input requires a positive frame rate.');
  return ['-i', localPath];
};
const renderSegment = async ({ question, nextQuestion = null, assets, index, duration, timeline, renderDir, ffmpegThreads }) => {
  const a = assets.find(asset => asset.questionIndex === index && asset.slot === 'A'); const b = assets.find(asset => asset.questionIndex === index && asset.slot === 'B');
  if (!a || !b) throw new Error(`Missing render assets for question ${index + 1}.`);
  // Next scene's assets, fetched here (only when a next scene exists) so this segment can render
  // the incoming half of the crossover transition in its own tail -- see the incoming-overlay block
  // below. Does not affect anything about scene N+1's OWN eventual segment/assets/text.
  const na = nextQuestion ? assets.find(asset => asset.questionIndex === index + 1 && asset.slot === 'A') : null;
  const nb = nextQuestion ? assets.find(asset => asset.questionIndex === index + 1 && asset.slot === 'B') : null;
  if (nextQuestion && (!na || !nb)) throw new Error(`Missing render assets for question ${index + 2}.`);
  const font = assertFontAvailable();
  const measureText = createTextMeasurer({ renderDir, font, namespace: `q${String(index + 1).padStart(2, '0')}` });
  const [aFit, bFit] = await Promise.all([fitOptionText({ text: question.optionA.text, measureText }), fitOptionText({ text: question.optionB.text, measureText })]);
  const [naFit, nbFit] = nextQuestion
    ? await Promise.all([fitOptionText({ text: nextQuestion.optionA.text, measureText }), fitOptionText({ text: nextQuestion.optionB.text, measureText })])
    : [null, null];
  const prefix = path.join(renderDir, `q${index + 1}`); const aText = `${prefix}-a.txt`; const bText = `${prefix}-b.txt`; const aPercentText = `${prefix}-a-percent.txt`; const bPercentText = `${prefix}-b-percent.txt`;
  fs.writeFileSync(aText, aFit.text); fs.writeFileSync(bText, bFit.text);
  fs.writeFileSync(aPercentText, question.optionA.percentage == null ? '' : `${question.optionA.percentage}%`);
  fs.writeFileSync(bPercentText, question.optionB.percentage == null ? '' : `${question.optionB.percentage}%`);
  writeJsonAtomic(`${prefix}-layout.json`, { optionA: aFit, optionB: bFit, textBox: { width: WYR_TEMPLATE.layout.textWidth, height: WYR_TEMPLATE.layout.textHeight } });
  let naText = null; let nbText = null;
  if (nextQuestion) { naText = `${prefix}-next-a.txt`; nbText = `${prefix}-next-b.txt`; fs.writeFileSync(naText, naFit.text); fs.writeFileSync(nbText, nbFit.text); }
  const { canvas, layout, timing, typography } = WYR_TEMPLATE;
  const foodVisualStyle = String(question.category || '').trim().toLowerCase() === 'food';
  const paperColor = foodVisualStyle ? layout.foodPaperColor : layout.paperColor;
  const paperNoiseStrength = foodVisualStyle ? layout.foodPaperNoiseStrength : layout.paperNoiseStrength;
  const output = path.join(renderDir, `segment-${String(index).padStart(2, '0')}.mp4`);
  const contentEnd = timeline?.contentEnd ?? Math.min(timing.transitionOutStart, duration - timing.transitionOutDuration);
  const revealTime = timeline?.revealTime ?? timing.percentageReveal;
  const answerEnd = Math.min(revealTime, contentEnd);
  const aWinner = Number(question.optionA.percentage) >= Number(question.optionB.percentage);
  const bWinner = Number(question.optionB.percentage) > Number(question.optionA.percentage);
  const slideDistance = (canvas.width + layout.imageWidth) / 2;
  // Every scene now starts already fully arrived: its real entrance no longer happens inside its
  // own segment at all -- it happens inside the PREVIOUS scene's tail (see the incoming-overlay
  // block below), mirrored against that scene's own outgoing slide so the two visually cross paths
  // "at the same time" in one ~transitionSlideDuration window instead of a slide-out, a blank hold,
  // then a separate slide-in. rawIncomingProgress is therefore pinned to 1 unconditionally
  // (previously index===0 only) -- topMotion/bottomMotion are 0 for a scene's entire duration.
  const rawIncomingProgress = '1';
  const incomingProgress = `(1-(1-${rawIncomingProgress})*(1-${rawIncomingProgress}))`;
  const outgoingProgress = `clip((t-${contentEnd})/${timing.transitionSlideDuration},0,1)`;
  const topMotion = `-${slideDistance}*(1-${incomingProgress})+${slideDistance}*${outgoingProgress}`;
  const bottomMotion = `${slideDistance}*(1-${incomingProgress})-${slideDistance}*${outgoingProgress}`;
  // Incoming overlay (non-final scenes only): scene N+1's images/text slide INTO the same slots,
  // reusing outgoingProgress itself (not a new expression) so the two motions can never drift apart
  // -- this scene's content and the next scene's content cross paths over the exact same window.
  // Visible from the instant the outgoing slide begins (contentEnd) through the rest of this
  // segment, so scene N+1's own segment (already fully arrived from ITS frame 0, see above) picks
  // up in the same end state this segment finishes in -- the hard cut at the concat boundary is
  // invisible because both sides already agree on it.
  const nextTopMotion = `-${slideDistance}*(1-${outgoingProgress})`;
  const nextBottomMotion = `${slideDistance}*(1-${outgoingProgress})`;
  const nextAlpha = activeAlpha({ start: contentEnd, fadeIn: 0.01, end: duration + 1, fadeOut: 0.01 });
  const optionEntranceStart = -0.01;
  const optionAlphaA = activeAlpha({ start: optionEntranceStart, fadeIn: 0.01, end: answerEnd, fadeOut: timing.percentageRevealDuration });
  const optionAlphaB = activeAlpha({ start: optionEntranceStart, fadeIn: 0.01, end: answerEnd, fadeOut: timing.percentageRevealDuration });
  const percentAlpha = activeAlpha({ start: revealTime, fadeIn: timing.percentageRevealDuration, end: contentEnd + timing.transitionSlideDuration, fadeOut: timing.transitionSlideDuration });
  // Option text is now at full fitted size from frame 0 for every scene (no entrance pop-in left to
  // ramp against, per rawIncomingProgress above) -- a plain number instead of a t-based expression.
  const optionFontSizeA = aFit.fontSize;
  const optionFontSizeB = bFit.fontSize;
  const popFontSize = (baseSize, start, popDuration, startScale) => `'round(${baseSize}*(${startScale}+${1 - startScale}*clip((t-${start})/${popDuration},0,1)))'`;
  // Reveal "payoff": percentages pop in slightly OVERSIZED (118%) and settle to their normal size
  // within a fifth of a second -- a quick "result hit" rather than the number simply appearing at
  // rest. Purely a fontsize ramp layered onto the existing percentAlpha fade-in/out and motion; no
  // new SFX, no change to revealTime/countdown sync, no added pause after the reveal. Unrelated to
  // the entrance changes above -- unchanged.
  const percentPopDuration = 0.22;
  const percentFontSize = popFontSize(typography.percentageSize, revealTime, percentPopDuration, 1.18);
  const textLayer = ({ textFile, fontSize, x, y, alphaExpression }) => [
    `drawtext=fontfile=${font}:textfile='${filterPath(textFile)}':expansion=none:fontsize=${fontSize}:line_spacing=${typography.lineSpacing}:fontcolor=black:x=${x}:y=${y}+(${layout.textHeight}-text_h)/2:boxw=${layout.textWidth}:text_align=C:alpha=${alphaExpression}`,
  ];
  const percentLayer = ({ textFile, winner, y, motion }) => `drawtext=fontfile=${font}:textfile='${filterPath(textFile)}':expansion=none:fontsize=${percentFontSize}:fontcolor=${winner ? '0x1FAE55' : 'black'}:x='(w-text_w)/2+${motion}':y=${y}+(${layout.textHeight}-text_h)/2:alpha=${percentAlpha}`;
  const filter = [
    ...buildFramedImageChain({ input: '0:v', width: layout.imageWidth, height: layout.imageHeight, fps: canvas.fps, outLabel: 'aimg', chainId: 'a', crop: a.framing }),
    ...buildFramedImageChain({ input: '1:v', width: layout.imageWidth, height: layout.imageHeight, fps: canvas.fps, outLabel: 'bimg', chainId: 'b', crop: b.framing }),
    ...(nextQuestion ? buildFramedImageChain({ input: '2:v', width: layout.imageWidth, height: layout.imageHeight, fps: canvas.fps, outLabel: 'naimg', chainId: 'na', crop: na.framing }) : []),
    ...(nextQuestion ? buildFramedImageChain({ input: '3:v', width: layout.imageWidth, height: layout.imageHeight, fps: canvas.fps, outLabel: 'nbimg', chainId: 'nb', crop: nb.framing }) : []),
    // Procedural paper texture: a flat off-white plate plus a fixed (non-temporal, luma-only) grain
    // pattern from ffmpeg's noise filter -- 'u' without 't' keeps the same grain on every frame
    // instead of flickering film-grain static, and restricting it to c0 (luma) avoids the colored
    // speckling that noising the chroma planes of a yuv420p frame would cause.
    `color=c=${paperColor}:s=${canvas.width}x${canvas.height}:r=${canvas.fps}:d=${duration},format=yuv420p,noise=c0s=${paperNoiseStrength}:c0f=u[base]`,
    `[base][aimg]overlay=x='(W-w)/2+${topMotion}':y=${layout.topImageY}:format=auto[tmpa]`,
    `[tmpa][bimg]overlay=x='(W-w)/2+${bottomMotion}':y=${layout.bottomImageY}:format=auto[tmpb]`,
    ...(nextQuestion ? [
      `[tmpb][naimg]overlay=x='(W-w)/2+${nextTopMotion}':y=${layout.topImageY}:format=auto[tmpna]`,
      `[tmpna][nbimg]overlay=x='(W-w)/2+${nextBottomMotion}':y=${layout.bottomImageY}:format=auto[tmpnb]`,
    ] : []),
    `color=c=black@0:s=${layout.orSize}x${layout.orSize}:r=${canvas.fps}:d=${duration},format=rgba,geq=r=0:g=0:b=0:a='if(lte((X-${layout.orSize / 2})*(X-${layout.orSize / 2})+(Y-${layout.orSize / 2})*(Y-${layout.orSize / 2}),${layout.orSize / 2}*${layout.orSize / 2}),255,0)'[orcircle]`,
    `[${nextQuestion ? 'tmpnb' : 'tmpb'}][orcircle]overlay=x=(W-w)/2:y=${canvas.height / 2}-${layout.orSize / 2}[withor]`,
    `[withor]${[
      ...textLayer({ textFile: aText, fontSize: optionFontSizeA, x: `'${layout.textX}+${topMotion}'`, y: layout.topTextY, alphaExpression: optionAlphaA }),
      ...textLayer({ textFile: bText, fontSize: optionFontSizeB, x: `'${layout.textX}+${bottomMotion}'`, y: layout.bottomTextY, alphaExpression: optionAlphaB }),
      percentLayer({ textFile: aPercentText, winner: aWinner, y: layout.topPercentageY, motion: topMotion }),
      percentLayer({ textFile: bPercentText, winner: bWinner, y: layout.bottomPercentageY, motion: bottomMotion }),
      ...(nextQuestion ? textLayer({ textFile: naText, fontSize: naFit.fontSize, x: `'${layout.textX}+${nextTopMotion}'`, y: layout.topTextY, alphaExpression: nextAlpha }) : []),
      ...(nextQuestion ? textLayer({ textFile: nbText, fontSize: nbFit.fontSize, x: `'${layout.textX}+${nextBottomMotion}'`, y: layout.bottomTextY, alphaExpression: nextAlpha }) : []),
      `drawtext=fontfile=${font}:text='OR':fontsize=${typography.orSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-5`,
      'setrange=limited,format=yuv420p[out]',
    ].join(',')}`,
  ].join(';');
  const stillInputs = [a, b, ...(nextQuestion ? [na, nb] : [])].flatMap(asset => buildStillImageInputArgs(asset.localPath, canvas.fps));
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
  const composition = { width: WYR_TEMPLATE.canvas.width, height: WYR_TEMPLATE.canvas.height, fps: WYR_TEMPLATE.canvas.fps, secondsPerQuestion: timeline ? null : duration, totalDuration: timeline?.totalDuration ?? plan.questions.length * duration, hook: plan.hook ? { ...plan.hook, timeline: timeline?.hook || null } : null, timing: WYR_TEMPLATE.timing, layout: WYR_TEMPLATE.layout, typography: WYR_TEMPLATE.typography, slots: ['A_IMAGE', 'A_TEXT', 'A_PERCENT', 'B_IMAGE', 'B_TEXT', 'B_PERCENT', 'OR'], percentages: plan.percentages, sfx: sfx ? { provider: sfx.provider, reveal: sfx.reveal.filename, transition: sfx.transition.filename, countdownSequence: sfx.countdownSequence.filename } : null, questions: plan.questions.map((question, index) => ({ index, optionA: question.optionA, optionB: question.optionB, A_IMAGE: assets.find(asset => asset.questionIndex === index && asset.slot === 'A')?.filename, B_IMAGE: assets.find(asset => asset.questionIndex === index && asset.slot === 'B')?.filename, narration: voiceovers.find(item => item.questionIndex === index)?.filename || null, scene: timeline?.scenes[index] || { duration } })) };
  writeJsonAtomic(path.join(workspace, 'composition.json'), composition); return composition;
};
const assertReadableNonEmptyFile = (localPath, label) => {
  if (!localPath || !fs.existsSync(localPath)) throw new Error(`Required render input is missing: ${label}.`);
  if (!fs.statSync(localPath).isFile() || fs.statSync(localPath).size <= 0) throw new Error(`Required render input is empty or unreadable: ${label}.`);
};
const SFX_ASSET_NAMES = Object.freeze([...SFX_EVENT_TYPES, 'countdownSequence']);
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
    const nextQuestion = plan.questions[index + 1] ?? null;
    const segment = await renderScene({ question, nextQuestion, assets, index, duration: sceneDuration, timeline: scene, renderDir, ffmpegThreads });
    completed += 1; onProgress?.(completed, plan.questions.length); return segment;
  });
};

const HOOK_ANALYSIS_WIDTH = 320;
const HOOK_ANALYSIS_HEIGHT = 200;
const HOOK_SUBJECT_PADDING = 0.12;

const percentile = (values, fraction) => values[Math.floor((values.length - 1) * fraction)];
const medianChannel = (samples, channel) => {
  const values = samples.map(sample => sample[channel]).sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)];
};

// Hook-only normalization for the already-approved isolated-food style. Estimate the canvas color
// from the four corners, find the non-background food pixels, then return a padded crop with the
// same aspect ratio as a collage cell. Quantiles ignore isolated JPEG/noise pixels; expanding the
// detected bounds before fitting the cell ensures the food is never clipped. A non-isolated fallback
// naturally resolves to the full frame because most pixels differ from the corner background.
export const computeHookSubjectCropFromRgb = ({ buffer, width = HOOK_ANALYSIS_WIDTH, height = HOOK_ANALYSIS_HEIGHT, outputWidth = WYR_TEMPLATE.layout.imageWidth, outputHeight = WYR_TEMPLATE.layout.imageHeight, tileWidth = 460, tileHeight = 288 }) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < width * height * 3) return null;
  const cornerSize = Math.max(4, Math.round(Math.min(width, height) * 0.06));
  const corners = [];
  for (const [startX, startY] of [[0, 0], [width - cornerSize, 0], [0, height - cornerSize], [width - cornerSize, height - cornerSize]]) {
    for (let y = startY; y < startY + cornerSize; y += 1) for (let x = startX; x < startX + cornerSize; x += 1) {
      const offset = (y * width + x) * 3;
      corners.push([buffer[offset], buffer[offset + 1], buffer[offset + 2]]);
    }
  }
  const background = [medianChannel(corners, 0), medianChannel(corners, 1), medianChannel(corners, 2)];
  const backgroundLuma = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2];
  const xs = []; const ys = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 3; const r = buffer[offset]; const g = buffer[offset + 1]; const b = buffer[offset + 2];
    const colorDistance = Math.hypot(r - background[0], g - background[1], b - background[2]);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (colorDistance > 18 || luma < backgroundLuma - 16) { xs.push(x); ys.push(y); }
  }
  if (xs.length < width * height * 0.002) return null;
  xs.sort((left, right) => left - right); ys.sort((left, right) => left - right);
  let left = percentile(xs, 0.005); let right = percentile(xs, 0.995);
  let top = percentile(ys, 0.005); let bottom = percentile(ys, 0.995);
  const subjectWidth = Math.max(1, right - left + 1); const subjectHeight = Math.max(1, bottom - top + 1);
  left -= subjectWidth * HOOK_SUBJECT_PADDING; right += subjectWidth * HOOK_SUBJECT_PADDING;
  top -= subjectHeight * HOOK_SUBJECT_PADDING; bottom += subjectHeight * HOOK_SUBJECT_PADDING;
  let cropWidth = right - left + 1; let cropHeight = bottom - top + 1;
  const targetAspect = tileWidth / tileHeight;
  if (cropWidth / cropHeight > targetAspect) cropHeight = cropWidth / targetAspect;
  else cropWidth = cropHeight * targetAspect;
  cropWidth = Math.min(width, cropWidth); cropHeight = Math.min(height, cropHeight);
  const centerX = (left + right) / 2; const centerY = (top + bottom) / 2;
  const startX = Math.max(0, Math.min(width - cropWidth, centerX - cropWidth / 2));
  const startY = Math.max(0, Math.min(height - cropHeight, centerY - cropHeight / 2));
  const scaleX = outputWidth / width; const scaleY = outputHeight / height;
  const crop = { x: Math.round(startX * scaleX), y: Math.round(startY * scaleY), width: Math.round(cropWidth * scaleX), height: Math.round(cropHeight * scaleY) };
  if (crop.width >= outputWidth * 0.96 && crop.height >= outputHeight * 0.96) return null;
  return crop;
};

const readHookAnalysisFrame = ({ asset, width = WYR_TEMPLATE.layout.imageWidth, height = WYR_TEMPLATE.layout.imageHeight }) => new Promise((resolve, reject) => {
  const scaleAndCrop = framedScaleAndCrop({ width, height, crop: asset.framing });
  const child = spawn(ffmpegPath, ['-hide_banner', '-v', 'error', '-i', asset.localPath, '-vf', `${scaleAndCrop},scale=${HOOK_ANALYSIS_WIDTH}:${HOOK_ANALYSIS_HEIGHT}:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let stderr = '';
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Hook subject analysis exited with code ${code}: ${stderr}`)));
});

const measureHookSubjectCrop = async ({ asset, tileWidth, tileHeight }) => {
  try {
    const buffer = await readHookAnalysisFrame({ asset });
    return computeHookSubjectCropFromRgb({ buffer, tileWidth, tileHeight });
  } catch {
    // Image selection has already validated the asset. If hook-only analysis is unavailable, retain
    // its existing framing instead of turning a cosmetic normalization into a render failure.
    return null;
  }
};

const renderHookVisual = async ({ plan, assets, renderDir, duration, output, ffmpegThreads = 4, still = false }) => {
  const selected = hookAssets(assets, 4);
  if (!plan.hook || selected.length < 2) throw new Error('A hook title and at least two validated food images are required.');
  fs.mkdirSync(renderDir, { recursive: true });
  const font = assertFontAvailable(); const titleFile = path.join(renderDir, 'hook-title.txt');
  fs.writeFileSync(titleFile, plan.hook.title);
  const measureText = createTextMeasurer({ renderDir, font, namespace: 'hook' });
  const titleFit = await fitOptionText({ text: plan.hook.title, measureText, maxWidth: 920, maxHeight: 170, preferredFontSize: 76, minimumFontSize: 52 });
  fs.writeFileSync(titleFile, titleFit.text);
  const twoImageLayout = selected.length === 2;
  const tileWidth = twoImageLayout ? 860 : 460; const tileHeight = twoImageLayout ? 538 : 288;
  const positions = twoImageLayout
    ? [[110, 650], [110, 1200]]
    : selected.length === 3 ? [[60, 680], [560, 680], [310, 1000]] : [[60, 680], [560, 680], [60, 1000], [560, 1000]];
  const subjectCrops = await Promise.all(selected.map(asset => measureHookSubjectCrop({ asset, tileWidth, tileHeight })));
  const chains = selected.flatMap((asset, index) => [
    ...buildFramedImageChain({ input: `${index}:v`, width: WYR_TEMPLATE.layout.imageWidth, height: WYR_TEMPLATE.layout.imageHeight, fps: WYR_TEMPLATE.canvas.fps, outLabel: `hookfull${index}`, chainId: `hook${index}`, crop: asset.framing }),
    subjectCrops[index]
      ? `[hookfull${index}]crop=${subjectCrops[index].width}:${subjectCrops[index].height}:${subjectCrops[index].x}:${subjectCrops[index].y},scale=${tileWidth}:${tileHeight}[hooktile${index}]`
      : `[hookfull${index}]scale=${tileWidth}:${tileHeight}[hooktile${index}]`,
  ]);
  const baseDuration = Math.max(0.04, duration);
  const overlays = selected.map((_, index) => {
    const input = index === 0 ? 'hookbase' : `hookoverlay${index - 1}`;
    const outputLabel = index === selected.length - 1 ? 'hookimages' : `hookoverlay${index}`;
    return `[${input}][hooktile${index}]overlay=x=${positions[index][0]}:y=${positions[index][1]}:format=auto[${outputLabel}]`;
  });
  const filter = [
    ...chains,
    `color=c=${WYR_TEMPLATE.layout.foodPaperColor}:s=1080x1920:r=30:d=${baseDuration},format=yuv420p[hookbase]`,
    ...overlays,
    `[hookimages]drawtext=fontfile=${font}:text='THIS OR THAT':fontsize=108:fontcolor=black:x=(w-text_w)/2:y=245,drawtext=fontfile=${font}:textfile='${filterPath(titleFile)}':expansion=none:fontsize=${titleFit.fontSize}:line_spacing=${WYR_TEMPLATE.typography.lineSpacing}:fontcolor=black:x=(w-text_w)/2:y=420+(170-text_h)/2,setrange=limited,format=yuv420p[hookout]`,
  ].join(';');
  const inputs = selected.flatMap(asset => buildStillImageInputArgs(asset.localPath));
  const args = ['-y', ...inputs, '-filter_complex', filter, '-map', '[hookout]', '-an'];
  if (still) args.push('-frames:v', '1', output);
  else {
    const encode = getAudioSpec().encode;
    args.push('-r', '30', '-c:v', 'libx264', '-threads', String(ffmpegThreads), '-preset', 'veryfast', '-profile:v', encode.profile, '-level', encode.level, '-b:v', encode.videoBitrate, '-maxrate', encode.maxrate, '-bufsize', encode.bufsize, '-t', String(duration), output);
  }
  await run(ffmpegPath, args, still ? 'render hook preview' : 'render hook segment');
  return output;
};

export const renderHookPreviewFrame = ({ plan, assets, workspace, output = path.join(workspace, 'hook-preview.png') }) => renderHookVisual({ plan, assets, renderDir: path.join(workspace, 'hook-preview-render'), duration: 0.04, output, still: true });
// Pure (no ffmpeg spawn) construction of the narration+SFX mix filter graph -- deliberately
// extracted from renderVideo so the input ordering, adelay timestamps, and amix label wiring can
// be verified deterministically in tests against ANY scene count, without needing a real ffmpeg
// render for every case. Input order (and therefore stream indices) is: [0]=video, then one input
// per voiceover, then one input per SFX_EVENT_TYPES entry, then the countdown sequence -- renderVideo pushes
// '-i' arguments in this exact same order, so inputOrder's indices are the real ffmpeg stream
// indices used by the filters below. `normalize=0` on amix plus explicit per-input `volume=`
// weights is what
// keeps narration and SFX at their intended target levels instead of amix auto-attenuating
// everything as more inputs are added.
export const buildAudioMixPlan = ({ voiceoverCount, timeline, sfx, schedule, countdown, totalDuration, voiceoverVolumes = [], hookVoiceover = null, hookVoiceoverVolume = 1, loudnessTarget = getAudioSpec().mix }) => {
  const inputOrder = ['video'];
  const filters = [`anullsrc=r=48000:cl=stereo,atrim=duration=${totalDuration}[bed]`];
  const mixLabels = ['[bed]'];
  if (hookVoiceover) {
    const hookInputIndex = inputOrder.length; inputOrder.push('hookVoiceover');
    filters.push(`[${hookInputIndex}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${hookVoiceoverVolume},adelay=delays=0:all=1[hookvoice]`); mixLabels.push('[hookvoice]');
  }
  for (let index = 0; index < voiceoverCount; index += 1) {
    const inputIndex = inputOrder.length; inputOrder.push(`voiceover${index}`);
    const delay = Math.round((timeline.scenes[index].start + timeline.scenes[index].voiceStart) * 1000);
    const volume = voiceoverVolumes[index] ?? 1;
    filters.push(`[${inputIndex}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${volume},adelay=delays=${delay}:all=1[v${index}]`); mixLabels.push(`[v${index}]`);
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
  const countdownInputIndex = inputOrder.length; inputOrder.push('sfx:countdownSequence');
  filters.push(`[${countdownInputIndex}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${sfx.countdownSequence.volume},asplit=${timeline.scenes.length}${timeline.scenes.map((_, index) => `[countdownSequence${index}raw]`).join('')}`);
  for (let index = 0; index < timeline.scenes.length; index += 1) {
    const label = `countdownSequence${index}`; const delay = Math.round((timeline.scenes[index].start + timeline.scenes[index].countdownStart) * 1000);
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
  return { inputOrder, filters, mixLabels, sfxInputIndexByType, countdownInputIndex };
};

export const renderVideo = async ({ plan, assets, duration, timeline, voiceovers = [], hookVoiceover = null, sfx = null, sfxSchedule = null, countdownSchedule = null, workspace, sceneConcurrency = 2, ffmpegThreads = 4, onProgress, narrationPeakDbfs = -3 }) => {
  assertLockedImageAssets(assets);
  const renderDir = path.join(workspace, 'render');
  const segments = await renderSceneSegments({ plan, assets, duration, timeline, renderDir, sceneConcurrency, ffmpegThreads, onProgress });
  const gapIndices = timeline?.scenes ? timeline.scenes.flatMap((scene, index) => scene.gapAfter > 0 ? [index] : []) : [];
  const gapSegmentByIndex = {};
  for (const index of gapIndices) gapSegmentByIndex[index] = await buildFreezeGapSegment({ renderDir, sourceSegment: segments[index], seconds: timeline.blankGapSeconds, index, ffmpegThreads });
  const questionSegments = buildConcatSegmentList({ segments, timeline, gapSegmentPath: index => gapSegmentByIndex[index] });
  const hookSegment = plan.hook ? await renderHookVisual({ plan, assets, renderDir, duration: timeline.hook.duration, output: path.join(renderDir, 'hook.mp4'), ffmpegThreads }) : null;
  const concatSegments = hookSegment ? [hookSegment, ...questionSegments] : questionSegments;
  const concatFile = path.join(renderDir, 'segments.txt'); fs.writeFileSync(concatFile, `${concatSegments.map(segment => `file '${path.basename(segment)}'`).join('\n')}\n`);
  const silentVideo = path.join(renderDir, 'video.mp4'); await run(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', silentVideo], 'concatenate segments');
  const totalDuration = timeline?.totalDuration ?? plan.questions.length * duration; const output = path.join(workspace, 'output', 'would-you-rather.mp4');
  if (voiceovers.length || (timeline && sfx)) {
    assertProductionAudioInputs({ plan, voiceovers, timeline, sfx });
    if (plan.hook) assertReadableNonEmptyFile(hookVoiceover?.localPath, 'hook voiceover');
    const schedule = sfxSchedule || buildSfxSchedule(timeline); assertCompleteSfxSchedule({ timeline, events: schedule.events });
    const countdown = countdownSchedule || buildCountdownSchedule(timeline); assertCompleteCountdownSchedule({ timeline, events: countdown.events });
    const voiceoverVolumes = computeNarrationVolumes(voiceovers, narrationPeakDbfs);
    const hookVoiceoverVolume = hookVoiceover ? computeNarrationVolumes([hookVoiceover], narrationPeakDbfs)[0] : 1;
    const mixPlan = buildAudioMixPlan({ voiceoverCount: voiceovers.length, timeline, sfx, schedule, countdown, totalDuration, voiceoverVolumes, hookVoiceover, hookVoiceoverVolume });
    const inputs = ['-y', '-i', silentVideo];
    if (hookVoiceover) inputs.push('-i', hookVoiceover.localPath);
    for (const voiceover of voiceovers) inputs.push('-i', voiceover.localPath);
    for (const type of SFX_EVENT_TYPES) inputs.push('-i', sfx[type].localPath);
    inputs.push('-i', sfx.countdownSequence.localPath);
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
    countdown = { eventCount: countdownSchedule.events.length, numbersPerScene: countdownSchedule.numbersPerScene, events: countdownSchedule.events };
  }
  return { fileSize: stat.size, duration, width: video.width, height: video.height, fps: rate(video.avg_frame_rate || video.r_frame_rate), pixelFormat: video.pix_fmt, videoCodec: video.codec_name, audioCodec: audio.codec_name, hasVideo: true, hasAudio: true, sceneCount: expectedSceneCount ?? null, sfx, countdown };
};

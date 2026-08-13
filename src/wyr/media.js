import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeJsonAtomic } from './utils.js';
import { fitOptionText, WYR_TEMPLATE } from './template.js';
import { assertFontAvailable, resolveFfmpegPath, resolveFfprobePath } from './runtime.js';
import { assertCompleteCountdownSchedule, assertCompleteSfxSchedule, buildCountdownSchedule, buildSfxSchedule, SFX_EVENT_TYPES } from './audio.js';

const ffmpegPath = resolveFfmpegPath();
const ffprobePath = resolveFfprobePath();

const run = (binary, args, label) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-12_000); }); child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(stderr) : reject(new Error(`${label} exited with code ${code}: ${stderr.slice(-4000)}`)));
});
const filterPath = file => file.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''");
const createTextMeasurer = ({ renderDir, font }) => {
  const cache = new Map(); const measureDir = path.join(renderDir, 'measure'); fs.mkdirSync(measureDir, { recursive: true });
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
const renderSegment = async ({ question, assets, index, duration, timeline, renderDir }) => {
  const a = assets.find(asset => asset.questionIndex === index && asset.slot === 'A'); const b = assets.find(asset => asset.questionIndex === index && asset.slot === 'B');
  if (!a || !b) throw new Error(`Missing render assets for question ${index + 1}.`);
  const font = assertFontAvailable();
  const measureText = createTextMeasurer({ renderDir, font });
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
  const optionAlphaA = activeAlpha({ start: timing.optionAEntrance, fadeIn: timing.optionEntranceDuration, end: answerEnd, fadeOut: timing.percentageRevealDuration });
  const optionAlphaB = activeAlpha({ start: timing.optionBEntrance, fadeIn: timing.optionEntranceDuration, end: answerEnd, fadeOut: timing.percentageRevealDuration });
  const percentAlpha = activeAlpha({ start: revealTime, fadeIn: timing.percentageRevealDuration, end: contentEnd, fadeOut: timing.transitionOutDuration });
  const countdownLayers = (timeline?.countdown || []).map(({ number, time }) => {
    const alpha = activeAlpha({ start: time, fadeIn: timing.countdownFadeDuration, end: time + timing.countdownInterval, fadeOut: timing.countdownFadeDuration });
    return `drawtext=fontfile=${font}:text='${number}':fontsize=${typography.countdownSize}:fontcolor=white:borderw=12:bordercolor=black:shadowcolor=0xF45A78:shadowx=6:shadowy=6:x=(w-text_w)/2:y=(h-text_h)/2:alpha=${alpha}`;
  });
  const textLayer = ({ textFile, fontSize, x, y, alphaExpression }) => [
    `drawtext=fontfile=${font}:textfile='${filterPath(textFile)}':expansion=none:fontsize=${fontSize}:line_spacing=${typography.lineSpacing}:fontcolor=0x19D8EE:x=${x}-4:y=${y}+(${layout.textHeight}-text_h)/2+4:boxw=${layout.textWidth}:text_align=C:alpha=${alphaExpression}`,
    `drawtext=fontfile=${font}:textfile='${filterPath(textFile)}':expansion=none:fontsize=${fontSize}:line_spacing=${typography.lineSpacing}:fontcolor=0xF45A78:x=${x}+4:y=${y}+(${layout.textHeight}-text_h)/2+4:boxw=${layout.textWidth}:text_align=C:alpha=${alphaExpression}`,
    `drawtext=fontfile=${font}:textfile='${filterPath(textFile)}':expansion=none:fontsize=${fontSize}:line_spacing=${typography.lineSpacing}:fontcolor=white:borderw=7:bordercolor=black:x=${x}:y=${y}+(${layout.textHeight}-text_h)/2:boxw=${layout.textWidth}:text_align=C:alpha=${alphaExpression}`,
  ];
  const percentLayer = ({ textFile, winner, y }) => `drawtext=fontfile=${font}:textfile='${filterPath(textFile)}':expansion=none:fontsize=${typography.percentageSize}:fontcolor=${winner ? '0x00F044' : 'white'}:borderw=7:bordercolor=black:shadowcolor=0xF45A78:shadowx=5:shadowy=5:x=(w-text_w)/2:y=${y}+(${layout.textHeight}-text_h)/2:alpha=${percentAlpha}`;
  const filter = [
    `[0:v]scale=${layout.imageWidth}:${layout.imageHeight}:force_original_aspect_ratio=increase,crop=${layout.imageWidth}:${layout.imageHeight}:(iw-${layout.imageWidth})/2:(ih-${layout.imageHeight})/2,setsar=1,format=rgba,fade=t=in:st=0:d=${timing.imageFadeIn}:alpha=1,fade=t=out:st=${contentEnd}:d=${timing.transitionOutDuration}:alpha=1[aimg]`,
    `[1:v]scale=${layout.imageWidth}:${layout.imageHeight}:force_original_aspect_ratio=increase,crop=${layout.imageWidth}:${layout.imageHeight}:(iw-${layout.imageWidth})/2:(ih-${layout.imageHeight})/2,setsar=1,format=rgba,fade=t=in:st=${timing.optionBEntrance}:d=${timing.imageFadeIn}:alpha=1,fade=t=out:st=${contentEnd}:d=${timing.transitionOutDuration}:alpha=1[bimg]`,
    `color=c=${layout.topColor}:s=${canvas.width}x${canvas.height}:r=${canvas.fps}:d=${duration},drawbox=x=0:y=${canvas.height / 2}:w=${canvas.width}:h=${canvas.height / 2}:color=${layout.bottomColor}:t=fill,drawbox=x=0:y=${layout.separatorY}:w=${canvas.width}:h=${layout.separatorHeight}:color=black:t=fill[base]`,
    `[base][aimg]overlay=x=(W-w)/2:y=${layout.topImageY}:format=auto[tmpa]`,
    `[tmpa][bimg]overlay=x=(W-w)/2:y=${layout.bottomImageY}:format=auto[tmpb]`,
    `color=c=black@0:s=${layout.orSize}x${layout.orSize}:r=${canvas.fps}:d=${duration},format=rgba,geq=r=0:g=0:b=0:a='if(lte((X-${layout.orSize / 2})*(X-${layout.orSize / 2})+(Y-${layout.orSize / 2})*(Y-${layout.orSize / 2}),${layout.orSize / 2}*${layout.orSize / 2}),255,0)'[orcircle]`,
    `[tmpb][orcircle]overlay=x=(W-w)/2:y=${canvas.height / 2}-${layout.orSize / 2}[withor]`,
    `[withor]${[
      ...textLayer({ textFile: aText, fontSize: aFit.fontSize, x: layout.textX, y: layout.topTextY, alphaExpression: optionAlphaA }),
      ...textLayer({ textFile: bText, fontSize: bFit.fontSize, x: layout.textX, y: layout.bottomTextY, alphaExpression: optionAlphaB }),
      percentLayer({ textFile: aPercentText, winner: aWinner, y: layout.topPercentageY }),
      percentLayer({ textFile: bPercentText, winner: bWinner, y: layout.bottomPercentageY }),
      `drawtext=fontfile=${font}:text='OR':fontsize=${typography.orSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-5`,
      ...countdownLayers,
      'setrange=limited,format=yuv420p[out]',
    ].join(',')}`,
  ].join(';');
  await run(ffmpegPath, ['-y', '-loop', '1', '-t', String(duration), '-i', a.localPath, '-loop', '1', '-t', String(duration), '-i', b.localPath, '-filter_complex', filter, '-map', '[out]', '-an', '-r', String(canvas.fps), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-t', String(duration), output], `render segment ${index + 1}`);
  return output;
};
export const buildComposition = ({ plan, assets, duration, timeline, voiceovers = [], sfx = null, workspace }) => {
  const composition = { width: WYR_TEMPLATE.canvas.width, height: WYR_TEMPLATE.canvas.height, fps: WYR_TEMPLATE.canvas.fps, secondsPerQuestion: timeline ? null : duration, totalDuration: timeline?.totalDuration ?? plan.questions.length * duration, timing: WYR_TEMPLATE.timing, layout: WYR_TEMPLATE.layout, typography: WYR_TEMPLATE.typography, slots: ['A_IMAGE', 'A_TEXT', 'A_PERCENT', 'B_IMAGE', 'B_TEXT', 'B_PERCENT', 'OR'], percentages: plan.percentages, sfx: sfx ? { provider: sfx.provider, entrance: sfx.entrance.filename, reveal: sfx.reveal.filename, transition: sfx.transition.filename, tick: sfx.tick.filename } : null, questions: plan.questions.map((question, index) => ({ index, optionA: question.optionA, optionB: question.optionB, A_IMAGE: assets.find(asset => asset.questionIndex === index && asset.slot === 'A')?.filename, B_IMAGE: assets.find(asset => asset.questionIndex === index && asset.slot === 'B')?.filename, narration: voiceovers.find(item => item.questionIndex === index)?.filename || null, scene: timeline?.scenes[index] || { duration } })) };
  writeJsonAtomic(path.join(workspace, 'composition.json'), composition); return composition;
};
export const renderVideo = async ({ plan, assets, duration, timeline, voiceovers = [], sfx = null, sfxSchedule = null, countdownSchedule = null, workspace, onProgress }) => {
  const renderDir = path.join(workspace, 'render'); const segments = [];
  for (let index = 0; index < plan.questions.length; index += 1) {
    const scene = timeline?.scenes[index]; const sceneDuration = scene?.duration ?? duration;
    segments.push(await renderSegment({ question: plan.questions[index], assets, index, duration: sceneDuration, timeline: scene, renderDir })); onProgress?.(index + 1, plan.questions.length);
  }
  const concatFile = path.join(renderDir, 'segments.txt'); fs.writeFileSync(concatFile, `${segments.map(segment => `file '${path.basename(segment)}'`).join('\n')}\n`);
  const silentVideo = path.join(renderDir, 'video.mp4'); await run(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', silentVideo], 'concatenate segments');
  const totalDuration = timeline?.totalDuration ?? plan.questions.length * duration; const output = path.join(workspace, 'output', 'would-you-rather.mp4');
  if (voiceovers.length) {
    if (voiceovers.length !== plan.questions.length || !timeline || !sfx || SFX_EVENT_TYPES.some(type => !sfx[type]?.localPath) || !sfx.tick?.localPath) throw new Error('Narrated rendering requires one voice file per scene, a timeline, and all local SFX files.');
    const schedule = sfxSchedule || buildSfxSchedule(timeline); assertCompleteSfxSchedule({ timeline, events: schedule.events });
    const countdown = countdownSchedule || buildCountdownSchedule(timeline); assertCompleteCountdownSchedule({ timeline, events: countdown.events });
    const inputs = ['-y', '-i', silentVideo]; for (const voiceover of voiceovers) inputs.push('-i', voiceover.localPath);
    const sfxInputs = {}; for (const type of SFX_EVENT_TYPES) { sfxInputs[type] = inputs.filter(value => value === '-i').length; inputs.push('-i', sfx[type].localPath); }
    const tickInput = inputs.filter(value => value === '-i').length; inputs.push('-i', sfx.tick.localPath);
    const filters = [`anullsrc=r=48000:cl=stereo,atrim=duration=${totalDuration}[bed]`]; const mixLabels = ['[bed]'];
    for (let index = 0; index < voiceovers.length; index += 1) {
      const delay = Math.round((timeline.scenes[index].start + timeline.scenes[index].voiceStart) * 1000); filters.push(`[${index + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=1,adelay=delays=${delay}:all=1[v${index}]`); mixLabels.push(`[v${index}]`);
    }
    for (const type of SFX_EVENT_TYPES) {
      const typeEvents = schedule.events.filter(event => event.type === type);
      filters.push(`[${sfxInputs[type]}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${sfx[type].volume},asplit=${typeEvents.length}${typeEvents.map((_, index) => `[${type}${index}raw]`).join('')}`);
      for (let index = 0; index < typeEvents.length; index += 1) {
        const label = `${type}${index}`; const delay = Math.round(typeEvents[index].timestamp * 1000);
        filters.push(`[${label}raw]adelay=delays=${delay}:all=1[${label}]`); mixLabels.push(`[${label}]`);
      }
    }
    filters.push(`[${tickInput}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${sfx.tick.volume},asplit=${countdown.events.length}${countdown.events.map((_, index) => `[tick${index}raw]`).join('')}`);
    for (let index = 0; index < countdown.events.length; index += 1) {
      const delay = Math.round(countdown.events[index].timestamp * 1000);
      filters.push(`[tick${index}raw]adelay=delays=${delay}:all=1[tick${index}]`); mixLabels.push(`[tick${index}]`);
    }
    filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,alimiter=limit=0.90:attack=5:release=50,atrim=duration=${totalDuration}[aout]`);
    await run(ffmpegPath, [...inputs, '-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', String(totalDuration), '-movflags', '+faststart', output], 'mix narration and SFX');
  } else {
    const music = `aevalsrc=0.020*sin(2*PI*174.61*t)+0.014*sin(2*PI*220*t)+0.010*sin(2*PI*261.63*t):s=48000:d=${totalDuration}`;
    await run(ffmpegPath, ['-y', '-i', silentVideo, '-f', 'lavfi', '-i', music, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', output], 'mux fixture video');
  }
  return output;
};
const rate = value => { const [numerator, denominator] = String(value || '').split('/').map(Number); return denominator ? numerator / denominator : Number(value); };
export const verifyVideo = async (output, { expectedSceneCount, expectedDuration, renderDir, timeline, sfxSchedule, countdownSchedule } = {}) => {
  const stat = fs.statSync(output); if (!stat.isFile() || stat.size <= 0) throw new Error('Output is not a non-empty regular file.'); let stdout = '';
  await new Promise((resolve, reject) => { const child = spawn(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`FFprobe exited with code ${code}: ${stderr}`))); });
  const metadata = JSON.parse(stdout); const video = metadata.streams?.find(stream => stream.codec_type === 'video'); const audio = metadata.streams?.find(stream => stream.codec_type === 'audio'); const duration = Number(metadata.format?.duration);
  if (!video) throw new Error('Verification failed: video stream is missing.'); if (!audio) throw new Error('Verification failed: expected audio stream is missing.'); if (video.width !== 1080 || video.height !== 1920) throw new Error(`Verification failed: expected 1080x1920, received ${video.width}x${video.height}.`); if (Math.abs(rate(video.avg_frame_rate || video.r_frame_rate) - 30) > 0.01) throw new Error(`Verification failed: expected 30fps, received ${video.avg_frame_rate || video.r_frame_rate}.`); if (video.codec_name !== 'h264') throw new Error(`Verification failed: expected H.264, received ${video.codec_name}.`); if (audio.codec_name !== 'aac') throw new Error(`Verification failed: expected AAC, received ${audio.codec_name}.`); if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Verification failed: invalid duration ${metadata.format?.duration}.`);
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
    sfx = { eventCount: sfxSchedule.events.length, eventsPerScene: SFX_EVENT_TYPES.length, events: sfxSchedule.events };
  }
  let countdown = null;
  if (timeline || countdownSchedule) {
    if (!timeline || !countdownSchedule) throw new Error('Verification failed: both timeline and countdown schedule are required for countdown verification.');
    assertCompleteCountdownSchedule({ timeline, events: countdownSchedule.events });
    countdown = { eventCount: countdownSchedule.events.length, numbersPerScene: 3, events: countdownSchedule.events };
  }
  return { fileSize: stat.size, duration, width: video.width, height: video.height, fps: rate(video.avg_frame_rate || video.r_frame_rate), pixelFormat: video.pix_fmt, videoCodec: video.codec_name, audioCodec: audio.codec_name, hasVideo: true, hasAudio: true, sceneCount: expectedSceneCount ?? null, sfx, countdown };
};

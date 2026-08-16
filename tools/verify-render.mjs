#!/usr/bin/env node
// Re-runs the same measurement methodology used to derive config/audio-spec.json (Phase 1: bandpass
// + RMS + percentile peak-picking for countdown ticks/reveal, spatial-variance blank-frame detection
// for transitions, ffmpeg volumedetect for levels) against a REAL rendered WYR output, and checks the
// result against the spec's own targets. Plain Node + ffmpeg only, no new dependencies.
//
// Usage: node tools/verify-render.mjs <path-to-rendered.mp4>

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveFfmpegPath } from '../src/wyr/runtime.js';
import { getAudioSpec } from '../src/wyr/audio-spec.js';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ffmpeg = resolveFfmpegPath();
const ffprobe = ffmpeg.replace(/ffmpeg([^/\\]*)$/, 'ffprobe$1');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node tools/verify-render.mjs <path-to-rendered.mp4>');
  process.exit(2);
}
if (!fs.existsSync(target)) {
  console.error(`File not found: ${target}`);
  process.exit(2);
}

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}`); };

const run = (bin, args) => spawnSync(bin, args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
const runText = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ---- shared PCM/percentile/peak-picking helpers (same method as the Phase 1 measurement) ----
const loadRawS16leMono = buffer => {
  const n = Math.floor(buffer.length / 2);
  const samples = new Array(n);
  for (let i = 0; i < n; i += 1) samples[i] = buffer.readInt16LE(i * 2);
  return samples;
};
const rmsWindows = (samples, sr, windowSeconds) => {
  const win = Math.max(1, Math.round(sr * windowSeconds));
  const out = [];
  for (let i = 0; i < samples.length; i += win) {
    const chunk = samples.slice(i, i + win);
    if (!chunk.length) break;
    const rms = Math.sqrt(chunk.reduce((sum, s) => sum + s * s, 0) / chunk.length);
    out.push(rms);
  }
  return { rms: out, win };
};
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const k = (sorted.length - 1) * (p / 100);
  const f = Math.floor(k); const c = Math.min(f + 1, sorted.length - 1);
  return f === c ? sorted[f] : sorted[f] + (sorted[c] - sorted[f]) * (k - f);
};
const pickPeaks = (rms, win, sr, pctThreshold, minSepSeconds) => {
  const threshold = percentile(rms, pctThreshold);
  const winSeconds = win / sr;
  const minSepWindows = Math.max(1, Math.round(minSepSeconds / winSeconds));
  const candidates = [];
  for (let i = 1; i < rms.length - 1; i += 1) if (rms[i] >= threshold && rms[i] >= rms[i - 1] && rms[i] >= rms[i + 1]) candidates.push([i, rms[i]]);
  candidates.sort((a, b) => b[1] - a[1]);
  const accepted = [];
  for (const [idx] of candidates) if (accepted.every(a => Math.abs(idx - a) >= minSepWindows)) accepted.push(idx);
  accepted.sort((a, b) => a - b);
  return accepted.map(idx => idx * winSeconds);
};
const groupRuns = (times, low, high) => {
  if (!times.length) return [];
  const runs = []; let current = [times[0]];
  for (const t of times.slice(1)) {
    const gap = t - current[current.length - 1];
    if (gap >= low && gap <= high) current.push(t); else { runs.push(current); current = [t]; }
  }
  runs.push(current);
  return runs.filter(r => r.length >= 2);
};
const median = values => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

const extractBandpassRaw = (inputPath, sr, highpassHz, lowpassHz) => {
  const result = run(ffmpeg, ['-i', inputPath, '-af', `highpass=f=${highpassHz},highpass=f=${highpassHz},lowpass=f=${lowpassHz},lowpass=f=${lowpassHz}`, '-ar', String(sr), '-ac', '1', '-f', 's16le', '-']);
  if (result.status !== 0) throw new Error(`ffmpeg bandpass extraction failed: ${result.stderr?.toString().slice(-500)}`);
  return loadRawS16leMono(result.stdout);
};

const spec = getAudioSpec();
const SAMPLE_RATE = 24000;

// ---- Check 1: countdown ticks ----
// tick SFX is synthesized 5500-11000Hz (see sfx-synth.js), matching the same band Phase 1 used to
// measure the reference -- so the same bandpass/peak-pick settings apply directly to our own output.
const tickSamples = extractBandpassRaw(target, SAMPLE_RATE, 5500, 11000);
const { rms: tickRms, win: tickWin } = rmsWindows(tickSamples, SAMPLE_RATE, 0.005);
const tickPeakTimes = pickPeaks(tickRms, tickWin, SAMPLE_RATE, 97, 0.09);
const tickRuns = groupRuns(tickPeakTimes, 0.08, 0.45).filter(run => run.length >= spec.countdown.tickCount * 0.9);
const tickSpacings = tickRuns.flatMap(run => run.slice(1).map((t, i) => t - run[i]));
const medianTickSpacing = median(tickSpacings);
{
  const expectedTicks = spec.countdown.tickCount; const expectedSpacing = spec.countdown.tickSpacingSeconds;
  const runCountOk = tickRuns.length >= 1;
  const tickCountOk = tickRuns.every(run => Math.abs(run.length - expectedTicks) <= 1);
  const spacingOk = medianTickSpacing !== null && Math.abs(medianTickSpacing - expectedSpacing) <= expectedSpacing * 0.25;
  record('countdown ticks', runCountOk && tickCountOk && spacingOk,
    `${tickRuns.length} run(s) found, ticks/run=[${tickRuns.map(r => r.length).join(',')}], median spacing=${medianTickSpacing?.toFixed(3)}s (expected ~${expectedSpacing}s, tickCount ~${expectedTicks})`);
}

// ---- Check 2: reveal gap after last tick ----
// reveal SFX is synthesized with partials at 2000Hz and 4000Hz (see sfx-synth.js) -- wider than the
// reference's raw 2400-2900Hz measurement band, so this uses a band that actually covers our own
// design (1500-4500Hz) rather than blindly reusing the reference's narrower band.
const revealSamples = extractBandpassRaw(target, SAMPLE_RATE, 1500, 4500);
const { rms: revealRms, win: revealWin } = rmsWindows(revealSamples, SAMPLE_RATE, 0.005);
const revealPeakTimes = pickPeaks(revealRms, revealWin, SAMPLE_RATE, 99.3, 1.0);
{
  const gaps = [];
  for (const run of tickRuns) {
    const lastTick = run[run.length - 1];
    const next = revealPeakTimes.find(t => t > lastTick);
    if (next !== undefined) gaps.push(next - lastTick);
  }
  const medianGap = median(gaps);
  const expectedGap = spec.reveal.gapAfterLastTickSeconds;
  const gapOk = medianGap !== null && Math.abs(medianGap - expectedGap) <= Math.max(0.3, expectedGap * 0.5);
  record('reveal gap after countdown', gapOk, `${gaps.length} reveal(s) matched to a countdown run, median gap=${medianGap?.toFixed(3)}s (expected ~${expectedGap}s)`);
}

// ---- Check 3: no unexpected blank/frozen video frames ----
// Same spatial-variance method used in Phase 1. Unlike the reference (which has real cut-to-black
// transitions), the WYR template never goes visually blank -- it's a continuous colored background
// with sliding motion. So finding blank runs here is NOT expected and would indicate a real
// rendering defect (e.g. a dropped/corrupt segment), not a missing "reference" feature.
// CAVEAT: this check is only meaningful with real, textured photo content. Flat/solid-color test
// images (e.g. a quick fixture render) have almost no spatial variance anywhere in the frame, which
// this check's low-variance threshold can misread as "blank" throughout -- a test-fixture artifact,
// not a renderer defect. Trust this result on a real production render (real Pixabay/Pexels photos).
{
  const scaleResult = run(ffmpeg, ['-i', target, '-vf', 'scale=48:86,format=gray,fps=20', '-f', 'rawvideo', '-']);
  if (scaleResult.status !== 0) throw new Error(`ffmpeg frame extraction failed: ${scaleResult.stderr?.toString().slice(-500)}`);
  const frameBytes = 48 * 86; const data = scaleResult.stdout; const frameCount = Math.floor(data.length / frameBytes);
  const variance = values => { const mean = values.reduce((s, v) => s + v, 0) / values.length; return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length; };
  const metrics = [];
  for (let i = 0; i < frameCount; i += 1) {
    const frame = data.subarray(i * frameBytes, (i + 1) * frameBytes);
    const top = [...frame.subarray(0, 28 * 48)]; const bottom = [...frame.subarray(58 * 48, 86 * 48)];
    metrics.push(variance(top) + variance(bottom));
  }
  const p5 = percentile(metrics, 5); const threshold = 1.3 * p5;
  const blankFrames = metrics.filter(m => m < threshold).length;
  record('no unexpected blank/frozen frames', blankFrames === 0, `${blankFrames}/${frameCount} frames flagged as blank (expected 0 -- WYR's template never goes visually blank)`);
}

// ---- Check 4: mix levels (volumedetect) ----
{
  const volumeResult = runText(ffmpeg, ['-i', target, '-af', 'volumedetect', '-f', 'null', '-']);
  const maxMatch = volumeResult.stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  const meanMatch = volumeResult.stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  const maxVolume = maxMatch ? Number(maxMatch[1]) : null; const meanVolume = meanMatch ? Number(meanMatch[1]) : null;
  const noClipping = maxVolume !== null && maxVolume < -0.5;
  const nearNarrationTarget = maxVolume !== null && Math.abs(maxVolume - spec.mix.narrationPeakDbfs) <= 4;
  record('mix levels (volumedetect)', noClipping && nearNarrationTarget,
    `max_volume=${maxVolume}dB, mean_volume=${meanVolume}dB (target narration peak ${spec.mix.narrationPeakDbfs}dBFS, no clipping)`);
}

// ---- Check 5: encode profile/bitrate/audio settings ----
{
  const probe = runText(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,profile,level,sample_rate', '-of', 'json', target]);
  let streams = [];
  try { streams = JSON.parse(probe.stdout).streams || []; } catch { /* leave empty, reported as fail below */ }
  const video = streams.find(s => s.codec_name === 'h264'); const audio = streams.find(s => s.codec_name === 'aac');
  const profileOk = video?.profile === 'High';
  const levelOk = video?.level === Math.round(parseFloat(spec.encode.level) * 10);
  const audioOk = audio?.codec_name === 'aac' && String(audio?.sample_rate) === String(spec.encode.audioSampleRate);
  record('encode profile/level/audio', Boolean(profileOk && levelOk && audioOk),
    `video profile=${video?.profile} level=${video?.level} (expect High/${Math.round(parseFloat(spec.encode.level) * 10)}), audio=${audio?.codec_name}@${audio?.sample_rate}Hz`);
}

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);

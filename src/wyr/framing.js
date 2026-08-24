import { spawn } from 'node:child_process';
import { resolveFfmpegPath } from './runtime.js';

// Food-aware crop: compute a cheap photographic saliency map from decoded source pixels, suppress
// peripheral props/table detail, and favor the central colorful/textured subject. Crop coordinates
// are always recomputed against the source-derived cover dimensions; no already-cropped bitmap is
// ever enlarged. The existing geometry/detail safety gate remains the final fallback authority.
export const ANALYSIS_MAX_DIMENSION = 480;
export const TOP_BIAS_STRENGTH = 0.6;
export const MAX_EXCESS_FRACTION = 0.6;
export const MIN_RETAINED_ENERGY_FRACTION = 0.35;
export const FOOD_PHOTO_ZOOM = 1.1;
export const MIN_FOOD_PHOTO_ZOOM = 1.08;
const ZOOM_CANDIDATES = Object.freeze([FOOD_PHOTO_ZOOM, MIN_FOOD_PHOTO_ZOOM, 1]);
const MIN_ZOOM_RETAINED_SALIENCY = 0.88;
const AXIS_TOLERANCE_PX = 2;

const assertPositive = (value, label) => { if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a positive finite number.`); };

export const computeCoverDimensions = ({ sourceWidth, sourceHeight, targetWidth, targetHeight }) => {
  assertPositive(sourceWidth, 'sourceWidth'); assertPositive(sourceHeight, 'sourceHeight');
  assertPositive(targetWidth, 'targetWidth'); assertPositive(targetHeight, 'targetHeight');
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  return { coverWidth: Math.max(targetWidth, Math.round(sourceWidth * scale)), coverHeight: Math.max(targetHeight, Math.round(sourceHeight * scale)), scale };
};

export const determineCropAxis = ({ coverWidth, coverHeight, targetWidth, targetHeight }) => {
  const widthExcess = coverWidth - targetWidth; const heightExcess = coverHeight - targetHeight;
  if (widthExcess <= AXIS_TOLERANCE_PX && heightExcess <= AXIS_TOLERANCE_PX) return 'none';
  return widthExcess > heightExcess ? 'horizontal' : 'vertical';
};

export const computeExcessFraction = ({ coverWidth, coverHeight, targetWidth, targetHeight, axis }) => {
  if (axis === 'horizontal') return Math.max(0, (coverWidth - targetWidth) / coverWidth);
  if (axis === 'vertical') return Math.max(0, (coverHeight - targetHeight) / coverHeight);
  return 0;
};

// Pure and independently testable: given a 1-D energy profile (row sums for a vertical crop, column
// sums for a horizontal one), finds the window of `windowLength` samples that keeps the most energy,
// applying the top-bias only on the vertical axis. Ties (and the un-biased horizontal axis) resolve
// toward the geometric center, matching the old center-crop default when detail is evenly spread.
export const chooseCropOffset = ({ profile, axis, windowLength, topBiasStrength = TOP_BIAS_STRENGTH }) => {
  const analysisLength = profile.length;
  const clampedWindow = Math.max(1, Math.min(windowLength, analysisLength));
  const windowCount = analysisLength - clampedWindow + 1;
  const prefix = new Array(analysisLength + 1).fill(0);
  for (let i = 0; i < analysisLength; i += 1) prefix[i + 1] = prefix[i] + profile[i];
  const totalEnergy = prefix[analysisLength];
  const center = (windowCount - 1) / 2;
  let bestIndex = 0; let bestScore = -Infinity;
  for (let start = 0; start < windowCount; start += 1) {
    const windowEnergy = prefix[start + clampedWindow] - prefix[start];
    const bias = axis === 'vertical' && windowCount > 1 ? 1 + topBiasStrength * (1 - start / (windowCount - 1)) : 1;
    const score = windowEnergy * bias;
    const better = score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && Math.abs(start - center) < Math.abs(bestIndex - center));
    if (better) { bestScore = score; bestIndex = start; }
  }
  const bestWindowEnergy = prefix[bestIndex + clampedWindow] - prefix[bestIndex];
  return {
    offsetFraction: windowCount > 1 ? bestIndex / (windowCount - 1) : 0,
    retainedFraction: totalEnergy > 0 ? bestWindowEnergy / totalEnergy : 1,
    bestIndex, windowLength: clampedWindow, analysisLength,
  };
};

export const assessCropSafety = ({ excessFraction, retainedFraction }) => {
  if (excessFraction > MAX_EXCESS_FRACTION) return { safe: false, reason: `framing rejected: source aspect ratio requires cropping away ${Math.round(excessFraction * 100)}% of the image, well beyond the ${Math.round(MAX_EXCESS_FRACTION * 100)}% safety limit` };
  if (retainedFraction < MIN_RETAINED_ENERGY_FRACTION) return { safe: false, reason: `framing rejected: best available crop window keeps only ${Math.round(retainedFraction * 100)}% of the image's visual detail, below the ${Math.round(MIN_RETAINED_ENERGY_FRACTION * 100)}% safety floor -- the subject is likely cut off` };
  return { safe: true, reason: null };
};

const readStdout = child => new Promise((resolve, reject) => {
  const chunks = []; let stderr = '';
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`FFmpeg edge-energy analysis exited with code ${code}: ${stderr}`)));
});

// One ffmpeg call: scale to a bounded analysis resolution (preserving the exact cover aspect ratio,
// so pixel-row/column indices map linearly back to the full-resolution cover image), run edge
// detection, and stream the grayscale result back as raw bytes. Summed per-row/per-column, this is a
// cheap, dependency-free stand-in for a saliency map -- no model weights, no native bindings.
export const readEdgeEnergyProfile = async ({ localPath, coverWidth, coverHeight, axis, ffmpegPath = resolveFfmpegPath() }) => {
  const scaleFactor = Math.min(1, ANALYSIS_MAX_DIMENSION / Math.max(coverWidth, coverHeight));
  const analysisWidth = Math.max(2, Math.round(coverWidth * scaleFactor));
  const analysisHeight = Math.max(2, Math.round(coverHeight * scaleFactor));
  const child = spawn(ffmpegPath, ['-hide_banner', '-v', 'error', '-i', localPath, '-vf', `scale=${analysisWidth}:${analysisHeight}:flags=area,format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-frames:v', '1', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const buffer = await readStdout(child);
  const expected = analysisWidth * analysisHeight * 3;
  if (buffer.length < expected) throw new Error(`Edge-energy analysis produced ${buffer.length} bytes, expected ${expected} for ${analysisWidth}x${analysisHeight}.`);
  const xProfile = new Array(analysisWidth).fill(0); const yProfile = new Array(analysisHeight).fill(0);
  const safetyXProfile = new Array(analysisWidth).fill(0); const safetyYProfile = new Array(analysisHeight).fill(0);
  let lumaTotal = 0;
  const channel = (x, y, component) => buffer[(Math.max(0, Math.min(analysisHeight - 1, y)) * analysisWidth + Math.max(0, Math.min(analysisWidth - 1, x))) * 3 + component];
  for (let y = 0; y < analysisHeight; y += 1) {
    const ny = (y + 0.5) / analysisHeight - 0.5;
    for (let x = 0; x < analysisWidth; x += 1) {
      const nx = (x + 0.5) / analysisWidth - 0.5;
      const i = (y * analysisWidth + x) * 3; const r = buffer[i]; const g = buffer[i + 1]; const b = buffer[i + 2];
      const maximum = Math.max(r, g, b); const minimum = Math.min(r, g, b);
      const saturation = maximum > 0 ? (maximum - minimum) / maximum : 0;
      const neighborContrast = (
        Math.abs(r - channel(x - 1, y, 0)) + Math.abs(g - channel(x - 1, y, 1)) + Math.abs(b - channel(x - 1, y, 2))
        + Math.abs(r - channel(x, y - 1, 0)) + Math.abs(g - channel(x, y - 1, 1)) + Math.abs(b - channel(x, y - 1, 2))
      ) / 6;
      // Broad colorful regions and meaningful texture score; thin high-contrast utensil/table lines
      // no longer dominate merely because they create a strong edge. A soft radial prior makes a
      // central dish win over equally detailed props without hard-locking the crop to dead center.
      const rawSaliency = 0.25 + neighborContrast * (0.75 + saturation * 0.5) + saturation * 12;
      const centralPrior = 0.22 + 0.78 * Math.exp(-((nx * nx) / 0.12 + (ny * ny) / 0.16));
      const focalSaliency = rawSaliency * centralPrior;
      xProfile[x] += focalSaliency; yProfile[y] += focalSaliency;
      safetyXProfile[x] += rawSaliency; safetyYProfile[y] += rawSaliency;
      lumaTotal += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  }
  return {
    profile: axis === 'vertical' ? yProfile : xProfile,
    safetyProfile: axis === 'vertical' ? safetyYProfile : safetyXProfile,
    xProfile, yProfile, safetyXProfile, safetyYProfile, analysisWidth, analysisHeight,
    averageLuma: lumaTotal / (analysisWidth * analysisHeight),
  };
};

const profileCenter = profile => {
  if (!profile?.length) return 0.5;
  const total = profile.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0.5;
  return profile.reduce((sum, value, index) => sum + value * ((index + 0.5) / profile.length), 0) / total;
};

// Keep render metadata compact while allowing old/test crop doubles that only return x/y/cover
// dimensions to remain byte-for-byte compatible with the existing pipeline.
export const renderableCrop = framing => {
  const crop = { x: framing.x, y: framing.y, coverWidth: framing.coverWidth, coverHeight: framing.coverHeight };
  for (const key of ['zoom', 'brightness', 'gamma', 'focalX', 'focalY']) if (Number.isFinite(framing?.[key])) crop[key] = framing[key];
  return crop;
};

const retainedAt = ({ profile, center, windowFraction }) => {
  if (!profile?.length) return { retainedFraction: 1, startFraction: 0, endFraction: 1 };
  const size = Math.max(1, Math.min(profile.length, Math.round(profile.length * windowFraction)));
  const start = Math.max(0, Math.min(profile.length - size, Math.round(center * profile.length - size / 2)));
  const total = profile.reduce((sum, value) => sum + value, 0);
  const retained = profile.slice(start, start + size).reduce((sum, value) => sum + value, 0);
  return { retainedFraction: total > 0 ? retained / total : 1, startFraction: start / profile.length, endFraction: (start + size) / profile.length };
};

const chooseAdaptiveZoom = ({ cover, targetWidth, targetHeight, focalX, focalY, safetyXProfile, safetyYProfile }) => {
  if (!safetyXProfile?.length || !safetyYProfile?.length) return 1;
  for (const zoom of ZOOM_CANDIDATES) {
    const x = retainedAt({ profile: safetyXProfile, center: focalX, windowFraction: targetWidth / (cover.coverWidth * zoom) });
    const y = retainedAt({ profile: safetyYProfile, center: focalY, windowFraction: targetHeight / (cover.coverHeight * zoom) });
    if (x.retainedFraction >= MIN_ZOOM_RETAINED_SALIENCY && y.retainedFraction >= MIN_ZOOM_RETAINED_SALIENCY) return zoom;
  }
  return 1;
};

// Full orchestration used by images.js at download time. `readEnergyProfile` is injectable so tests
// can exercise the safety-rejection/fallback wiring without spawning ffmpeg for every candidate.
export const computeSubjectAwareCrop = async ({ localPath, sourceWidth, sourceHeight, targetWidth, targetHeight, ffmpegPath = resolveFfmpegPath(), readEnergyProfile = readEdgeEnergyProfile }) => {
  const cover = computeCoverDimensions({ sourceWidth, sourceHeight, targetWidth, targetHeight });
  const axis = determineCropAxis({ coverWidth: cover.coverWidth, coverHeight: cover.coverHeight, targetWidth, targetHeight });
  const centeredX = Math.round((cover.coverWidth - targetWidth) / 2); const centeredY = Math.round((cover.coverHeight - targetHeight) / 2);
  const excessFraction = computeExcessFraction({ coverWidth: cover.coverWidth, coverHeight: cover.coverHeight, targetWidth, targetHeight, axis });
  if (excessFraction > MAX_EXCESS_FRACTION) {
    const safety = assessCropSafety({ excessFraction, retainedFraction: 1 });
    return { x: centeredX, y: centeredY, coverWidth: cover.coverWidth, coverHeight: cover.coverHeight, axis, safe: false, reason: safety.reason, retainedFraction: 1, excessFraction, zoom: 1 };
  }
  const analysis = await readEnergyProfile({ localPath, coverWidth: cover.coverWidth, coverHeight: cover.coverHeight, axis: axis === 'none' ? 'horizontal' : axis, ffmpegPath });
  const { profile, safetyProfile = profile, analysisWidth, analysisHeight } = analysis;
  const analysisLength = axis === 'vertical' ? analysisHeight : analysisWidth;
  const coverLength = axis === 'vertical' ? cover.coverHeight : cover.coverWidth;
  const targetLength = axis === 'vertical' ? targetHeight : targetWidth;
  const windowLength = Math.max(1, Math.round(analysisLength * (targetLength / coverLength)));
  const chosen = axis === 'none'
    ? { bestIndex: 0, offsetFraction: 0, retainedFraction: 1, windowLength: analysisLength, analysisLength }
    : chooseCropOffset({ profile, axis, windowLength, topBiasStrength: 0.08 });
  let winner = chosen;
  const safetyAt = choice => {
    if (axis === 'none') return 1;
    const length = choice.windowLength; const start = choice.bestIndex;
    const total = safetyProfile.reduce((sum, value) => sum + value, 0);
    const retained = safetyProfile.slice(start, start + length).reduce((sum, value) => sum + value, 0);
    return total > 0 ? retained / total : 1;
  };
  let retainedFraction = safetyAt(chosen);
  let safety = assessCropSafety({ excessFraction, retainedFraction });
  // Safe-alternative-crop recovery: the top bias (vertical axis only) trades some raw retained
  // energy for a better chance of keeping a head/face in frame, so it's possible for the SAME
  // image's plain maximum-energy window (topBiasStrength=0 -- mathematically >= the biased choice's
  // retainedFraction, since the biased search is strictly more constrained) to clear the retained-
  // energy safety floor when the top-biased choice doesn't. Tried only when the biased choice fails,
  // reuses the exact same edge-energy profile and the exact same safety gate (never a blind center
  // guess, never a weakened floor) -- if even the unbiased maximum still fails, no crop position
  // could ever satisfy the floor for this image, and the candidate is correctly rejected below.
  if (!safety.safe && axis === 'vertical') {
    const unbiased = chooseCropOffset({ profile, axis, windowLength, topBiasStrength: 0 });
    const unbiasedRetained = safetyAt(unbiased);
    const unbiasedSafety = assessCropSafety({ excessFraction, retainedFraction: unbiasedRetained });
    if (unbiasedSafety.safe) { winner = unbiased; retainedFraction = unbiasedRetained; safety = unbiasedSafety; }
  }
  if (!safety.safe) return { x: centeredX, y: centeredY, coverWidth: cover.coverWidth, coverHeight: cover.coverHeight, axis, safe: false, reason: safety.reason, retainedFraction, excessFraction, zoom: 1 };
  const axisCenter = analysisLength ? (winner.bestIndex + winner.windowLength / 2) / analysisLength : 0.5;
  const focalX = axis === 'horizontal' ? axisCenter : profileCenter(analysis.xProfile);
  const focalY = axis === 'vertical' ? axisCenter : profileCenter(analysis.yProfile);
  const zoom = chooseAdaptiveZoom({ cover, targetWidth, targetHeight, focalX, focalY, safetyXProfile: analysis.safetyXProfile, safetyYProfile: analysis.safetyYProfile });
  const coverWidth = Math.max(targetWidth, Math.round(cover.coverWidth * zoom));
  const coverHeight = Math.max(targetHeight, Math.round(cover.coverHeight * zoom));
  const x = Math.round(Math.max(0, Math.min(coverWidth - targetWidth, focalX * coverWidth - targetWidth / 2)));
  const y = Math.round(Math.max(0, Math.min(coverHeight - targetHeight, focalY * coverHeight - targetHeight / 2)));
  const averageLuma = Number(analysis.averageLuma);
  const brightness = Number.isFinite(averageLuma) ? averageLuma < 82 ? 0.015 : averageLuma < 150 ? 0.008 : averageLuma > 205 ? -0.004 : 0.003 : 0.006;
  const gamma = Number.isFinite(averageLuma) ? averageLuma < 105 ? 1.025 : averageLuma < 175 ? 1.012 : 1 : 1.01;
  return { x, y, coverWidth, coverHeight, axis, safe: true, reason: null, retainedFraction, excessFraction, zoom, brightness, gamma, focalX, focalY };
};

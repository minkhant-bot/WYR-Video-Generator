import { spawn } from 'node:child_process';
import { resolveFfmpegPath } from './runtime.js';

// Subject-aware crop: instead of always centering the crop window on the geometric center of the
// scaled ("cover") image, this scores where the visual detail (edge energy) actually is along the
// axis that must be cropped, and places the window there instead. Vertical crops (portrait/square
// sources squeezed into the landscape 750x450 slot -- the case most likely to behead a person) get
// an extra bias toward the top of the frame, since a head/face is overwhelmingly more likely to sit
// in the upper portion of a photo than the lower portion, and losing legs/background is far less
// damaging than losing a head. This is a heuristic, not real face detection: there is no ML face
// detector available in this pipeline, so `assessCropSafety` exists as a backstop -- when an image's
// aspect ratio is too extreme, or even the best-scoring window keeps too little of the image's
// detail, the candidate is rejected outright rather than forcing a crop that likely mutilates the
// subject (see images.js's use of this to fall back to the next ranked candidate).
export const ANALYSIS_MAX_DIMENSION = 480;
export const TOP_BIAS_STRENGTH = 0.6;
export const MAX_EXCESS_FRACTION = 0.6;
export const MIN_RETAINED_ENERGY_FRACTION = 0.35;
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
  const child = spawn(ffmpegPath, ['-hide_banner', '-v', 'error', '-i', localPath, '-vf', `scale=${analysisWidth}:${analysisHeight}:flags=area,edgedetect=low=0.1:high=0.4,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-frames:v', '1', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const buffer = await readStdout(child);
  const expected = analysisWidth * analysisHeight;
  if (buffer.length < expected) throw new Error(`Edge-energy analysis produced ${buffer.length} bytes, expected ${expected} for ${analysisWidth}x${analysisHeight}.`);
  const profile = new Array(axis === 'vertical' ? analysisHeight : analysisWidth).fill(0);
  if (axis === 'vertical') {
    for (let y = 0; y < analysisHeight; y += 1) { let sum = 0; const rowOffset = y * analysisWidth; for (let x = 0; x < analysisWidth; x += 1) sum += buffer[rowOffset + x]; profile[y] = sum; }
  } else {
    for (let y = 0; y < analysisHeight; y += 1) { const rowOffset = y * analysisWidth; for (let x = 0; x < analysisWidth; x += 1) profile[x] += buffer[rowOffset + x]; }
  }
  return { profile, analysisWidth, analysisHeight };
};

// Full orchestration used by images.js at download time. `readEnergyProfile` is injectable so tests
// can exercise the safety-rejection/fallback wiring without spawning ffmpeg for every candidate.
export const computeSubjectAwareCrop = async ({ localPath, sourceWidth, sourceHeight, targetWidth, targetHeight, ffmpegPath = resolveFfmpegPath(), readEnergyProfile = readEdgeEnergyProfile }) => {
  const cover = computeCoverDimensions({ sourceWidth, sourceHeight, targetWidth, targetHeight });
  const axis = determineCropAxis({ coverWidth: cover.coverWidth, coverHeight: cover.coverHeight, targetWidth, targetHeight });
  const centeredX = Math.round((cover.coverWidth - targetWidth) / 2); const centeredY = Math.round((cover.coverHeight - targetHeight) / 2);
  if (axis === 'none') return { x: centeredX, y: centeredY, coverWidth: cover.coverWidth, coverHeight: cover.coverHeight, axis, safe: true, reason: null, retainedFraction: 1, excessFraction: 0 };
  const excessFraction = computeExcessFraction({ coverWidth: cover.coverWidth, coverHeight: cover.coverHeight, targetWidth, targetHeight, axis });
  const { profile, analysisWidth, analysisHeight } = await readEnergyProfile({ localPath, coverWidth: cover.coverWidth, coverHeight: cover.coverHeight, axis, ffmpegPath });
  const analysisLength = axis === 'vertical' ? analysisHeight : analysisWidth;
  const coverLength = axis === 'vertical' ? cover.coverHeight : cover.coverWidth;
  const targetLength = axis === 'vertical' ? targetHeight : targetWidth;
  const windowLength = Math.max(1, Math.round(analysisLength * (targetLength / coverLength)));
  const chosen = chooseCropOffset({ profile, axis, windowLength });
  let winner = chosen;
  let safety = assessCropSafety({ excessFraction, retainedFraction: chosen.retainedFraction });
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
    const unbiasedSafety = assessCropSafety({ excessFraction, retainedFraction: unbiased.retainedFraction });
    if (unbiasedSafety.safe) { winner = unbiased; safety = unbiasedSafety; }
  }
  const maxOffsetPixels = coverLength - targetLength;
  const offsetPixels = Math.round(winner.offsetFraction * maxOffsetPixels);
  const x = axis === 'horizontal' ? offsetPixels : centeredX;
  const y = axis === 'vertical' ? offsetPixels : centeredY;
  return { x, y, coverWidth: cover.coverWidth, coverHeight: cover.coverHeight, axis, safe: safety.safe, reason: safety.reason, retainedFraction: winner.retainedFraction, excessFraction };
};

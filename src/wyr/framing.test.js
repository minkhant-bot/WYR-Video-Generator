import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessCropSafety, chooseCropOffset, computeCoverDimensions, computeExcessFraction, computeSubjectAwareCrop, determineCropAxis, MAX_EXCESS_FRACTION, MIN_RETAINED_ENERGY_FRACTION } from './framing.js';
import { resolveFfmpegPath } from './runtime.js';

test('computeCoverDimensions scales to fully cover the target without ever going under it, preserving aspect ratio', () => {
  const cover = computeCoverDimensions({ sourceWidth: 2000, sourceHeight: 1000, targetWidth: 750, targetHeight: 450 });
  assert.ok(cover.coverWidth >= 750 && cover.coverHeight >= 450);
  // aspect ratio preserved: coverWidth/coverHeight should match sourceWidth/sourceHeight
  assert.ok(Math.abs(cover.coverWidth / cover.coverHeight - 2000 / 1000) < 0.01);
});

test('determineCropAxis identifies which axis needs cropping, or none when the aspect ratio already matches', () => {
  assert.equal(determineCropAxis({ coverWidth: 750, coverHeight: 450, targetWidth: 750, targetHeight: 450 }), 'none');
  assert.equal(determineCropAxis({ coverWidth: 750, coverHeight: 1000, targetWidth: 750, targetHeight: 450 }), 'vertical');
  assert.equal(determineCropAxis({ coverWidth: 1200, coverHeight: 450, targetWidth: 750, targetHeight: 450 }), 'horizontal');
});

test('computeExcessFraction reports how much of the covered image must be cut away on the cropped axis', () => {
  assert.equal(computeExcessFraction({ coverWidth: 750, coverHeight: 900, targetWidth: 750, targetHeight: 450, axis: 'vertical' }), 0.5);
  assert.equal(computeExcessFraction({ coverWidth: 750, coverHeight: 450, targetWidth: 750, targetHeight: 450, axis: 'none' }), 0);
});

test('chooseCropOffset picks the window that keeps the most edge energy, and biases vertical crops toward the top', () => {
  // All the energy is in the first 100 samples of a 300-sample profile; a 150-sample window has to
  // choose between including it near its start (small offset) or missing it -- top bias should push
  // it to the very top even though a slightly-lower window would also fully contain the energy.
  const profile = new Array(300).fill(0); for (let i = 0; i < 100; i += 1) profile[i] = 10;
  const vertical = chooseCropOffset({ profile, axis: 'vertical', windowLength: 150 });
  assert.equal(vertical.bestIndex, 0);
  assert.ok(vertical.retainedFraction > 0.99);

  // Horizontal crops are not top-biased -- among windows that equally capture all the energy (here,
  // any start from 50 to 100 fully contains the [100,200) energy band), the choice should land on
  // the one closest to the geometric center of the window range (75) rather than being pushed to an
  // edge the way the vertical/top-biased case above is.
  const centeredProfile = new Array(300).fill(0); for (let i = 100; i < 200; i += 1) centeredProfile[i] = 10;
  const horizontal = chooseCropOffset({ profile: centeredProfile, axis: 'horizontal', windowLength: 150 });
  assert.equal(horizontal.bestIndex, 75, `expected the centered tie-break window, got start index ${horizontal.bestIndex}`);
  assert.ok(horizontal.retainedFraction > 0.99);
});

test('assessCropSafety rejects both an overly extreme aspect ratio and a window that keeps too little detail', () => {
  assert.equal(assessCropSafety({ excessFraction: MAX_EXCESS_FRACTION + 0.05, retainedFraction: 1 }).safe, false);
  assert.equal(assessCropSafety({ excessFraction: 0, retainedFraction: MIN_RETAINED_ENERGY_FRACTION - 0.05 }).safe, false);
  assert.equal(assessCropSafety({ excessFraction: 0.1, retainedFraction: 0.9 }).safe, true);
});

test('computeSubjectAwareCrop analyzes a matching-aspect source so adaptive zoom is still source-derived', async () => {
  let analyzed = false;
  const result = await computeSubjectAwareCrop({ localPath: '/nonexistent.jpg', sourceWidth: 1500, sourceHeight: 900, targetWidth: 750, targetHeight: 450, readEnergyProfile: async () => { analyzed = true; return { profile: [], analysisWidth: 0, analysisHeight: 0 }; } });
  assert.equal(result.safe, true); assert.equal(result.axis, 'none'); assert.equal(analyzed, true);
  assert.equal(result.x, 0); assert.equal(result.y, 0);
});

test('computeSubjectAwareCrop rejects an extreme aspect ratio purely from geometry, without even reading pixel data', async () => {
  let analyzed = false;
  const result = await computeSubjectAwareCrop({ localPath: '/nonexistent.jpg', sourceWidth: 300, sourceHeight: 1500, targetWidth: 750, targetHeight: 450, readEnergyProfile: async () => { analyzed = true; return { profile: new Array(480).fill(1), analysisWidth: 187, analysisHeight: 480 }; } });
  assert.equal(result.safe, false);
  assert.match(result.reason, /framing rejected/);
});

test('adaptive food zoom uses 1.10x for a compact center subject and disables zoom for edge-spanning arrangements', async () => {
  const concentrated = new Array(100).fill(0); for (let index = 35; index < 65; index += 1) concentrated[index] = 10;
  const edgeSpanning = new Array(100).fill(0); for (let index = 0; index < 12; index += 1) edgeSpanning[index] = 10; for (let index = 88; index < 100; index += 1) edgeSpanning[index] = 10;
  const analyze = safety => async () => ({ profile: concentrated, safetyProfile: safety, xProfile: concentrated, yProfile: concentrated, safetyXProfile: safety, safetyYProfile: safety, analysisWidth: 100, analysisHeight: 100, averageLuma: 120 });
  const compact = await computeSubjectAwareCrop({ localPath: '/not-read.jpg', sourceWidth: 1600, sourceHeight: 1000, targetWidth: 960, targetHeight: 600, readEnergyProfile: analyze(concentrated) });
  const platter = await computeSubjectAwareCrop({ localPath: '/not-read.jpg', sourceWidth: 1600, sourceHeight: 1000, targetWidth: 960, targetHeight: 600, readEnergyProfile: analyze(edgeSpanning) });
  assert.equal(compact.zoom, 1.1); assert.deepEqual([compact.coverWidth, compact.coverHeight], [1056, 660]);
  assert.equal(platter.zoom, 1); assert.deepEqual([platter.coverWidth, platter.coverHeight], [960, 600]);
});

test('computeSubjectAwareCrop keeps a synthetic head band inside the crop window on a real image via real ffmpeg edge analysis', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-framing-real-'));
  try {
    const ffmpeg = resolveFfmpegPath();
    const width = 700; const height = 1000;
    const jpg = path.join(root, 'subject.jpg');
    // A bright "head" square near the top on a flat dark background -- the only real edges in the
    // frame surround that square, so a saliency-driven crop must include it.
    const result = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=1`, '-vf', `drawbox=x=${Math.round(width * 0.3)}:y=${Math.round(height * 0.05)}:w=${Math.round(width * 0.4)}:h=${Math.round(height * 0.15)}:color=white:t=fill`, '-frames:v', '1', jpg], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const crop = await computeSubjectAwareCrop({ localPath: jpg, sourceWidth: width, sourceHeight: height, targetWidth: 750, targetHeight: 450 });
    assert.equal(crop.safe, true);
    // Convert the head band's pixel bounds into cover space and assert the chosen window contains it.
    const scale = crop.coverWidth / width;
    const headTop = height * 0.05 * scale; const headBottom = (height * 0.05 + height * 0.15) * scale;
    assert.ok(crop.y <= headTop, `crop window top (${crop.y}) should be at/above the head's top (${headTop})`);
    assert.ok(crop.y + 450 >= headBottom, `crop window bottom (${crop.y + 450}) should be at/below the head's bottom (${headBottom})`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

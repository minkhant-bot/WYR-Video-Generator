import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateDownloadedImageForRender } from './images.js';
import { resolveFfmpegPath } from './runtime.js';

const ffmpeg = resolveFfmpegPath();
const renderFoodFixture = ({ width, height, blurred = false }) => {
  const destination = path.join(os.tmpdir(), `wyr-food-quality-${randomUUID()}.jpg`);
  const subjectWidth = Math.round(width * 0.58); const subjectHeight = Math.round(height * 0.58);
  const x = Math.round((width - subjectWidth) / 2); const y = Math.round((height - subjectHeight) / 2);
  const subjectFilter = `scale=${subjectWidth}:${subjectHeight}${blurred ? ',gblur=sigma=24' : ''}`;
  const result = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', `color=c=white:s=${width}x${height}`,
    '-f', 'lavfi', '-i', `testsrc2=s=${subjectWidth}x${subjectHeight}:rate=1`,
    '-filter_complex', `[1:v]${subjectFilter}[subject];[0:v][subject]overlay=${x}:${y}`,
    '-frames:v', '1', destination,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not create FOOD quality fixture: ${result.stderr}`);
  return destination;
};

const inspectFood = localPath => validateDownloadedImageForRender({ localPath, option: { category: 'food', text: 'Fixture Food' } });

test('decoded FOOD image requiring material crop/zoom upscaling is rejected', async () => {
  const image = renderFoodFixture({ width: 800, height: 800 });
  try {
    const quality = await inspectFood(image);
    assert.equal(quality.valid, false);
    assert.match(quality.reasons.join(' '), /effective upscaling/);
  } finally { fs.rmSync(image, { force: true }); }
});

test('sufficiently large square and portrait FOOD images remain accepted', async () => {
  const square = renderFoodFixture({ width: 1200, height: 1200 });
  const portrait = renderFoodFixture({ width: 1200, height: 1800 });
  try {
    const [squareQuality, portraitQuality] = await Promise.all([inspectFood(square), inspectFood(portrait)]);
    assert.equal(squareQuality.valid, true, JSON.stringify(squareQuality));
    assert.equal(portraitQuality.valid, true, JSON.stringify(portraitQuality));
    assert.ok(squareQuality.resolution.upscaleFactor <= 1);
    assert.ok(portraitQuality.resolution.upscaleFactor <= 1);
  } finally { fs.rmSync(square, { force: true }); fs.rmSync(portrait, { force: true }); }
});

test('visibly blurred FOOD subject is rejected by decoded crop sharpness', async () => {
  const image = renderFoodFixture({ width: 1600, height: 1000, blurred: true });
  try {
    const quality = await inspectFood(image);
    assert.equal(quality.valid, false, JSON.stringify(quality));
    assert.match(quality.reasons.join(' '), /blurred|sharpness/);
  } finally { fs.rmSync(image, { force: true }); }
});

test('clean white background does not penalize a crisp isolated FOOD subject', async () => {
  const image = renderFoodFixture({ width: 1600, height: 1000 });
  try {
    const quality = await inspectFood(image);
    assert.equal(quality.valid, true, JSON.stringify(quality));
    assert.ok(quality.sharpness.usefulFraction < 0.75, 'fixture must retain a substantial excluded white-background region');
    assert.ok(quality.sharpness.score >= 2);
  } finally { fs.rmSync(image, { force: true }); }
});

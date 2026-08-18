// Dev-only visual review artifact for the subject-aware image framing change. Not part of the
// production pipeline: builds 8 synthetic source images (one per source-shape category requested
// for review), renders each into the real 750x450 image slot two ways -- BEFORE (the old plain
// center-crop math) and AFTER (buildFramedImageChain with a computeSubjectAwareCrop offset) -- and
// assembles a labeled contact sheet so the framing change can be inspected visually.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SUBJECT_PRESETS, renderSyntheticSubject } from '../src/wyr/fixtures.js';
import { computeSubjectAwareCrop } from '../src/wyr/framing.js';
import { buildFramedImageChain } from '../src/wyr/media.js';
import { WYR_TEMPLATE } from '../src/wyr/template.js';
import { resolveFfmpegPath, assertFontAvailable, PROJECT_ROOT } from '../src/wyr/runtime.js';

const ffmpegPath = resolveFfmpegPath();
const workspace = path.join(PROJECT_ROOT, 'data', 'framing-review');
fs.rmSync(workspace, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
  child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${stderr}`)));
});

const { imageWidth: width, imageHeight: height } = WYR_TEMPLATE.layout;
const colors = ['#28547a', '#bd6c42', '#3e806e', '#704b8e', '#9b793c', '#426e98', '#a34e64', '#477c75'];
const hexToRgb = hex => hex.match(/[a-f\d]{2}/gi).map(value => Number.parseInt(value, 16));

const renderStill = async ({ sourcePath, crop, destination }) => {
  const [filter] = buildFramedImageChain({ input: '0:v', width, height, fps: 30, outLabel: 'out', chainId: 'x', crop });
  const stage = filter.slice(filter.indexOf(']') + 1, filter.lastIndexOf('['));
  await run(['-y', '-i', sourcePath, '-vf', stage, '-frames:v', '1', '-q:v', '3', destination]);
};

const font = assertFontAvailable();
const filterPath = file => file.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''");
const labelTile = async ({ imagePath, label, destination }) => {
  const textFile = `${destination}.txt`; fs.writeFileSync(textFile, label);
  await run(['-y', '-i', imagePath, '-vf', `pad=${width}:${height + 40}:0:0:black,drawtext=fontfile=${filterPath(font)}:textfile='${filterPath(textFile)}':fontcolor=white:fontsize=20:x=10:y=${height + 8}`, '-frames:v', '1', '-q:v', '3', destination]);
  fs.rmSync(textFile, { force: true });
};

const report = [];
const tiles = [];
for (let index = 0; index < SUBJECT_PRESETS.length; index += 1) {
  const preset = SUBJECT_PRESETS[index];
  const bg = hexToRgb(colors[index % colors.length]); const accent = hexToRgb(colors[(index + 4) % colors.length]);
  const sourcePath = path.join(workspace, `${index + 1}-${preset.kind}-source.jpg`);
  await renderSyntheticSubject({ ffmpegPath, kind: preset.kind, width: preset.width, height: preset.height, bg, accent, destination: sourcePath });

  const beforePath = path.join(workspace, `${index + 1}-${preset.kind}-before.jpg`);
  await renderStill({ sourcePath, crop: null, destination: beforePath });
  const beforeTile = path.join(workspace, `${index + 1}-${preset.kind}-before-tile.jpg`);
  await labelTile({ imagePath: beforePath, label: `${preset.kind} (${preset.width}x${preset.height}) -- BEFORE: plain center crop`, destination: beforeTile });
  tiles.push(beforeTile);

  const framing = await computeSubjectAwareCrop({ localPath: sourcePath, sourceWidth: preset.width, sourceHeight: preset.height, targetWidth: width, targetHeight: height, ffmpegPath });
  const afterPath = path.join(workspace, `${index + 1}-${preset.kind}-after.jpg`);
  const afterTile = path.join(workspace, `${index + 1}-${preset.kind}-after-tile.jpg`);
  if (framing.safe) {
    await renderStill({ sourcePath, crop: { x: framing.x, y: framing.y, coverWidth: framing.coverWidth, coverHeight: framing.coverHeight }, destination: afterPath });
    await labelTile({ imagePath: afterPath, label: `${preset.kind} -- AFTER: subject-aware crop (y=${framing.y} x=${framing.x}, kept ${Math.round(framing.retainedFraction * 100)}% detail)`, destination: afterTile });
  } else {
    // Requirement 5: an unsafe crop must never be forced -- render a plain red "REJECTED" placeholder
    // instead of a bad crop, standing in for the real pipeline's candidate-fallback behavior.
    await run(['-y', '-f', 'lavfi', '-i', `color=c=0x330000:s=${width}x${height}:d=1`, '-vf', `drawtext=fontfile=${filterPath(font)}:text='REJECTED -- would fall back to next candidate':fontcolor=white:fontsize=26:x=(w-text_w)/2:y=(h-text_h)/2`, '-frames:v', '1', afterPath]);
    await labelTile({ imagePath: afterPath, label: `${preset.kind} -- AFTER: unsafe (${framing.reason})`, destination: afterTile });
  }
  tiles.push(afterTile);
  report.push({ kind: preset.kind, width: preset.width, height: preset.height, safe: framing.safe, x: framing.x, y: framing.y, retainedFraction: framing.retainedFraction, excessFraction: framing.excessFraction, reason: framing.reason });
}

const contactSheetPath = path.join(workspace, 'contact-sheet.jpg');
const tileArgs = tiles.flatMap(tile => ['-i', tile]);
const layout = tiles.map((_, index) => `${(index % 2) * width}_${Math.floor(index / 2) * (height + 40)}`).join('|');
await run(['-y', ...tileArgs, '-filter_complex', `xstack=inputs=${tiles.length}:layout=${layout}:fill=black`, '-q:v', '2', contactSheetPath]);

const outputDir = path.join(PROJECT_ROOT, 'output'); fs.mkdirSync(outputDir, { recursive: true });
const publishedContactSheet = path.join(outputDir, 'framing-before-after-contact-sheet.jpg');
fs.copyFileSync(contactSheetPath, publishedContactSheet);
fs.writeFileSync(path.join(workspace, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: 'completed', contactSheetPath: publishedContactSheet, report }, null, 2));

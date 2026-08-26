import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpegPath } from './runtime.js';
import { computeSubjectAwareCrop, renderableCrop } from './framing.js';
import { WYR_TEMPLATE } from './template.js';

const questions = [
  ['Explore a mountain cabin', 'Relax at a tropical beach villa', 58, 42],
  ['Master every musical instrument', 'Speak every language fluently', 46, 54],
  ['Travel through space', 'Explore the deepest ocean', 63, 37],
  ['Eat breakfast for every meal', 'Eat dessert for every meal', 52, 48],
  ['Own a private cinema with unlimited screenings', 'Own a private rooftop garden overlooking the entire city skyline', 57, 43],
  ['Always have perfect weather', 'Always find a perfect parking spot', 71, 29],
  ['Live in a glass treehouse', 'Live on a luxury houseboat', 49, 51],
  ['Take a year-long sabbatical', 'Retire ten years early', 44, 56],
  ['Have a personal chef every night', 'Have a personal driver every day', 55, 45],
  ['Wake up to a sunrise every morning', 'Fall asleep to a sunset every night', 61, 39],
];

// Eight canonical subject shapes covering the source shapes the framing system has to handle:
// portrait/landscape/square/very-wide/very-tall aspect ratios, close-up faces, full-body people, and
// a non-person subject (a vehicle). Cycled by index so fixture renders exercise every shape and, via
// computeSubjectAwareCrop below, so the review MP4 demonstrates genuine subject-aware framing (the
// crop offset is discovered by the same edge-energy analysis production images go through -- the
// head/body positions below are never read directly by the cropper).
// Aspect ratios are chosen deliberately: all but 'very-tall' need real-but-safe cropping (under the
// MAX_EXCESS_FRACTION floor in framing.js), so the review shows genuine subject-aware positioning.
// 'very-tall' (0.318 aspect) is deliberately too extreme to fit the 5:3 slot safely -- it exists to
// demonstrate the safe-crop rejection/fallback path (see scripts/render-framing-review.mjs).
export const SUBJECT_PRESETS = [
  { kind: 'portrait-person', width: 700, height: 950 },
  { kind: 'landscape-person', width: 1400, height: 900 },
  { kind: 'close-up-face', width: 1000, height: 1000 },
  { kind: 'full-body-person', width: 850, height: 1150 },
  { kind: 'vehicle', width: 1600, height: 700 },
  { kind: 'square-subject', width: 1000, height: 1000 },
  { kind: 'very-wide', width: 2400, height: 700 },
  { kind: 'very-tall', width: 700, height: 2200 },
];

const colors = ['#28547a', '#bd6c42', '#3e806e', '#704b8e', '#9b793c', '#426e98', '#a34e64', '#477c75', '#805e42', '#3c6090', '#8b527c', '#4d8052', '#a7653e', '#4c6591', '#6f598b', '#3f7d78'];
const hexToRgb = hex => hex.match(/[a-f\d]{2}/gi).map(value => Number.parseInt(value, 16));
const SKIN = [232, 196, 165]; const DARK = [35, 32, 30]; const WHEEL = [25, 25, 25];

// Builds the head/body (or car) shapes for one preset, as fractions of the frame -- resolved to
// absolute pixel circles/rectangles once width/height are known.
const shapesForKind = (kind, width, height, accent) => {
  const m = Math.min(width, height); const f = (fx, fy) => [fx * width, fy * height];
  const circle = (cxF, cyF, rF, color) => { const [cx, cy] = f(cxF, cyF); return { type: 'circle', cx, cy, r: rF * m, color }; };
  const rect = (x0F, y0F, x1F, y1F, color) => { const [x0, y0] = f(x0F, y0F); const [x1, y1] = f(x1F, y1F); return { type: 'rect', x0, y0, x1, y1, color }; };
  switch (kind) {
    case 'portrait-person': return [circle(0.5, 0.18, 0.11, SKIN), rect(0.28, 0.30, 0.72, 0.95, accent)];
    case 'landscape-person': case 'square-subject': return [circle(0.5, 0.22, 0.14, SKIN), rect(0.35, 0.36, 0.65, 0.9, accent)];
    case 'close-up-face': return [circle(0.5, 0.48, 0.40, SKIN), circle(0.36, 0.40, 0.045, DARK), circle(0.64, 0.40, 0.045, DARK), rect(0.42, 0.62, 0.58, 0.66, DARK)];
    case 'full-body-person': return [circle(0.5, 0.12, 0.09, SKIN), rect(0.32, 0.22, 0.68, 0.62, accent), rect(0.35, 0.62, 0.47, 0.97, accent), rect(0.53, 0.62, 0.65, 0.97, accent)];
    case 'vehicle': return [rect(0.12, 0.35, 0.88, 0.68, accent), rect(0.32, 0.18, 0.68, 0.35, accent), circle(0.25, 0.72, 0.12, WHEEL), circle(0.75, 0.72, 0.12, WHEEL)];
    case 'very-wide': return [circle(0.22, 0.35, 0.09, SKIN), rect(0.17, 0.42, 0.27, 0.85, accent)];
    case 'very-tall': return [circle(0.5, 0.08, 0.09, SKIN), rect(0.30, 0.16, 0.70, 0.9, accent)];
    default: return [circle(0.5, 0.3, 0.12, SKIN), rect(0.35, 0.42, 0.65, 0.9, accent)];
  }
};
const shapeCondition = shape => shape.type === 'circle'
  ? `lte((X-${shape.cx.toFixed(1)})*(X-${shape.cx.toFixed(1)})+(Y-${shape.cy.toFixed(1)})*(Y-${shape.cy.toFixed(1)}),${(shape.r * shape.r).toFixed(1)})`
  : `between(X,${shape.x0.toFixed(1)},${shape.x1.toFixed(1)})*between(Y,${shape.y0.toFixed(1)},${shape.y1.toFixed(1)})`;
const buildChannelExpr = (shapes, bg, channel) => shapes.reduceRight((acc, shape) => `if(${shapeCondition(shape)},${shape.color[channel]},${acc})`, String(bg[channel]));

const run = (binary, args) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Fixture asset command failed: ${stderr.slice(-2000)}`)));
});
export const renderSyntheticSubject = async ({ ffmpegPath, kind, width, height, bg, accent, destination }) => {
  const shapes = shapesForKind(kind, width, height, accent);
  const [r, g, b] = [0, 1, 2].map(channel => buildChannelExpr(shapes, bg, channel));
  await run(ffmpegPath, ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=1`, '-vf', `geq=r='${r}':g='${g}':b='${b}'`, '-frames:v', '1', '-q:v', '3', destination]);
};

export const createFixturePlan = (count = questions.length) => ({
  version: 1,
  topic: 'Impossible Choices: Everyday Edition',
  percentages: { mode: 'demo', label: 'Entertainment demo percentages only' },
  questions: questions.slice(0, count).map(([a, b, aPercent, bPercent], index) => ({
    index,
    optionA: { text: a, searchQuery: `fixture option a ${index + 1}`, percentage: aPercent },
    optionB: { text: b, searchQuery: `fixture option b ${index + 1}`, percentage: bPercent },
  })),
});

export const createFixtureAssets = async ({ assetsDir, count = questions.length, ffmpegPath = resolveFfmpegPath(), computeCrop = computeSubjectAwareCrop }) => {
  fs.mkdirSync(assetsDir, { recursive: true }); const assets = [];
  for (let index = 0; index < count * 2; index += 1) {
    const preset = SUBJECT_PRESETS[index % SUBJECT_PRESETS.length]; const { kind, width, height } = preset;
    const jpg = path.join(assetsDir, `fixture-${String(index + 1).padStart(2, '0')}-${kind}.jpg`);
    const bg = hexToRgb(colors[index % colors.length]); const accent = hexToRgb(colors[(index + 5) % colors.length]);
    if (!fs.existsSync(jpg)) await renderSyntheticSubject({ ffmpegPath, kind, width, height, bg, accent, destination: jpg });
    // Runs every fixture image through the same subject-aware crop analysis production images get,
    // so the local 6-scene fixture render exercises the real framing logic end-to-end instead of
    // always taking buildFramedImageChain's plain-center fallback.
    const framing = await computeCrop({ localPath: jpg, sourceWidth: width, sourceHeight: height, targetWidth: WYR_TEMPLATE.layout.imageWidth, targetHeight: WYR_TEMPLATE.layout.imageHeight, ffmpegPath });
    assets.push({ questionIndex: Math.floor(index / 2), slot: index % 2 === 0 ? 'A' : 'B', localPath: jpg, filename: path.basename(jpg), provider: 'fixture', id: `fixture-${index + 1}`, width, height, photographer: 'Local fixture', photographerUrl: null, photoUrl: null, queryUsed: 'fixture', subjectKind: kind, framing: framing.safe ? renderableCrop(framing) : undefined });
  }
  return assets;
};

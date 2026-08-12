import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpegPath } from './runtime.js';

const questions = [
  ['Explore a mountain cabin', 'Relax at a tropical beach villa', 58, 42],
  ['Master every musical instrument', 'Speak every language fluently', 46, 54],
  ['Travel through space', 'Explore the deepest ocean', 63, 37],
  ['Eat breakfast for every meal', 'Eat dessert for every meal', 52, 48],
  ['Own a private cinema with unlimited screenings', 'Own a private rooftop garden overlooking the entire city skyline', 57, 43],
  ['Always have perfect weather', 'Always find a perfect parking spot', 71, 29],
  ['Live in a glass treehouse', 'Live on a luxury houseboat', 49, 51],
  ['Take a year-long sabbatical', 'Retire ten years early', 44, 56],
];

const dimensions = [
  [1400, 900], [700, 1200], [1000, 1000], [2200, 700],
  [1200, 800], [800, 1400], [1100, 1100], [2400, 900],
  [1500, 850], [850, 1350], [1000, 1000], [2100, 800],
  [1300, 900], [720, 1280], [1000, 1000], [2300, 750],
];

const colors = ['#28547a', '#bd6c42', '#3e806e', '#704b8e', '#9b793c', '#426e98', '#a34e64', '#477c75', '#805e42', '#3c6090', '#8b527c', '#4d8052', '#a7653e', '#4c6591', '#6f598b', '#3f7d78'];

const writePpm = (file, width, height, color) => {
  const [r, g, b] = color.match(/[a-f\d]{2}/gi).map(value => Number.parseInt(value, 16));
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 3; const shade = Math.round((x / width) * 24 + (y / height) * 18);
    pixels[i] = Math.min(255, r + shade); pixels[i + 1] = Math.min(255, g + shade); pixels[i + 2] = Math.min(255, b + shade);
  }
  fs.writeFileSync(file, Buffer.concat([header, pixels]));
};

const run = (binary, args) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Fixture asset command failed: ${stderr.slice(-2000)}`)));
});

export const createFixturePlan = () => ({
  version: 1,
  topic: 'Impossible Choices: Everyday Edition',
  percentages: { mode: 'demo', label: 'Entertainment demo percentages only' },
  questions: questions.map(([a, b, aPercent, bPercent], index) => ({
    index,
    optionA: { text: a, searchQuery: `fixture option a ${index + 1}`, percentage: aPercent },
    optionB: { text: b, searchQuery: `fixture option b ${index + 1}`, percentage: bPercent },
  })),
});

export const createFixtureAssets = async ({ assetsDir, ffmpegPath = resolveFfmpegPath() }) => {
  fs.mkdirSync(assetsDir, { recursive: true }); const assets = [];
  for (let index = 0; index < 16; index += 1) {
    const [width, height] = dimensions[index]; const ppm = path.join(assetsDir, `fixture-${String(index + 1).padStart(2, '0')}.ppm`); const jpg = path.join(assetsDir, `fixture-${String(index + 1).padStart(2, '0')}.jpg`);
    if (!fs.existsSync(jpg)) { writePpm(ppm, width, height, colors[index]); await run(ffmpegPath, ['-y', '-i', ppm, '-q:v', '3', jpg]); fs.unlinkSync(ppm); }
    assets.push({ questionIndex: Math.floor(index / 2), slot: index % 2 === 0 ? 'A' : 'B', localPath: jpg, filename: path.basename(jpg), provider: 'fixture', id: `fixture-${index + 1}`, width, height, photographer: 'Local fixture', photographerUrl: null, photoUrl: null, queryUsed: 'fixture' });
  }
  return assets;
};

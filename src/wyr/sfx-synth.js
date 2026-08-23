import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveFfmpegPath, PROJECT_ROOT } from './runtime.js';
import { log } from './utils.js';

const run = (args, label) => {
  const result = spawnSync(resolveFfmpegPath(), args, { encoding: 'buffer' });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr?.toString().slice(-2000)}`);
  return result;
};

const measurePeakDbfs = wavPath => {
  const result = run(['-i', wavPath, '-af', 'volumedetect', '-f', 'null', '-'], 'measure SFX peak level');
  const match = result.stderr.toString().match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  if (!match) throw new Error(`Could not measure peak level of ${wavPath}`);
  return Number(match[1]);
};

// Checked-in sources, never synthesized at runtime and never extracted from reference/ref.mp4.
// Tick, whoosh, and slide were restored from commit 6e99c92; reveal is a deterministic
// FFmpeg-generated broadband hit. See config/audio-spec.json's `sfx` section for provenance.
const REFERENCE_SOURCES = {
  tick: path.join(PROJECT_ROOT, 'assets', 'sfx', 'reference-countdown.wav'),
  reveal: path.join(PROJECT_ROOT, 'assets', 'sfx', 'reference-reveal.wav'),
  whoosh: path.join(PROJECT_ROOT, 'assets', 'sfx', 'reference-transition.wav'),
  slide: path.join(PROJECT_ROOT, 'assets', 'sfx', 'reference-entrance.wav'),
};

const sha256File = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const fingerprintOf = spec => crypto.createHash('sha256')
  .update(Object.keys(REFERENCE_SOURCES).sort().map(name => `${name}:${sha256File(REFERENCE_SOURCES[name])}`).join('|'))
  .update(JSON.stringify(spec.mix))
  .digest('hex');

// Installs (or reuses a cached, still-valid copy of) the four checked-in SFX assets. Refreshes the
// cache if their bytes or config/audio-spec.json's `mix` section change (tracked via a fingerprint
// in the cache manifest), otherwise reuses the cached files untouched.
export const ensureSfxAssets = ({ cacheDir, spec }) => {
  fs.mkdirSync(cacheDir, { recursive: true });
  const manifestPath = path.join(cacheDir, 'manifest.json');
  const fingerprint = fingerprintOf(spec);
  const expectedFiles = Object.fromEntries(Object.keys(REFERENCE_SOURCES).map(name => [name, path.join(cacheDir, `${name}.wav`)]));
  const cacheIsValid = () => {
    if (!fs.existsSync(manifestPath)) return false;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return false; }
    if (manifest.fingerprint !== fingerprint) return false;
    return Object.values(expectedFiles).every(file => fs.existsSync(file) && fs.statSync(file).size > 44) && manifest.volumes;
  };
  if (cacheIsValid()) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return { files: expectedFiles, volumes: manifest.volumes };
  }

  const volumes = {};
  for (const [name, sourcePath] of Object.entries(REFERENCE_SOURCES)) {
    if (!fs.existsSync(sourcePath)) throw new Error(`Missing reference SFX asset: ${sourcePath}`);
    const outPath = expectedFiles[name];
    fs.copyFileSync(sourcePath, outPath);
    const peakDbfs = measurePeakDbfs(outPath);
    const targetDbfs = spec.mix.sfxPeakDbfs;
    const volume = Number((10 ** ((targetDbfs - peakDbfs) / 20)).toFixed(4));
    volumes[name] = volume;
    log('sfx.installed', { name, source: sourcePath, measuredPeakDbfs: peakDbfs, targetDbfs, volume });
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ fingerprint, volumes, generatedAt: new Date().toISOString() }, null, 2));
  return { files: expectedFiles, volumes };
};

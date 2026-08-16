import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveFfmpegPath } from './runtime.js';
import { energyRatioInBand } from './fft.js';
import { log } from './utils.js';

const SAMPLE_RATE = 48000;
const MIN_IN_BAND_ENERGY_RATIO = 0.5; // at least half the spectral energy must sit in the intended band

const run = (args, label) => {
  const result = spawnSync(resolveFfmpegPath(), args, { encoding: 'buffer' });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr?.toString().slice(-2000)}`);
  return result;
};

// White noise, band-limited, with an amplitude envelope built from ffmpeg's afade chain --
// generates the tick/whoosh/slide SFX. `envelope` is a raw afade filter fragment.
const synthNoise = ({ durationSeconds, highpassHz, lowpassHz, envelope, outPath }) => {
  const filters = [];
  // Two cascaded biquads per cutoff for a steeper rolloff -- a single highpass/lowpass stage lets
  // too much energy leak outside the intended band to pass FFT verification.
  if (highpassHz) filters.push(`highpass=f=${highpassHz}`, `highpass=f=${highpassHz}`);
  if (lowpassHz) filters.push(`lowpass=f=${lowpassHz}`, `lowpass=f=${lowpassHz}`);
  filters.push(envelope);
  run(['-y', '-f', 'lavfi', '-i', `anoisesrc=d=${durationSeconds}:c=white:r=${SAMPLE_RATE}`, '-af', filters.join(','), '-ac', '2', '-c:a', 'pcm_s16le', outPath], 'synthesize noise SFX');
};

// Two decaying sine partials -- generates the reveal "ding".
const synthTone = ({ durationSeconds, expression, outPath }) => {
  run(['-y', '-f', 'lavfi', '-i', `aevalsrc=${expression}:s=${SAMPLE_RATE}:d=${durationSeconds}`, '-af', 'afade=t=out:st=' + Math.max(0, durationSeconds - 0.03) + ':d=0.03', '-ac', '2', '-c:a', 'pcm_s16le', outPath], 'synthesize tone SFX');
};

const readMonoSamples = wavPath => {
  const result = spawnSync(resolveFfmpegPath(), ['-i', wavPath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Failed to read samples from ${wavPath}: ${result.stderr?.toString().slice(-1000)}`);
  const buf = result.stdout;
  const samples = new Float64Array(buf.length / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = buf.readInt16LE(i * 2) / 32768;
  return samples;
};

const measurePeakDbfs = wavPath => {
  const result = spawnSync(resolveFfmpegPath(), ['-i', wavPath, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = result.stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  if (!match) throw new Error(`Could not measure peak level of ${wavPath}`);
  return Number(match[1]);
};

// Verifies the generated asset's spectral energy actually lands in its intended band -- a real FFT
// check, not just trusting the filter chain did what it was told to.
const verifySpectrum = ({ label, wavPath, minHz, maxHz }) => {
  const samples = readMonoSamples(wavPath);
  const ratio = energyRatioInBand(samples, SAMPLE_RATE, minHz, maxHz);
  if (ratio < MIN_IN_BAND_ENERGY_RATIO) throw new Error(`${label} SFX failed FFT verification: only ${(ratio * 100).toFixed(1)}% of spectral energy falls within ${minHz}-${maxHz}Hz (need >= ${MIN_IN_BAND_ENERGY_RATIO * 100}%).`);
  return ratio;
};

const SPECS = {
  tick: { minHz: 5500, maxHz: 12000, build: outPath => synthNoise({ durationSeconds: 0.04, highpassHz: 5500, lowpassHz: 11000, envelope: 'afade=t=in:st=0:d=0.002,afade=t=out:st=0.006:d=0.034', outPath }) },
  reveal: { minHz: 1500, maxHz: 4500, build: outPath => synthTone({ durationSeconds: 0.3, expression: "'0.12*sin(2*PI*2000*t)*exp(-6*t)+0.08*sin(2*PI*4000*t)*exp(-9*t)'", outPath }) },
  whoosh: { minHz: 700, maxHz: 4200, build: outPath => synthNoise({ durationSeconds: 0.35, highpassHz: 800, lowpassHz: 4000, envelope: 'afade=t=in:st=0:d=0.12,afade=t=out:st=0.15:d=0.2', outPath }) },
  slide: { minHz: 200, maxHz: 2100, build: outPath => synthNoise({ durationSeconds: 0.28, highpassHz: 300, lowpassHz: 2000, envelope: 'afade=t=in:st=0:d=0.05,afade=t=out:st=0.15:d=0.13', outPath }) },
};

const fingerprintOf = spec => crypto.createHash('sha256').update(JSON.stringify(spec.sfx) + JSON.stringify(spec.mix)).digest('hex');

// Synthesizes (or reuses a cached, still-valid) set of the four generic SFX assets from
// ffmpeg lavfi noise/sine sources only -- nothing sampled or extracted from any video. Regenerates
// automatically if config/audio-spec.json's sfx/mix sections change (tracked via a fingerprint in
// the cache manifest), otherwise reuses the cached files untouched. Each asset is verified with a
// real FFT (energyRatioInBand) before being accepted into the cache.
export const ensureSfxAssets = ({ cacheDir, spec }) => {
  fs.mkdirSync(cacheDir, { recursive: true });
  const manifestPath = path.join(cacheDir, 'manifest.json');
  const fingerprint = fingerprintOf(spec);
  const expectedFiles = Object.fromEntries(Object.keys(SPECS).map(name => [name, path.join(cacheDir, `${name}.wav`)]));
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
  for (const [name, { minHz, maxHz, build }] of Object.entries(SPECS)) {
    const outPath = expectedFiles[name];
    build(outPath);
    const ratio = verifySpectrum({ label: name, wavPath: outPath, minHz, maxHz });
    const peakDbfs = measurePeakDbfs(outPath);
    const targetDbfs = spec.mix.sfxPeakDbfs;
    const volume = Number((10 ** ((targetDbfs - peakDbfs) / 20)).toFixed(4));
    volumes[name] = volume;
    log('sfx.synthesized', { name, minHz, maxHz, inBandEnergyRatio: Number(ratio.toFixed(3)), measuredPeakDbfs: peakDbfs, targetDbfs, volume });
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ fingerprint, volumes, generatedAt: new Date().toISOString() }, null, 2));
  return { files: expectedFiles, volumes };
};

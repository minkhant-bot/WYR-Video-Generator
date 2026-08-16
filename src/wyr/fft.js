// Minimal, dependency-free radix-2 FFT used only to verify a synthesized SFX asset's spectral
// content lands where it was designed to (see sfx-synth.js) and, in tools/verify-render.mjs, to
// double-check a rendered output's tick/reveal timing independently of the ffmpeg-filter route.
const nextPowerOfTwo = n => { let p = 1; while (p < n) p *= 2; return p; };

// In-place iterative Cooley-Tukey FFT over parallel real/imag arrays (length must be a power of 2).
const fftInPlace = (re, im) => {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang); const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1; let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const uRe = re[i + k]; const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm; const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe; curIm = nextIm;
      }
    }
  }
};

// Returns { magnitudes, binHz } for the positive-frequency half of the spectrum of `samples`
// (a plain array of PCM values, any length -- zero-padded up to the next power of 2).
export const magnitudeSpectrum = (samples, sampleRate) => {
  const n = nextPowerOfTwo(samples.length);
  const re = new Float64Array(n); const im = new Float64Array(n);
  for (let i = 0; i < samples.length; i += 1) {
    // Hann window to reduce spectral leakage from the non-periodic, short SFX bursts being analyzed.
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (samples.length - 1 || 1));
    re[i] = samples[i] * w;
  }
  fftInPlace(re, im);
  const half = n / 2;
  const magnitudes = new Float64Array(half);
  for (let i = 0; i < half; i += 1) magnitudes[i] = Math.hypot(re[i], im[i]);
  return { magnitudes, binHz: sampleRate / n };
};

// Fraction of total spectral energy (magnitude^2) that falls within [minHz, maxHz].
export const energyRatioInBand = (samples, sampleRate, minHz, maxHz) => {
  const { magnitudes, binHz } = magnitudeSpectrum(samples, sampleRate);
  let total = 0; let inBand = 0;
  for (let i = 0; i < magnitudes.length; i += 1) {
    const energy = magnitudes[i] * magnitudes[i];
    const hz = i * binHz;
    total += energy;
    if (hz >= minHz && hz <= maxHz) inBand += energy;
  }
  return total > 0 ? inBand / total : 0;
};

export const peakFrequencyHz = (samples, sampleRate) => {
  const { magnitudes, binHz } = magnitudeSpectrum(samples, sampleRate);
  let best = 0; let bestMag = -Infinity;
  for (let i = 1; i < magnitudes.length; i += 1) if (magnitudes[i] > bestMag) { bestMag = magnitudes[i]; best = i; }
  return best * binHz;
};

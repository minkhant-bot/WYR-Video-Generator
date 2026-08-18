import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './runtime.js';

// Single source of truth for all measured/derived audio timing: countdown tick count/spacing,
// reveal gap, transition blank duration, reference SFX source/timing metadata, mix target levels,
// and encode settings. Loaded once from config/audio-spec.json and cached -- nothing in the
// renderer hardcodes these values; they are all read through this module (or via explicit function
// parameters that default to it), so re-measuring a reference and rewriting the JSON is the only
// thing ever required to retime the whole pipeline.
export const AUDIO_SPEC_PATH = path.join(PROJECT_ROOT, 'config', 'audio-spec.json');

let cached = null;
export const loadAudioSpec = ({ force = false } = {}) => {
  if (cached && !force) return cached;
  const raw = fs.readFileSync(AUDIO_SPEC_PATH, 'utf8');
  cached = JSON.parse(raw);
  return cached;
};
export const getAudioSpec = () => loadAudioSpec();
export const __resetAudioSpecCacheForTests = () => { cached = null; };

// (tickCount - 1) * tickSpacing covers the tick train itself; the reveal fires
// revealGapAfterLastTickSeconds after the LAST tick, so the countdown-to-reveal span is the sum of
// both -- this replaces the old fixed countdownSequenceDuration constant.
export const getCountdownSequenceDuration = (spec = getAudioSpec()) =>
  (spec.countdown.tickCount - 1) * spec.countdown.tickSpacingSeconds + spec.reveal.gapAfterLastTickSeconds;

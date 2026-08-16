import { WYR_TEMPLATE } from './template.js';
import { getCountdownSequenceDuration } from './audio-spec.js';

// Mirrors audio.js's SCENE_TAIL_SECONDS exactly (voice start pause + narration-to-countdown gap +
// countdown ticks + reveal hold + transition out) -- everything a scene costs beyond the spoken
// narration itself. Recomputed here (not imported from audio.js) so this module stays free of the
// EdgeTTS/ffmpeg runtime dependencies audio.js pulls in -- this runs during question SELECTION,
// before any TTS call, and must be safe to import from pure, DB-free selection code.
// (audio-spec.js is a plain fs/JSON reader, no ffmpeg/EdgeTTS dependency, so it's safe to import here.)
const SCENE_TAIL_SECONDS = 0.3 + WYR_TEMPLATE.timing.countdownPauseAfterVoice + getCountdownSequenceDuration() + WYR_TEMPLATE.timing.revealHoldDuration + WYR_TEMPLATE.timing.transitionOutDuration;
const frameCeil = seconds => Math.ceil(seconds * WYR_TEMPLATE.canvas.fps) / WYR_TEMPLATE.canvas.fps;

// Narration text exactly as audio.js's buildNarration constructs it ("Option A, or option b?"),
// reimplemented locally for the same dependency-isolation reason as SCENE_TAIL_SECONDS above.
const narrationPart = (text, lowercaseFirst = false) => {
  const cleaned = String(text).replace(/\bwould you rather\b/gi, '').replace(/\s+/g, ' ').replace(/[?.!,;:]+$/g, '').trim();
  return cleaned.replace(/^./, character => lowercaseFirst ? character.toLowerCase() : character.toUpperCase());
};
const narrationText = (optionAText, optionBText) => `${narrationPart(optionAText)}, or ${narrationPart(optionBText, true)}?`;
const wordCount = text => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;

// Words-per-second for the production Edge TTS voice at its default -10% rate, calibrated against
// short interrogative "Option A, or option b?" phrasing (which neural TTS voices read briskly,
// well above a 150wpm audiobook-narration pace). This is a coarse proxy, not a physics-grade
// model: its job is to RANK candidate questions by relative narration length so the substitution
// logic in pool-selection.js can pick shorter ones, not to predict seconds exactly -- the real
// TTS-measured budget/retry in pipeline.js and the final ffprobe check (see media.js) remain the
// authoritative source of truth regardless of how this estimate turns out.
const WORDS_PER_SECOND = 3.2;
// Mirrors pipeline.js's own pre-render safety check exactly (SHORTS_DURATION_LIMIT_SECONDS=60
// minus its DURATION_SAFETY_MARGIN_SECONDS=0.5) -- reusing the identical boundary, not a new one,
// is what lets duration-aware selection catch the same failure mode that check does, just earlier.
const SHORTS_DURATION_LIMIT_SECONDS = 60;
const DURATION_SAFETY_MARGIN_SECONDS = 0.5;
export const DEFAULT_DURATION_BUDGET_TOTAL_SECONDS = SHORTS_DURATION_LIMIT_SECONDS - DURATION_SAFETY_MARGIN_SECONDS;

// Estimated seconds of spoken narration for a question's two option texts, before any TTS call.
export const estimateNarrationSecondsFromText = (optionAText, optionBText) => wordCount(narrationText(optionAText, optionBText)) / WORDS_PER_SECOND;

// Estimated total scene duration (narration + fixed tail), mirroring buildSceneTimeline's
// `frameCeil(max(baseDuration, voiceDuration + voicePaddingSeconds, requiredDuration))`. In the
// project's real constants, requiredDuration (narration + SCENE_TAIL_SECONDS) always exceeds
// `voiceDuration + voicePaddingSeconds` (SCENE_TAIL_SECONDS ~4.15s > voicePaddingSeconds 1-3s), so
// this is exactly `frameCeil(max(baseDuration, narration + SCENE_TAIL_SECONDS))`.
export const estimateSceneDurationFromText = (optionAText, optionBText, { baseDuration = WYR_TEMPLATE.timing.defaultSceneDuration } = {}) =>
  frameCeil(Math.max(baseDuration, estimateNarrationSecondsFromText(optionAText, optionBText) + SCENE_TAIL_SECONDS));

export const WYR_TEMPLATE = Object.freeze({
  canvas: Object.freeze({ width: 1080, height: 1920, fps: 30 }),
  timing: Object.freeze({
    defaultSceneDuration: 7,
    initialEntranceDuration: 0.4,
    orEntrance: 0,
    orEntranceDuration: 0.01,
    percentageReveal: 4.72,
    percentageRevealDuration: 0.12,
    countdownPauseAfterVoice: 0.1,
    maximumNarrationCountdownGap: 0.2,
    countdownInterval: 0.8,
    // Tick count/spacing and the reveal gap after the last tick now come from
    // config/audio-spec.json (see audio-spec.js's getCountdownSequenceDuration) instead of being
    // hardcoded here -- the old 3-cue "3, 2, 1" countdown was replaced by a tick-train countdown.
    countdownFadeDuration: 0.06,
    transitionOutStart: 6.18,
    revealHoldDuration: 1.438,
    transitionSfxLead: 0.145,
    transitionOutDuration: 0.5,
    transitionSlideDuration: 0.2,
  }),
  layout: Object.freeze({
    safeX: 60,
    topColor: '0xE13A3C',
    bottomColor: '0x0B5BC8',
    topImageY: 130,
    bottomImageY: 1270,
    imageWidth: 860,
    imageHeight: 520,
    textX: 60,
    textWidth: 960,
    topTextY: 660,
    bottomTextY: 1050,
    topPercentageY: 660,
    bottomPercentageY: 1050,
    textHeight: 210,
    separatorY: 947,
    separatorHeight: 26,
    orSize: 168,
  }),
  typography: Object.freeze({
    preferredOptionSize: 72,
    minimumOptionSize: 50,
    optionSizeStep: 2,
    maximumOptionLines: 2,
    lineHeightRatio: 1.05,
    lineSpacing: 4,
    percentageSize: 96,
    countdownSize: 190,
    orSize: 60,
  }),
});

const normalizeText = text => String(text ?? '').replace(/\s+/g, ' ').trim();

const splitOversizedWord = async ({ word, fontSize, maxWidth, measureText }) => {
  const characters = Array.from(word); const chunks = []; let chunk = '';
  for (const character of characters) {
    const candidate = `${chunk}${character}`;
    if (chunk && await measureText(candidate, fontSize) > maxWidth) { chunks.push(chunk); chunk = character; }
    else chunk = candidate;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
};

const wrapAtSize = async ({ text, fontSize, maxWidth, measureText }) => {
  const sourceWords = normalizeText(text).split(' ').filter(Boolean); const words = [];
  for (const word of sourceWords) {
    if (await measureText(word, fontSize) <= maxWidth) words.push(word);
    else words.push(...await splitOversizedWord({ word, fontSize, maxWidth, measureText }));
  }
  const lines = []; let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || await measureText(candidate, fontSize) <= maxWidth) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
};

export const fitOptionText = async ({
  text,
  measureText,
  maxWidth = WYR_TEMPLATE.layout.textWidth,
  maxHeight = WYR_TEMPLATE.layout.textHeight,
  preferredFontSize = WYR_TEMPLATE.typography.preferredOptionSize,
  minimumFontSize = WYR_TEMPLATE.typography.minimumOptionSize,
  fontSizeStep = WYR_TEMPLATE.typography.optionSizeStep,
  maxLines = WYR_TEMPLATE.typography.maximumOptionLines,
  lineHeightRatio = WYR_TEMPLATE.typography.lineHeightRatio,
  lineSpacing = WYR_TEMPLATE.typography.lineSpacing,
} = {}) => {
  const normalized = normalizeText(text);
  if (!normalized) throw new Error('Option text cannot be empty.');
  if (typeof measureText !== 'function') throw new Error('A text measurement function is required.');
  for (let fontSize = preferredFontSize; fontSize >= minimumFontSize; fontSize -= fontSizeStep) {
    const lines = await wrapAtSize({ text: normalized, fontSize, maxWidth, measureText });
    const lineHeight = Math.ceil(fontSize * lineHeightRatio);
    const height = lines.length * lineHeight + Math.max(0, lines.length - 1) * lineSpacing;
    if (lines.length <= maxLines && height <= maxHeight) return { text: lines.join('\n'), lines, fontSize, lineHeight, height };
  }
  throw new Error(`Option text cannot fit inside ${maxWidth}x${maxHeight}px at the minimum readable font size of ${minimumFontSize}px.`);
};

export const WYR_TEMPLATE = Object.freeze({
  canvas: Object.freeze({ width: 1080, height: 1920, fps: 30 }),
  timing: Object.freeze({
    defaultSceneDuration: 7,
    imageFadeIn: 0.16,
    optionAEntrance: 0.08,
    optionBEntrance: 0.28,
    optionEntranceDuration: 0.18,
    orEntrance: 0,
    orEntranceDuration: 0.01,
    percentageReveal: 4.72,
    percentageRevealDuration: 0.12,
    transitionOutStart: 6.18,
    transitionOutDuration: 0.28,
  }),
  layout: Object.freeze({
    safeX: 60,
    topColor: '0xE13A3C',
    bottomColor: '0x0B5BC8',
    topImageY: 180,
    bottomImageY: 1320,
    imageWidth: 750,
    imageHeight: 450,
    textX: 70,
    textWidth: 940,
    topTextY: 570,
    bottomTextY: 1030,
    topPercentageY: 620,
    bottomPercentageY: 1030,
    textHeight: 250,
    separatorY: 947,
    separatorHeight: 26,
    orSize: 168,
  }),
  typography: Object.freeze({
    preferredOptionSize: 60,
    minimumOptionSize: 42,
    optionSizeStep: 2,
    maximumOptionLines: 2,
    lineHeightRatio: 1.05,
    lineSpacing: 4,
    percentageSize: 82,
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

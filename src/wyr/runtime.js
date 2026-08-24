import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
export const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const FONT_PATH = path.resolve(process.env.WYR_FONT_PATH || path.join(PROJECT_ROOT, 'assets', 'fonts', 'Baloo2-ExtraBold.ttf'));
export const resolveProjectPath = value => path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
export const REQUIRED_FFMPEG_FILTERS = Object.freeze([
  'drawtext', 'bbox', 'scale', 'crop', 'eq', 'unsharp', 'setsar', 'format', 'fade', 'drawbox', 'overlay', 'color', 'geq', 'setrange', 'noise',
  'aevalsrc', 'highpass', 'lowpass', 'afade', 'anullsrc', 'atrim', 'aresample', 'aformat', 'volume', 'adelay', 'asplit', 'amix', 'alimiter',
]);
export const REQUIRED_FFMPEG_ENCODERS = Object.freeze(['libx264', 'aac']);

const executableFile = file => {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
};

const listedCapability = (output, name) => new RegExp(`^\\s*[A-Z.]{3,}\\s+${name}\\s`, 'm').test(output);
export const inspectFfmpegCompatibility = (binary, { spawn = spawnSync } = {}) => {
  const inspect = argument => spawn(binary, ['-hide_banner', argument], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const filters = inspect('-filters');
  if (filters.error || filters.status !== 0) return { compatible: false, reason: 'could not execute -filters' };
  const filterOutput = `${filters.stdout || ''}\n${filters.stderr || ''}`;
  const missingFilters = REQUIRED_FFMPEG_FILTERS.filter(name => !listedCapability(filterOutput, name));
  const encoders = inspect('-encoders');
  if (encoders.error || encoders.status !== 0) return { compatible: false, missingFilters, reason: 'could not execute -encoders' };
  const encoderOutput = `${encoders.stdout || ''}\n${encoders.stderr || ''}`;
  const missingEncoders = REQUIRED_FFMPEG_ENCODERS.filter(name => !listedCapability(encoderOutput, name));
  return { compatible: missingFilters.length === 0 && missingEncoders.length === 0, missingFilters, missingEncoders };
};

const checkCandidates = (candidates, inspect) => {
  const checked = []; const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate?.path || seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    let result;
    try { result = inspect(candidate.path); }
    catch { result = { compatible: false, reason: 'capability inspection failed' }; }
    checked.push({ ...candidate, ...result });
    if (result.compatible) return { selected: candidate, checked };
  }
  return { selected: null, checked };
};

const incompatibilitySummary = checked => checked.map(candidate => {
  const missing = [
    candidate.missingFilters?.length ? `filters ${candidate.missingFilters.join(', ')}` : '',
    candidate.missingEncoders?.length ? `encoders ${candidate.missingEncoders.join(', ')}` : '',
    candidate.reason || '',
  ].filter(Boolean).join('; ');
  return `${candidate.path} (${missing || 'incompatible'})`;
}).join(', ');

export const selectCompatibleFfmpeg = (candidates, { inspect = inspectFfmpegCompatibility } = {}) => {
  const result = checkCandidates(candidates, inspect);
  if (result.selected) return result.selected;
  throw new Error(`No compatible FFmpeg binary found. Install FFmpeg with drawtext/libfreetype, the required filters, libx264, and AAC, or set FFMPEG_PATH. Checked: ${incompatibilitySummary(result.checked) || 'no candidates'}.`);
};

export const isRailwayRuntime = (environment = process.env) => Object.keys(environment).some(name => name.startsWith('RAILWAY_') && environment[name]);

const packagedFfmpegCandidate = () => {
  try {
    const installed = require('ffmpeg-static');
    return installed && executableFile(installed) ? { path: installed, source: 'ffmpeg-static' } : null;
  } catch { return null; }
};

const systemFfmpegCandidates = () => {
  const paths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].filter(executableFile).map(binary => ({ path: binary, source: 'system' }));
  paths.push({ path: 'ffmpeg', source: 'PATH' });
  return paths;
};

let selectedFfmpeg;
export const resolveFfmpegPath = () => {
  if (selectedFfmpeg) return selectedFfmpeg.path;
  const configured = process.env.FFMPEG_PATH ? { path: resolveProjectPath(process.env.FFMPEG_PATH), source: 'FFMPEG_PATH' } : null;
  const system = systemFfmpegCandidates(); const railway = isRailwayRuntime(); const checked = [];
  const groups = railway
    ? [() => [configured], () => [packagedFfmpegCandidate()], () => system]
    : [() => [configured], () => system, () => [packagedFfmpegCandidate()]];
  for (const candidates of groups) {
    const group = candidates();
    const result = checkCandidates(group, inspectFfmpegCompatibility); checked.push(...result.checked);
    if (result.selected) {
      selectedFfmpeg = result.selected;
      console.info(JSON.stringify({ component: 'wyr-generator', event: 'ffmpeg.selected', binary: selectedFfmpeg.path, source: selectedFfmpeg.source, drawtext: true }));
      return selectedFfmpeg.path;
    }
  }
  throw new Error(`No compatible FFmpeg binary found. Install FFmpeg with drawtext/libfreetype, the required filters, libx264, and AAC, or set FFMPEG_PATH. Checked: ${incompatibilitySummary(checked) || 'no candidates'}.`);
};

const resolveBinary = ({ name, environmentName, commonPaths, packageName, packagePath }) => {
  const configured = process.env[environmentName];
  if (configured) {
    const resolved = resolveProjectPath(configured);
    if (!executableFile(resolved)) throw new Error(`${environmentName} does not point to an executable file: ${resolved}`);
    return resolved;
  }
  const common = commonPaths.find(executableFile); if (common) return common;
  const command = spawnSync(name, ['-version'], { stdio: 'ignore' }); if (!command.error && command.status === 0) return name;
  try {
    const installed = require(packageName); const resolved = packagePath(installed);
    if (!resolved || !executableFile(resolved)) throw new Error('package did not expose an executable path');
    return resolved;
  } catch (error) {
    throw new Error(`Could not find ${name}. Install it system-wide, set ${environmentName}, or install ${packageName}: ${error.message}`);
  }
};

export const resolveFfprobePath = () => resolveBinary({ name: 'ffprobe', environmentName: 'FFPROBE_PATH', commonPaths: ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe'], packageName: 'ffprobe-static', packagePath: installed => installed.path });

export const assertFontAvailable = () => {
  if (!fs.existsSync(FONT_PATH) || !fs.statSync(FONT_PATH).isFile()) throw new Error(`Render font not found: ${FONT_PATH}. Restore assets/fonts/Baloo2-ExtraBold.ttf or set WYR_FONT_PATH.`);
  return FONT_PATH;
};

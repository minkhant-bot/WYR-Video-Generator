import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
export const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const FONT_PATH = path.resolve(process.env.WYR_FONT_PATH || path.join(PROJECT_ROOT, 'assets', 'fonts', 'FreeSansBold.ttf'));
export const resolveProjectPath = value => path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);

const executableFile = file => {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
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

export const resolveFfmpegPath = () => resolveBinary({ name: 'ffmpeg', environmentName: 'FFMPEG_PATH', commonPaths: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'], packageName: 'ffmpeg-static', packagePath: installed => installed });
export const resolveFfprobePath = () => resolveBinary({ name: 'ffprobe', environmentName: 'FFPROBE_PATH', commonPaths: ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe'], packageName: 'ffprobe-static', packagePath: installed => installed.path });

export const assertFontAvailable = () => {
  if (!fs.existsSync(FONT_PATH) || !fs.statSync(FONT_PATH).isFile()) throw new Error(`Render font not found: ${FONT_PATH}. Restore assets/fonts/FreeSansBold.ttf or set WYR_FONT_PATH.`);
  return FONT_PATH;
};

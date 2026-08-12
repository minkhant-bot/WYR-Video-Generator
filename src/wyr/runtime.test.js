import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { inspectFfmpegCompatibility, PROJECT_ROOT, REQUIRED_FFMPEG_ENCODERS, REQUIRED_FFMPEG_FILTERS, selectCompatibleFfmpeg } from './runtime.js';

const require = createRequire(import.meta.url);
const listing = names => names.map(name => ` ... ${name} test capability`).join('\n');

test('FFmpeg inspection requires drawtext and every renderer capability', () => {
  const spawn = (_, args) => ({ status: 0, stdout: listing(args.includes('-filters') ? REQUIRED_FFMPEG_FILTERS.filter(name => name !== 'drawtext') : REQUIRED_FFMPEG_ENCODERS), stderr: '' });
  const result = inspectFfmpegCompatibility('/fake/ffmpeg', { spawn });
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missingFilters, ['drawtext']);
  assert.deepEqual(result.missingEncoders, []);
});

test('FFmpeg selection skips an incompatible system binary and uses the packaged fallback', () => {
  const inspected = [];
  const selected = selectCompatibleFfmpeg([
    { path: '/usr/bin/ffmpeg', source: 'system' },
    { path: '/app/node_modules/ffmpeg-static/ffmpeg', source: 'ffmpeg-static' },
  ], { inspect: binary => { inspected.push(binary); return binary.includes('ffmpeg-static') ? { compatible: true, missingFilters: [], missingEncoders: [] } : { compatible: false, missingFilters: ['drawtext'], missingEncoders: [] }; } });
  assert.equal(selected.path, '/app/node_modules/ffmpeg-static/ffmpeg');
  assert.equal(selected.source, 'ffmpeg-static');
  assert.deepEqual(inspected, ['/usr/bin/ffmpeg', '/app/node_modules/ffmpeg-static/ffmpeg']);
});

test('FFmpeg selection fails early with an actionable capability error', () => {
  assert.throws(() => selectCompatibleFfmpeg([{ path: '/usr/bin/ffmpeg', source: 'system' }], {
    inspect: () => ({ compatible: false, missingFilters: ['drawtext'], missingEncoders: ['libx264'] }),
  }), /No compatible FFmpeg binary found.*drawtext\/libfreetype.*libx264.*FFMPEG_PATH/);
});

test('Railway runtime prefers compatible ffmpeg-static and otherwise falls back safely', () => {
  const packaged = require('ffmpeg-static');
  const check = inspectFfmpegCompatibility(packaged);
  const script = "import { resolveFfmpegPath } from './src/wyr/runtime.js'; console.log(resolveFfmpegPath());";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PROJECT_ROOT, encoding: 'utf8', env: { ...process.env, RAILWAY_ENVIRONMENT: 'test', FFMPEG_PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const selected = result.stdout.trim().split('\n').at(-1);
  assert.equal(inspectFfmpegCompatibility(selected).compatible, true);
  if (check.compatible) {
    assert.equal(selected, packaged); assert.match(result.stdout, /"source":"ffmpeg-static"/);
  } else {
    assert.notEqual(selected, packaged); assert.match(result.stdout, /"source":"(system|PATH)"/);
  }
  assert.match(result.stdout, /"drawtext":true/);
});

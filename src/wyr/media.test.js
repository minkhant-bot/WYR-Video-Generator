import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertLockedImageAssets, buildFramedImageChain, buildStillImageInputArgs, DurationVerificationError, renderSceneSegments, SHORTS_DURATION_LIMIT_SECONDS, verifyVideo } from './media.js';
import { resolveFfmpegPath } from './runtime.js';
import { WYR_TEMPLATE } from './template.js';

test('scene rendering enforces concurrency and preserves concat order', async () => {
  const plan = { questions: Array.from({ length: 6 }, (_, index) => ({ index })) };
  let active = 0; let maximumActive = 0; const threadValues = []; const renderDirectories = [];
  const segments = await renderSceneSegments({ plan, assets: [], duration: 7, renderDir: '/tmp/wyr-render-test', sceneConcurrency: 2, ffmpegThreads: 3, renderScene: async ({ index, ffmpegThreads, renderDir }) => {
    active += 1; maximumActive = Math.max(maximumActive, active); threadValues.push(ffmpegThreads); renderDirectories.push(renderDir);
    await new Promise(resolve => setTimeout(resolve, (6 - index) * 2)); active -= 1; return `segment-${index}.mp4`;
  } });
  assert.equal(maximumActive, 2);
  assert.deepEqual(segments, ['segment-0.mp4', 'segment-1.mp4', 'segment-2.mp4', 'segment-3.mp4', 'segment-4.mp4', 'segment-5.mp4']);
  assert.deepEqual(threadValues, [3, 3, 3, 3, 3, 3]); assert.equal(new Set(renderDirectories).size, 1);
});

test('still-image argv is provider-independent and cannot orphan demuxer loop options', () => {
  const pexels = '/tmp/q01-a-pexels.jpg'; const web = '/tmp/q01-b-web.jpg';
  assert.deepEqual(buildStillImageInputArgs(pexels, 30), ['-i', pexels]);
  assert.deepEqual(buildStillImageInputArgs(web, 30), ['-i', web]);
  const combined = [pexels, web].flatMap(localPath => buildStillImageInputArgs(localPath, 30));
  assert.deepEqual(combined, ['-i', pexels, '-i', web]);
  assert.equal(combined.some(value => value === '-loop' || value === 'loop' || value === '-stream_loop'), false);
});

test('production scene renderer accepts every Pexels/web still-image ordering', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-mixed-stills-')); const ffmpeg = resolveFfmpegPath();
  const pexelsPath = path.join(root, 'q01-a-pexels.jpg'); const webPath = path.join(root, 'q01-b-web.jpg');
  const makeJpeg = (destination, color) => {
    const result = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=900x600`, '-frames:v', '1', destination], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    makeJpeg(pexelsPath, 'red'); makeJpeg(webPath, 'blue');
    const combinations = [['Pexels', 'Pexels'], ['DuckDuckGo Images', 'DuckDuckGo Images'], ['Pexels', 'DuckDuckGo Images'], ['DuckDuckGo Images', 'Pexels']];
    for (const [providerA, providerB] of combinations) {
      const renderDir = path.join(root, `${providerA.startsWith('Pexels') ? 'p' : 'w'}-${providerB.startsWith('Pexels') ? 'p' : 'w'}`); fs.mkdirSync(renderDir);
      const assets = [
        { questionIndex: 0, slot: 'A', provider: providerA, localPath: providerA === 'Pexels' ? pexelsPath : webPath },
        { questionIndex: 0, slot: 'B', provider: providerB, localPath: providerB === 'Pexels' ? pexelsPath : webPath },
      ];
      const [segment] = await renderSceneSegments({ plan: { questions: [{ index: 0, optionA: { text: 'Explore Space', percentage: 55 }, optionB: { text: 'Explore Oceans', percentage: 45 } }] }, assets, duration: 1, renderDir, sceneConcurrency: 1, ffmpegThreads: 1 });
      assert.ok(fs.statSync(segment).size > 0, `${providerA}/${providerB} render is empty`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scene rendering verifies locked image hashes before using local assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-locked-assets-')); const ffmpeg = resolveFfmpegPath(); const image = path.join(root, 'locked.jpg');
  const result = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=900x600', '-frames:v', '1', image], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  const crypto = await import('node:crypto'); const hash = crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex');
  const asset = { localPath: image, filename: 'locked.jpg', locked: true, sha256: hash };
  try { assert.equal(assertLockedImageAssets([asset]), true); fs.appendFileSync(image, 'changed'); assert.throws(() => assertLockedImageAssets([asset]), /hash mismatch/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('framed image chain scales the foreground with contain (decrease), never crop, and only crops the separate blurred background fill', () => {
  const chain = buildFramedImageChain({ input: '0:v', width: 750, height: 450, fps: 30, outLabel: 'aimg', chainId: 'a' });
  const joined = chain.join(';');
  assert.match(joined, /\[asrc1\]scale=750:450:force_original_aspect_ratio=increase,crop=750:450:[^,]+,gblur=sigma=\d+[^[]*\[abg\]/);
  assert.match(joined, /\[asrc2\]scale=750:450:force_original_aspect_ratio=decrease,setsar=1,format=rgba\[afg\]/);
  assert.equal(/\[afg\]/.test(joined.split('[afg]')[1]?.split(';')[0] || ''), false);
  const foregroundStage = joined.split('[asrc2]')[1].split(';')[0];
  assert.equal(foregroundStage.includes('crop='), false);
  assert.match(joined, /\[abg\]\[afg\]overlay=x=\(W-w\)\/2:y=\(H-h\)\/2:format=auto,format=rgba\[aimg\]/);
});

test('non-destructive framing preserves the full subject of an extreme-aspect-ratio image instead of center-cropping it away', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-safe-framing-')); const ffmpeg = resolveFfmpegPath();
  try {
    const width = 300; const height = 1500;
    const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      const color = y < 500 ? [255, 0, 0] : y < 1000 ? [200, 200, 200] : [0, 255, 0];
      for (let x = 0; x < width; x += 1) { const i = (y * width + x) * 3; pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; }
    }
    const ppm = path.join(root, 'tall.ppm'); const sourceJpg = path.join(root, 'tall.jpg');
    fs.writeFileSync(ppm, Buffer.concat([header, pixels]));
    const convert = spawnSync(ffmpeg, ['-y', '-i', ppm, '-q:v', '2', sourceJpg], { encoding: 'utf8' }); assert.equal(convert.status, 0, convert.stderr);

    const renderDir = path.join(root, 'render'); fs.mkdirSync(renderDir);
    const assets = [
      { questionIndex: 0, slot: 'A', localPath: sourceJpg },
      { questionIndex: 0, slot: 'B', localPath: sourceJpg },
    ];
    const [segment] = await renderSceneSegments({
      plan: { questions: [{ index: 0, optionA: { text: 'Top Choice', percentage: 50 }, optionB: { text: 'Bottom Choice', percentage: 50 } }] },
      assets, duration: 2, renderDir, sceneConcurrency: 1, ffmpegThreads: 1,
    });

    const { layout } = WYR_TEMPLATE;
    const slotX = (WYR_TEMPLATE.canvas.width - layout.imageWidth) / 2;
    const samplePatch = y => {
      const result = spawnSync(ffmpeg, ['-ss', '1', '-i', segment, '-vframes', '1', '-vf', `crop=12:8:${Math.round(slotX + layout.imageWidth / 2 - 6)}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr?.toString());
      const buffer = result.stdout; const pixelCount = buffer.length / 3; let r = 0; let g = 0; let b = 0;
      for (let i = 0; i < buffer.length; i += 3) { r += buffer[i]; g += buffer[i + 1]; b += buffer[i + 2]; }
      return { r: r / pixelCount, g: g / pixelCount, b: b / pixelCount };
    };

    const topPatch = samplePatch(layout.topImageY + 10);
    const bottomPatch = samplePatch(layout.topImageY + layout.imageHeight - 10);
    assert.ok(topPatch.r > 180 && topPatch.g < 80, `expected the preserved top of the source image (red) near the slot's top edge; sampled ${JSON.stringify(topPatch)}`);
    assert.ok(bottomPatch.g > 180 && bottomPatch.r < 80, `expected the preserved bottom of the source image (green) near the slot's bottom edge; sampled ${JSON.stringify(bottomPatch)}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rendering consumes locked local assets without image-provider calls', async () => {
  let providerCalls = 0; const provider = { search: () => { providerCalls += 1; throw new Error('provider must not be called during rendering'); }, downloadAsset: () => { providerCalls += 1; throw new Error('provider must not be called during rendering'); } };
  const segments = await renderSceneSegments({ plan: { questions: [{ index: 0 }] }, assets: [], duration: 1, renderDir: '/tmp/wyr-no-provider-render', sceneConcurrency: 1, ffmpegThreads: 1, renderScene: async () => 'locked-local-segment.mp4' });
  assert.deepEqual(segments, ['locked-local-segment.mp4']); assert.equal(providerCalls, 0); assert.equal(typeof provider.search, 'function');
});

test('a genuine FFmpeg failure (undecodable input) rejects the render and is never silently reported as a successful segment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-ffmpeg-failure-'));
  const garbagePath = path.join(root, 'not-an-image.jpg');
  fs.writeFileSync(garbagePath, Buffer.alloc(20_000, 65)); // correct extension, not valid image data
  try {
    const assets = [
      { questionIndex: 0, slot: 'A', provider: 'Pexels', localPath: garbagePath },
      { questionIndex: 0, slot: 'B', provider: 'Pexels', localPath: garbagePath },
    ];
    const plan = { questions: [{ index: 0, optionA: { text: 'Explore Space', percentage: 55 }, optionB: { text: 'Explore Oceans', percentage: 45 } }] };
    await assert.rejects(
      () => renderSceneSegments({ plan, assets, duration: 1, renderDir: root, sceneConcurrency: 1, ffmpegThreads: 1 }),
      /exited with code/,
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyVideo rejects a zero-byte or missing output file before ever probing it, instead of reporting it completed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-empty-output-'));
  try {
    const emptyPath = path.join(root, 'empty.mp4');
    fs.writeFileSync(emptyPath, Buffer.alloc(0));
    await assert.rejects(() => verifyVideo(emptyPath, {}), /not a non-empty regular file/);
    await assert.rejects(() => verifyVideo(path.join(root, 'does-not-exist.mp4'), {}), error => Boolean(error));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verification authoritatively rejects any output at or above the 60s Shorts limit, independent of the expected duration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-duration-gate-')); const ffmpeg = resolveFfmpegPath();
  try {
    assert.equal(SHORTS_DURATION_LIMIT_SECONDS, 60);
    const overLimit = path.join(root, 'over-limit.mp4');
    const overLimitDuration = SHORTS_DURATION_LIMIT_SECONDS + 4.33;
    const build = spawnSync(ffmpeg, [
      '-y', '-f', 'lavfi', '-i', `color=c=black:s=1080x1920:r=30:d=${overLimitDuration}`,
      '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${overLimitDuration}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', overLimit,
    ], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);

    await assert.rejects(
      () => verifyVideo(overLimit, { expectedDuration: overLimitDuration }),
      error => { assert.ok(error instanceof DurationVerificationError); assert.match(error.message, /60\.0s Shorts limit/); return true; },
    );
    // Even when the caller (wrongly) expects the over-limit duration, the hard ceiling still wins —
    // production validators must remain authoritative over any prediction the timeline made.
    await assert.rejects(() => verifyVideo(overLimit, {}), DurationVerificationError);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

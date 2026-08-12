import fs from 'node:fs';
import path from 'node:path';
import { createFixturePlan, createFixtureAssets } from '../src/wyr/fixtures.js';
import { buildComposition, renderVideo, verifyVideo } from '../src/wyr/media.js';
import { WYR_TEMPLATE } from '../src/wyr/template.js';
import { writeJsonAtomic } from '../src/wyr/utils.js';
import { PROJECT_ROOT, resolveProjectPath } from '../src/wyr/runtime.js';

if (process.env.WYR_FIXTURE_MODE !== 'true' && !process.argv.includes('--fixture')) throw new Error('Fixture rendering requires explicit WYR_FIXTURE_MODE=true or --fixture.');
const workspace = process.env.WYR_FIXTURE_DIR ? resolveProjectPath(process.env.WYR_FIXTURE_DIR) : path.join(PROJECT_ROOT, 'data', 'wyr-fixture-job');
for (const folder of ['', 'assets', 'audio', 'render', 'output']) fs.mkdirSync(path.join(workspace, folder), { recursive: true });
const plan = createFixturePlan(); const assets = await createFixtureAssets({ assetsDir: path.join(workspace, 'assets') });
if (assets.length !== 16) throw new Error(`Fixture must contain 16 images; found ${assets.length}.`);
writeJsonAtomic(path.join(workspace, 'plan.json'), plan); writeJsonAtomic(path.join(workspace, 'assets.json'), assets);
const duration = WYR_TEMPLATE.timing.defaultSceneDuration;
buildComposition({ plan, assets, duration, workspace });
const outputPath = await renderVideo({ plan, assets, duration, workspace, onProgress: (done, total) => console.log(JSON.stringify({ stage: 'rendering', done, total })) });
const verification = await verifyVideo(outputPath);
console.log(JSON.stringify({ status: 'completed', workspace, outputPath, scenes: plan.questions.length, uniqueImages: new Set(assets.map(asset => asset.id)).size, verification }, null, 2));

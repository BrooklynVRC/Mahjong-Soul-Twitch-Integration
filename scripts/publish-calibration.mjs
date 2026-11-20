// Turns the calibration on this PC into the built-in calibration for everyone.
//   npm run calibration:publish
// Reads %APPDATA%\MahjongSoulScreenReader (what you taught in either app) and writes
// calibration/default-pack.json. Commit + push afterwards:
// apps with "Get calibration updates online" pick it up right away, and the next release bundles it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const shared = process.env.MSB_SHARED_DIR || resolve(process.env.APPDATA, 'MahjongSoulScreenReader');
const read = (f, fallback) => { const p = resolve(shared, f); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback; };
const templates = read('templates.json', []);
const scores = read('scores.json', { regions: {}, glyphs: [] });
if (!scores.regions?.me || !scores.glyphs?.length) { console.error('No score calibration found in', shared, '- teach the score boxes first.'); process.exit(1); }

const root = resolve(import.meta.dirname, '..');
const prev = existsSync(resolve(root, 'calibration/default-pack.json')) ? JSON.parse(readFileSync(resolve(root, 'calibration/default-pack.json'), 'utf8')) : {};
const pack = {
  app: 'mahjong-soul-screen-reader', version: 3,
  packVersion: Math.max(Math.floor(Date.now() / 1000), (prev.packVersion || 0) + 1),
  created: new Date().toISOString(),
  templates, scores,
};
const digits = [...new Set(scores.glyphs.map((g) => g.ch))].sort().join('');
for (const dir of [root]) {
  if (!existsSync(resolve(dir, 'calibration'))) continue;
  writeFileSync(resolve(dir, 'calibration/default-pack.json'), JSON.stringify(pack, null, 2) + '\n');
  console.log('wrote', resolve(dir, 'calibration/default-pack.json'));
}
console.log(`pack v${pack.packVersion}: ${templates.length} banner templates, score seats: ${Object.keys(scores.regions).join(', ')}, digits: ${digits} (${scores.glyphs.length} samples)`);

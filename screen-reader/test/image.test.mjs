import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decodeBmpGray, encodeGrayBmp, cropTemplate, prepare, matchScore } = await import('../src/image.ts');
const { KEYS, toGameEvent } = await import('../src/events.ts');

// Synthetic 480x270 "game frame": noise background + a bright banner with text-like stripes.
function frame(bannerX, bannerY, seed = 1) {
  const w = 480, h = 270, px = new Uint8Array(w * h);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < px.length; i++) px[i] = 40 + rnd() * 60;
  for (let y = 0; y < 40; y++) for (let x = 0; x < 120; x++) {
    const v = ((x >> 3) % 3 === 0 || y % 13 < 3) ? 250 : 170;
    px[(bannerY + y) * w + bannerX + x] = v;
  }
  return { w, h, px };
}

test('BMP round trip', () => {
  const f = frame(100, 100);
  const g = decodeBmpGray(encodeGrayBmp(f));
  assert.equal(g.w, 480); assert.equal(g.h, 270);
  assert.deepEqual(g.px.slice(0, 50), f.px.slice(0, 50));
});

test('template matches itself, tolerates a shift, ignores other frames', () => {
  const f = frame(180, 115);
  const rect = { x: 180 / 480, y: 115 / 270, w: 120 / 480, h: 40 / 270 };
  const crop = cropTemplate(f, rect);
  const t = prepare(crop.px, crop.w, crop.h);
  assert.ok(matchScore(f, rect, t, 8) > 0.98, 'self');
  assert.ok(matchScore(frame(184, 117, 7), rect, t, 8) > 0.9, 'shifted by a few px');
  assert.ok(matchScore(frame(20, 200, 3), rect, t, 8) < 0.5, 'banner elsewhere');
});

test('every teachable key maps to an event', () => {
  for (const k of KEYS) assert.ok(toGameEvent(k.key), k.key);
  assert.equal(toGameEvent('dealt_in').dealtInByMe, true);
  assert.equal(toGameEvent('game_end_3').myPlace, 3);
});

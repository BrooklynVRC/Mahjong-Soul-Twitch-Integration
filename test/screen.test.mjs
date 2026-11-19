// Screen reader tests: image matching, digit reading and placement. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decodeBmpGray, encodeGrayBmp, cropTemplate, prepare, matchScore } = await import('../src/screen/image.ts');
const { learn, readScore, prepareGlyphs, placement, emptyLayout, segment } = await import('../src/screen/scores.ts');
const { KEYS, EVENT_KEYS, placeOf } = await import('../src/screen/keys.ts');

// Synthetic 480x270 frame: noise + a bright "banner" with text-like stripes.
function frame(bannerX, bannerY, seed = 1) {
  const w = 480, h = 270, px = new Uint8Array(w * h);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < px.length; i++) px[i] = 40 + rnd() * 60;
  for (let y = 0; y < 40; y++) for (let x = 0; x < 120; x++) px[(bannerY + y) * w + bannerX + x] = ((x >> 3) % 3 === 0 || y % 13 < 3) ? 250 : 170;
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

// 3x5 pixel font, drawn at 4x scale, light digits on a dark panel (like the score display).
const FONT = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'], 2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'], 4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '010', '010', '010'], 8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'], '-': ['000', '000', '111', '000', '000'],
};
function scoreFrame(text, x0 = 40, y0 = 30) {
  const w = 400, h = 120, px = new Uint8Array(w * h).fill(30), S = 4;
  [...text].forEach((ch, i) => FONT[ch].forEach((row, y) => [...row].forEach((on, x) => {
    if (on === '1') for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) px[(y0 + y * S + dy) * w + x0 + i * 16 + x * S + dx] = 230;
  })));
  return { w, h, px, rect: { x: (x0 - 4) / w, y: (y0 - 4) / h, w: (text.length * 16 + 4) / w, h: 28 / h } };
}

test('segments a score into characters', () => {
  const f = scoreFrame('25000');
  assert.equal(segment(f, f.rect).length, 5);
});

test('learns digits from typed examples and reads new scores', () => {
  const layout = emptyLayout();
  for (const t of ['25000', '31400', '-7600', '18900']) { const f = scoreFrame(t); learn(layout, f, f.rect, t); }
  const glyphs = prepareGlyphs(layout);
  for (const t of ['40300', '19700', '-2100', '5800']) { const f = scoreFrame(t); assert.equal(readScore(f, f.rect, glyphs), Number(t), t); }
});

test('rejects a typed number with the wrong length', () => {
  const f = scoreFrame('25000');
  assert.throws(() => learn(emptyLayout(), f, f.rect, '2500'), /Found 5 characters/);
});

test('placement from scores', () => {
  assert.equal(placement({ me: 32000, right: 25000, top: 18000, left: 25000 }), 1);
  assert.equal(placement({ me: 20000, right: 25000, top: 18000, left: 37000 }), 3);
  assert.equal(placement({ me: 25000, right: null, top: 30000, left: null }), 2);
  assert.equal(placement({ me: null, right: 1, top: 2, left: 3 }), null);
});

test('keys', () => {
  assert.ok(EVENT_KEYS.length < KEYS.length, 'generic keys are excluded from app events');
  assert.equal(placeOf('game_end_3'), 3);
  assert.equal(placeOf('my_riichi'), null);
});

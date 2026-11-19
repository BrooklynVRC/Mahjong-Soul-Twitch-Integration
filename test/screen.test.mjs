// Screen reader tests: image matching, digit reading and placement. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decodeBmpGray, encodeGrayBmp, cropTemplate, prepare, matchScore, shrink, searchable, searchAnywhere, seatAt } = await import('../src/screen/image.ts');
const { learn, readScore, prepareGlyphs, placement, emptyLayout, segment, classifyChange, looksLikeGameStart } = await import('../src/screen/scores.ts');
const { KEYS, placeOf } = await import('../src/screen/keys.ts');

// Synthetic 480x270 frame: noise + a bright "banner" with text-like stripes.
function frame(bannerX, bannerY, seed = 1) {
  const w = 480, h = 270, px = new Uint8Array(w * h);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < px.length; i++) px[i] = 40 + rnd() * 60;
  for (let y = 0; y < 40; y++) for (let x = 0; x < 120; x++) px[(bannerY + y) * w + bannerX + x] = ((x >> 3) % 3 === 0 || y % 13 < 3) ? 250 : 170;
  return { w, h, px };
}

test('finds a banner anywhere and tells which seat it belongs to', () => {
  // taught at the bottom (my side), then shown on the right side of a 960x540 picture
  const big = (bx, by, seed) => { const f = frame(0, 0, seed); const w = 960, h = 540, px = new Uint8Array(w * h);
    let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < px.length; i++) px[i] = 40 + rnd() * 60;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 120; x++) px[(by + y) * w + bx + x] = ((x >> 3) % 3 === 0 || y % 13 < 3) ? 250 : 170;
    return { w, h, px }; };
  const taught = big(420, 400, 1), rect = { x: 420 / 960, y: 400 / 540, w: 120 / 960, h: 40 / 540 };
  const crop = cropTemplate(taught, rect);
  const sq = searchable(crop.px, crop.w, crop.h, crop.w / rect.w, 480);
  const m = searchAnywhere(shrink(big(780, 250, 5), 480), sq);
  assert.ok(m.score > 0.85, 'found: ' + m.score);
  assert.equal(seatAt(m.cx, m.cy), 'right');
  assert.equal(seatAt(0.5, 0.85), 'me'); assert.equal(seatAt(0.5, 0.15), 'top'); assert.equal(seatAt(0.12, 0.5), 'left');
});

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
function scoreFrame(text, rot = 0) {
  const S = 4, x0 = 40, y0 = 30, w = 400, h = 120, up = new Uint8Array(w * h).fill(30);
  [...text].forEach((ch, i) => FONT[ch].forEach((row, y) => [...row].forEach((on, x) => {
    if (on === '1') for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) up[(y0 + y * S + dy) * w + x0 + i * 16 + x * S + dx] = 230;
  })));
  const rect = { x: (x0 - 4) / w, y: (y0 - 4) / h, w: (text.length * 16 + 4) / w, h: 28 / h };
  if (rot === 0) return { w, h, px: up, rect };
  // Rotate the picture clockwise by rot degrees (what the game does for the other seats).
  const W = rot === 180 ? w : h, H = rot === 180 ? h : w, px = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [nx, ny] = rot === 90 ? [h - 1 - y, x] : rot === 180 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
    px[ny * W + nx] = up[y * w + x];
  }
  const [rx, ry, rw, rh] = rot === 90 ? [1 - rect.y - rect.h, rect.x, rect.h, rect.w] : rot === 180 ? [1 - rect.x - rect.w, 1 - rect.y - rect.h, rect.w, rect.h] : [rect.y, 1 - rect.x - rect.w, rect.h, rect.w];
  return { w: W, h: H, px, rect: { x: rx, y: ry, w: rw, h: rh } };
}

test('segments a score into characters', () => {
  const f = scoreFrame('25000');
  assert.equal(segment(f, f.rect).length, 5);
});

test('learns digits from typed examples and reads new scores', () => {
  const layout = emptyLayout();
  for (const t of ['25000', '31400', '-7600', '18900']) { const f = scoreFrame(t); learn(layout, f, f.rect, t, 'me'); }
  const glyphs = prepareGlyphs(layout);
  for (const t of ['40300', '19700', '-2100', '5800']) { const f = scoreFrame(t); assert.equal(readScore(f, { ...f.rect, rot: 0 }, glyphs)?.value, Number(t), t); }
});

test('reads rotated scores and works out the rotation by itself', () => {
  const layout = emptyLayout();
  for (const t of ['25000', '31400', '-7600', '18900']) { const f = scoreFrame(t); learn(layout, f, f.rect, t, 'me'); }
  for (const [seat, rot] of [['top', 180], ['right', 270], ['left', 90]]) {
    const f = scoreFrame('34900', rot);
    const r = learn(layout, f, f.rect, '34900', seat);
    assert.equal(r.rot, rot, seat);
    const g = scoreFrame('21800', rot);
    assert.equal(readScore(g, { ...g.rect, rot: r.rot }, prepareGlyphs(layout))?.value, 21800, seat);
  }
});

test('picks 90 vs 270 correctly even against the seat default', () => {
  const layout = emptyLayout();
  for (const t of ['25000', '31400', '-7600', '18900']) { const f = scoreFrame(t); learn(layout, f, f.rect, t, 'me'); }
  const f = scoreFrame('34900', 90); // left-style rotation, taught as "right"
  assert.equal(learn(layout, f, f.rect, '34900', 'right').rot, 90);
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

test('works out events from score changes', () => {
  const s = (me, right, top, left) => ({ me, right, top, left });
  assert.deepEqual(classifyChange(s(25000, 25000, 25000, 25000), s(24000, 25000, 25000, 25000)).keys, ['my_riichi']);
  assert.deepEqual(classifyChange(s(25000, 25000, 25000, 25000), s(25000, 24000, 25000, 25000)).keys, ['opponent_riichi']);
  assert.deepEqual(classifyChange(s(25000, 25000, 25000, 25000), s(33000, 17000, 25000, 25000)).keys, ['my_win_ron']);
  assert.deepEqual(classifyChange(s(25000, 25000, 25000, 25000), s(17000, 33000, 25000, 25000)).keys, ['dealt_in']);
  assert.deepEqual(classifyChange(s(25000, 25000, 25000, 25000), s(25000, 33000, 17000, 25000)).keys, ['opponent_ron_other']);
  assert.deepEqual(classifyChange(s(25000, 25000, 25000, 25000), s(33000, 23000, 23000, 21000)).keys, ['my_win_tsumo']);
  assert.deepEqual(classifyChange(s(25000, 25000, 25000, 25000), s(23000, 33000, 23000, 21000)).keys, ['opponent_tsumo']);
  assert.deepEqual(classifyChange(s(25000, 25000, 25000, 25000), s(26500, 26500, 23500, 23500)).keys, ['draw']);
  assert.deepEqual(classifyChange(s(25000, 24000, 25000, 25000), s(24000, 27000, 24000, 24000)).keys, ['draw'], '1 tenpai (seen in a real match)');
  assert.deepEqual(classifyChange(s(25000, 25000, 25000, 25000), s(26000, 26000, 22000, 26000)).keys, ['draw'], '3 tenpai');
  assert.deepEqual(classifyChange(s(35000, 35000, null, 35000), s(37000, 34000, null, 34000)).keys, ['draw'], '3-player 1 tenpai');
  assert.equal(classifyChange(s(25000, 25000, 25000, 25000), s(24000, 25000, 24000, 24000)), null, 'three -1000s at once is not riichi');
  assert.deepEqual(classifyChange(s(35000, 35000, null, 35000), s(43000, 27000, null, 35000)).keys, ['my_win_ron'], '3-player');
  assert.equal(classifyChange(s(25000, 25000, 25000, 25000), s(25000, 25000, 25000, 25000)), null);
  assert.equal(classifyChange(s(33000, 27000, 24000, 15000), s(40300, 14700, 24000, 15000)), null, 'half-finished count-up (seen in a real match) waits');
  assert.equal(classifyChange(s(33000, 27000, 24000, 15000), s(33050, 27000, 24000, 15000)), null, 'not a multiple of 100');
  assert.deepEqual(classifyChange(s(33000, 27000, 24000, 15000), s(46300, 14700, 23000, 15000)).keys, ['opponent_riichi', 'my_win_ron'], 'riichi in the same moment as a ron');
  assert.deepEqual(classifyChange(s(24000, 25000, 25000, 25000), s(37300, 25000, 25000, 11700)).keys, ['my_win_ron'], 'ron collecting my own riichi stick');
  assert.ok(looksLikeGameStart(s(25000, 25000, 25000, 25000)));
  assert.ok(looksLikeGameStart(s(35000, 35000, null, 35000)));
  assert.ok(!looksLikeGameStart(s(25000, 24000, 25000, 25000)));
});

test('keys', () => {
  assert.ok(KEYS.filter((k) => k.auto).length >= 10, 'most events come from the scores');
  assert.equal(placeOf('game_end_3'), 3);
  assert.equal(placeOf('my_riichi'), null);
});

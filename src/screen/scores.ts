// Reads the point totals from the game picture with taught digit shapes (tiny template OCR), and works
// out what happened from how they change. Same file in both repos.
//
// Teaching: draw a box around a score and type the number shown. The box is split into characters and each
// one is learned. Scores of the other seats are drawn rotated (sideways / upside down); the rotation is
// detected automatically. Reading is size-independent (every character is normalized), and colour or
// brightness changes don't matter (each box is binarized on its own).
import { type Gray, type Rect } from './image.js';

export type Seat = 'me' | 'right' | 'top' | 'left';
export const SEATS: Seat[] = ['me', 'right', 'top', 'left'];
/** Clockwise rotation of the text in the picture: 0 upright, 180 upside down, 90/270 sideways. */
export type Rotation = 0 | 90 | 180 | 270;
export interface ScoreRegion extends Rect { rot: Rotation }
export const GW = 12, GH = 16; // normalized glyph size
const MAX_SAMPLES = 10;          // per character
// Likely rotation per seat (each player's score faces them); used when there's nothing to compare against yet.
const SEAT_ROT: Record<Seat, Rotation[]> = { me: [0, 180, 90, 270], top: [180, 0, 270, 90], right: [270, 90, 0, 180], left: [90, 270, 0, 180] };

export interface Glyph { ch: string; data: string } // base64 of GW*GH bytes (0..255)
export interface ScoreLayout { regions: Partial<Record<Seat, ScoreRegion>>; glyphs: Glyph[] }
export const emptyLayout = (): ScoreLayout => ({ regions: {}, glyphs: [] });

/** Samples the box upright (undoing `rot`) into a W×H float image. */
function upright(img: Gray, r: Rect, rot: Rotation, H: number): { W: number; H: number; px: Float32Array } {
  const rx = r.x * img.w, ry = r.y * img.h, rw = r.w * img.w, rh = r.h * img.h;
  const sideways = rot === 90 || rot === 270;
  const W = Math.max(8, Math.round((sideways ? rh / rw : rw / rh) * H));
  const px = new Float32Array(W * H);
  const at = (x: number, y: number) => {
    x = Math.min(img.w - 1.001, Math.max(0, x)); y = Math.min(img.h - 1.001, Math.max(0, y));
    const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy, i = iy * img.w + ix;
    return (img.px[i] * (1 - tx) + img.px[i + 1] * tx) * (1 - ty) + (img.px[i + img.w] * (1 - tx) + img.px[i + img.w + 1] * tx) * ty;
  };
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const fu = (u + 0.5) / W, fv = (v + 0.5) / H; // 0..1 along the text / down the glyph
    let sx: number, sy: number;
    if (rot === 0) { sx = fu * rw; sy = fv * rh; }
    else if (rot === 180) { sx = (1 - fu) * rw; sy = (1 - fv) * rh; }
    else if (rot === 90) { sx = (1 - fv) * rw; sy = fu * rh; }   // text runs top→bottom, glyph tops face right
    else { sx = fv * rw; sy = (1 - fu) * rh; }                    // 270: text runs bottom→top, glyph tops face left
    px[v * W + u] = at(rx + sx - 0.5, ry + sy - 0.5);
  }
  return { W, H, px };
}

/** Splits the score box into character images (GW×GH floats, 1 = ink). */
export function segment(frame: Gray, rect: Rect, rot: Rotation = 0): Float32Array[] {
  if (rect.w * frame.w < 4 || rect.h * frame.h < 3) throw new Error('Box is too small. Draw it around the score digits.');
  const H = 32;
  const { W, px: img } = upright(frame, rect, rot, H);

  // Otsu threshold, then treat the minority class as ink (works for light-on-dark and dark-on-light).
  const hist = new Array(256).fill(0);
  for (const v of img) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  const total = img.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = i; }
  }
  let bright = 0; for (const v of img) if (v > thr) bright++;
  const inkBright = bright < total / 2;
  const ink = new Uint8Array(total);
  for (let i = 0; i < total; i++) ink[i] = (inkBright ? img[i] > thr : img[i] <= thr) ? 1 : 0;

  // Column runs with ink = characters.
  const colInk = new Array(W).fill(0);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) colInk[x] += ink[y * W + x];
  let runs: [number, number][] = [];
  for (let x = 0; x < W;) {
    if (colInk[x] >= 2) { const s = x; while (x < W && colInk[x] >= 2) x++; if (x - s >= 2) runs.push([s, x]); }
    else x++;
  }
  if (!runs.length) return [];
  const widths = runs.map(([a, b]) => b - a).sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)];
  // Ignore thin slivers cut off by the box edge (e.g. a neighbouring icon), so loose boxes still work.
  const sliver = ([a, b]: [number, number]) => (a <= 1 || b >= W - 1) && b - a < median * 0.6;
  while (runs.length > 1 && sliver(runs[0])) runs.shift();
  while (runs.length > 1 && sliver(runs[runs.length - 1])) runs.pop();
  // Split runs that are clearly two touching characters.
  runs = runs.flatMap(([a, b]) => {
    const n = Math.round((b - a) / median);
    if (n <= 1 || (b - a) < median * 1.6) return [[a, b] as [number, number]];
    const step = (b - a) / n;
    return Array.from({ length: n }, (_, i) => [Math.round(a + i * step), Math.round(a + (i + 1) * step)] as [number, number]);
  });

  return runs.map(([a, b]) => {
    let top = H, bot = -1;
    for (let y = 0; y < H; y++) for (let x = a; x < b; x++) if (ink[y * W + x]) { top = Math.min(top, y); bot = Math.max(bot, y); }
    if (bot < top) { top = 0; bot = H - 1; }
    // Keep a minimum height for short glyphs like "-" so they don't get stretched into a "1".
    if (bot - top < H * 0.35) { const mid = (top + bot) / 2; top = Math.max(0, Math.floor(mid - H * 0.35)); bot = Math.min(H - 1, Math.ceil(mid + H * 0.35)); }
    const g = new Float32Array(GW * GH);
    const gw = b - a, gh = bot - top + 1;
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const sx = a + Math.min(gw - 1, Math.floor((x + 0.5) * gw / GW)), sy = top + Math.min(gh - 1, Math.floor((y + 0.5) * gh / GH));
      g[y * GW + x] = ink[sy * W + sx];
    }
    return g;
  });
}

function ncc(a: ArrayLike<number>, b: ArrayLike<number>) {
  let ma = 0, mb = 0; const n = a.length;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; c += x * y; va += x * x; vb += y * y; }
  return va && vb ? c / Math.sqrt(va * vb) : 0;
}

const toB64 = (g: Float32Array) => Buffer.from(Uint8Array.from(g, (v) => Math.round(v * 255))).toString('base64');
const fromB64 = (s: string) => Float32Array.from(Buffer.from(s, 'base64'), (v) => v / 255);

export interface Prepared { ch: string; v: Float32Array }
export const prepareGlyphs = (layout: ScoreLayout): Prepared[] => layout.glyphs.map((g) => ({ ch: g.ch, v: fromB64(g.data) }));

function addSample(layout: ScoreLayout, ch: string, g: Float32Array) {
  layout.glyphs.push({ ch, data: toB64(g) });
  const same = layout.glyphs.filter((x) => x.ch === ch);
  if (same.length > MAX_SAMPLES) layout.glyphs.splice(layout.glyphs.indexOf(same[0]), 1);
}

/**
 * Learns characters from a box whose value you typed, working out the rotation by itself.
 * Returns the rotation used and how many characters were learned.
 */
export function learn(layout: ScoreLayout, frame: Gray, rect: Rect, text: string, seat: Seat = 'me'): { rot: Rotation; learned: number } {
  const chars = text.replace(/[\s,.]/g, '');
  if (!/^-?\d+$/.test(chars)) throw new Error('Type the number exactly as shown, e.g. 25000 or -1200.');
  const known = prepareGlyphs(layout);
  let best: { rot: Rotation; glyphs: Float32Array[]; fit: number } | null = null;
  const counts: string[] = [];
  SEAT_ROT[seat].forEach((rot, order) => {
    let glyphs: Float32Array[];
    try { glyphs = segment(frame, rect, rot); } catch { return; }
    counts.push(`${glyphs.length}`);
    if (glyphs.length !== chars.length) return;
    // How well do the pieces match characters we already know? (Picks 90° vs 270°, 0° vs 180°.)
    let fit = 0, n = 0;
    chars.split('').forEach((ch, i) => {
      const same = known.filter((k) => k.ch === ch);
      if (same.length) { fit += Math.max(...same.map((k) => ncc(glyphs[i], k.v))); n++; }
    });
    const score = n ? fit / n : 1 - order * 0.1; // nothing to compare: prefer the seat's usual rotation
    if (!best || score > best.fit) best = { rot, glyphs, fit: score };
  });
  if (!best) {
    const found = counts[0] ?? '0'; // as seen in this seat's usual rotation
    throw new Error(`Found ${found} characters in the box but you typed ${chars.length}. Draw the box tightly around just the number.`);
  }
  const b = best as { rot: Rotation; glyphs: Float32Array[] };
  chars.split('').forEach((ch, i) => addSample(layout, ch, b.glyphs[i]));
  return { rot: b.rot, learned: chars.length };
}

export interface Reading { value: number; confidence: number; glyphs: Float32Array[]; text: string }

/** Reads one score, or null if any character is unclear. */
export function readScore(frame: Gray, region: ScoreRegion, glyphs: Prepared[], minConfidence = 0.6): Reading | null {
  if (!glyphs.length) return null;
  let parts: Float32Array[];
  try { parts = segment(frame, region, region.rot ?? 0); } catch { return null; }
  if (!parts.length || parts.length > 8) return null;
  let s = '', worst = 1;
  for (const p of parts) {
    let best = -1, ch = '';
    for (const g of glyphs) { const c = ncc(p, g.v); if (c > best) { best = c; ch = g.ch; } }
    if (best < minConfidence) return null;
    worst = Math.min(worst, best);
    s += ch;
  }
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Math.abs(n) <= 999_900 ? { value: n, confidence: worst, glyphs: parts, text: s } : null;
}

/** Keeps learning from very clear readings, so new skins/sizes get covered over time. */
export function reinforce(layout: ScoreLayout, r: Reading) {
  r.text.split('').forEach((ch, i) => addSample(layout, ch, r.glyphs[i]));
}

export const coverage = (layout: ScoreLayout) => [...new Set(layout.glyphs.map((g) => g.ch))].sort().join('');

/** 1-based placement of `me` among the readable scores (ties count in your favour). */
export function placement(scores: Partial<Record<Seat, number | null>>): number | null {
  const me = scores.me;
  if (me === null || me === undefined) return null;
  const others = (['right', 'top', 'left'] as Seat[]).map((s) => scores[s]).filter((v): v is number => typeof v === 'number');
  if (!others.length) return null;
  return 1 + others.filter((v) => v > me).length;
}

/**
 * What a settled score change means, from "my" point of view. Cosmetics can't fool this: it only
 * uses the numbers. Returns the event keys to fire (possibly several, e.g. double ron).
 */
export function classifyChange(before: Partial<Record<Seat, number | null>>, after: Partial<Record<Seat, number | null>>): { keys: string[]; note: string } | null {
  const d: [Seat, number][] = [];
  for (const s of SEATS) {
    const a = before[s], b = after[s];
    if (typeof a === 'number' && typeof b === 'number' && a !== b) d.push([s, b - a]);
  }
  if (!d.length) return null;
  const note = d.map(([s, v]) => `${s} ${v > 0 ? '+' : ''}${v}`).join(', ');
  const gain = d.filter(([, v]) => v > 0), loss = d.filter(([, v]) => v < 0);

  // Riichi: exactly one player pays the 1,000 stick and nothing else changes.
  if (!gain.length && loss.length === 1 && loss[0][1] === -1000) return { keys: [loss[0][0] === 'me' ? 'my_riichi' : 'opponent_riichi'], note };
  if (!gain.length && loss.length >= 2 && loss.every(([, v]) => v === -1000)) return { keys: loss.map(([s]) => (s === 'me' ? 'my_riichi' : 'opponent_riichi')), note };

  // Exhaustive draw: several players gain the noten payments (3,000 or 2,000 split between them).
  const notenStep = new Set([1000, 1500, 2000, 3000]);
  if (gain.length >= 2 && d.every(([, v]) => notenStep.has(Math.abs(v)))) return { keys: ['draw'], note };

  if (!gain.length || !loss.length) return null;
  // Win: winners gained, payers lost. One payer = ron; several = tsumo.
  const big = gain.filter(([, v]) => v >= 1000);
  if (!big.length) return null;
  const keys: string[] = [];
  if (loss.length === 1) {
    const payer = loss[0][0];
    for (const [w] of big) keys.push(w === 'me' ? 'my_win_ron' : payer === 'me' ? 'dealt_in' : 'opponent_ron_other');
  } else {
    const w = big.sort((a, b) => b[1] - a[1])[0][0];
    keys.push(w === 'me' ? 'my_win_tsumo' : 'opponent_tsumo');
  }
  return { keys: [...new Set(keys)], note };
}

/** Typical starting scores: a fresh game shows everyone on the same value. */
export function looksLikeGameStart(row: Partial<Record<Seat, number | null>>): boolean {
  const vals = SEATS.map((s) => row[s]).filter((v): v is number => typeof v === 'number');
  return vals.length >= 2 && vals.every((v) => v === vals[0]) && [25000, 30000, 35000, 40000].includes(vals[0]);
}

// Reads the point totals from the game picture with taught digit shapes (tiny template OCR).
// You draw a box around a score and type the number shown; it splits the box into characters
// and learns each one. After a few examples it can read all four scores live.
import { resample, type Gray, type Rect } from './image.js';

export type Seat = 'me' | 'right' | 'top' | 'left';
export const SEATS: Seat[] = ['me', 'right', 'top', 'left'];
export const GW = 12, GH = 16; // normalized glyph size
const MAX_SAMPLES = 6;          // per character

export interface Glyph { ch: string; data: string } // base64 of GW*GH bytes (0..255)
export interface ScoreLayout { regions: Partial<Record<Seat, Rect>>; glyphs: Glyph[] }
export const emptyLayout = (): ScoreLayout => ({ regions: {}, glyphs: [] });

/** Splits the score box into character images (GW×GH floats, 1 = ink). */
export function segment(frame: Gray, rect: Rect): Float32Array[] {
  const rw = rect.w * frame.w, rh = rect.h * frame.h;
  if (rw < 4 || rh < 3) throw new Error('Box is too small. Draw it around the score digits.');
  const H = 32, W = Math.max(8, Math.round(rw * H / rh));
  const img = resample(frame, rect.x * frame.w, rect.y * frame.h, rect.x * frame.w + rw, rect.y * frame.h + rh, W, H);

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
    // Keep the full box height for short glyphs like "-" so they don't get stretched into a "1".
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

/** Learns characters from a box whose value you typed. Returns how many characters were learned. */
export function learn(layout: ScoreLayout, frame: Gray, rect: Rect, text: string): number {
  const chars = text.replace(/[\s,.]/g, '');
  if (!/^-?\d+$/.test(chars)) throw new Error('Type the number exactly as shown, e.g. 25000 or -1200.');
  const glyphs = segment(frame, rect);
  if (glyphs.length !== chars.length) throw new Error(`Found ${glyphs.length} characters in the box but you typed ${chars.length}. Draw the box tightly around just the number.`);
  chars.split('').forEach((ch, i) => {
    layout.glyphs.push({ ch, data: toB64(glyphs[i]) });
    const same = layout.glyphs.filter((g) => g.ch === ch);
    if (same.length > MAX_SAMPLES) layout.glyphs.splice(layout.glyphs.indexOf(same[0]), 1);
  });
  return chars.length;
}

export interface Prepared { ch: string; v: Float32Array }
export const prepareGlyphs = (layout: ScoreLayout): Prepared[] => layout.glyphs.map((g) => ({ ch: g.ch, v: fromB64(g.data) }));

/** Reads one score, or null if any character is unclear. */
export function readScore(frame: Gray, rect: Rect, glyphs: Prepared[], minConfidence = 0.6): number | null {
  if (!glyphs.length) return null;
  let parts: Float32Array[];
  try { parts = segment(frame, rect); } catch { return null; }
  if (!parts.length || parts.length > 8) return null;
  let s = '';
  for (const p of parts) {
    let best = -1, ch = '';
    for (const g of glyphs) { const c = ncc(p, g.v); if (c > best) { best = c; ch = g.ch; } }
    if (best < minConfidence) return null;
    s += ch;
  }
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Math.abs(n) <= 999_900 ? n : null;
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

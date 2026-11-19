// BMP decoding/encoding and template matching (normalized cross-correlation). No dependencies.

export interface Gray { w: number; h: number; px: Uint8Array }

export function decodeBmpGray(buf: Buffer): Gray {
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error('not a BMP image');
  const off = buf.readUInt32LE(10);
  const hdr = buf.readUInt32LE(14);
  const w = buf.readInt32LE(18);
  let h = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const comp = buf.readUInt32LE(30);
  const topDown = h < 0; h = Math.abs(h);
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported BMP bit depth ${bpp}`);
  let rm = 0x00ff0000, gm = 0x0000ff00, bm = 0x000000ff;
  if (bpp === 32 && (comp === 3 || comp === 6)) {
    const mo = hdr >= 52 ? 54 : 14 + hdr; // masks inside V4/V5 header, or right after a 40-byte header
    rm = buf.readUInt32LE(mo); gm = buf.readUInt32LE(mo + 4); bm = buf.readUInt32LE(mo + 8);
  }
  const shift = (m: number) => { let s = 0; while (m && !(m & 1)) { m >>>= 1; s++; } return s; };
  const rs = shift(rm), gs = shift(gm), bs = shift(bm);
  const stride = Math.floor((bpp * w + 31) / 32) * 4;
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = off + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      let r, g, b;
      if (bpp === 24) { const i = row + x * 3; b = buf[i]; g = buf[i + 1]; r = buf[i + 2]; }
      else { const v = buf.readUInt32LE(row + x * 4); r = ((v & rm) >>> rs) & 255; g = ((v & gm) >>> gs) & 255; b = ((v & bm) >>> bs) & 255; }
      px[y * w + x] = (r * 77 + g * 150 + b * 29) >> 8;
    }
  }
  return { w, h, px };
}

/** 24-bit BMP from a grayscale image (used for template thumbnails). */
export function encodeGrayBmp(img: Gray): Buffer {
  const stride = Math.floor((24 * img.w + 31) / 32) * 4;
  const size = 54 + stride * img.h;
  const b = Buffer.alloc(size);
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(img.w, 18); b.writeInt32LE(-img.h, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(stride * img.h, 34);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const v = img.px[y * img.w + x], i = 54 + y * stride + x * 3;
    b[i] = b[i + 1] = b[i + 2] = v;
  }
  return b;
}

/** Bilinear resample of the source rectangle (in source pixels) to ow×oh. */
export function resample(src: Gray, x0: number, y0: number, x1: number, y1: number, ow: number, oh: number): Float32Array {
  const out = new Float32Array(ow * oh);
  const sx = (x1 - x0) / ow, sy = (y1 - y0) / oh;
  for (let y = 0; y < oh; y++) {
    const fy = Math.min(src.h - 1.001, Math.max(0, y0 + (y + 0.5) * sy - 0.5));
    const iy = Math.floor(fy), ty = fy - iy;
    for (let x = 0; x < ow; x++) {
      const fx = Math.min(src.w - 1.001, Math.max(0, x0 + (x + 0.5) * sx - 0.5));
      const ix = Math.floor(fx), tx = fx - ix;
      const i = iy * src.w + ix;
      const a = src.px[i], b = src.px[i + 1], c = src.px[i + src.w], d = src.px[i + src.w + 1];
      out[y * ow + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

export interface Rect { x: number; y: number; w: number; h: number } // normalized 0..1

export interface Prepared { tw: number; th: number; zero: Float32Array; norm: number }

export function prepare(px: ArrayLike<number>, tw: number, th: number): Prepared {
  let mean = 0;
  for (let i = 0; i < tw * th; i++) mean += px[i];
  mean /= tw * th;
  const zero = new Float32Array(tw * th);
  let ss = 0;
  for (let i = 0; i < tw * th; i++) { zero[i] = px[i] - mean; ss += zero[i] * zero[i]; }
  return { tw, th, zero, norm: Math.sqrt(ss) };
}

/** Best normalized cross-correlation (-1..1) of the template around its saved spot, allowing a small shift. */
export function matchScore(frame: Gray, rect: Rect, t: Prepared, marginPct: number): number {
  if (t.norm < 1e-3) return 0;
  const mx = Math.max(1, Math.round(t.tw * marginPct / 100)), my = Math.max(1, Math.round(t.th * marginPct / 100));
  const rw = rect.w * frame.w, rh = rect.h * frame.h;
  const pxPerT = rw / t.tw, pyPerT = rh / t.th; // frame pixels per template pixel
  const sw = t.tw + 2 * mx, sh = t.th + 2 * my;
  const x0 = rect.x * frame.w - mx * pxPerT, y0 = rect.y * frame.h - my * pyPerT;
  const area = resample(frame, x0, y0, x0 + sw * pxPerT, y0 + sh * pyPerT, sw, sh);
  const n = t.tw * t.th;
  let best = -1;
  for (let dy = 0; dy <= 2 * my; dy++) {
    for (let dx = 0; dx <= 2 * mx; dx++) {
      let sum = 0, sum2 = 0, cross = 0;
      for (let y = 0; y < t.th; y++) {
        const row = (y + dy) * sw + dx, trow = y * t.tw;
        for (let x = 0; x < t.tw; x++) {
          const v = area[row + x];
          sum += v; sum2 += v * v; cross += v * t.zero[trow + x];
        }
      }
      const varr = sum2 - (sum * sum) / n;
      if (varr < 1e-3) continue;
      const s = cross / (Math.sqrt(varr) * t.norm); // template is zero-mean, so frame mean cancels
      if (s > best) best = s;
    }
  }
  return best;
}

/** Crops the normalized rect from a frame and shrinks it to at most `max` px on its long side. */
export function cropTemplate(frame: Gray, rect: Rect, max = 96): Gray {
  const rw = rect.w * frame.w, rh = rect.h * frame.h;
  if (rw < 6 || rh < 6) throw new Error('Selection is too small; drag a bigger box.');
  const scale = Math.min(1, max / Math.max(rw, rh));
  const tw = Math.max(8, Math.round(rw * scale)), th = Math.max(8, Math.round(rh * scale));
  const f = resample(frame, rect.x * frame.w, rect.y * frame.h, rect.x * frame.w + rw, rect.y * frame.h + rh, tw, th);
  return { w: tw, h: th, px: Uint8Array.from(f, (v) => Math.round(v)) };
}

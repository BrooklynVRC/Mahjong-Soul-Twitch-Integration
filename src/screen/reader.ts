// Read-only screen reader. Same file in both repos.
//
// It watches the game picture (Windows Graphics Capture or an OBS source), reads the four point totals from
// a high-resolution zoom of the centre panel, and works out what happened from how they change. Optional
// banner templates add extras (yakuman, calls, game mode, instant results).
//
// Calibration (templates, score boxes, learned digits) and the reader's settings live in one shared folder,
// so calibrating in either app sets up both. A built-in calibration pack is loaded on first run and can be
// kept up to date online, so most people never need to calibrate at all.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ObsCapture, WindowCapture, type Source } from './capture.js';
import { KEYS, keyLabel, placeOf, type Detection, type GameState } from './keys.js';
import { cropTemplate, decodeBmpGray, encodeGrayBmp, matchScore, prepare, type Gray, type Prepared, type Rect } from './image.js';
import {
  SEATS, classifyChange, coverage, emptyLayout, learn, looksLikeGameStart, placement, prepareGlyphs, readScore, reinforce,
  type Prepared as GlyphSet, type ScoreLayout, type ScoreRegion, type Seat,
} from './scores.js';

export const SCREEN_DEFAULTS = {
  enabled: true,
  source: 'window' as 'window' | 'obs',
  window: { processName: 'Jantama_MahjongSoul', keep16x9: true },
  obs: { url: 'ws://127.0.0.1:4455', password: '', sourceName: '' },
  fps: 4,
  analysisWidth: 960,
  bufferSeconds: 20,
  detection: { searchMarginPct: 8, defaultThreshold: 0.8, defaultCooldownSec: 6, confirmFrames: 1, rearmMargin: 0.05 },
  scores: {
    enabled: true, minConfidence: 0.6, stableFrames: 3, settleSeconds: 1.5, gameEndSeconds: 40, autoLearn: true,
    zone: { x: 0.3, y: 0.18, w: 0.4, h: 0.6 },
  },
  calibration: { autoUpdate: true, url: 'https://raw.githubusercontent.com/BrooklynVRC/Mahjong-Soul-Twitch-Integration/main/calibration/default-pack.json' },
};
export type ScreenConfig = typeof SCREEN_DEFAULTS;

export const SCREEN_HINTS: Record<string, unknown> = {
  enabled: { label: 'Detection on', help: 'Off = no events are sent. The picture keeps updating.' },
  source: { label: 'Picture source', options: [{ value: 'window', label: 'Game window (screen-share style, works when tabbed out)' }, { value: 'obs', label: 'OBS source' }] },
  'window.processName': { label: 'Game process name', help: 'Steam client: Jantama_MahjongSoul' },
  'window.keep16x9': { label: 'Use the 16:9 game area', help: 'Cuts off black bars so every window size looks the same to the reader. Leave on.' },
  obs: { label: 'OBS', help: 'OBS → Tools → WebSocket Server Settings: enable it and copy the password.' },
  'obs.password': { secret: true },
  'obs.sourceName': { label: 'Source name', help: 'The OBS source that shows the game (exact name). "List OBS sources" shows the names.' },
  fps: { label: 'Checks per second', min: 1, max: 15, step: 1 },
  analysisWidth: { label: 'Analysis width (px)', help: 'Size the picture is checked at. Scores are read from a separate full-resolution zoom.', min: 480, max: 1920, step: 10 },
  bufferSeconds: { label: 'Freeze buffer (seconds)', help: 'How far back "Freeze" can go.', min: 5, max: 60, step: 1 },
  'detection.searchMarginPct': { label: 'Position tolerance (%)', help: 'How far a banner may move from where it was taught.', min: 0, max: 30, step: 1 },
  'detection.defaultThreshold': { label: 'Default match threshold', min: 0.5, max: 0.99, step: 0.01 },
  'detection.defaultCooldownSec': { label: 'Default cooldown (s)', min: 1, max: 60 },
  'detection.confirmFrames': { label: 'Frames to confirm', help: 'A banner must match this many checks in a row before it fires.', min: 1, max: 5, step: 1 },
  'detection.rearmMargin': { label: 'Re-arm margin', help: 'After firing, the score must drop this far below the threshold before it can fire again.', min: 0, max: 0.3, step: 0.01 },
  scores: { label: 'Score reading', help: 'Reads the point totals: live placement, game start/end, and who riichi\'d / won / paid.' },
  'scores.minConfidence': { label: 'Digit confidence', help: 'Lower reads more but risks misreads.', min: 0.3, max: 0.95, step: 0.01 },
  'scores.stableFrames': { label: 'Stable frames', help: 'A reading must repeat this many checks before it counts.', min: 1, max: 8, step: 1 },
  'scores.settleSeconds': { label: 'Settle time (s)', help: 'Score changes are grouped over this time before deciding what happened.', min: 0.5, max: 6, step: 0.5 },
  'scores.gameEndSeconds': { label: 'Game over after (s)', help: 'With no scores on screen for this long, the match counts as finished and your last place is reported.', min: 10, max: 300 },
  'scores.autoLearn': { label: 'Keep learning digits', help: 'Very clear readings are added as extra examples, so new sizes and skins get covered over time.' },
  'scores.zone': { label: 'High-resolution zoom area', help: 'Part of the screen read at full resolution (fractions of the game area). The default covers the centre panel.' },
  calibration: { label: 'Calibration', help: 'Where the built-in calibration comes from. Teaching anything yourself switches to "custom" and stops online updates.' },
  'calibration.autoUpdate': { label: 'Get calibration updates online' },
};

export interface Template {
  id: string; key: string; name: string; enabled: boolean;
  rect: Rect; tw: number; th: number; data: string; // base64 grayscale pixels
  threshold: number; cooldownSec: number; frameWidth: number;
}
interface Frame { bmp?: Buffer; gray: Gray; zoom?: Gray; zone?: Rect; ts: number }
interface Logged extends Detection { ts: number; frame: Frame | null; note?: string; via: 'banner' | 'scores' | 'test' }
type ScoreRow = Record<Seat, number | null>;
interface Meta { source: 'none' | 'builtin' | 'online' | 'custom'; version: number }
interface Pack { version?: number; packVersion?: number; templates?: Template[]; scores?: ScoreLayout }

export interface ReaderOptions {
  sharedDir: string;
  captureExe(): { exe: string; args: string[] };
  builtinPack(): string | null;      // JSON text of the bundled calibration pack
  onDetect(d: Detection): void;
  onState?(s: GameState): void;
}

const emptyRow = (): ScoreRow => ({ me: null, right: null, top: null, left: null });
const sameRow = (a: ScoreRow, b: ScoreRow) => SEATS.every((s) => a[s] === b[s]);

function merge<T>(base: T, over: unknown): T {
  if (Array.isArray(base)) return (Array.isArray(over) ? over : base) as T;
  if (base && typeof base === 'object') {
    const out: Record<string, unknown> = {};
    const o = (over && typeof over === 'object' ? over : {}) as Record<string, unknown>;
    for (const k of Object.keys(base)) out[k] = merge((base as Record<string, unknown>)[k], o[k]);
    return out as T;
  }
  return (over !== undefined && typeof over === typeof base ? over : base) as T;
}
const inside = (r: Rect, z: Rect) => r.x >= z.x - 1e-6 && r.y >= z.y - 1e-6 && r.x + r.w <= z.x + z.w + 1e-6 && r.y + r.h <= z.y + z.h + 1e-6;

export class ScreenReader {
  private cfg: ScreenConfig = structuredClone(SCREEN_DEFAULTS);
  private templates: Template[] = [];
  private layout: ScoreLayout = emptyLayout();
  private meta: Meta = { source: 'none', version: 0 };
  private mtimes: Record<string, number> = {};
  private glyphs: GlyphSet[] = [];
  private prepared = new Map<string, Prepared>();
  private source: Source | null = null;
  private sourceKey = '';
  status = 'starting';
  private latest: Frame | null = null;
  private ring: Frame[] = [];
  private frozen: Frame[] | null = null;
  private bookmarks: { ts: number; frames: Frame[] }[] = [];
  private scores = new Map<string, number>();
  private streak = new Map<string, number>();
  private latched = new Set<string>();
  private lastFired = new Map<string, number>();
  private lastEmit = new Map<string, number>();
  private frameTimes: number[] = [];
  private analysisMs = 0;
  private log: Logged[] = [];
  private lastReloadCheck = 0;
  private stopped = false;
  private updateNote = '';
  // score reading
  private rawRow: ScoreRow = emptyRow();
  private candidate = '';
  private candidateCount = 0;
  private stable: ScoreRow | null = null;     // latest stable reading
  private settled: ScoreRow | null = null;    // last reading we classified from
  private lastChange = 0;
  private lastScoresSeen = 0;
  private lastReinforce: Record<string, number> = {};
  state: GameState = { inGame: false, since: null, mode: null, scores: emptyRow(), place: null, lastResult: null, players: 0 };

  constructor(private o: ReaderOptions) {
    mkdirSync(o.sharedDir, { recursive: true });
    this.reload(true);
    if (this.meta.source === 'none' && !this.templates.length && !this.layout.regions.me) this.applyBuiltin('first run');
    void this.checkOnline();
  }

  // ---------------- shared files ----------------
  private p(name: string) { return resolve(this.o.sharedDir, name); }
  private readIfChanged<T>(name: string, force: boolean): T | undefined {
    const f = this.p(name);
    if (!existsSync(f)) return undefined;
    const m = statSync(f).mtimeMs;
    if (!force && m === this.mtimes[name]) return undefined;
    this.mtimes[name] = m;
    try { return JSON.parse(readFileSync(f, 'utf8')) as T; } catch { return undefined; }
  }
  private write(name: string, data: unknown) {
    writeFileSync(this.p(name), JSON.stringify(data, null, 2));
    this.mtimes[name] = statSync(this.p(name)).mtimeMs;
  }
  private reload(force = false) {
    const c = this.readIfChanged<unknown>('screen-settings.json', force); if (c) this.cfg = merge(SCREEN_DEFAULTS, c);
    const t = this.readIfChanged<Template[]>('templates.json', force); if (t) { this.templates = t; this.prepared.clear(); }
    const l = this.readIfChanged<ScoreLayout>('scores.json', force); if (l) { this.layout = { ...emptyLayout(), ...l }; this.glyphs = prepareGlyphs(this.layout); }
    const m = this.readIfChanged<Meta>('calibration.json', force); if (m) this.meta = m;
  }
  private saveTemplates() { this.write('templates.json', this.templates); }
  private saveLayout() { this.write('scores.json', this.layout); this.glyphs = prepareGlyphs(this.layout); }
  private markCustom() { if (this.meta.source !== 'custom') { this.meta = { source: 'custom', version: this.meta.version }; this.write('calibration.json', this.meta); } }
  get config() { return this.cfg; }
  saveConfig(next: unknown) { this.cfg = merge(SCREEN_DEFAULTS, next); this.write('screen-settings.json', this.cfg); this.syncSource(); return this.cfg; }

  // ---------------- calibration packs ----------------
  private validTemplate(t: any): t is Template {
    return t && typeof t.key === 'string' && KEYS.some((k) => k.key === t.key) && t.rect && [t.rect.x, t.rect.y, t.rect.w, t.rect.h].every((v) => typeof v === 'number' && v >= 0 && v <= 1)
      && Number.isInteger(t.tw) && Number.isInteger(t.th) && typeof t.data === 'string' && Buffer.from(t.data, 'base64').length === t.tw * t.th;
  }
  private applyPack(pack: Pack, source: Meta['source']): number {
    const tpls = (pack.templates ?? []).filter((t) => this.validTemplate(t));
    const sc = pack.scores && Array.isArray(pack.scores.glyphs) && pack.scores.glyphs.length ? pack.scores : null;
    if (!tpls.length && !sc) return 0; // empty pack: nothing to load
    this.templates = tpls.map((t) => ({ ...t, id: t.id || randomUUID() })); this.prepared.clear(); this.saveTemplates();
    this.layout = sc ? { regions: sc.regions ?? {}, glyphs: sc.glyphs.filter((g) => typeof g?.ch === 'string' && typeof g?.data === 'string') } : emptyLayout();
    this.saveLayout();
    this.meta = { source, version: Number(pack.packVersion) || 0 };
    this.write('calibration.json', this.meta);
    return tpls.length;
  }
  private applyBuiltin(why: string) {
    const text = this.o.builtinPack();
    if (!text) return false;
    try {
      const n = this.applyPack(JSON.parse(text), 'builtin');
      if (!n && !this.layout.glyphs.length) return false;
      console.log(`[screen] loaded the built-in calibration (${why}): ${n} templates, ${this.layout.glyphs.length} digit samples`);
      return true;
    } catch { return false; }
  }
  private async checkOnline(force = false) {
    const c = this.cfg.calibration;
    if ((!c.autoUpdate && !force) || (this.meta.source === 'custom' && !force) || !/^https:\/\//.test(c.url)) return;
    try {
      const r = await fetch(c.url, { signal: AbortSignal.timeout(8000), headers: { 'Cache-Control': 'no-cache' } });
      if (!r.ok) { this.updateNote = `no online calibration yet (${r.status})`; return; }
      const pack = (await r.json()) as Pack;
      const v = Number(pack.packVersion) || 0;
      if (!force && v <= this.meta.version && this.meta.source !== 'none') { this.updateNote = `up to date (v${this.meta.version})`; return; }
      const n = this.applyPack(pack, 'online');
      this.updateNote = n || this.layout.regions.me ? `updated to online calibration v${v}` : 'online calibration was empty';
      console.log('[screen]', this.updateNote);
    } catch (e) { this.updateNote = `couldn't check online: ${(e as Error).message}`; }
  }
  private exportPack(): Pack & Record<string, unknown> {
    return { app: 'mahjong-soul-screen-reader', version: 3, packVersion: Math.floor(Date.now() / 1000), exported: new Date().toISOString(), templates: this.templates, scores: this.layout };
  }

  start() { void this.loop(); }
  stop() { this.stopped = true; this.source?.close(); }

  // ---------------- detections ----------------
  private record(d: Detection, frame: Frame | null, via: Logged['via'], note?: string) {
    this.log.unshift({ ...d, ts: Date.now(), frame, note, via });
    this.log.length = Math.min(this.log.length, 30);
  }

  /** Sends an event to the app, skipping repeats of the same event within 10 s (e.g. banner + scores). */
  private emit(key: string, name: string, score: number | null, frame: Frame | null, via: Logged['via'], note?: string) {
    const now = Date.now();
    if (via !== 'test' && now - (this.lastEmit.get(key) ?? 0) < 10000) { this.record({ key, name, score, manual: false }, frame, via, 'skipped: already reported'); return; }
    this.lastEmit.set(key, now);
    const d: Detection = { key, name, score, manual: via === 'test' };
    this.record(d, frame, via, note);
    console.log(`[screen] ${keyLabel(key)} (${via}: ${name})${note ? ' ' + note : ''}`);
    this.applyToState(key, name);
    this.o.onDetect(d);
  }
  test(key: string) { this.emit(key, 'test button', null, this.latest, 'test'); }

  private pushState() { this.o.onState?.({ ...this.state, scores: { ...this.state.scores } }); }

  private applyToState(key: string, name: string) {
    const s = this.state, now = Date.now();
    if (key === 'game_mode') s.mode = name;
    const place = placeOf(key);
    if (place) { s.inGame = false; s.lastResult = place; s.since = null; s.place = place; this.settled = null; this.stable = null; }
    else if (key !== 'game_mode' && !s.inGame) { s.inGame = true; s.since = now; }
    this.pushState();
  }

  private endGame(why: string) {
    const place = this.state.place;
    if (place) this.emit(`game_end_${place}`, 'scores', null, this.latest, 'scores', why);
    else { Object.assign(this.state, { inGame: false, since: null }); this.pushState(); }
    this.settled = null; this.stable = null;
  }

  // ---------------- score reading ----------------
  private zone(): Rect {
    let z = { ...this.cfg.scores.zone };
    for (const r of Object.values(this.layout.regions)) {
      if (!r || inside(r, z)) continue;
      const x0 = Math.min(z.x, r.x - 0.01), y0 = Math.min(z.y, r.y - 0.01), x1 = Math.max(z.x + z.w, r.x + r.w + 0.01), y1 = Math.max(z.y + z.h, r.y + r.h + 0.01);
      z = { x: Math.max(0, x0), y: Math.max(0, y0), w: Math.min(1, x1) - Math.max(0, x0), h: Math.min(1, y1) - Math.max(0, y0) };
    }
    return z;
  }
  /** The best picture for a box: the high-resolution zoom when the box is inside it. */
  private imageFor(f: Frame, r: Rect): { img: Gray; rect: Rect } {
    if (f.zoom && f.zone && inside(r, f.zone)) return { img: f.zoom, rect: { x: (r.x - f.zone.x) / f.zone.w, y: (r.y - f.zone.y) / f.zone.h, w: r.w / f.zone.w, h: r.h / f.zone.h } };
    return { img: f.gray, rect: r };
  }

  private readScores(frame: Frame) {
    const sc = this.cfg.scores;
    if (!sc.enabled || !this.glyphs.length || !this.layout.regions.me) return;
    const now = Date.now();
    const row = emptyRow();
    const readings: Partial<Record<Seat, ReturnType<typeof readScore>>> = {};
    for (const seat of SEATS) {
      const r = this.layout.regions[seat]; if (!r) continue;
      const { img, rect } = this.imageFor(frame, r);
      readings[seat] = readScore(img, { ...rect, rot: r.rot ?? 0 }, this.glyphs, sc.minConfidence);
      row[seat] = readings[seat]?.value ?? null;
    }
    this.rawRow = row;
    const readable = SEATS.filter((s) => row[s] !== null).length;
    if (row.me !== null && readable >= 2) this.lastScoresSeen = now;

    const sig = JSON.stringify(row);
    if (sig === this.candidate) this.candidateCount++; else { this.candidate = sig; this.candidateCount = 1; }
    // Learn from readings that are both very clear and stable (at most once a minute per seat).
    if (sc.autoLearn && this.candidateCount === Math.max(2, sc.stableFrames) + 2) {
      let changed = false;
      for (const seat of SEATS) {
        const r = readings[seat];
        if (r && r.confidence > 0.9 && now - (this.lastReinforce[seat] ?? 0) > 60000) { this.lastReinforce[seat] = now; reinforce(this.layout, r); changed = true; }
      }
      if (changed) this.saveLayout();
    }
    if (this.candidateCount === Math.max(1, sc.stableFrames) && row.me !== null && readable >= 2) {
      const next = { ...(this.stable ?? emptyRow()) };
      for (const seat of SEATS) if (row[seat] !== null) next[seat] = row[seat];
      if (!this.stable || !sameRow(next, this.stable)) { this.stable = next; this.lastChange = now; this.onStable(now); }
    }
    // Group changes for a moment, then decide what happened.
    if (this.stable && this.settled && !sameRow(this.stable, this.settled) && now - this.lastChange >= sc.settleSeconds * 1000) {
      const before = this.settled; this.settled = { ...this.stable };
      const what = classifyChange(before, this.settled);
      if (what) for (const k of what.keys) this.emit(k, 'scores', null, frame, 'scores', `(${what.note})`);
      else this.record({ key: 'unknown', name: 'scores', score: null, manual: false }, frame, 'scores', `score change not recognised (${SEATS.filter((s) => before[s] !== this.settled![s]).map((s) => `${s} ${before[s]}→${this.settled![s]}`).join(', ')})`);
    }
    // No scores for a while: the match is over.
    if (this.state.inGame && this.lastScoresSeen && now - this.lastScoresSeen > sc.gameEndSeconds * 1000) this.endGame('(score panel gone)');
  }

  private onStable(now: number) {
    const s = this.state, row = this.stable!;
    if (looksLikeGameStart(row) && (!s.inGame || (this.settled && !looksLikeGameStart(this.settled)))) {
      if (s.inGame) this.endGame('(a new match started)');
      this.settled = { ...row };
      this.emit('game_start', 'scores', null, this.latest, 'scores', '(everyone on the starting score)');
    }
    if (!this.settled) this.settled = { ...row };
    s.scores = { ...row };
    s.players = SEATS.filter((x) => row[x] !== null).length;
    s.place = placement(row);
    if (!s.inGame) { s.inGame = true; s.since = now; }
    this.pushState();
  }

  // ---------------- capture loop ----------------
  private syncSource() {
    const c = this.cfg;
    const key = c.source === 'obs' ? `obs|${c.obs.url}|${c.obs.password}|${c.obs.sourceName}` : `win|${c.window.processName}|${c.window.keep16x9}`;
    if (key === this.sourceKey && this.source) return;
    this.source?.close();
    this.sourceKey = key;
    try {
      if (c.source === 'obs') this.source = new ObsCapture(c.obs.url, c.obs.password, c.obs.sourceName);
      else { const h = this.o.captureExe(); this.source = new WindowCapture(h.exe, [...h.args, '--process', c.window.processName, ...(c.window.keep16x9 ? [] : ['--no-aspect'])]); }
    } catch (e) { this.source = null; this.status = (e as Error).message; }
  }

  private detect(frame: Frame) {
    const c = this.cfg, d = c.detection;
    const started = performance.now(), now = Date.now();
    for (const t of this.templates) {
      if (!t.enabled) { this.scores.delete(t.id); continue; }
      const s = matchScore(frame.gray, t.rect, this.prep(t), d.searchMarginPct);
      this.scores.set(t.id, s);
      if (!c.enabled) continue;
      if (s >= t.threshold) {
        const n = (this.streak.get(t.id) ?? 0) + 1;
        this.streak.set(t.id, n);
        if (n >= Math.max(1, d.confirmFrames) && !this.latched.has(t.id)) {
          this.latched.add(t.id);
          const k = 'key:' + t.key + (t.key === 'game_mode' ? ':' + t.name : '');
          if (now - (this.lastFired.get(k) ?? 0) >= t.cooldownSec * 1000) {
            this.lastFired.set(k, now);
            if (t.key === 'game_mode') { if (this.state.mode !== t.name) this.emit(t.key, t.name, s, frame, 'banner'); }
            else this.emit(t.key, t.name, s, frame, 'banner');
          }
        }
      } else {
        this.streak.set(t.id, 0);
        if (s < t.threshold - d.rearmMargin) this.latched.delete(t.id);
      }
    }
    if (c.enabled) this.readScores(frame);
    this.analysisMs = this.analysisMs * 0.8 + (performance.now() - started) * 0.2;
  }
  private prep(t: Template) {
    let p = this.prepared.get(t.id);
    if (!p) { p = prepare(Buffer.from(t.data, 'base64'), t.tw, t.th); this.prepared.set(t.id, p); }
    return p;
  }

  private async loop() {
    if (this.stopped) return;
    const started = Date.now();
    if (started - this.lastReloadCheck > 2000) { this.lastReloadCheck = started; this.reload(); }
    const c = this.cfg;
    try {
      this.syncSource();
      if (this.source) {
        const zone = c.scores.enabled ? this.zone() : undefined;
        const g = await this.source.grab(c.analysisWidth, zone);
        const frame: Frame = { bmp: g.main, gray: decodeBmpGray(g.main), zoom: g.zoom, zone: g.zoom ? zone : undefined, ts: Date.now() };
        this.latest = frame;
        this.ring.push({ gray: frame.gray, zoom: frame.zoom, zone: frame.zone, ts: frame.ts }); // the buffer keeps grayscale only
        const max = Math.max(4, Math.round(c.bufferSeconds * c.fps));
        while (this.ring.length > max) this.ring.shift();
        this.frameTimes.push(Date.now()); this.frameTimes = this.frameTimes.filter((t) => Date.now() - t < 3000);
        this.status = `capturing ${frame.gray.w}×${frame.gray.h}${frame.zoom ? ` + ${frame.zoom.w}×${frame.zoom.h} zoom` : ''} from ${this.source.name}`;
        this.detect(frame);
      }
    } catch (e) {
      this.status = (e as Error).message;
      this.scores.clear();
    }
    const ok = this.status.startsWith('capturing');
    const delay = Math.max(20, 1000 / Math.max(1, c.fps) - (Date.now() - started));
    setTimeout(() => void this.loop(), ok ? delay : 1500);
  }

  /** Saves the last few seconds (F8 in the app window), to teach from later. */
  bookmark() {
    const n = Math.max(4, Math.round(5 * this.cfg.fps));
    if (!this.ring.length) return false;
    this.bookmarks.unshift({ ts: Date.now(), frames: this.ring.slice(-n) });
    this.bookmarks.length = Math.min(this.bookmarks.length, 12);
    console.log('[screen] bookmark saved');
    return true;
  }

  // ---------------- guidance ----------------
  private coverage() {
    const has = (k: string) => this.templates.some((t) => t.enabled && t.key === k);
    const seats = SEATS.filter((s) => this.layout.regions[s]);
    const digits = coverage(this.layout);
    const missingDigits = '0123456789'.split('').filter((d) => !digits.includes(d));
    return {
      seats, digits, missingDigits,
      keys: KEYS.map((k) => ({ key: k.key, label: k.label, auto: !!k.auto, template: has(k.key) })),
      ready: seats.includes('me') && seats.length >= 3 && missingDigits.length === 0,
    };
  }

  hint(): string | null {
    const s = this.status.toLowerCase();
    if (s.includes('minimized')) return 'The game is minimized. Restore it. It can sit behind other windows, just not minimized.';
    if (s.includes('not found')) return 'Start Mahjong Soul. If it is running, check "Game process name" in the screen reader settings (Steam: Jantama_MahjongSoul).';
    if (s.includes('obs')) return 'Check OBS is open, Tools → WebSocket Server Settings is enabled, and the password and source name match.';
    if (s.includes('helper')) return 'The capture helper could not start. Try restarting the app.';
    const cov = this.coverage();
    if (!s.startsWith('capturing')) return null;
    if (!cov.seats.includes('me')) return 'Next: teach the score boxes (tab 2b), starting with your own score. That alone gives placement, riichi, wins, deal-ins and game start/end.';
    if (cov.seats.length < 3) return `Next: teach the other players' score boxes (${SEATS.filter((x) => !cov.seats.includes(x)).join(', ')}).`;
    if (cov.missingDigits.length) return `Almost there: the reader hasn't seen these digits yet: ${cov.missingDigits.join(' ')}. Teach a score that contains them (any seat).`;
    return null;
  }

  summary() {
    const cov = this.coverage();
    const last = this.log.find((l) => l.key !== 'unknown' && !l.note?.startsWith('skipped'));
    return {
      status: this.status, capturing: this.status.startsWith('capturing'), detecting: this.cfg.enabled,
      templates: this.templates.filter((t) => t.enabled).length, scoresTaught: cov.ready, calibration: this.meta.source,
      lastDetection: last ? { key: last.key, label: keyLabel(last.key), name: last.name, ts: last.ts, via: last.via } : null,
      state: this.state, hint: this.hint(),
    };
  }

  private publicTemplate(t: Template) { return { ...t, data: undefined, score: this.scores.get(t.id) ?? null }; }
  private frames() { return this.frozen ?? this.ring; }
  private frameFor(b: any): Frame | null {
    if (b.snapshot !== undefined) return this.log[b.snapshot]?.frame ?? null;
    if (typeof b.frame === 'number') return this.frames()[b.frame] ?? null;
    return this.latest;
  }

  /** Handles /api/screen/* routes. Returns false if the path isn't ours. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!path.startsWith('/api/screen/')) return false;
    const p = path.slice('/api/screen'.length), M = req.method;
    const send = (code: number, body: unknown, type = 'application/json', extra: Record<string, string> = {}) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const body = async (): Promise<any> => {
      let data = '';
      for await (const chunk of req) { data += chunk; if (data.length > 30e6) throw new Error('too large'); }
      return data ? JSON.parse(data) : {};
    };
    const c = this.cfg;
    const frameBmp = (f: Frame) => f.bmp ?? encodeGrayBmp(f.gray);
    let m: RegExpExecArray | null;

    if (M === 'GET' && p === '/config') { send(200, { config: c, hints: SCREEN_HINTS, keys: KEYS }); return true; }
    if (M === 'POST' && p === '/config') { send(200, { ok: true, config: this.saveConfig(await body()) }); return true; }
    if (M === 'POST' && p === '/detection') { const b = await body(); this.saveConfig({ ...c, enabled: !!b.enabled }); send(200, { ok: true, enabled: this.cfg.enabled }); return true; }
    if (M === 'GET' && p === '/status') {
      send(200, {
        status: this.status, hint: this.hint(), fps: this.frameTimes.length / 3, analysisMs: this.analysisMs,
        detecting: c.enabled, bufferSeconds: c.bufferSeconds, frozen: !!this.frozen, frames: this.frames().length,
        zone: this.zone(), hasZoom: !!this.latest?.zoom,
        templates: this.templates.map((t) => this.publicTemplate(t)),
        detections: this.log.map(({ frame, ...d }, i) => ({ ...d, index: i, label: d.key === 'unknown' ? 'Unrecognised change' : keyLabel(d.key), hasFrame: !!frame })),
        bookmarks: this.bookmarks.map((b, i) => ({ index: i, ts: b.ts, frames: b.frames.length })),
        scores: { regions: this.layout.regions, learned: coverage(this.layout), samples: this.layout.glyphs.length, live: this.rawRow, stable: this.stable ?? emptyRow() },
        coverage: this.coverage(), calibration: { ...this.meta, note: this.updateNote, autoUpdate: c.calibration.autoUpdate },
        state: this.state,
      });
      return true;
    }
    if (M === 'GET' && p === '/frame/latest') { this.latest ? send(200, frameBmp(this.latest), 'image/bmp') : send(404, { error: this.status }); return true; }
    if (M === 'GET' && p === '/zoom/latest') { this.latest?.zoom ? send(200, encodeGrayBmp(this.latest.zoom), 'image/bmp') : send(404, { error: 'no zoom yet' }); return true; }
    if (M === 'GET' && (m = /^\/(frame|zoom)\/(\d+)$/.exec(p))) {
      const f = this.frames()[Number(m[2])];
      if (!f) { send(404, { error: 'no such frame' }); return true; }
      if (m[1] === 'zoom') { f.zoom ? send(200, encodeGrayBmp(f.zoom), 'image/bmp') : send(404, { error: 'no zoom for this frame' }); return true; }
      send(200, frameBmp(f), 'image/bmp'); return true;
    }
    if (M === 'GET' && (m = /^\/detection\/(\d+)$/.exec(p))) { const f = this.log[Number(m[1])]?.frame; f ? send(200, frameBmp(f), 'image/bmp') : send(404, { error: 'no snapshot' }); return true; }
    if (M === 'POST' && p === '/freeze') {
      const b = await body();
      if (typeof b.bookmark === 'number' && this.bookmarks[b.bookmark]) this.frozen = [...this.bookmarks[b.bookmark].frames];
      else this.frozen = b.frozen ? [...this.ring] : null;
      send(200, { ok: true, frames: this.frames().length }); return true;
    }
    if (M === 'POST' && p === '/bookmark') { send(200, { ok: this.bookmark() }); return true; }
    if (M === 'POST' && p === '/scan') {
      const list = this.frames();
      const result = this.templates.map((t) => {
        let best = -1, at = -1, worst = 2;
        list.forEach((f, i) => { const s = matchScore(f.gray, t.rect, this.prep(t), c.detection.searchMarginPct); if (s > best) { best = s; at = i; } if (s < worst) worst = s; });
        return { id: t.id, best, at, worst: list.length ? worst : null, wouldFire: best >= t.threshold };
      });
      send(200, { frames: list.length, result }); return true;
    }
    // ---- score boxes ----
    if (M === 'POST' && p === '/scores/teach') {
      const b = await body();
      const f = this.frameFor(b);
      if (!f) { send(400, { error: 'No picture yet.' }); return true; }
      if (!SEATS.includes(b.seat)) { send(400, { error: 'Pick whose score this is.' }); return true; }
      try {
        const { img, rect } = this.imageFor(f, b.rect);
        const { rot, learned } = learn(this.layout, img, rect, String(b.text ?? ''), b.seat);
        this.layout.regions[b.seat as Seat] = { ...b.rect, rot } as ScoreRegion;
        this.saveLayout(); this.markCustom();
        const check = readScore(img, { ...rect, rot }, this.glyphs, c.scores.minConfidence);
        send(200, { ok: true, learned, rot, chars: coverage(this.layout), check: check?.value ?? null });
      } catch (e) { send(400, { error: (e as Error).message }); }
      return true;
    }
    if (M === 'POST' && p === '/scores/region') {
      const b = await body();
      if (!SEATS.includes(b.seat)) { send(400, { error: 'bad seat' }); return true; }
      if (b.rect) this.layout.regions[b.seat as Seat] = { ...b.rect, rot: b.rot ?? this.layout.regions[b.seat as Seat]?.rot ?? 0 };
      else delete this.layout.regions[b.seat as Seat];
      this.saveLayout(); this.markCustom(); send(200, { ok: true }); return true;
    }
    if (M === 'POST' && p === '/scores/clear') { this.layout = emptyLayout(); this.saveLayout(); this.markCustom(); this.stable = this.settled = null; send(200, { ok: true }); return true; }
    // ---- calibration packs ----
    if (M === 'POST' && p === '/calibration/builtin') { const ok = this.applyBuiltin('restored'); send(ok ? 200 : 400, ok ? { ok, source: this.meta.source } : { error: 'This build has no built-in calibration.' }); return true; }
    if (M === 'POST' && p === '/calibration/online') { await this.checkOnline(true); send(200, { ok: true, note: this.updateNote, source: this.meta.source }); return true; }
    // ---- templates ----
    if (M === 'POST' && p === '/templates') {
      const b = await body();
      const f = this.frameFor(b);
      if (!f) { send(400, { error: 'No picture to cut from yet.' }); return true; }
      if (!KEYS.some((k) => k.key === b.key)) { send(400, { error: 'Pick an event.' }); return true; }
      const name = String(b.name ?? '').trim();
      if (b.key === 'game_mode' && !name) { send(400, { error: 'Type the mode name (e.g. "Gold Room · East") so chat and Discord can show it.' }); return true; }
      const crop = cropTemplate(f.gray, b.rect);
      const t: Template = {
        id: randomUUID(), key: b.key, name: name || keyLabel(b.key), enabled: true, rect: b.rect, tw: crop.w, th: crop.h,
        data: Buffer.from(crop.px).toString('base64'), threshold: c.detection.defaultThreshold, cooldownSec: c.detection.defaultCooldownSec, frameWidth: f.gray.w,
      };
      this.reload(); this.templates.push(t); this.saveTemplates(); this.markCustom();
      send(200, { ok: true, template: this.publicTemplate(t), selfScore: matchScore(f.gray, t.rect, this.prep(t), c.detection.searchMarginPct) });
      return true;
    }
    if (M === 'GET' && p === '/templates/export') {
      send(200, JSON.stringify(this.exportPack(), null, 2), 'application/json', { 'Content-Disposition': 'attachment; filename="mahjong-soul-calibration.json"' });
      return true;
    }
    if (M === 'POST' && p === '/templates/import') {
      const b = await body();
      const src: Pack = b.data ?? b;
      if (b.mode === 'replace') {
        const n = this.applyPack(src, 'custom');
        if (!n && !this.layout.regions.me) { send(400, { error: 'No valid calibration in that file.' }); return true; }
        send(200, { ok: true, added: n, scores: !!src.scores }); return true;
      }
      const good = (src.templates ?? []).filter((t) => this.validTemplate(t));
      if (!good.length && !src.scores) { send(400, { error: 'No valid templates in that file.' }); return true; }
      this.reload();
      for (const t of good) this.templates.push({ ...t, id: randomUUID() });
      this.saveTemplates();
      if (src.scores?.glyphs?.length) { this.layout = { regions: { ...src.scores.regions, ...this.layout.regions }, glyphs: [...this.layout.glyphs, ...src.scores.glyphs] }; this.saveLayout(); }
      this.markCustom();
      send(200, { ok: true, added: good.length, scores: !!src.scores }); return true;
    }
    if ((m = /^\/templates\/([\w-]+)(\.bmp|\/fire)?$/.exec(p))) {
      const t = this.templates.find((x) => x.id === m![1]);
      if (!t) { send(404, { error: 'template not found' }); return true; }
      if (M === 'GET' && m[2] === '.bmp') { send(200, encodeGrayBmp({ w: t.tw, h: t.th, px: Buffer.from(t.data, 'base64') }), 'image/bmp'); return true; }
      if (M === 'POST' && m[2] === '/fire') { this.test(t.key); send(200, { ok: true }); return true; }
      if (M === 'POST' && !m[2]) {
        const b = await body();
        if (typeof b.threshold === 'number') t.threshold = Math.min(0.999, Math.max(0.3, b.threshold));
        if (typeof b.cooldownSec === 'number') t.cooldownSec = Math.max(0, b.cooldownSec);
        if (typeof b.enabled === 'boolean') t.enabled = b.enabled;
        if (typeof b.name === 'string') t.name = b.name;
        if (typeof b.key === 'string' && KEYS.some((k) => k.key === b.key)) t.key = b.key;
        this.saveTemplates(); this.markCustom();
        send(200, { ok: true, template: this.publicTemplate(t) }); return true;
      }
      if (M === 'DELETE' && !m[2]) { this.templates = this.templates.filter((x) => x !== t); this.prepared.delete(t.id); this.saveTemplates(); this.markCustom(); send(200, { ok: true }); return true; }
    }
    if (M === 'POST' && p === '/fire') { const b = await body(); this.test(String(b.key)); send(200, { ok: true }); return true; }
    if (M === 'GET' && p === '/obs/sources') {
      const obs = new ObsCapture(c.obs.url, c.obs.password, '');
      try { send(200, { sources: await obs.listSources() }); } catch (e) { send(500, { error: (e as Error).message }); } finally { obs.close(); }
      return true;
    }
    send(404, { error: 'not found' });
    return true;
  }
}

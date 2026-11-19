// Read-only screen reader: watches the game picture, matches taught banner templates, reads the
// point totals, and reports detections + live game state (in game, time, mode, scores, placement).
// Shared by the Twitch and Lovense apps (identical file in both repos). Templates and score layout
// live in one shared folder, so you only teach once even when both apps run.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ObsCapture, WindowCapture, type Source } from './capture.js';
import { GENERIC_KEYS, KEYS, keyLabel, placeOf, type Detection, type GameState } from './keys.js';
import { cropTemplate, decodeBmpGray, encodeGrayBmp, matchScore, prepare, type Gray, type Prepared } from './image.js';
import { SEATS, coverage, emptyLayout, learn, placement, prepareGlyphs, readScore, type Prepared as GlyphSet, type ScoreLayout, type Seat } from './scores.js';

export const SCREEN_DEFAULTS = {
  enabled: true,
  source: 'window' as 'window' | 'obs',
  window: { processName: 'Jantama_MahjongSoul' },
  obs: { url: 'ws://127.0.0.1:4455', password: '', sourceName: '' },
  fps: 4,
  analysisWidth: 960,
  bufferSeconds: 20,
  detection: { searchMarginPct: 8, defaultThreshold: 0.8, defaultCooldownSec: 6, confirmFrames: 1, rearmMargin: 0.05 },
  scores: { enabled: true, minConfidence: 0.6, stableFrames: 2, resolveSeconds: 20, gameTimeoutSec: 45 },
};
export type ScreenConfig = typeof SCREEN_DEFAULTS;

export const SCREEN_HINTS: Record<string, unknown> = {
  enabled: { label: 'Detection on', help: 'Off = no events are sent. The picture keeps updating.' },
  source: { label: 'Picture source', options: [{ value: 'window', label: 'Game window (screen-share style, works when tabbed out)' }, { value: 'obs', label: 'OBS source' }] },
  'window.processName': { label: 'Game process name', help: 'Steam client: Jantama_MahjongSoul' },
  obs: { label: 'OBS', help: 'OBS → Tools → WebSocket Server Settings: enable it and copy the password.' },
  'obs.password': { secret: true },
  'obs.sourceName': { label: 'Source name', help: 'The OBS source that shows the game (exact name). "List OBS sources" shows the names.' },
  fps: { label: 'Checks per second', min: 1, max: 15, step: 1 },
  analysisWidth: { label: 'Analysis width (px)', help: 'Frames are resized to this width. Higher reads small score digits better. Changing it means re-teaching.', min: 480, max: 1920, step: 10 },
  bufferSeconds: { label: 'Freeze buffer (seconds)', help: 'How far back "Freeze" can go.', min: 5, max: 60, step: 1 },
  'detection.searchMarginPct': { label: 'Position tolerance (%)', help: 'How far a banner may move from where you taught it.', min: 0, max: 30, step: 1 },
  'detection.defaultThreshold': { label: 'Default match threshold', min: 0.5, max: 0.99, step: 0.01 },
  'detection.defaultCooldownSec': { label: 'Default cooldown (s)', min: 1, max: 60 },
  'detection.confirmFrames': { label: 'Frames to confirm', help: 'A banner must match this many checks in a row before it fires. 2 cuts false alarms; 1 reacts fastest.', min: 1, max: 5, step: 1 },
  'detection.rearmMargin': { label: 'Re-arm margin', help: 'After firing, the score must drop this far below the threshold before it can fire again.', min: 0, max: 0.3, step: 0.01 },
  scores: { label: 'Score reading', help: 'Reads the point totals to work out your live placement and who riichi\'d / won / paid.' },
  'scores.minConfidence': { label: 'Digit confidence', help: 'Lower reads more but risks misreads.', min: 0.3, max: 0.95, step: 0.01 },
  'scores.stableFrames': { label: 'Stable frames', help: 'A new reading must repeat this many checks before it counts.', min: 1, max: 6, step: 1 },
  'scores.resolveSeconds': { label: 'Who-did-it window (s)', help: 'How long to wait for scores to change after a generic RON/TSUMO/RIICHI banner.', min: 5, max: 60 },
  'scores.gameTimeoutSec': { label: 'Leave game after (s)', help: 'If no scores are visible for this long, you count as out of the game.', min: 10, max: 300 },
};

export interface Template {
  id: string; key: string; name: string; enabled: boolean;
  rect: { x: number; y: number; w: number; h: number };
  tw: number; th: number; data: string; // base64 grayscale pixels
  threshold: number; cooldownSec: number; frameWidth: number;
}
interface Frame { bmp?: Buffer; gray: Gray; ts: number }
interface Logged extends Detection { ts: number; frame: Frame | null; note?: string }
type ScoreRow = Record<Seat, number | null>;
interface Pending { kind: string; name: string; score: number | null; frame: Frame | null; at: number; baseline: ScoreRow }

export interface ReaderOptions {
  getConfig(): ScreenConfig;
  saveConfig(c: ScreenConfig): ScreenConfig;
  sharedDir: string;
  captureExe(): { exe: string; args: string[] };
  onDetect(d: Detection): void;
  onState?(s: GameState): void;
}

const emptyRow = (): ScoreRow => ({ me: null, right: null, top: null, left: null });

export class ScreenReader {
  private templates: Template[] = [];
  private templatesMtime = 0;
  private layout: ScoreLayout = emptyLayout();
  private layoutMtime = 0;
  private glyphs: GlyphSet[] = [];
  private prepared = new Map<string, Prepared>();
  private source: Source | null = null;
  private sourceKey = '';
  status = 'starting';
  private latest: Frame | null = null;
  private ring: Frame[] = [];
  private frozen: Frame[] | null = null;
  private scores = new Map<string, number>();
  private streak = new Map<string, number>();
  private latched = new Set<string>();
  private lastFired = new Map<string, number>();
  private frameTimes: number[] = [];
  private analysisMs = 0;
  private log: Logged[] = [];
  private lastReloadCheck = 0;
  private stopped = false;
  // score reading / game state
  private rawRow: ScoreRow = emptyRow();
  private candidate = '';
  private candidateCount = 0;
  private stable: ScoreRow = emptyRow();
  private lastScoresSeen = 0;
  private pending: Pending[] = [];
  state: GameState = { inGame: false, since: null, mode: null, scores: emptyRow(), place: null, lastResult: null };

  constructor(private o: ReaderOptions) {
    mkdirSync(o.sharedDir, { recursive: true });
    this.reload(true);
  }

  private get tplPath() { return resolve(this.o.sharedDir, 'templates.json'); }
  private get layoutPath() { return resolve(this.o.sharedDir, 'scores.json'); }
  private get cfg() { return this.o.getConfig(); }

  private reload(force = false) {
    try {
      if (existsSync(this.tplPath)) {
        const m = statSync(this.tplPath).mtimeMs;
        if (force || m !== this.templatesMtime) { this.templatesMtime = m; this.templates = JSON.parse(readFileSync(this.tplPath, 'utf8')); this.prepared.clear(); }
      } else this.templates = [];
      if (existsSync(this.layoutPath)) {
        const m = statSync(this.layoutPath).mtimeMs;
        if (force || m !== this.layoutMtime) { this.layoutMtime = m; this.layout = { ...emptyLayout(), ...JSON.parse(readFileSync(this.layoutPath, 'utf8')) }; this.glyphs = prepareGlyphs(this.layout); }
      }
    } catch { /* keep current */ }
  }
  private saveTemplates() { writeFileSync(this.tplPath, JSON.stringify(this.templates, null, 2)); this.templatesMtime = statSync(this.tplPath).mtimeMs; }
  private saveLayout() { writeFileSync(this.layoutPath, JSON.stringify(this.layout, null, 2)); this.layoutMtime = statSync(this.layoutPath).mtimeMs; this.glyphs = prepareGlyphs(this.layout); }
  private prep(t: Template) {
    let p = this.prepared.get(t.id);
    if (!p) { p = prepare(Buffer.from(t.data, 'base64'), t.tw, t.th); this.prepared.set(t.id, p); }
    return p;
  }

  start() { void this.loop(); }
  stop() { this.stopped = true; this.source?.close(); }

  // ---------------- detections ----------------
  private record(d: Detection, frame: Frame | null, note?: string) {
    this.log.unshift({ ...d, ts: Date.now(), frame, note });
    this.log.length = Math.min(this.log.length, 25);
  }

  private emit(key: string, name: string, score: number | null, frame: Frame | null, manual = false, note?: string) {
    const d: Detection = { key, name, score, manual };
    this.record(d, frame, note);
    console.log(`[screen] ${keyLabel(key)} (${name})${score !== null ? ' score ' + score.toFixed(2) : manual ? ' (test)' : ''}${note ? ' ' + note : ''}`);
    this.applyToState(key, name);
    this.o.onDetect(d);
  }

  /** A template fired (or a test button). Generic keys wait for the scores to say who it was. */
  private fire(key: string, name: string, score: number | null, frame: Frame | null, manual = false) {
    if (GENERIC_KEYS.includes(key)) {
      if (manual) { this.record({ key, name, score, manual }, frame, 'test: needs a real score change to resolve'); return; }
      this.pending.push({ kind: key, name, score, frame, at: Date.now(), baseline: { ...this.stable } });
      this.record({ key, name, score, manual }, frame, 'waiting for scores…');
      return;
    }
    this.emit(key, name, score, frame, manual);
  }
  test(key: string) { this.fire(key, 'test button', null, this.latest, true); }

  private applyToState(key: string, name: string) {
    const s = this.state, now = Date.now();
    if (key === 'game_mode') s.mode = name;
    if (key === 'game_start' || (!s.inGame && key !== 'game_mode' && !placeOf(key))) { if (!s.inGame) { s.inGame = true; s.since = now; } }
    const place = placeOf(key);
    if (place) { s.inGame = false; s.lastResult = place; s.since = null; s.place = place; }
    this.o.onState?.({ ...s, scores: { ...s.scores } });
  }

  private resolvePending(now: number) {
    const keep: Pending[] = [];
    for (const p of this.pending) {
      const d: Partial<Record<Seat, number>> = {};
      let any = false;
      for (const seat of SEATS) {
        const a = p.baseline[seat], b = this.stable[seat];
        if (a !== null && b !== null && a !== b) { d[seat] = b - a; any = true; }
      }
      let resolved: string | null = null, note = '';
      if (any && p.kind === 'any_riichi') {
        const who = SEATS.find((s) => d[s] === -1000);
        if (who) { resolved = who === 'me' ? 'my_riichi' : 'opponent_riichi'; note = `(${who} paid the 1,000 stick)`; }
      } else if (any && (p.kind === 'any_ron' || p.kind === 'any_tsumo')) {
        const entries = Object.entries(d) as [Seat, number][];
        const winner = entries.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
        if (winner && (d[winner] ?? 0) >= 1000) {
          if (p.kind === 'any_tsumo') resolved = winner === 'me' ? 'my_win_tsumo' : 'opponent_tsumo';
          else {
            const payer = entries.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1])[0]?.[0];
            resolved = winner === 'me' ? 'my_win_ron' : payer === 'me' ? 'dealt_in' : 'opponent_ron_other';
          }
          note = `(scores: ${entries.map(([s, v]) => `${s} ${v > 0 ? '+' : ''}${v}`).join(', ')})`;
        }
      }
      if (resolved) this.emit(resolved, p.name, p.score, p.frame, false, note);
      else if (now - p.at > this.cfg.scores.resolveSeconds * 1000) this.record({ key: p.kind, name: p.name, score: p.score, manual: false }, p.frame, 'gave up: scores did not show who');
      else keep.push(p);
    }
    this.pending = keep;
  }

  private readScores(frame: Frame) {
    const sc = this.cfg.scores;
    if (!sc.enabled || !this.glyphs.length || !this.layout.regions.me) return;
    const row = emptyRow();
    for (const seat of SEATS) { const r = this.layout.regions[seat]; if (r) row[seat] = readScore(frame.gray, r, this.glyphs, sc.minConfidence); }
    this.rawRow = row;
    const readable = SEATS.filter((s) => row[s] !== null).length;
    const now = Date.now();
    if (row.me !== null && readable >= 2) this.lastScoresSeen = now;
    const sig = JSON.stringify(row);
    if (sig === this.candidate) this.candidateCount++; else { this.candidate = sig; this.candidateCount = 1; }
    if (this.candidateCount === Math.max(1, sc.stableFrames) && row.me !== null && readable >= 2) {
      const prev = JSON.stringify(this.stable);
      for (const seat of SEATS) if (row[seat] !== null) this.stable[seat] = row[seat];
      if (JSON.stringify(this.stable) !== prev) {
        const s = this.state;
        s.scores = { ...this.stable };
        s.place = placement(this.stable);
        if (!s.inGame) { s.inGame = true; s.since = now; }
        this.o.onState?.({ ...s, scores: { ...s.scores } });
      }
    }
    if (this.pending.length) this.resolvePending(now);
    // No scores for a while → out of the game.
    if (this.state.inGame && this.lastScoresSeen && now - this.lastScoresSeen > sc.gameTimeoutSec * 1000) {
      Object.assign(this.state, { inGame: false, since: null });
      this.stable = emptyRow();
      this.o.onState?.({ ...this.state, scores: { ...this.state.scores } });
    }
  }

  // ---------------- capture loop ----------------
  private syncSource() {
    const c = this.cfg;
    const key = c.source === 'obs' ? `obs|${c.obs.url}|${c.obs.password}|${c.obs.sourceName}` : `win|${c.window.processName}`;
    if (key === this.sourceKey && this.source) return;
    this.source?.close();
    this.sourceKey = key;
    try {
      if (c.source === 'obs') this.source = new ObsCapture(c.obs.url, c.obs.password, c.obs.sourceName);
      else { const h = this.o.captureExe(); this.source = new WindowCapture(h.exe, [...h.args, '--process', c.window.processName]); }
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
          const k = 'key:' + t.key + (t.key === 'game_mode' ? ':' + t.name : ''); // shared cooldown per event
          if (now - (this.lastFired.get(k) ?? 0) >= t.cooldownSec * 1000) { this.lastFired.set(k, now); this.fire(t.key, t.name, s, frame); }
        }
      } else {
        this.streak.set(t.id, 0);
        if (s < t.threshold - d.rearmMargin) this.latched.delete(t.id);
      }
    }
    if (c.enabled) this.readScores(frame);
    this.analysisMs = this.analysisMs * 0.8 + (performance.now() - started) * 0.2;
  }

  private async loop() {
    if (this.stopped) return;
    const started = Date.now();
    const c = this.cfg;
    if (started - this.lastReloadCheck > 2000) { this.lastReloadCheck = started; this.reload(); }
    try {
      this.syncSource();
      if (this.source) {
        const bmp = await this.source.grab(c.analysisWidth);
        const frame: Frame = { bmp, gray: decodeBmpGray(bmp), ts: Date.now() };
        this.latest = frame;
        this.ring.push({ gray: frame.gray, ts: frame.ts }); // buffer keeps grayscale only, to save memory
        const max = Math.max(4, Math.round(c.bufferSeconds * c.fps));
        while (this.ring.length > max) this.ring.shift();
        this.frameTimes.push(Date.now()); this.frameTimes = this.frameTimes.filter((t) => Date.now() - t < 3000);
        this.status = `capturing ${frame.gray.w}×${frame.gray.h} from ${this.source.name}`;
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

  hint(): string | null {
    const s = this.status.toLowerCase();
    if (s.includes('minimized')) return 'The game is minimized. Restore it. It can sit behind other windows, just not minimized.';
    if (s.includes('not found')) return 'Start Mahjong Soul. If it is running, check "Game process name" in settings (Steam: Jantama_MahjongSoul).';
    if (s.includes('obs')) return 'Check OBS is open, Tools → WebSocket Server Settings is enabled, and the password and source name match.';
    if (s.includes('helper')) return 'The capture helper could not start. Try restarting the app.';
    if (this.templates.length === 0 && s.startsWith('capturing')) return 'Picture is working. Next: catch a banner and save your first template.';
    if (this.templates.some((t) => t.frameWidth !== this.cfg.analysisWidth)) return 'Some templates were taught at a different analysis width. Re-teach them or change the width back.';
    if (this.templates.some((t) => GENERIC_KEYS.includes(t.key)) && !this.layout.regions.me) return 'You have "anyone" banner templates: teach the score boxes too, so the reader can tell who it was.';
    return null;
  }

  summary() {
    const active = this.templates.filter((t) => t.enabled).length;
    const last = this.log.find((l) => !GENERIC_KEYS.includes(l.key));
    return {
      status: this.status, capturing: this.status.startsWith('capturing'), detecting: this.cfg.enabled, templates: active,
      scoresTaught: !!this.layout.regions.me && this.glyphs.length > 0,
      lastDetection: last ? { key: last.key, label: keyLabel(last.key), name: last.name, ts: last.ts } : null,
      state: this.state, hint: this.hint(),
    };
  }

  private validTemplate(t: any): t is Template {
    return t && typeof t.key === 'string' && KEYS.some((k) => k.key === t.key) && t.rect && [t.rect.x, t.rect.y, t.rect.w, t.rect.h].every((v) => typeof v === 'number' && v >= 0 && v <= 1)
      && Number.isInteger(t.tw) && Number.isInteger(t.th) && typeof t.data === 'string' && Buffer.from(t.data, 'base64').length === t.tw * t.th;
  }
  private publicTemplate(t: Template) { return { ...t, data: undefined, score: this.scores.get(t.id) ?? null, mismatchedWidth: t.frameWidth !== this.cfg.analysisWidth }; }
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
      for await (const chunk of req) { data += chunk; if (data.length > 20e6) throw new Error('too large'); }
      return data ? JSON.parse(data) : {};
    };
    const c = this.cfg;
    const frameBmp = (f: Frame) => f.bmp ?? encodeGrayBmp(f.gray);
    let m: RegExpExecArray | null;

    if (M === 'GET' && p === '/config') { send(200, { config: c, hints: SCREEN_HINTS, keys: KEYS }); return true; }
    if (M === 'POST' && p === '/config') {
      const prevWidth = c.analysisWidth;
      const next = this.o.saveConfig(await body());
      this.syncSource();
      if (prevWidth !== next.analysisWidth) { this.ring = []; this.frozen = null; }
      send(200, { ok: true, config: next }); return true;
    }
    if (M === 'POST' && p === '/detection') { const b = await body(); const next = this.o.saveConfig({ ...c, enabled: !!b.enabled }); send(200, { ok: true, enabled: next.enabled }); return true; }
    if (M === 'GET' && p === '/status') {
      send(200, {
        status: this.status, hint: this.hint(), fps: this.frameTimes.length / 3, analysisMs: this.analysisMs,
        detecting: c.enabled, bufferSeconds: c.bufferSeconds, frozen: !!this.frozen, frames: this.frames().length,
        templates: this.templates.map((t) => this.publicTemplate(t)),
        detections: this.log.map(({ frame, ...d }, i) => ({ ...d, index: i, label: keyLabel(d.key), hasFrame: !!frame })),
        scores: { regions: this.layout.regions, learned: coverage(this.layout), samples: this.layout.glyphs.length, live: this.rawRow, stable: this.stable },
        state: this.state, pending: this.pending.length,
      });
      return true;
    }
    if (M === 'GET' && p === '/frame/latest') { this.latest ? send(200, frameBmp(this.latest), 'image/bmp') : send(404, { error: this.status }); return true; }
    if (M === 'GET' && (m = /^\/frame\/(\d+)$/.exec(p))) { const f = this.frames()[Number(m[1])]; f ? send(200, frameBmp(f), 'image/bmp') : send(404, { error: 'no such frame' }); return true; }
    if (M === 'GET' && (m = /^\/detection\/(\d+)$/.exec(p))) { const f = this.log[Number(m[1])]?.frame; f ? send(200, frameBmp(f), 'image/bmp') : send(404, { error: 'no snapshot' }); return true; }
    if (M === 'POST' && p === '/freeze') { const b = await body(); this.frozen = b.frozen ? [...this.ring] : null; send(200, { ok: true, frames: this.frames().length }); return true; }
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
        const n = learn(this.layout, f.gray, b.rect, String(b.text ?? ''));
        this.layout.regions[b.seat as Seat] = b.rect;
        this.saveLayout();
        send(200, { ok: true, learned: n, chars: coverage(this.layout), check: readScore(f.gray, b.rect, this.glyphs, c.scores.minConfidence) });
      } catch (e) { send(400, { error: (e as Error).message }); }
      return true;
    }
    if (M === 'POST' && p === '/scores/region') {
      const b = await body();
      if (!SEATS.includes(b.seat)) { send(400, { error: 'bad seat' }); return true; }
      if (b.rect) this.layout.regions[b.seat as Seat] = b.rect; else delete this.layout.regions[b.seat as Seat];
      this.saveLayout(); send(200, { ok: true }); return true;
    }
    if (M === 'POST' && p === '/scores/clear') { this.layout = emptyLayout(); this.saveLayout(); this.stable = emptyRow(); send(200, { ok: true }); return true; }
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
      this.reload(); this.templates.push(t); this.saveTemplates();
      send(200, { ok: true, template: this.publicTemplate(t), selfScore: matchScore(f.gray, t.rect, this.prep(t), c.detection.searchMarginPct) });
      return true;
    }
    if (M === 'GET' && p === '/templates/export') {
      const data = { app: 'mahjong-soul-screen-reader', version: 2, analysisWidth: c.analysisWidth, exported: new Date().toISOString(), templates: this.templates, scores: this.layout };
      send(200, JSON.stringify(data, null, 2), 'application/json', { 'Content-Disposition': 'attachment; filename="mahjong-soul-templates.json"' });
      return true;
    }
    if (M === 'POST' && p === '/templates/import') {
      const b = await body();
      const src = b.data ?? b;
      const incoming = Array.isArray(src.templates) ? src.templates : [];
      const good = incoming.filter((t: unknown) => this.validTemplate(t)) as Template[];
      const hasScores = src.scores && Array.isArray(src.scores.glyphs) && src.scores.regions;
      if (!good.length && !hasScores) { send(400, { error: 'No valid templates in that file.' }); return true; }
      this.reload();
      if (b.mode === 'replace') { this.templates = []; this.prepared.clear(); }
      for (const t of good) this.templates.push({ ...t, id: randomUUID(), enabled: t.enabled !== false, threshold: Number(t.threshold) || c.detection.defaultThreshold, cooldownSec: Number(t.cooldownSec) || c.detection.defaultCooldownSec, frameWidth: Number(t.frameWidth) || c.analysisWidth });
      this.saveTemplates();
      if (hasScores && (b.mode === 'replace' || !this.layout.regions.me)) { this.layout = { regions: src.scores.regions, glyphs: src.scores.glyphs.filter((g: any) => typeof g?.ch === 'string' && typeof g?.data === 'string') }; this.saveLayout(); }
      send(200, { ok: true, added: good.length, skipped: incoming.length - good.length, scores: !!hasScores }); return true;
    }
    if ((m = /^\/templates\/([\w-]+)(\.bmp|\/fire)?$/.exec(p))) {
      const t = this.templates.find((x) => x.id === m![1]);
      if (!t) { send(404, { error: 'template not found' }); return true; }
      if (M === 'GET' && m[2] === '.bmp') { send(200, encodeGrayBmp({ w: t.tw, h: t.th, px: Buffer.from(t.data, 'base64') }), 'image/bmp'); return true; }
      if (M === 'POST' && m[2] === '/fire') { this.fire(t.key, t.name, null, this.latest, true); send(200, { ok: true }); return true; }
      if (M === 'POST' && !m[2]) {
        const b = await body();
        if (typeof b.threshold === 'number') t.threshold = Math.min(0.999, Math.max(0.3, b.threshold));
        if (typeof b.cooldownSec === 'number') t.cooldownSec = Math.max(0, b.cooldownSec);
        if (typeof b.enabled === 'boolean') t.enabled = b.enabled;
        if (typeof b.name === 'string') t.name = b.name;
        if (typeof b.key === 'string' && KEYS.some((k) => k.key === b.key)) t.key = b.key;
        this.saveTemplates();
        send(200, { ok: true, template: this.publicTemplate(t) }); return true;
      }
      if (M === 'DELETE' && !m[2]) { this.templates = this.templates.filter((x) => x !== t); this.prepared.delete(t.id); this.saveTemplates(); send(200, { ok: true }); return true; }
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

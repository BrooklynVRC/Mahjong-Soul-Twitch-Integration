import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DATA_DIR, HINTS, loadConfig, loadTemplates, saveConfig, saveTemplates, type Config, type Template } from './config.js';
import { ObsCapture, WindowCapture, type Source } from './capture.js';
import { KEYS, toGameEvent } from './events.js';
import { cropTemplate, decodeBmpGray, encodeGrayBmp, matchScore, prepare, type Gray, type Prepared } from './image.js';
import { VERSION, helperPath, openBrowser, pauseIfPackaged, readAsset } from './runtime.js';

let config: Config = loadConfig();
let templates: Template[] = loadTemplates();
const prepared = new Map<string, Prepared>();
const prep = (t: Template) => {
  let p = prepared.get(t.id);
  if (!p) { p = prepare(Buffer.from(t.data, 'base64'), t.tw, t.th); prepared.set(t.id, p); }
  return p;
};
const keyLabel = (k: string) => KEYS.find((x) => x.key === k)?.label ?? k;

// ---------------- Event targets (Twitch app / Lovense app) ----------------
class Target {
  ws: WebSocket | null = null; timer: NodeJS.Timeout | null = null; closed = false;
  constructor(public url: string) { this.open(); }
  open() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    ws.on('open', () => { this.ws = ws; });
    ws.on('error', () => { /* close follows */ });
    ws.on('close', () => { if (this.ws === ws) this.ws = null; if (!this.closed) this.timer = setTimeout(() => this.open(), 5000); });
  }
  send(text: string) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text); }
  close() { this.closed = true; if (this.timer) clearTimeout(this.timer); this.ws?.close(); }
}
let targets: Target[] = [];
function syncTargets() {
  const want = config.targets.filter(Boolean);
  if (want.join('|') === targets.map((t) => t.url).join('|')) return;
  targets.forEach((t) => t.close());
  targets = want.map((u) => new Target(u));
}

interface Frame { bmp: Buffer; gray: Gray; ts: number }
interface Detection { ts: number; key: string; name: string; score: number | null; manual: boolean; frame: Frame | null }
const detections: Detection[] = [];

function fire(key: string, name: string, score: number | null, frame: Frame | null, manual = false) {
  const ev = toGameEvent(key);
  if (!ev) return;
  const text = JSON.stringify(ev);
  targets.forEach((t) => t.send(text));
  detections.unshift({ ts: Date.now(), key, name, score, manual, frame });
  detections.length = Math.min(detections.length, 25);
  console.log(`[detect] ${keyLabel(key)} (${name})${score !== null ? ' score ' + score.toFixed(2) : ' (test)'}`);
}

// ---------------- Capture + detection loop ----------------
let source: Source | null = null;
let sourceKey = '';
let status = 'starting';
let latest: Frame | null = null;
let ring: Frame[] = [];
let frozen: Frame[] | null = null;
const scores = new Map<string, number>();
const streak = new Map<string, number>();
const latched = new Set<string>(); // fired; waiting for the score to drop before it can fire again
const lastFired = new Map<string, number>();
let frameTimes: number[] = [];
let analysisMs = 0;

function syncSource() {
  const key = config.source === 'obs' ? `obs|${config.obs.url}|${config.obs.password}|${config.obs.sourceName}` : `win|${config.window.processName}`;
  if (key === sourceKey && source) return;
  source?.close();
  sourceKey = key;
  try {
    source = config.source === 'obs'
      ? new ObsCapture(config.obs.url, config.obs.password, config.obs.sourceName)
      : new WindowCapture(helperPath(DATA_DIR), config.window.processName);
  } catch (e) { source = null; status = (e as Error).message; }
}

function detect(frame: Frame) {
  const d = config.detection;
  const started = performance.now();
  const now = Date.now();
  for (const t of templates) {
    if (!t.enabled) { scores.delete(t.id); continue; }
    const s = matchScore(frame.gray, t.rect, prep(t), d.searchMarginPct);
    scores.set(t.id, s);
    if (!d.enabled) continue;
    if (s >= t.threshold) {
      const n = (streak.get(t.id) ?? 0) + 1;
      streak.set(t.id, n);
      if (n >= Math.max(1, d.confirmFrames) && !latched.has(t.id)) {
        latched.add(t.id);
        const k = 'key:' + t.key; // cooldown is shared by every template of the same event
        if (now - (lastFired.get(k) ?? 0) >= t.cooldownSec * 1000) { lastFired.set(k, now); fire(t.key, t.name, s, frame); }
      }
    } else {
      streak.set(t.id, 0);
      if (s < t.threshold - d.rearmMargin) latched.delete(t.id);
    }
  }
  analysisMs = analysisMs * 0.8 + (performance.now() - started) * 0.2;
}

async function loop() {
  const started = Date.now();
  try {
    syncSource();
    if (source) {
      const bmp = await source.grab(config.analysisWidth);
      const frame = { bmp, gray: decodeBmpGray(bmp), ts: Date.now() };
      latest = frame;
      ring.push(frame);
      const max = Math.max(4, Math.round(config.bufferSeconds * config.fps));
      while (ring.length > max) ring.shift();
      frameTimes.push(Date.now()); frameTimes = frameTimes.filter((t) => Date.now() - t < 3000);
      status = `capturing ${frame.gray.w}×${frame.gray.h} from ${source.name}`;
      detect(frame);
    }
  } catch (e) {
    status = (e as Error).message;
    scores.clear();
  }
  const delay = Math.max(20, 1000 / Math.max(1, config.fps) - (Date.now() - started));
  setTimeout(loop, status.startsWith('capturing') ? delay : 1500);
}

function addTemplate(f: Frame, rect: Template['rect'], key: string, name: string): Template {
  const crop = cropTemplate(f.gray, rect);
  const t: Template = {
    id: randomUUID(), key, name: name || keyLabel(key), enabled: true,
    rect, tw: crop.w, th: crop.h, data: Buffer.from(crop.px).toString('base64'),
    threshold: config.detection.defaultThreshold, cooldownSec: config.detection.defaultCooldownSec, frameWidth: f.gray.w,
  };
  templates.push(t); saveTemplates(templates);
  return t;
}

function validTemplate(t: any): t is Template {
  return t && typeof t.key === 'string' && KEYS.some((k) => k.key === t.key) && t.rect && [t.rect.x, t.rect.y, t.rect.w, t.rect.h].every((v) => typeof v === 'number' && v >= 0 && v <= 1)
    && Number.isInteger(t.tw) && Number.isInteger(t.th) && typeof t.data === 'string' && Buffer.from(t.data, 'base64').length === t.tw * t.th;
}

// ---------------- HTTP ----------------
const localOrigins = () => [`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`];
function send(res: ServerResponse, code: number, body: unknown, type = 'application/json', extra: Record<string, string> = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<any> {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 20e6) throw new Error('too large'); }
  return data ? JSON.parse(data) : {};
}
const publicTemplate = (t: Template) => ({ ...t, data: undefined, score: scores.get(t.id) ?? null, mismatchedWidth: t.frameWidth !== config.analysisWidth });
const frames = () => frozen ?? ring;

function hint(): string | null {
  const s = status.toLowerCase();
  if (s.includes('minimized')) return 'The game is minimized. Restore it. It can sit behind other windows, just not minimized.';
  if (s.includes('not found')) return 'Start Mahjong Soul. If it is running, check "Game process name" in settings (Steam: Jantama_MahjongSoul).';
  if (s.includes('obs')) return 'Check OBS is open, Tools → WebSocket Server Settings is enabled, and the password and source name match.';
  if (s.includes('helper')) return 'The capture helper could not start. Try restarting the app.';
  if (templates.length === 0 && s.startsWith('capturing')) return 'Picture is working. Next: catch a banner and save your first template.';
  if (templates.some((t) => t.frameWidth !== config.analysisWidth)) return 'Some templates were taught at a different analysis width. Re-teach them or change the width back.';
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !localOrigins().includes(origin)) return send(res, 403, { error: 'forbidden origin' });
  const path = url.pathname, M = req.method;
  try {
    if (M === 'GET' && path === '/') return send(res, 200, readAsset('index.html'), 'text/html; charset=utf-8');
    if (M === 'GET' && path === '/ui.js') return send(res, 200, readAsset('ui.js'), 'text/javascript; charset=utf-8');
    if (M === 'GET' && path === '/api/config') return send(res, 200, { config, hints: HINTS, keys: KEYS });
    if (M === 'POST' && path === '/api/config') {
      const prevWidth = config.analysisWidth;
      config = saveConfig(await body(req));
      syncTargets(); syncSource();
      if (prevWidth !== config.analysisWidth) { ring = []; frozen = null; }
      return send(res, 200, { ok: true, config });
    }
    if (M === 'POST' && path === '/api/detection') {
      const b = await body(req);
      config = saveConfig({ ...config, detection: { ...config.detection, enabled: !!b.enabled } });
      return send(res, 200, { ok: true, enabled: config.detection.enabled });
    }
    if (M === 'GET' && path === '/api/status') return send(res, 200, {
      version: VERSION, dataDir: DATA_DIR, status, hint: hint(), fps: frameTimes.length / 3, analysisMs,
      detecting: config.detection.enabled, bufferSeconds: config.bufferSeconds,
      targets: targets.map((t) => ({ url: t.url, connected: !!t.ws })),
      frozen: !!frozen, frames: frames().length,
      templates: templates.map(publicTemplate),
      detections: detections.map(({ frame, ...d }, i) => ({ ...d, index: i, label: keyLabel(d.key), hasFrame: !!frame })),
    });
    if (M === 'GET' && path === '/api/frame/latest') return latest ? send(res, 200, latest.bmp, 'image/bmp') : send(res, 404, { error: status });
    let m = /^\/api\/frame\/(\d+)$/.exec(path);
    if (M === 'GET' && m) { const f = frames()[Number(m[1])]; return f ? send(res, 200, f.bmp, 'image/bmp') : send(res, 404, { error: 'no such frame' }); }
    m = /^\/api\/detection\/(\d+)$/.exec(path);
    if (M === 'GET' && m) { const f = detections[Number(m[1])]?.frame; return f ? send(res, 200, f.bmp, 'image/bmp') : send(res, 404, { error: 'no snapshot' }); }
    if (M === 'POST' && path === '/api/freeze') {
      const b = await body(req);
      frozen = b.frozen ? [...ring] : null;
      return send(res, 200, { ok: true, frames: frames().length });
    }
    if (M === 'POST' && path === '/api/scan') {
      // Best score of every template over the frozen (or buffered) frames: shows what threshold would work.
      const list = frames();
      const result = templates.map((t) => {
        let best = -1, at = -1, worst = 2;
        list.forEach((f, i) => { const s = matchScore(f.gray, t.rect, prep(t), config.detection.searchMarginPct); if (s > best) { best = s; at = i; } if (s < worst) worst = s; });
        return { id: t.id, best, at, worst: list.length ? worst : null, wouldFire: best >= t.threshold };
      });
      return send(res, 200, { frames: list.length, result });
    }
    if (M === 'POST' && path === '/api/templates') {
      const b = await body(req);
      const f = b.snapshot !== undefined ? detections[b.snapshot]?.frame : typeof b.frame === 'number' ? frames()[b.frame] : latest;
      if (!f) return send(res, 400, { error: 'No picture to cut from yet.' });
      if (!KEYS.some((k) => k.key === b.key)) return send(res, 400, { error: 'Pick an event.' });
      const t = addTemplate(f, b.rect, b.key, String(b.name ?? '').trim());
      return send(res, 200, { ok: true, template: publicTemplate(t), selfScore: matchScore(f.gray, t.rect, prep(t), config.detection.searchMarginPct) });
    }
    if (M === 'GET' && path === '/api/templates/export') {
      const data = { app: 'mahjong-soul-screen-reader', version: 1, analysisWidth: config.analysisWidth, exported: new Date().toISOString(), templates };
      return send(res, 200, JSON.stringify(data, null, 2), 'application/json', { 'Content-Disposition': 'attachment; filename="mahjong-soul-templates.json"' });
    }
    if (M === 'POST' && path === '/api/templates/import') {
      const b = await body(req);
      const incoming = Array.isArray(b.templates) ? b.templates : Array.isArray(b.data?.templates) ? b.data.templates : [];
      const good = incoming.filter(validTemplate);
      if (!good.length) return send(res, 400, { error: 'No valid templates in that file.' });
      if (b.mode === 'replace') { templates = []; prepared.clear(); }
      for (const t of good) templates.push({ ...t, id: randomUUID(), enabled: t.enabled !== false, threshold: Number(t.threshold) || config.detection.defaultThreshold, cooldownSec: Number(t.cooldownSec) || config.detection.defaultCooldownSec, frameWidth: Number(t.frameWidth) || config.analysisWidth });
      saveTemplates(templates);
      return send(res, 200, { ok: true, added: good.length, skipped: incoming.length - good.length });
    }
    m = /^\/api\/templates\/([\w-]+)(\.bmp|\/fire)?$/.exec(path);
    if (m) {
      const t = templates.find((x) => x.id === m![1]);
      if (!t) return send(res, 404, { error: 'template not found' });
      if (M === 'GET' && m[2] === '.bmp') return send(res, 200, encodeGrayBmp({ w: t.tw, h: t.th, px: Buffer.from(t.data, 'base64') }), 'image/bmp');
      if (M === 'POST' && m[2] === '/fire') { fire(t.key, t.name, null, latest, true); return send(res, 200, { ok: true }); }
      if (M === 'POST' && !m[2]) {
        const b = await body(req);
        if (typeof b.threshold === 'number') t.threshold = Math.min(0.999, Math.max(0.3, b.threshold));
        if (typeof b.cooldownSec === 'number') t.cooldownSec = Math.max(0, b.cooldownSec);
        if (typeof b.enabled === 'boolean') t.enabled = b.enabled;
        if (typeof b.name === 'string') t.name = b.name;
        if (typeof b.key === 'string' && KEYS.some((k) => k.key === b.key)) t.key = b.key;
        saveTemplates(templates);
        return send(res, 200, { ok: true, template: publicTemplate(t) });
      }
      if (M === 'DELETE' && !m[2]) {
        templates = templates.filter((x) => x !== t); prepared.delete(t.id); saveTemplates(templates);
        return send(res, 200, { ok: true });
      }
    }
    if (M === 'POST' && path === '/api/fire') { const b = await body(req); fire(String(b.key), 'test button', null, latest, true); return send(res, 200, { ok: true }); }
    if (M === 'GET' && path === '/api/obs/sources') {
      const obs = new ObsCapture(config.obs.url, config.obs.password, '');
      try { return send(res, 200, { sources: await obs.listSources() }); } finally { obs.close(); }
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: (e as Error).message });
  }
});

const home = `http://localhost:${config.port}/`;
server.on('error', async (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${config.port} is already in use. The app is probably already running, so opening ${home}`);
    openBrowser(home);
  } else console.error('Server error:', e);
  await pauseIfPackaged();
  process.exit(1);
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Mahjong Soul Screen Reader ${VERSION}  (keep this window open while playing)`);
  console.log(`  Settings: ${home}`);
  console.log(`  Data:     ${DATA_DIR}`);
  console.log('  Read-only: it only looks at the game picture, like a screen share.');
  if (config.openBrowserOnStart) openBrowser(home);
  syncTargets();
  void loop();
});

process.on('uncaughtException', (e) => console.error('[error]', e));
process.on('unhandledRejection', (e) => console.error('[error]', e));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => { source?.close(); process.exit(0); });

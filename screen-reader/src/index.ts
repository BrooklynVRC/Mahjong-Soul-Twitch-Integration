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

const log: { ts: number; key: string; name: string; score: number | null; manual: boolean }[] = [];
function fire(key: string, name: string, score: number | null, manual = false) {
  const ev = toGameEvent(key);
  if (!ev) return;
  const text = JSON.stringify(ev);
  targets.forEach((t) => t.send(text));
  log.unshift({ ts: Date.now(), key, name, score, manual });
  log.length = Math.min(log.length, 40);
  console.log(`[detect] ${key} (${name})${score !== null ? ' score ' + score.toFixed(2) : ' (manual)'}`);
}

// ---------------- Capture loop ----------------
let source: Source | null = null;
let sourceKey = '';
let status = 'starting';
let latest: { bmp: Buffer; gray: Gray; ts: number } | null = null;
const BUFFER_FRAMES = 40;
let ring: { bmp: Buffer; gray: Gray; ts: number }[] = [];
let frozen: { bmp: Buffer; gray: Gray; ts: number }[] | null = null;
const scores = new Map<string, number>();
const above = new Set<string>();
const lastFired = new Map<string, number>();
let frameTimes: number[] = [];

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

function detect(frame: Gray) {
  if (!config.detection.enabled) return;
  const now = Date.now();
  for (const t of templates) {
    if (!t.enabled) { scores.delete(t.id); continue; }
    const s = matchScore(frame, t.rect, prep(t), config.detection.searchMarginPct);
    scores.set(t.id, s);
    const isAbove = s >= t.threshold;
    if (isAbove && !above.has(t.id)) {
      // Fire on the rising edge, at most once per cooldown per event key.
      const k = 'key:' + t.key;
      if (now - (lastFired.get(k) ?? 0) >= t.cooldownSec * 1000) { lastFired.set(k, now); fire(t.key, t.name, s); }
    }
    if (isAbove) above.add(t.id); else above.delete(t.id);
  }
}

async function loop() {
  const started = Date.now();
  try {
    syncSource();
    if (source) {
      const bmp = await source.grab(config.analysisWidth);
      const gray = decodeBmpGray(bmp);
      latest = { bmp, gray, ts: Date.now() };
      ring.push(latest); if (ring.length > BUFFER_FRAMES) ring.shift();
      frameTimes.push(Date.now()); frameTimes = frameTimes.filter((t) => Date.now() - t < 3000);
      status = `capturing ${gray.w}×${gray.h} from ${source.name}`;
      detect(gray);
    }
  } catch (e) {
    status = (e as Error).message;
  }
  const delay = Math.max(20, 1000 / Math.max(1, config.fps) - (Date.now() - started));
  setTimeout(loop, status.startsWith('capturing') ? delay : 1500);
}

// ---------------- HTTP ----------------
const localOrigins = () => [`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`];
function send(res: ServerResponse, code: number, body: unknown, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<any> {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 1e6) throw new Error('too large'); }
  return data ? JSON.parse(data) : {};
}
const publicTemplate = (t: Template) => ({ ...t, data: undefined, score: scores.get(t.id) ?? null });
const frames = () => frozen ?? ring;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !localOrigins().includes(origin)) return send(res, 403, { error: 'forbidden origin' });
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/') return send(res, 200, readAsset('index.html'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && path === '/ui.js') return send(res, 200, readAsset('ui.js'), 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && path === '/api/config') return send(res, 200, { config, hints: HINTS, keys: KEYS });
    if (req.method === 'POST' && path === '/api/config') {
      const prevWidth = config.analysisWidth;
      config = saveConfig(await body(req));
      syncTargets(); syncSource();
      if (prevWidth !== config.analysisWidth) { ring = []; frozen = null; }
      return send(res, 200, { ok: true, config });
    }
    if (req.method === 'GET' && path === '/api/status') return send(res, 200, {
      version: VERSION, dataDir: DATA_DIR, status, fps: frameTimes.length / 3,
      targets: targets.map((t) => ({ url: t.url, connected: !!t.ws })),
      frozen: !!frozen, frames: frames().length,
      templates: templates.map(publicTemplate), log,
    });
    if (req.method === 'GET' && path === '/api/frame/latest') return latest ? send(res, 200, latest.bmp, 'image/bmp') : send(res, 404, { error: status });
    const fm = /^\/api\/frame\/(\d+)$/.exec(path);
    if (req.method === 'GET' && fm) { const f = frames()[Number(fm[1])]; return f ? send(res, 200, f.bmp, 'image/bmp') : send(res, 404, { error: 'no such frame' }); }
    if (req.method === 'POST' && path === '/api/freeze') {
      const b = await body(req);
      frozen = b.frozen ? [...ring] : null;
      return send(res, 200, { ok: true, frames: frames().length });
    }
    if (req.method === 'POST' && path === '/api/templates') {
      const b = await body(req);
      const list = frames();
      const f = typeof b.frame === 'number' ? list[b.frame] : latest;
      if (!f) return send(res, 400, { error: 'No frame to cut from yet.' });
      if (!KEYS.some((k) => k.key === b.key)) return send(res, 400, { error: 'Pick an event.' });
      const crop = cropTemplate(f.gray, b.rect);
      const t: Template = {
        id: randomUUID(), key: b.key, name: String(b.name || KEYS.find((k) => k.key === b.key)!.label), enabled: true,
        rect: b.rect, tw: crop.w, th: crop.h, data: Buffer.from(crop.px).toString('base64'),
        threshold: config.detection.defaultThreshold, cooldownSec: config.detection.defaultCooldownSec, frameWidth: f.gray.w,
      };
      templates.push(t); saveTemplates(templates);
      return send(res, 200, { ok: true, template: publicTemplate(t), selfScore: matchScore(f.gray, t.rect, prep(t), config.detection.searchMarginPct) });
    }
    const tm = /^\/api\/templates\/([\w-]+)(\.bmp|\/fire)?$/.exec(path);
    if (tm) {
      const t = templates.find((x) => x.id === tm[1]);
      if (!t) return send(res, 404, { error: 'template not found' });
      if (req.method === 'GET' && tm[2] === '.bmp') return send(res, 200, encodeGrayBmp({ w: t.tw, h: t.th, px: Buffer.from(t.data, 'base64') }), 'image/bmp');
      if (req.method === 'POST' && tm[2] === '/fire') { fire(t.key, t.name, null, true); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && !tm[2]) {
        const b = await body(req);
        if (typeof b.threshold === 'number') t.threshold = Math.min(0.999, Math.max(0.3, b.threshold));
        if (typeof b.cooldownSec === 'number') t.cooldownSec = Math.max(0, b.cooldownSec);
        if (typeof b.enabled === 'boolean') t.enabled = b.enabled;
        if (typeof b.name === 'string') t.name = b.name;
        if (typeof b.key === 'string' && KEYS.some((k) => k.key === b.key)) t.key = b.key;
        saveTemplates(templates);
        return send(res, 200, { ok: true, template: publicTemplate(t) });
      }
      if (req.method === 'DELETE' && !tm[2]) {
        templates = templates.filter((x) => x !== t); prepared.delete(t.id); saveTemplates(templates);
        return send(res, 200, { ok: true });
      }
    }
    if (req.method === 'POST' && path === '/api/fire') { const b = await body(req); fire(String(b.key), 'test button', null, true); return send(res, 200, { ok: true }); }
    if (req.method === 'GET' && path === '/api/obs/sources') {
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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { ALL_KEYS, DATA_DIR, HINTS, loadConfig, saveConfig, type Config } from './config.js';
import { SessionTracker, fill } from './game.js';
import { Twitch, type TwitchEvent } from './twitch.js';
import { DiscordPresence, buildActivity, postWebhook } from './discord.js';
import { ScreenReader } from './screen/reader.js';
import { keyLabel, placeOf, type Detection, type GameState } from './screen/keys.js';
import { VERSION, captureExe, pauseIfPackaged, readAsset, sharedDir, showUi } from './runtime.js';

let config: Config = loadConfig();
const session = new SessionTracker();
const cooldowns = new Map<string, number>();
let gameState: GameState = { inGame: false, since: null, mode: null, scores: { me: null, right: null, top: null, left: null }, place: null, lastResult: null };
const recent: { ts: number; key: string; label: string; text: string | null }[] = [];
const labelOf = (k: string) => ALL_KEYS.find((x) => x.key === k)?.label ?? keyLabel(k);

const localOrigins = () => [`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`];

// ---------------- WebSocket hubs ----------------
const overlayOut = new WebSocketServer({ noServer: true });  // us -> OBS overlay
const eventsOut = new WebSocketServer({ noServer: true });   // us -> other apps (Lovense: Twitch viewer events)

function broadcast(wss: WebSocketServer, data: unknown) {
  const text = JSON.stringify(data);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(text);
}
const overlayState = () => ({ kind: 'state', state: gameState, vars: session.vars(gameState), overlay: config.overlay });
overlayOut.on('connection', (ws) => ws.send(JSON.stringify(overlayState())));
setInterval(() => broadcast(overlayOut, overlayState()), 30000); // keeps "time in game" fresh

// ---------------- Game events (from the screen reader) ----------------
async function handleKey(key: string) {
  const place = placeOf(key);
  if (place) session.record(place);
  const vars = session.vars(gameState);
  const ann = config.announcements.events[key];
  const text = ann ? fill(ann.text, vars) : null;
  if (ann && text && config.announcements.enabled && ann.enabled) await twitch.say(config.announcements.prefix + text);
  const hook = config.discord.webhook;
  if (hook.enabled && hook.url && hook.events[key] && text) postWebhook(hook.url, hook.username, text).catch((e) => console.warn('[discord] webhook:', e.message));

  broadcast(overlayOut, { kind: 'event', key, text: config.overlay.feedEvents[key] ? text : null, place });
  broadcast(overlayOut, overlayState());
  recent.unshift({ ts: Date.now(), key, label: labelOf(key), text }); recent.length = Math.min(recent.length, 15);

  if (key === 'game_start') await twitch.startPrediction(4);
  if (place) await twitch.resolvePrediction(place);
  updatePresence();
}

function onDetect(d: Detection) { void handleKey(d.key); }

function onState(s: GameState) {
  const prev = gameState.place;
  gameState = s;
  if (s.inGame && prev && s.place && prev !== s.place) {
    if (s.place === 1) void handleKey('took_lead');
    else if (prev === 1) void handleKey('lost_lead');
  }
  broadcast(overlayOut, overlayState());
  updatePresence();
}

// ---------------- Discord presence ----------------
const discord = new DiscordPresence();
function updatePresence() {
  const p = config.discord.presence;
  discord.configure(p.enabled, p.clientId);
  if (!p.enabled) return;
  const v = session.vars(gameState);
  const inGame = gameState.inGame;
  discord.set(buildActivity({
    details: fill(inGame ? p.gameDetails : p.lobbyDetails, v),
    state: fill(inGame ? p.gameState : p.lobbyState, v),
    start: inGame && p.showElapsed ? gameState.since : null,
    largeImage: p.largeImage, largeText: fill(p.largeText, v), buttonLabel: p.buttonLabel, buttonUrl: p.buttonUrl,
  }));
}

// ---------------- Twitch ----------------
function handleTwitchEvent(e: TwitchEvent) {
  const f = config.forwarding;
  if (!f.enabled) return;
  if (e.type === 'chat' && f.chatCommandsOnly && !e.message?.startsWith('!')) return;
  broadcast(eventsOut, e);
}

function handleChat(text: string, _user: string, isMod: boolean, isBroadcaster: boolean) {
  const c = config.commands;
  if (!c.enabled) return;
  const word = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (!word) return;
  const vars = session.vars(gameState);
  if (c.reset.enabled && word === c.reset.trigger.toLowerCase()) {
    if (!isMod && !isBroadcaster) return;
    session.reset();
    broadcast(overlayOut, overlayState());
    return void twitch.say(fill(c.reset.response, vars));
  }
  const cmd = [c.stats, c.place, c.last, ...c.custom].find((x) => x.enabled && x.trigger.toLowerCase() === word);
  if (!cmd) return;
  const now = Date.now();
  if (!isBroadcaster && now - (cooldowns.get(word) ?? 0) < c.cooldownSec * 1000) return;
  cooldowns.set(word, now);
  void twitch.say(fill(cmd.response, vars));
}

const twitch = new Twitch(() => config, handleTwitchEvent, handleChat);

// ---------------- Screen reader ----------------
const reader = new ScreenReader({
  getConfig: () => config.screen,
  saveConfig: (s) => { config = saveConfig({ ...config, screen: s }); return config.screen; },
  sharedDir: sharedDir(),
  captureExe,
  onDetect,
  onState,
});

// ---------------- HTTP ----------------
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function send(res: ServerResponse, code: number, body: unknown, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function file(res: ServerResponse, name: string) {
  const ext = name.slice(name.lastIndexOf('.'));
  try { send(res, 200, readAsset(name), TYPES[ext] ?? 'text/plain'); } catch { send(res, 404, 'not found', 'text/plain'); }
}
async function body(req: IncomingMessage): Promise<any> {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 1e6) throw new Error('too large'); }
  return data ? JSON.parse(data) : {};
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  reader.stop();
  discord.close();
  await twitch.disconnect().catch(() => {});
  setTimeout(() => process.exit(0), 300);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !localOrigins().includes(origin)) return send(res, 403, { error: 'forbidden origin' });
  try {
    if (await reader.handle(req, res, url.pathname)) return;
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /': return file(res, 'settings.html');
      case 'GET /screen': return file(res, 'screen.html');
      case 'GET /ui.js': return file(res, 'ui.js');
      case 'GET /overlay': return file(res, 'overlay.html');
      case 'GET /api/config': return send(res, 200, { config, hints: HINTS, keys: ALL_KEYS });
      case 'POST /api/config': {
        const prev = JSON.stringify(config.twitch);
        config = saveConfig(await body(req));
        if (JSON.stringify(config.twitch) !== prev) void twitch.connect();
        broadcast(overlayOut, overlayState());
        updatePresence();
        return send(res, 200, { ok: true, config });
      }
      case 'GET /api/status': return send(res, 200, {
        version: VERSION, dataDir: DATA_DIR, sharedDir: sharedDir(),
        twitch: twitch.status, redirectUri: twitch.redirectUri, discord: discord.status,
        overlayClients: overlayOut.clients.size, eventClients: eventsOut.clients.size,
        screen: reader.summary(), vars: session.vars(gameState), recent,
      });
      case 'POST /api/test/game': { const b = await body(req); await handleKey(String(b.key)); return send(res, 200, { ok: true }); }
      case 'POST /api/test/state': {
        const b = await body(req);
        onState({ ...gameState, inGame: true, since: gameState.since ?? Date.now(), mode: b.mode ?? gameState.mode ?? 'Test match', place: b.place ?? 2 });
        return send(res, 200, { ok: true });
      }
      case 'POST /api/test/twitch': {
        const e = await body(req);
        handleTwitchEvent({ source: 'twitch', ts: Date.now(), user: 'TestViewer', ...e });
        if (e.type === 'chat' && e.message) handleChat(e.message, 'TestViewer', false, true);
        return send(res, 200, { ok: true });
      }
      case 'POST /api/test/webhook': {
        const h = config.discord.webhook;
        try { await postWebhook(h.url, h.username, 'Test message from Mahjong Soul × Twitch 🀄'); return send(res, 200, { ok: true }); }
        catch (e) { return send(res, 400, { error: (e as Error).message }); }
      }
      case 'POST /api/session/reset': session.reset(); broadcast(overlayOut, overlayState()); updatePresence(); return send(res, 200, { ok: true });
      case 'POST /api/twitch/reconnect': await twitch.connect(); return send(res, 200, { ok: true, status: twitch.status });
      case 'POST /api/twitch/disconnect': await twitch.disconnect(); return send(res, 200, { ok: true });
      case 'POST /api/shutdown': send(res, 200, { ok: true }); return void shutdown();
      case 'GET /auth/login':
        if (!config.twitch.clientId) return send(res, 400, 'Set your Client ID and secret in settings first.', 'text/plain');
        res.writeHead(302, { Location: twitch.authUrl() }); return res.end();
      case 'GET /auth/callback': {
        const err = url.searchParams.get('error_description');
        if (err) return send(res, 400, `Twitch said: ${err}`, 'text/plain');
        await twitch.handleCallback(url.searchParams.get('code') ?? '', url.searchParams.get('state') ?? '');
        res.writeHead(302, { Location: '/' }); return res.end();
      }
      default: return send(res, 404, { error: 'not found' });
    }
  } catch (e) {
    console.error(e);
    send(res, 500, { error: (e as Error).message });
  }
});

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const origin = req.headers.origin;
  const ok = !origin || localOrigins().includes(origin);
  const target = path === '/overlay' && ok ? overlayOut : path === '/events' && ok ? eventsOut : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

const home = `http://localhost:${config.port}/`;
server.on('error', async (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${config.port} is already in use. The app is probably already running.`);
    showUi(home, true, true);
  } else console.error('Server error:', e);
  await pauseIfPackaged();
  process.exit(1);
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Mahjong Soul × Twitch ${VERSION}`);
  console.log(`  Settings: ${home}`);
  console.log(`  Overlay:  ${home}overlay  (OBS Browser Source)`);
  console.log(`  Data:     ${DATA_DIR}`);
  showUi(home, config.openBrowserOnStart);
  reader.start();
  updatePresence();
  void twitch.connect();
});

process.on('uncaughtException', (e) => console.error('[error]', e));
process.on('unhandledRejection', (e) => console.error('[error]', e));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => void shutdown());

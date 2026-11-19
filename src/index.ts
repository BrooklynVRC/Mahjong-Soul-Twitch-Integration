import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { HINTS, ROOT, loadConfig, saveConfig, type Config } from './config.js';
import { GameTracker, fill, type GameEvent } from './game.js';
import { Twitch, type TwitchEvent } from './twitch.js';

let config: Config = loadConfig();
const game = new GameTracker();
const cooldowns = new Map<string, number>();

const GAME_ORIGINS = ['https://game.mahjongsoul.com', 'https://mahjongsoul.game.yo-star.com', 'https://game.maj-soul.com', 'https://game.maj-soul.net'];
const localOrigins = () => [`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`];

// ---------------- WebSocket hubs ----------------
const gameIn = new WebSocketServer({ noServer: true });      // userscript -> us
const overlayOut = new WebSocketServer({ noServer: true });  // us -> OBS overlay
const eventsOut = new WebSocketServer({ noServer: true });   // us -> other apps (Lovense)

function broadcast(wss: WebSocketServer, data: unknown) {
  const text = JSON.stringify(data);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(text);
}
const overlayState = () => ({ kind: 'state', state: game.snapshot(), overlay: config.overlay });

gameIn.on('connection', (ws) => {
  console.log('[game] userscript connected');
  ws.on('message', (raw) => {
    try {
      const e = JSON.parse(String(raw));
      if (e?.source === 'mahjongsoul') void handleGameEvent(e);
    } catch { /* ignore bad frames */ }
  });
  ws.on('close', () => console.log('[game] userscript disconnected'));
});
overlayOut.on('connection', (ws) => ws.send(JSON.stringify(overlayState())));

// ---------------- Event handling ----------------
async function handleGameEvent(e: GameEvent) {
  game.apply(e);
  const d = game.describe(e, config.announcements.whose);
  let text: string | null = null;
  if (d) {
    const ann = config.announcements.events[d.key];
    text = fill(ann.template, d.vars);
    if (config.announcements.enabled && ann.enabled) await twitch.say(config.announcements.prefix + text);
  }
  const showInFeed = d ? config.overlay.feedEvents[d.key] : false;
  broadcast(overlayOut, { kind: 'event', event: e, key: d?.key ?? e.type, text: showInFeed ? text : null });
  broadcast(overlayOut, overlayState());

  if (e.type === 'game_start') await twitch.startPrediction(e.playerCount);
  if (e.type === 'game_end') await twitch.resolvePrediction(e.myPlace);
}

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
  const vars = game.sessionVars();
  const builtins = [c.stats, c.score, c.last];
  const all = [...builtins, ...c.custom];
  if (c.reset.enabled && word === c.reset.trigger.toLowerCase()) {
    if (!isMod && !isBroadcaster) return;
    game.resetSession();
    broadcast(overlayOut, overlayState());
    return void twitch.say(fill(c.reset.response, vars));
  }
  const cmd = all.find((x) => x.enabled && x.trigger.toLowerCase() === word);
  if (!cmd) return;
  const now = Date.now();
  if (!isBroadcaster && now - (cooldowns.get(word) ?? 0) < c.cooldownSec * 1000) return;
  cooldowns.set(word, now);
  void twitch.say(fill(cmd.response, vars));
}

const twitch = new Twitch(() => config, handleTwitchEvent, handleChat);

// ---------------- HTTP ----------------
const PUBLIC = resolve(ROOT, 'public');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res: ServerResponse, code: number, body: unknown, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function file(res: ServerResponse, name: string) {
  const ext = name.slice(name.lastIndexOf('.'));
  try { send(res, 200, readFileSync(resolve(PUBLIC, name), 'utf8'), TYPES[ext] ?? 'text/plain'); } catch { send(res, 404, 'not found', 'text/plain'); }
}
async function body(req: IncomingMessage): Promise<any> {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 1e6) throw new Error('too large'); }
  return data ? JSON.parse(data) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !localOrigins().includes(origin)) return send(res, 403, { error: 'forbidden origin' });
  try {
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /': return file(res, 'settings.html');
      case 'GET /ui.js': return file(res, 'ui.js');
      case 'GET /overlay': return file(res, 'overlay.html');
      case 'GET /api/config': return send(res, 200, { config, hints: HINTS });
      case 'POST /api/config': {
        const prev = JSON.stringify(config.twitch);
        config = saveConfig(await body(req));
        if (JSON.stringify(config.twitch) !== prev) void twitch.connect();
        broadcast(overlayOut, overlayState());
        return send(res, 200, { ok: true, config });
      }
      case 'GET /api/status': return send(res, 200, {
        twitch: twitch.status, redirectUri: twitch.redirectUri,
        gameClients: gameIn.clients.size, overlayClients: overlayOut.clients.size, eventClients: eventsOut.clients.size,
        game: game.snapshot(),
      });
      case 'POST /api/test/game': await handleGameEvent({ source: 'mahjongsoul', ts: Date.now(), ...(await body(req)) }); return send(res, 200, { ok: true });
      case 'POST /api/test/twitch': {
        const e = await body(req);
        handleTwitchEvent({ source: 'twitch', ts: Date.now(), user: 'TestViewer', ...e });
        if (e.type === 'chat' && e.message) handleChat(e.message, 'TestViewer', false, true);
        return send(res, 200, { ok: true });
      }
      case 'POST /api/session/reset': game.resetSession(); broadcast(overlayOut, overlayState()); return send(res, 200, { ok: true });
      case 'POST /api/twitch/reconnect': await twitch.connect(); return send(res, 200, { ok: true, status: twitch.status });
      case 'POST /api/twitch/disconnect': await twitch.disconnect(); return send(res, 200, { ok: true });
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
  const ok = (allowed: string[]) => !origin || allowed.includes(origin);
  const target = path === '/game' && ok(GAME_ORIGINS) ? gameIn
    : path === '/overlay' && ok(localOrigins()) ? overlayOut
    : path === '/events' && ok(localOrigins()) ? eventsOut : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Mahjong Soul × Twitch running`);
  console.log(`  Settings: http://localhost:${config.port}/`);
  console.log(`  Overlay:  http://localhost:${config.port}/overlay  (OBS Browser Source)`);
  console.log(`  Events:   ws://localhost:${config.port}/events`);
  void twitch.connect();
});

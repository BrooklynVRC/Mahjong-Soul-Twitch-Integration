import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from './runtime.js';
import { EVENT_KEYS } from './screen/keys.js';

export const DATA_DIR = dataDir('MahjongSoulTwitch');
const CONFIG_PATH = resolve(DATA_DIR, 'config.json');

/** Extra events the app derives from the live placement. */
export const LEAD_KEYS = [
  { key: 'took_lead', label: 'Took the lead (now 1st)' },
  { key: 'lost_lead', label: 'Lost the lead' },
];
export const ALL_KEYS = [...EVENT_KEYS.map(({ key, label }) => ({ key, label })), ...LEAD_KEYS];

const TEXT: Record<string, [boolean, string]> = {
  game_mode: [false, 'Playing {mode}.'],
  game_start: [true, 'New Mahjong Soul game{modeText} starting!'],
  round_start: [false, 'New round! Currently {place}.'],
  my_riichi: [true, 'I declared riichi!'],
  opponent_riichi: [false, 'An opponent declared riichi.'],
  my_call: [false, 'I called a tile.'],
  my_pon: [false, 'Pon!'],
  my_chi: [false, 'Chi!'],
  my_kan: [true, 'KAN!'],
  opponent_call: [false, 'An opponent called a tile.'],
  my_win_ron: [true, 'RON! I won the hand.'],
  my_win_tsumo: [true, 'TSUMO! I won the hand.'],
  my_yakuman: [true, 'YAKUMAN!!!'],
  my_mangan: [true, 'MANGAN! 🔥'],
  my_haneman: [true, 'HANEMAN!! 🔥🔥'],
  my_baiman: [true, 'BAIMAN!!! 🔥🔥🔥'],
  my_sanbaiman: [true, 'SANBAIMAN!!!! 🤯'],
  opponent_mangan: [false, 'An opponent hit a mangan.'],
  opponent_haneman: [false, 'An opponent hit a haneman!'],
  opponent_baiman: [true, 'An opponent hit a BAIMAN!'],
  opponent_sanbaiman: [true, 'An opponent hit a SANBAIMAN!'],
  opponent_yakuman: [true, 'An opponent hit a YAKUMAN!'],
  dealt_in: [true, 'Ouch, I dealt in.'],
  opponent_tsumo: [false, 'An opponent won by tsumo.'],
  opponent_ron: [false, 'An opponent won by ron!'],
  opponent_ron_other: [false, 'An opponent won by ron (not off me).'],
  draw: [false, 'Round drawn.'],
  game_end_1: [true, 'Game over: 1st place! Session: {sessionSummary}'],
  game_end_2: [true, 'Game over: 2nd place. Session: {sessionSummary}'],
  game_end_3: [true, 'Game over: 3rd place. Session: {sessionSummary}'],
  game_end_4: [true, 'Game over: 4th place. Session: {sessionSummary}'],
  took_lead: [true, 'I just took the lead!'],
  lost_lead: [false, 'Lost the lead. Now {place}.'],
};
const FEED_DEFAULT_OFF = ['game_mode', 'round_start', 'opponent_riichi', 'my_call', 'opponent_ron_other'];
const WEBHOOK_DEFAULT_ON = ['game_start', 'my_win_ron', 'my_win_tsumo', 'my_yakuman', 'dealt_in', 'game_end_1', 'game_end_2', 'game_end_3', 'game_end_4'];

const byKey = <T>(f: (k: string) => T) => Object.fromEntries(ALL_KEYS.map(({ key }) => [key, f(key)])) as Record<string, T>;

export const DEFAULT_CONFIG = {
  port: 7701,
  openBrowserOnStart: true,
  twitch: {
    clientId: '',
    clientSecret: '',
    channel: '',
  },
  announcements: {
    enabled: true,
    prefix: '🀄 ',
    events: byKey((k) => ({ enabled: TEXT[k]?.[0] ?? false, text: TEXT[k]?.[1] ?? k })),
  },
  overlay: {
    showStatus: true,
    showFeed: true,
    showSession: true,
    feedSeconds: 8,
    feedMax: 4,
    feedEvents: byKey((k) => !FEED_DEFAULT_OFF.includes(k)),
    theme: {
      fontFamily: 'Segoe UI, sans-serif',
      fontSize: 22,
      text: '#ffffff',
      background: 'rgba(12, 14, 24, 0.78)',
      accent: '#f0b84a',
      win: '#5fd38d',
      loss: '#ff6b6b',
      riichi: '#6bb6ff',
    },
  },
  commands: {
    enabled: true,
    cooldownSec: 10,
    stats: { enabled: true, trigger: '!stats', response: 'Session: {games} games, avg place {avgPlace} — 1st {first} / 2nd {second} / 3rd {third} / 4th {fourth}' },
    place: { enabled: true, trigger: '!place', response: '{statusText}' },
    last: { enabled: true, trigger: '!last', response: 'Last game: {lastPlace} place.' },
    reset: { enabled: true, trigger: '!msreset', response: 'Session stats reset.' },
    custom: [{ enabled: true, trigger: '!ms', response: 'Playing Mahjong Soul! Ask me about riichi mahjong.' }],
  },
  predictions: {
    enabled: false,
    mode: 'first' as 'first' | 'placement',
    titleFirst: 'Will I get 1st place?',
    titlePlacement: 'What place will I finish?',
    windowSec: 120,
  },
  discord: {
    presence: {
      enabled: false,
      clientId: '',
      lobbyDetails: 'In the lobby',
      lobbyState: 'Session: {sessionSummary}',
      gameDetails: '{mode}',
      gameState: '{placeText}',
      showElapsed: true,
      largeImage: '',
      largeText: 'Mahjong Soul',
      buttonLabel: '',
      buttonUrl: '',
    },
    webhook: {
      enabled: false,
      url: '',
      username: 'Mahjong Soul',
      events: byKey((k) => WEBHOOK_DEFAULT_ON.includes(k)),
    },
  },
  forwarding: {
    enabled: true,
    chatCommandsOnly: true,
  },
};

export type Config = typeof DEFAULT_CONFIG;

const labels = Object.fromEntries(ALL_KEYS.map(({ key, label }) => [key, label]));
const PLACEHOLDERS = 'Placeholders: {mode} {modeText} {place} {placeText} {elapsed} {statusText} {games} {avgPlace} {first} {second} {third} {fourth} {lastPlace} {sessionSummary}';

export const HINTS: Record<string, unknown> = {
  port: { help: 'Restart the app after changing.' },
  openBrowserOnStart: { label: 'Open in browser when run on its own', help: 'Only used when the server runs without the app window.' },
  'twitch.clientId': { label: 'Client ID', help: 'From dev.twitch.tv/console. OAuth redirect URL: http://localhost:7701/auth/callback' },
  'twitch.clientSecret': { label: 'Client secret', secret: true },
  'twitch.channel': { label: 'Channel (login name)', help: 'Leave blank to use the account you connect with.' },
  'announcements.events': { label: 'Chat messages', help: PLACEHOLDERS },
  'announcements.events.*.text': { multiline: true },
  'overlay': { help: 'Add http://localhost:7701/overlay as an OBS Browser Source (e.g. 600×300).' },
  'overlay.showStatus': { label: 'Show status (mode, place, time)' },
  'overlay.feedEvents': { label: 'Feed shows', help: 'Which events pop up in the overlay (same text as the chat messages).' },
  'overlay.theme.*': { color: true },
  'overlay.theme.fontFamily': { color: false },
  'overlay.theme.fontSize': { color: false },
  'commands.*.response': { multiline: true },
  'commands.place': { help: 'Shows whether you are in a game, the mode, your live place and time in game.' },
  'commands.custom.[].response': { multiline: true },
  'commands.custom': { template: { enabled: true, trigger: '!new', response: 'Response text' } },
  'commands.reset': { help: 'Only the broadcaster and mods can use this.' },
  'predictions': { help: 'Needs Affiliate/Partner. Opens a prediction at game start and resolves it from the result.' },
  'predictions.mode': { options: [{ value: 'first', label: 'Yes/No: 1st place?' }, { value: 'placement', label: 'Pick the placement' }] },
  'predictions.windowSec': { label: 'Voting window (seconds)', min: 30, max: 1800 },
  discord: { label: 'Discord' },
  'discord.presence': { label: 'Rich Presence (your Discord profile)', help: 'Shows "Playing …" with your mode, live place and time in game. Create an application at discord.com/developers/applications (its name is what Discord shows after "Playing"), then paste its Application ID. Discord must be running on this PC. ' + PLACEHOLDERS },
  'discord.presence.clientId': { label: 'Application ID' },
  'discord.presence.lobbyDetails': { label: 'Line 1 (not in a game)' },
  'discord.presence.lobbyState': { label: 'Line 2 (not in a game)' },
  'discord.presence.gameDetails': { label: 'Line 1 (in a game)' },
  'discord.presence.gameState': { label: 'Line 2 (in a game)' },
  'discord.presence.showElapsed': { label: 'Show time in game' },
  'discord.presence.largeImage': { label: 'Image', help: 'Name of an image uploaded under your application → Rich Presence → Art Assets, or an https:// image URL.' },
  'discord.presence.buttonUrl': { label: 'Button URL', help: 'Optional, e.g. your Twitch channel. Needs a button label too.' },
  'discord.webhook': { label: 'Channel messages (webhook)', help: 'Posts to a Discord channel: Channel settings → Integrations → Webhooks → New Webhook → Copy URL. Uses the same text as the chat messages.' },
  'discord.webhook.url': { label: 'Webhook URL', secret: true },
  'discord.webhook.events': { label: 'Post these' },
  'forwarding': { help: 'Shares Twitch events (bits, subs, redeems, chat commands) on ws://localhost:7701/events so the Lovense app can react to viewers.' },
};
for (const group of ['announcements.events', 'overlay.feedEvents', 'discord.webhook.events'])
  for (const [k, label] of Object.entries(labels)) HINTS[`${group}.${k}`] = { label };

function merge<T>(base: T, over: unknown): T {
  if (Array.isArray(base)) {
    if (!Array.isArray(over)) return base;
    const tpl = base[0];
    return (tpl && typeof tpl === 'object' ? over.map((x) => merge(tpl, x)) : over) as T;
  }
  if (base && typeof base === 'object') {
    const out: Record<string, unknown> = {};
    const o = (over && typeof over === 'object' ? over : {}) as Record<string, unknown>;
    for (const k of Object.keys(base)) out[k] = merge((base as Record<string, unknown>)[k], o[k]);
    return out as T;
  }
  return (over !== undefined && typeof over === typeof base ? over : base) as T;
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return structuredClone(DEFAULT_CONFIG);
  try {
    return merge(DEFAULT_CONFIG, JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
  } catch (e) {
    console.error('config.json is invalid, using defaults:', e);
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(cfg: unknown): Config {
  const merged = merge(DEFAULT_CONFIG, cfg);
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

export function readJson<T>(name: string, fallback: T): T {
  const p = resolve(DATA_DIR, name);
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback; } catch { return fallback; }
}
export function writeJson(name: string, data: unknown) {
  writeFileSync(resolve(DATA_DIR, name), JSON.stringify(data, null, 2));
}

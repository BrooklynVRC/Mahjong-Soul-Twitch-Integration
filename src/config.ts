import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from './runtime.js';

export const DATA_DIR = dataDir('MahjongSoulTwitch');
const CONFIG_PATH = resolve(DATA_DIR, 'config.json');

// template: full-detail text (browser userscript). templateBasic: used for screen-reader events,
// which don't know han/fu/yaku/names. Extra placeholder there: {who} = "I" / "An opponent".
const ev = (enabled: boolean, template: string, templateBasic: string) => ({ enabled, template, templateBasic });

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
    whose: 'me' as 'me' | 'all',
    prefix: '🀄 ',
    events: {
      game_start: ev(true, 'New Mahjong Soul game! Opponents: {opponents}', 'New Mahjong Soul game starting!'),
      round_start: ev(false, '{round}{honbaText} — scores: {scores}', 'New round!'),
      riichi: ev(true, '{player} declared {riichiType}!', '{who} declared riichi!'),
      call: ev(false, '{player} called {call}.', '{who} called a tile.'),
      win_tsumo: ev(true, '{player} TSUMO! {han} han {fu} fu, +{points} ({yaku})', '{who} won by TSUMO!'),
      win_ron: ev(true, '{player} RON off {from}! {han} han {fu} fu, +{points} ({yaku})', '{who} won by RON!'),
      dealt_in: ev(true, 'Ouch, I dealt into {winner} for {lost}.', 'Ouch, I dealt in.'),
      yakuman: ev(true, 'YAKUMAN!!! {player} hit {yaku}!', 'YAKUMAN!!!'),
      draw: ev(false, 'Round drawn ({reason}). Tenpai: {tenpai}', 'Round drawn.'),
      game_end: ev(true, 'Game over: {place} place with {score}. Session: {sessionSummary}', 'Game over: {place} place. Session: {sessionSummary}'),
    },
  },
  overlay: {
    showRound: true,
    showScores: true,
    showFeed: true,
    showSession: true,
    feedSeconds: 8,
    feedMax: 4,
    feedEvents: {
      game_start: true, round_start: false, riichi: true, call: false, win_tsumo: true, win_ron: true,
      dealt_in: true, yakuman: true, draw: true, game_end: true,
    },
    highlightMe: true,
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
    score: { enabled: true, trigger: '!score', response: '{round}: {scores}' },
    last: { enabled: true, trigger: '!last', response: 'Last game: {lastPlace} place with {lastScore}' },
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
  forwarding: {
    enabled: true,
    chatCommandsOnly: true,
  },
};

export type Config = typeof DEFAULT_CONFIG;

// Labels, help text and dropdown options for the settings page.
export const HINTS: Record<string, unknown> = {
  port: { help: 'Restart the app after changing. The userscript sends to 7701 by default.' },
  openBrowserOnStart: { label: 'Open this page when the app starts' },
  'twitch.clientId': { label: 'Client ID', help: 'From dev.twitch.tv/console. OAuth redirect URL: http://localhost:7701/auth/callback' },
  'twitch.clientSecret': { label: 'Client secret', secret: true },
  'twitch.channel': { label: 'Channel (login name)', help: 'Leave blank to use the account you connect with.' },
  'announcements.whose': { label: 'Announce events for', options: [{ value: 'me', label: 'Only me' }, { value: 'all', label: 'All players' }] },
  'announcements.events.*.template': { multiline: true, label: 'Text (full detail)' },
  'announcements.events.*.templateBasic': { multiline: true, label: 'Text (screen reader)', help: 'Used for events from the screen reader, which can\'t see han/fu/yaku/names. {who} = "I" or "An opponent".' },
  'announcements.events': { help: 'Placeholders: {player} {round} {han} {fu} {points} {yaku} {from} {winner} {lost} {call} {riichiType} {reason} {tenpai} {place} {score} {opponents} {scores} {sessionSummary}' },
  'announcements.events.dealt_in': { label: 'I dealt in' },
  'overlay': { help: 'Add http://localhost:7701/overlay as an OBS Browser Source (e.g. 600×400).' },
  'overlay.feedEvents': { label: 'Feed shows', help: 'Which events pop up in the overlay feed (uses the same text as the chat templates).' },
  'overlay.feedEvents.dealt_in': { label: 'I dealt in' },
  'overlay.theme.*': { color: true },
  'overlay.theme.fontFamily': { color: false },
  'overlay.theme.fontSize': { color: false },
  'commands.*.response': { multiline: true },
  'commands.custom.[].response': { multiline: true },
  'commands.custom': { template: { enabled: true, trigger: '!new', response: 'Response text' } },
  'commands.reset': { help: 'Only the broadcaster and mods can use this.' },
  'predictions': { help: 'Needs Affiliate/Partner. Opens a prediction at game start and resolves it from the result.' },
  'predictions.mode': { options: [{ value: 'first', label: 'Yes/No: 1st place?' }, { value: 'placement', label: 'Pick the placement' }] },
  'predictions.windowSec': { label: 'Voting window (seconds)', min: 30, max: 1800 },
  'forwarding': { help: 'Shares Twitch events (bits, subs, redeems, chat commands) on ws://localhost:7701/events so other apps, like the Lovense app, can react.' },
};

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

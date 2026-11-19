import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from './runtime.js';

export const DATA_DIR = dataDir('MahjongSoulScreenReader');
const CONFIG_PATH = resolve(DATA_DIR, 'config.json');
const TEMPLATES_PATH = resolve(DATA_DIR, 'templates.json');

export const DEFAULT_CONFIG = {
  port: 7703,
  openBrowserOnStart: true,
  source: 'window' as 'window' | 'obs',
  window: { processName: 'Jantama_MahjongSoul' },
  obs: { url: 'ws://127.0.0.1:4455', password: '', sourceName: '' },
  fps: 4,
  analysisWidth: 480,
  bufferSeconds: 20,
  detection: { enabled: true, searchMarginPct: 8, defaultThreshold: 0.8, defaultCooldownSec: 6, confirmFrames: 1, rearmMargin: 0.05 },
  targets: ['ws://127.0.0.1:7701/game', 'ws://127.0.0.1:7702/game'],
};
export type Config = typeof DEFAULT_CONFIG;

export const HINTS: Record<string, unknown> = {
  port: { help: 'Restart after changing.' },
  openBrowserOnStart: { label: 'Open this page when the app starts' },
  source: { label: 'Picture source', options: [{ value: 'window', label: 'Game window (screen-share style, works when tabbed out)' }, { value: 'obs', label: 'OBS source' }] },
  'window.processName': { label: 'Game process name', help: 'Steam client: Jantama_MahjongSoul. For the browser version use your browser, e.g. chrome or msedge.' },
  obs: { label: 'OBS', help: 'OBS → Tools → WebSocket Server Settings: enable it and copy the password.' },
  'obs.password': { secret: true },
  'obs.sourceName': { label: 'Source name', help: 'The OBS source that shows the game (exact name). Click "List OBS sources" to see names.' },
  fps: { label: 'Checks per second', min: 1, max: 15, step: 1 },
  analysisWidth: { label: 'Analysis width (px)', help: 'Frames are shrunk to this width. Changing it means re-teaching templates.', min: 240, max: 1280, step: 10 },
  'detection.searchMarginPct': { label: 'Position tolerance (%)', help: 'How far a banner may move from where you taught it.', min: 0, max: 30, step: 1 },
  'detection.defaultThreshold': { label: 'Default match threshold', min: 0.5, max: 0.99, step: 0.01 },
  'detection.defaultCooldownSec': { label: 'Default cooldown (s)', min: 1, max: 60 },
  bufferSeconds: { label: 'Freeze buffer (seconds)', help: 'How far back "Freeze" can go.', min: 5, max: 60, step: 1 },
  'detection.enabled': { label: 'Detection on' },
  'detection.confirmFrames': { label: 'Frames to confirm', help: 'A banner must match this many checks in a row before it fires. 2 cuts false alarms; 1 reacts fastest.', min: 1, max: 5, step: 1 },
  'detection.rearmMargin': { label: 'Re-arm margin', help: 'After firing, the score must drop this far below the threshold before the same template can fire again.', min: 0, max: 0.3, step: 0.01 },
  targets: { label: 'Send events to', help: 'The Twitch app (7701) and Lovense app (7702). Whichever is running receives events.', template: 'ws://127.0.0.1:7701/game' },
};

export interface Template {
  id: string; key: string; name: string; enabled: boolean;
  rect: { x: number; y: number; w: number; h: number };
  tw: number; th: number; data: string; // base64 grayscale pixels
  threshold: number; cooldownSec: number; frameWidth: number;
}

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

export function loadConfig(): Config {
  try { return existsSync(CONFIG_PATH) ? merge(DEFAULT_CONFIG, JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))) : structuredClone(DEFAULT_CONFIG); }
  catch (e) { console.error('config.json is invalid, using defaults:', e); return structuredClone(DEFAULT_CONFIG); }
}
export function saveConfig(cfg: unknown): Config {
  const merged = merge(DEFAULT_CONFIG, cfg);
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}
export function loadTemplates(): Template[] {
  try { return existsSync(TEMPLATES_PATH) ? JSON.parse(readFileSync(TEMPLATES_PATH, 'utf8')) : []; } catch { return []; }
}
export function saveTemplates(t: Template[]) { writeFileSync(TEMPLATES_PATH, JSON.stringify(t, null, 2)); }

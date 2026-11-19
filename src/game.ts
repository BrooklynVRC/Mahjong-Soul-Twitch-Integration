// Session stats + the placeholder values used in chat, overlay and Discord text.
import { readJson, writeJson } from './config.js';
import type { GameState } from './screen/keys.js';

const ORD = ['1st', '2nd', '3rd', '4th'];
export const ordinal = (n: number | null | undefined) => (n && n >= 1 && n <= 4 ? ORD[n - 1] : '?');

export interface Session { places: number[]; lastPlace: number | null }

export function elapsed(since: number | null) {
  if (!since) return '';
  const m = Math.floor((Date.now() - since) / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export class SessionTracker {
  session: Session = readJson<Session>('session.json', { places: [], lastPlace: null });

  record(place: number) {
    this.session.places.push(place);
    this.session.lastPlace = place;
    writeJson('session.json', this.session);
  }
  reset() { this.session = { places: [], lastPlace: null }; writeJson('session.json', this.session); }

  vars(s: GameState): Record<string, string | number> {
    const p = this.session.places;
    const count = (n: number) => p.filter((x) => x === n).length;
    const avg = p.length ? (p.reduce((a, b) => a + b, 0) / p.length).toFixed(2) : '-';
    const mode = s.mode ?? 'Mahjong Soul';
    const placeText = s.inGame ? (s.place ? `Currently ${ordinal(s.place)}` : 'In a match') : s.lastResult ? `Last game: ${ordinal(s.lastResult)}` : 'In the lobby';
    const time = elapsed(s.since);
    const statusText = s.inGame
      ? `In a game (${mode})${s.place ? `, currently ${ordinal(s.place)}` : ''}${time ? `, ${time} in` : ''}.`
      : `Not in a game right now.${s.lastResult ? ` Last game: ${ordinal(s.lastResult)} place.` : ''}`;
    return {
      games: p.length, avgPlace: avg, first: count(1), second: count(2), third: count(3), fourth: count(4),
      lastPlace: ordinal(this.session.lastPlace), sessionSummary: `${p.length} game${p.length === 1 ? '' : 's'}, avg ${avg}`,
      mode, modeText: s.mode ? ` (${s.mode})` : '', place: ordinal(s.place), placeText, elapsed: time, statusText,
    };
  }
}

export function fill(template: string, vars: Record<string, unknown>) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

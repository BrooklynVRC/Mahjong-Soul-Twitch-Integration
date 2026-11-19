// Tracks the current Mahjong Soul game + session stats, and turns events into chat text.
import { readJson, writeJson, type Config } from './config.js';

export interface Player { seat: number; nickname: string; accountId?: number }
export interface GameEvent {
  source: 'mahjongsoul';
  type: 'game_start' | 'round_start' | 'riichi' | 'call' | 'win' | 'draw' | 'game_end';
  mySeat: number | null;
  [k: string]: any;
}

const PLACE = ['1st', '2nd', '3rd', '4th'];

export interface Session { games: number; places: number[]; lastPlace: number | null; lastScore: number | null }

export class GameTracker {
  players: Player[] = [];
  mySeat: number | null = null;
  round = '';
  honba = 0;
  riichiSticks = 0;
  scores: number[] = [];
  riichi = new Set<number>();
  inGame = false;
  session: Session = readJson<Session>('session.json', { games: 0, places: [], lastPlace: null, lastScore: null });

  apply(e: GameEvent) {
    if (e.mySeat !== null && e.mySeat !== undefined) this.mySeat = e.mySeat;
    switch (e.type) {
      case 'game_start':
        this.players = e.players; this.inGame = true; this.scores = []; this.round = ''; this.riichi.clear();
        break;
      case 'round_start':
        this.round = e.label; this.honba = e.honba; this.riichiSticks = e.riichiSticks; this.scores = e.scores; this.riichi.clear();
        if (e.players?.length) this.players = e.players;
        break;
      case 'riichi':
        this.riichi.add(e.seat);
        break;
      case 'win':
        if (e.scores?.length) this.scores = e.scores;
        break;
      case 'draw':
        if (e.deltas?.length && this.scores.length) this.scores = this.scores.map((s, i) => s + (e.deltas[i] || 0));
        break;
      case 'game_end': {
        this.inGame = false;
        const byseat: number[] = [];
        for (const r of e.results) byseat[r.seat] = r.score;
        this.scores = byseat;
        if (e.myPlace) {
          this.session.games++;
          this.session.places.push(e.myPlace);
          this.session.lastPlace = e.myPlace;
          this.session.lastScore = e.myScore;
          this.saveSession();
        }
        break;
      }
    }
  }

  resetSession() {
    this.session = { games: 0, places: [], lastPlace: null, lastScore: null };
    this.saveSession();
  }
  saveSession() { writeJson('session.json', this.session); }

  name(seat: number | null | undefined) {
    if (seat === null || seat === undefined) return '?';
    return this.players[seat]?.nickname ?? `Seat ${seat}`;
  }

  scoresText() {
    if (!this.scores.length) return 'no scores yet';
    return this.scores.map((s, i) => `${this.name(i)} ${s}`).join(' | ');
  }

  sessionVars() {
    const p = this.session.places;
    const count = (n: number) => p.filter((x) => x === n).length;
    const avg = p.length ? (p.reduce((a, b) => a + b, 0) / p.length).toFixed(2) : '-';
    return {
      games: p.length, avgPlace: avg, first: count(1), second: count(2), third: count(3), fourth: count(4),
      lastPlace: this.session.lastPlace ? PLACE[this.session.lastPlace - 1] : '-',
      lastScore: this.session.lastScore ?? '-',
      sessionSummary: `${p.length} games, avg ${avg}`,
      round: this.round || 'not in a round', scores: this.scoresText(),
    };
  }

  snapshot() {
    return {
      inGame: this.inGame, round: this.round, honba: this.honba, riichiSticks: this.riichiSticks,
      mySeat: this.mySeat, riichi: [...this.riichi],
      players: this.players.map((p, i) => ({ seat: i, nickname: p.nickname, score: this.scores[i] ?? null })),
      session: this.sessionVars(),
    };
  }

  /** Returns { key, vars } describing which announcement applies to this event (or null). */
  describe(e: GameEvent, whose: 'me' | 'all'): { key: keyof Config['announcements']['events']; vars: Record<string, unknown> } | null {
    const mineOnly = whose === 'me';
    const common = this.sessionVars();
    switch (e.type) {
      case 'game_start':
        return { key: 'game_start', vars: { ...common, opponents: e.players.filter((p: Player) => p.seat !== e.mySeat).map((p: Player) => p.nickname).join(', ') } };
      case 'round_start':
        return { key: 'round_start', vars: { ...common, round: e.label, honbaText: e.honba ? ` (${e.honba} honba)` : '' } };
      case 'riichi':
        if (mineOnly && !e.isMe) return null;
        return { key: 'riichi', vars: { ...common, player: e.player, riichiType: e.double ? 'DOUBLE RIICHI' : 'riichi' } };
      case 'call':
        if (mineOnly && !e.isMe) return null;
        return { key: 'call', vars: { ...common, player: e.player, call: e.call } };
      case 'win': {
        const vars = { ...common, player: e.player, winner: e.player, han: e.han, fu: e.fu, points: e.points, lost: e.from !== null ? -(e.deltas?.[e.from] ?? 0) : '?', yaku: (e.yaku || []).join(', '), from: e.fromPlayer ?? '?', title: e.title };
        if (e.dealtInByMe) return { key: 'dealt_in', vars };
        if (e.yakuman) return { key: 'yakuman', vars }; // always worth announcing
        if (mineOnly && !e.isMe) return null;
        return { key: e.method === 'tsumo' ? 'win_tsumo' : 'win_ron', vars };
      }
      case 'draw':
        return { key: 'draw', vars: { ...common, reason: e.reason, tenpai: e.tenpaiPlayers?.length ? e.tenpaiPlayers.join(', ') : 'nobody' } };
      case 'game_end':
        if (!e.myPlace) return null;
        return { key: 'game_end', vars: { ...this.sessionVars(), place: PLACE[e.myPlace - 1], score: e.myScore } };
    }
    return null;
  }
}

export function fill(template: string, vars: Record<string, unknown>) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

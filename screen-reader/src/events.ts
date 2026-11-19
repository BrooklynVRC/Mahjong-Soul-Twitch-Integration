// Event keys you can teach, and the game events they become. These match what the
// userscript sends, so the Twitch and Lovense apps handle them the same way.
// Screen events carry less detail (no han/fu/yaku/names), marked with detail:false.

export const KEYS: { key: string; label: string; hint: string }[] = [
  { key: 'game_start', label: 'Game start', hint: 'The opening screen of a match' },
  { key: 'round_start', label: 'Round start', hint: 'The "East 1" style round banner' },
  { key: 'my_riichi', label: 'My riichi', hint: 'RIICHI banner on your (bottom) side' },
  { key: 'opponent_riichi', label: 'Opponent riichi', hint: 'RIICHI banner on any other side (teach one per side if needed)' },
  { key: 'my_call', label: 'My call (chi/pon/kan)', hint: 'Call banner on your side' },
  { key: 'my_win_ron', label: 'My ron', hint: 'RON banner on your side' },
  { key: 'my_win_tsumo', label: 'My tsumo', hint: 'TSUMO banner on your side' },
  { key: 'my_yakuman', label: 'My yakuman', hint: 'The yakuman result screen' },
  { key: 'dealt_in', label: 'I dealt in', hint: 'Anything that shows you paid a ron, e.g. your score turning red' },
  { key: 'opponent_tsumo', label: 'Opponent tsumo', hint: 'TSUMO banner on another side' },
  { key: 'opponent_ron_other', label: 'Opponent ron (not off me)', hint: 'RON banner on another side' },
  { key: 'draw', label: 'Draw (ryuukyoku)', hint: 'The draw banner' },
  { key: 'game_end_1', label: 'Finished 1st', hint: 'Final results showing you in 1st' },
  { key: 'game_end_2', label: 'Finished 2nd', hint: 'Final results showing you in 2nd' },
  { key: 'game_end_3', label: 'Finished 3rd', hint: 'Final results showing you in 3rd' },
  { key: 'game_end_4', label: 'Finished 4th', hint: 'Final results showing you in 4th' },
];

export function toGameEvent(key: string): Record<string, unknown> | null {
  const base = { source: 'mahjongsoul', via: 'screen', detail: false, ts: Date.now(), mySeat: 0 };
  const win = (isMe: boolean, method: 'ron' | 'tsumo', extra: Record<string, unknown> = {}) => ({
    ...base, type: 'win', seat: isMe ? 0 : 1, player: isMe ? 'Me' : 'Opponent', isMe, method,
    from: null, fromPlayer: null, dealtInByMe: false, han: null, fu: null, yakuman: false, yaku: [], points: null, deltas: [], scores: [], ...extra,
  });
  switch (key) {
    case 'game_start': return { ...base, type: 'game_start', players: [], playerCount: 4, me: 'Me' };
    case 'round_start': return { ...base, type: 'round_start', label: 'New round', wind: '', round: 0, honba: 0, riichiSticks: 0, dealer: -1, iAmDealer: false, scores: [], players: [] };
    case 'my_riichi': return { ...base, type: 'riichi', seat: 0, player: 'Me', isMe: true, double: false };
    case 'opponent_riichi': return { ...base, type: 'riichi', seat: 1, player: 'Opponent', isMe: false, double: false };
    case 'my_call': return { ...base, type: 'call', seat: 0, player: 'Me', isMe: true, call: 'a call', tiles: [] };
    case 'my_win_ron': return win(true, 'ron');
    case 'my_win_tsumo': return win(true, 'tsumo');
    case 'my_yakuman': return win(true, 'tsumo', { yakuman: true });
    case 'dealt_in': return win(false, 'ron', { dealtInByMe: true, fromPlayer: 'Me', from: 0 });
    case 'opponent_tsumo': return win(false, 'tsumo');
    case 'opponent_ron_other': return win(false, 'ron');
    case 'draw': return { ...base, type: 'draw', kind: 'exhaustive', reason: 'draw', tenpai: [], tenpaiPlayers: [], iAmTenpai: false, deltas: [] };
  }
  const m = /^game_end_([1-4])$/.exec(key);
  if (m) { const place = Number(m[1]); return { ...base, type: 'game_end', results: [], myPlace: place, myScore: null, playerCount: 4 }; }
  return null;
}

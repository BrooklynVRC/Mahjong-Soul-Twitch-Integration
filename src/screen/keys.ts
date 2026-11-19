// Everything the screen reader can be taught to recognise. Both apps key their reactions on these.
export const KEYS: { key: string; label: string; hint: string }[] = [
  { key: 'game_mode', label: 'Game mode (name it)', hint: 'Text that shows which mode/room you are in, e.g. the room name while a match loads. Name the template after the mode ("Gold Room · East"). Chat and Discord show that name.' },
  { key: 'game_start', label: 'Game start', hint: 'Something shown once when a match begins' },
  { key: 'round_start', label: 'Round start', hint: 'The round banner, e.g. "East 1"' },
  { key: 'any_riichi', label: 'Riichi (anyone, needs scores)', hint: 'RIICHI banner wherever it shows. Who declared it is worked out from the scores: the riichi player pays 1,000. Teach the score boxes first.' },
  { key: 'any_ron', label: 'Ron (anyone, needs scores)', hint: 'RON banner wherever it shows. Winner and payer are worked out from the score change. Teach the score boxes first.' },
  { key: 'any_tsumo', label: 'Tsumo (anyone, needs scores)', hint: 'TSUMO banner wherever it shows. The winner is worked out from the score change. Teach the score boxes first.' },
  { key: 'my_riichi', label: 'My riichi', hint: 'RIICHI banner on your (bottom) side' },
  { key: 'opponent_riichi', label: 'Opponent riichi', hint: 'RIICHI banner on another side (teach one per side)' },
  { key: 'my_call', label: 'My call (chi/pon/kan)', hint: 'Call banner on your side' },
  { key: 'my_win_ron', label: 'My ron', hint: 'RON banner on your side' },
  { key: 'my_win_tsumo', label: 'My tsumo', hint: 'TSUMO banner on your side' },
  { key: 'my_yakuman', label: 'My yakuman', hint: 'The yakuman result screen' },
  { key: 'dealt_in', label: 'I dealt in', hint: 'Something that shows you paid a ron, e.g. your score change turning red' },
  { key: 'opponent_tsumo', label: 'Opponent tsumo', hint: 'TSUMO banner on another side' },
  { key: 'opponent_ron_other', label: 'Opponent ron (not off me)', hint: 'RON banner on another side' },
  { key: 'draw', label: 'Draw (ryuukyoku)', hint: 'The draw banner' },
  { key: 'game_end_1', label: 'Finished 1st', hint: 'Final results marking you 1st' },
  { key: 'game_end_2', label: 'Finished 2nd', hint: 'Final results marking you 2nd' },
  { key: 'game_end_3', label: 'Finished 3rd', hint: 'Final results marking you 3rd' },
  { key: 'game_end_4', label: 'Finished 4th', hint: 'Final results marking you 4th' },
];

export const keyLabel = (k: string) => KEYS.find((x) => x.key === k)?.label ?? k;
export const placeOf = (k: string) => { const m = /^game_end_([1-4])$/.exec(k); return m ? Number(m[1]) : null; };

/** Keys that are only placeholders: the reader resolves them into real keys using the scores. */
export const GENERIC_KEYS = ['any_riichi', 'any_ron', 'any_tsumo'];
/** Keys apps react to (everything except the generic placeholders). */
export const EVENT_KEYS = KEYS.filter((k) => !GENERIC_KEYS.includes(k.key));

export interface Detection { key: string; name: string; score: number | null; manual: boolean }

/** Live game state, from score reading plus detections. */
export interface GameState {
  inGame: boolean;
  since: number | null;            // ms timestamp the current game started
  mode: string | null;             // name of the last "Game mode" template seen
  scores: { me: number | null; right: number | null; top: number | null; left: number | null };
  place: number | null;            // live placement from the scores
  lastResult: number | null;       // final placement of the last finished game
}

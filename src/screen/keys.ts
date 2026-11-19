// Everything the screen reader reports. Both apps key their reactions on these. Same file in both repos.
// `auto` = worked out from the score boxes alone (no banner template needed).
export const KEYS: { key: string; label: string; hint: string; auto?: boolean; banner?: boolean }[] = [
  { key: 'any_riichi', label: 'RIICHI banner (real time)', banner: true, hint: 'Teach the RIICHI call banner once, from any player. It is found anywhere on screen, and where it appears tells who called it.' },
  { key: 'any_ron', label: 'RON banner (real time)', banner: true, hint: 'Teach the RON call banner once, from any player. Where it appears tells who won; the scores add "I dealt in" a moment later.' },
  { key: 'any_tsumo', label: 'TSUMO banner (real time)', banner: true, hint: 'Teach the TSUMO call banner once, from any player. Where it appears tells who won.' },
  { key: 'any_pon', label: 'PON banner (real time)', banner: true, hint: 'Teach the PON call banner once, from any player. Where it appears tells who called it.' },
  { key: 'any_chi', label: 'CHI banner (real time)', banner: true, hint: 'Teach the CHI call banner once, from any player.' },
  { key: 'any_kan', label: 'KAN banner (real time)', banner: true, hint: 'Teach the KAN call banner once, from any player.' },
  { key: 'game_mode', label: 'Game mode (name it)', hint: 'Text that shows which mode/room you are in, e.g. the room name while a match loads. Name the template after the mode ("Gold Room · East"). Chat and Discord show that name.' },
  { key: 'game_start', label: 'Game start', auto: true, hint: 'Automatic from the scores (everyone on the starting score). A banner template is optional.' },
  { key: 'round_start', label: 'Round start', hint: 'The round banner, e.g. "East 1"' },
  { key: 'my_riichi', label: 'My riichi', auto: true, hint: 'Automatic from the scores (you pay 1,000). Optionally teach the RIICHI banner on your side.' },
  { key: 'opponent_riichi', label: 'Opponent riichi', auto: true, hint: 'Automatic from the scores (they pay 1,000).' },
  { key: 'my_pon', label: 'My pon', hint: 'Instant, from the PON banner on your side.' },
  { key: 'my_chi', label: 'My chi', hint: 'Instant, from the CHI banner on your side.' },
  { key: 'my_kan', label: 'My kan', hint: 'Instant, from the KAN banner on your side.' },
  { key: 'opponent_call', label: 'Opponent call (pon/chi/kan)', hint: 'Instant, from a PON/CHI/KAN banner on another side.' },
  { key: 'my_call', label: 'My call (any, legacy)', hint: 'A call banner taught only for your side (older setups).' },
  { key: 'my_win_ron', label: 'My ron', auto: true, hint: 'Automatic from the scores (you gain, one player pays).' },
  { key: 'my_win_tsumo', label: 'My tsumo', auto: true, hint: 'Automatic from the scores (you gain, everyone pays).' },
  { key: 'my_yakuman', label: 'My yakuman', hint: 'The yakuman result screen' },
  { key: 'dealt_in', label: 'I dealt in', auto: true, hint: 'Automatic from the scores (you pay, one opponent gains).' },
  { key: 'opponent_tsumo', label: 'Opponent tsumo', auto: true, hint: 'Automatic from the scores.' },
  { key: 'opponent_ron', label: 'Opponent ron', hint: 'Instant, from the RON banner (any opponent). Whether it was off you comes from the scores a moment later as "I dealt in".' },
  { key: 'opponent_ron_other', label: 'Opponent ron (not off me)', auto: true, hint: 'Automatic from the scores.' },
  { key: 'draw', label: 'Draw (ryuukyoku)', auto: true, hint: 'Automatic from the scores when 2+ players get noten payments. Teach the draw banner to catch every draw.' },
  { key: 'game_end_1', label: 'Finished 1st', auto: true, hint: 'Automatic from the last scores when the match ends. A results-screen template makes it instant.' },
  { key: 'game_end_2', label: 'Finished 2nd', auto: true, hint: 'Automatic from the last scores when the match ends.' },
  { key: 'game_end_3', label: 'Finished 3rd', auto: true, hint: 'Automatic from the last scores when the match ends.' },
  { key: 'game_end_4', label: 'Finished 4th', auto: true, hint: 'Automatic from the last scores when the match ends.' },
];

export const keyLabel = (k: string) => KEYS.find((x) => x.key === k)?.label ?? k;
export const placeOf = (k: string) => { const m = /^game_end_([1-4])$/.exec(k); return m ? Number(m[1]) : null; };
/** Banner keys found anywhere on screen; the reader turns them into the real event using the banner's position. */
export const BANNER_KEYS = KEYS.filter((k) => k.banner).map((k) => k.key);
/** Keys apps react to (the banner placeholders become real events before reaching the apps). */
export const EVENT_KEYS = KEYS.filter((k) => !k.banner);

export interface Detection { key: string; name: string; score: number | null; manual: boolean }

/** Live game state, from score reading plus detections. */
export interface GameState {
  inGame: boolean;
  since: number | null;            // ms timestamp the current game started
  mode: string | null;             // name of the last "Game mode" template seen
  scores: { me: number | null; right: number | null; top: number | null; left: number | null };
  place: number | null;            // live placement from the scores
  lastResult: number | null;       // final placement of the last finished game
  players: number;                 // 3 or 4 (from how many score boxes are readable)
}

// ==UserScript==
// @name         Mahjong Soul Stream Bridge
// @namespace    mahjong-soul-stream-bridge
// @version      1.0.0
// @description  Reads Mahjong Soul game events (read-only) and forwards them to local stream tools (Twitch app / Lovense app).
// @match        https://game.mahjongsoul.com/*
// @match        https://mahjongsoul.game.yo-star.com/*
// @match        https://game.maj-soul.com/*
// @match        https://game.maj-soul.net/*
// @run-at       document-start
// @grant        none
// @homepageURL  https://github.com/BrooklynVRC/Mahjong-Soul-Twitch-Integration
// @downloadURL  https://raw.githubusercontent.com/BrooklynVRC/Mahjong-Soul-Twitch-Integration/main/userscript/mahjong-soul-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/BrooklynVRC/Mahjong-Soul-Twitch-Integration/main/userscript/mahjong-soul-bridge.user.js
// ==/UserScript==

/*
 * READ-ONLY bridge. This script never sends anything to the game server and never
 * automates play. It only listens to the game's own WebSocket traffic, decodes a few
 * message types, and forwards simplified JSON events to apps running on your own PC.
 *
 * The same file ships in both repos (mahjong-soul-twitch and mahjong-soul-lovense).
 * Install it ONCE. By default it sends to both apps; whichever is running receives events.
 *
 * Debug: in the game tab's console run  localStorage.msbDebug = '1'  and reload.
 */

(function () {
  'use strict';

  // ---- Where to send events (edit if you change ports in the apps) ----
  var TARGETS = ['ws://127.0.0.1:7701/game', 'ws://127.0.0.1:7702/game'];

  // ---------------------------------------------------------------------
  // Minimal protobuf decoder (only what we need, no dependencies)
  // ---------------------------------------------------------------------
  var utf8 = new TextDecoder('utf-8');

  function Reader(buf) { this.b = buf; this.p = 0; }
  Reader.prototype.varint = function () {
    var result = 0, shift = 0, byte;
    do {
      if (this.p >= this.b.length) throw new Error('varint out of range');
      byte = this.b[this.p++];
      if (shift < 32) result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0; // low 32 bits
  };

  function parseFields(buf) {
    var f = {}, r = new Reader(buf);
    while (r.p < buf.length) {
      var key = r.varint(), no = key >>> 3, wt = key & 7, v;
      if (wt === 0) v = r.varint();
      else if (wt === 2) { var len = r.varint(); v = buf.subarray(r.p, r.p + len); r.p += len; }
      else if (wt === 5) { v = (buf[r.p] | buf[r.p + 1] << 8 | buf[r.p + 2] << 16 | buf[r.p + 3] << 24) >>> 0; r.p += 4; }
      else if (wt === 1) { v = 0; r.p += 8; }
      else throw new Error('unsupported wire type ' + wt);
      (f[no] || (f[no] = [])).push({ wt: wt, v: v });
    }
    return f;
  }

  function scalar(v, type) {
    if (type === 'i32') return v | 0;
    if (type === 'bool') return v !== 0;
    return v >>> 0;
  }
  function defaultFor(type) {
    if (typeof type === 'object') return null;
    if (type === 'str') return '';
    if (type === 'bool') return false;
    if (type === 'bytes') return null;
    return 0;
  }

  // schema: { fieldName: [fieldNumber, type, repeated?] }  type: 'u32'|'i32'|'bool'|'str'|'bytes'|schemaObject
  function decode(buf, schema) {
    var f = parseFields(buf), out = {};
    Object.keys(schema).forEach(function (key) {
      var spec = schema[key], no = spec[0], type = spec[1], rep = !!spec[2];
      var vals = f[no] || [], conv = [];
      vals.forEach(function (item) {
        if (typeof type === 'object') conv.push(decode(item.v, type));
        else if (type === 'str') conv.push(utf8.decode(item.v));
        else if (type === 'bytes') conv.push(item.v);
        else if (item.wt === 2) { var r = new Reader(item.v); while (r.p < item.v.length) conv.push(scalar(r.varint(), type)); }
        else conv.push(scalar(item.v, type));
      });
      out[key] = rep ? conv : (conv.length ? conv[conv.length - 1] : defaultFor(type));
    });
    return out;
  }

  // Mahjong Soul XORs the payload of ActionPrototype messages.
  var XOR_KEYS = [0x84, 0x5e, 0x4e, 0x42, 0x39, 0xa2, 0x1f, 0x60, 0x1c];
  function unmask(data) {
    var out = new Uint8Array(data.length);
    for (var i = 0; i < data.length; i++) {
      var u = ((23 ^ data.length) + 5 * i + XOR_KEYS[i % XOR_KEYS.length]) & 255;
      out[i] = data[i] ^ u;
    }
    return out;
  }

  // ---- Schemas (field numbers from the game's liqi.proto) ----
  var S = {};
  S.Wrapper = { name: [1, 'str'], data: [2, 'bytes'] };
  S.ActionPrototype = { step: [1, 'u32'], name: [2, 'str'], data: [3, 'bytes'] };
  S.ActionNewRound = { chang: [1, 'u32'], ju: [2, 'u32'], ben: [3, 'u32'], dora: [5, 'str'], scores: [6, 'i32', true], liqibang: [8, 'u32'], left_tile_count: [13, 'u32'], doras: [14, 'str', true] };
  S.ActionDiscardTile = { seat: [1, 'u32'], tile: [2, 'str'], is_liqi: [3, 'bool'], moqie: [5, 'bool'], is_wliqi: [9, 'bool'] };
  S.ActionChiPengGang = { seat: [1, 'u32'], type: [2, 'u32'], tiles: [3, 'str', true], froms: [4, 'u32', true] };
  S.ActionAnGangAddGang = { seat: [1, 'u32'], type: [2, 'u32'], tiles: [3, 'str'] };
  S.FanInfo = { name: [1, 'str'], val: [2, 'u32'], id: [3, 'u32'] };
  S.HuleInfo = { hand: [1, 'str', true], hu_tile: [3, 'str'], seat: [4, 'u32'], zimo: [5, 'bool'], qinjia: [6, 'bool'], liqi: [7, 'bool'], yiman: [10, 'bool'], count: [11, 'u32'], fans: [12, S.FanInfo, true], fu: [13, 'u32'], title: [14, 'str'], point_rong: [15, 'u32'], point_zimo_qin: [16, 'u32'], point_zimo_xian: [17, 'u32'], point_sum: [19, 'u32'] };
  S.ActionHule = { hules: [1, S.HuleInfo, true], old_scores: [2, 'i32', true], delta_scores: [3, 'i32', true], scores: [5, 'i32', true] };
  S.ActionLiuJu = { type: [1, 'u32'], seat: [3, 'u32'] };
  S.NoTilePlayerInfo = { tingpai: [3, 'bool'] };
  S.NoTileScoreInfo = { seat: [1, 'u32'], old_scores: [2, 'i32', true], delta_scores: [3, 'i32', true] };
  S.ActionNoTile = { liujumanguan: [1, 'bool'], players: [2, S.NoTilePlayerInfo, true], scores: [3, S.NoTileScoreInfo, true], gameend: [4, 'bool'] };
  S.PlayerGameView = { account_id: [1, 'u32'], nickname: [4, 'str'] };
  S.ReqAuthGame = { account_id: [1, 'u32'], game_uuid: [3, 'str'] };
  S.ResAuthGame = { players: [2, S.PlayerGameView, true], seat_list: [3, 'u32', true], is_game_start: [4, 'bool'], robots: [7, S.PlayerGameView, true] };
  S.PlayerItem = { seat: [1, 'u32'], total_point: [2, 'i32'], part_point_1: [3, 'i32'], grading_score: [5, 'i32'] };
  S.GameEndResult = { players: [1, S.PlayerItem, true] };
  S.NotifyGameEndResult = { result: [1, S.GameEndResult] };

  var WINDS = ['East', 'South', 'West', 'North'];
  var CALLS = { 0: 'chi', 1: 'pon', 2: 'kan' };
  var ABORTIVE = { 1: 'nine terminals', 2: 'four winds', 3: 'four kans', 4: 'four riichi', 5: 'triple ron' };
  var PLACES = ['1st', '2nd', '3rd', '4th'];

  // ---------------------------------------------------------------------
  // Game state + event normalization
  // ---------------------------------------------------------------------
  function createTracker(emit) {
    var st = { accountId: null, mySeat: null, players: [], pendingByIndex: {} };

    function nick(seat) { var p = st.players[seat]; return p ? p.nickname : ('Seat ' + seat); }
    function base(type, extra) {
      var ev = { source: 'mahjongsoul', type: type, ts: Date.now(), mySeat: st.mySeat };
      for (var k in extra) ev[k] = extra[k];
      return ev;
    }
    function isMe(seat) { return st.mySeat !== null && seat === st.mySeat; }

    function onAction(name, d) {
      switch (name) {
        case 'ActionMJStart':
          break;
        case 'ActionNewRound': {
          var a = decode(d, S.ActionNewRound);
          emit(base('round_start', {
            wind: WINDS[a.chang] || 'East', round: a.ju + 1, honba: a.ben, riichiSticks: a.liqibang,
            dealer: a.ju, label: (WINDS[a.chang] || 'East') + ' ' + (a.ju + 1), scores: a.scores,
            iAmDealer: isMe(a.ju), players: st.players
          }));
          break;
        }
        case 'ActionDiscardTile': {
          var t = decode(d, S.ActionDiscardTile);
          if (t.is_liqi || t.is_wliqi) emit(base('riichi', { seat: t.seat, player: nick(t.seat), double: t.is_wliqi, isMe: isMe(t.seat) }));
          break;
        }
        case 'ActionChiPengGang': {
          var c = decode(d, S.ActionChiPengGang);
          emit(base('call', { seat: c.seat, player: nick(c.seat), call: CALLS[c.type] || 'call', tiles: c.tiles, isMe: isMe(c.seat) }));
          break;
        }
        case 'ActionAnGangAddGang': {
          var g = decode(d, S.ActionAnGangAddGang);
          emit(base('call', { seat: g.seat, player: nick(g.seat), call: g.type === 3 ? 'closed kan' : 'added kan', tiles: [g.tiles], isMe: isMe(g.seat) }));
          break;
        }
        case 'ActionHule': {
          var h = decode(d, S.ActionHule);
          var winners = h.hules.map(function (x) { return x.seat; });
          var from = null;
          if (h.hules.length && !h.hules[0].zimo) {
            var min = 0;
            h.delta_scores.forEach(function (delta, seat) { if (winners.indexOf(seat) < 0 && delta < min) { min = delta; from = seat; } });
          }
          h.hules.forEach(function (x) {
            var han = x.count || x.fans.reduce(function (s, f) { return s + f.val; }, 0);
            emit(base('win', {
              seat: x.seat, player: nick(x.seat), isMe: isMe(x.seat), method: x.zimo ? 'tsumo' : 'ron',
              from: x.zimo ? null : from, fromPlayer: x.zimo || from === null ? null : nick(from),
              dealtInByMe: !x.zimo && from !== null && isMe(from),
              han: han, fu: x.fu, yakuman: x.yiman, yaku: x.fans.map(function (f) { return f.name; }),
              title: x.title, riichi: x.liqi, dealer: x.qinjia,
              points: h.delta_scores[x.seat] || 0, scores: h.scores, deltas: h.delta_scores
            }));
          });
          break;
        }
        case 'ActionNoTile': {
          var n = decode(d, S.ActionNoTile);
          var tenpai = [];
          n.players.forEach(function (p, seat) { if (p.tingpai) tenpai.push(seat); });
          var deltas = n.scores.length ? n.scores[0].delta_scores : [];
          emit(base('draw', {
            kind: 'exhaustive', reason: n.liujumanguan ? 'nagashi mangan' : 'exhaustive draw',
            tenpai: tenpai, tenpaiPlayers: tenpai.map(nick), iAmTenpai: st.mySeat !== null && tenpai.indexOf(st.mySeat) >= 0, deltas: deltas
          }));
          break;
        }
        case 'ActionLiuJu': {
          var l = decode(d, S.ActionLiuJu);
          emit(base('draw', { kind: 'abortive', reason: ABORTIVE[l.type] || 'abortive draw', tenpai: [], tenpaiPlayers: [], iAmTenpai: false, deltas: [] }));
          break;
        }
      }
    }

    function onNotify(name, data) {
      if (name === '.lq.ActionPrototype') {
        var ap = decode(data, S.ActionPrototype);
        onAction(ap.name, unmask(ap.data));
      } else if (name === '.lq.NotifyGameEndResult') {
        var r = decode(data, S.NotifyGameEndResult);
        var list = (r.result && r.result.players) || [];
        var results = list.map(function (p, i) {
          return { seat: p.seat, place: i + 1, placeText: PLACES[i], score: p.part_point_1, points: p.total_point, player: nick(p.seat), isMe: isMe(p.seat) };
        });
        var mine = results.filter(function (x) { return x.isMe; })[0] || null;
        emit(base('game_end', { results: results, myPlace: mine ? mine.place : null, myScore: mine ? mine.score : null, playerCount: results.length }));
      }
    }

    function onRequest(name, data) {
      if (name === '.lq.FastTest.authGame') {
        var q = decode(data, S.ReqAuthGame);
        st.accountId = q.account_id;
      }
    }

    function onResponse(name, data) {
      if (name === '.lq.FastTest.authGame') {
        var a = decode(data, S.ResAuthGame);
        var views = a.players.concat(a.robots);
        st.players = a.seat_list.map(function (id, seat) {
          var v = views.filter(function (p) { return p.account_id === id; })[0];
          return { seat: seat, accountId: id, nickname: v && v.nickname ? v.nickname : (id ? 'Player ' + id : 'Bot') };
        });
        st.mySeat = st.accountId !== null ? a.seat_list.indexOf(st.accountId) : -1;
        if (st.mySeat < 0) st.mySeat = null;
        emit(base('game_start', { players: st.players, playerCount: st.players.length, me: st.mySeat === null ? null : nick(st.mySeat) }));
      }
    }

    // frame: Uint8Array from a game WebSocket. pending: per-socket map of request index -> method name
    function handleFrame(u8, pending) {
      if (!u8 || u8.length < 2) return;
      var type = u8[0], w, idx;
      if (type === 1) { w = decode(u8.subarray(1), S.Wrapper); onNotify(w.name, w.data || new Uint8Array(0)); }
      else if (type === 2) { idx = u8[1] | (u8[2] << 8); w = decode(u8.subarray(3), S.Wrapper); pending[idx] = w.name; onRequest(w.name, w.data || new Uint8Array(0)); }
      else if (type === 3) { idx = u8[1] | (u8[2] << 8); var nm = pending[idx]; delete pending[idx]; if (nm) { w = decode(u8.subarray(3), S.Wrapper); onResponse(nm, w.data || new Uint8Array(0)); } }
    }

    return { handleFrame: handleFrame, state: st };
  }

  var api = { decode: decode, unmask: unmask, schemas: S, createTracker: createTracker, XOR_KEYS: XOR_KEYS };

  // Allow unit tests in Node to load this file without touching a browser.
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  // ---------------------------------------------------------------------
  // Browser side: hook WebSockets, forward events to local apps
  // ---------------------------------------------------------------------
  var debug = false;
  try { debug = localStorage.getItem('msbDebug') === '1'; } catch (e) { /* ignore */ }
  function log() { if (debug) console.log.apply(console, ['[MSB]'].concat([].slice.call(arguments))); }

  var OrigWS = window.WebSocket;

  function Outlet(url) {
    var self = this; self.url = url; self.ws = null; self.delay = 2000;
    self.open = function () {
      try { self.ws = new OrigWS(url); } catch (e) { return self.retry(); }
      self.ws.onopen = function () { self.delay = 2000; log('connected', url); };
      self.ws.onclose = function () { self.ws = null; self.retry(); };
      self.ws.onerror = function () { /* close follows */ };
    };
    self.retry = function () { setTimeout(self.open, self.delay); self.delay = Math.min(self.delay * 2, 30000); };
    self.send = function (text) { if (self.ws && self.ws.readyState === 1) self.ws.send(text); };
    self.open();
  }
  var outlets = TARGETS.map(function (u) { return new Outlet(u); });

  var tracker = createTracker(function (ev) {
    log(ev.type, ev);
    var text = JSON.stringify(ev);
    outlets.forEach(function (o) { o.send(text); });
  });

  function toU8(d) {
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    return null;
  }
  function safe(fn) { try { fn(); } catch (e) { log('decode error', e); } }

  function attach(ws) {
    var pending = {};
    ws.addEventListener('message', function (ev) {
      var d = ev.data;
      if (typeof Blob !== 'undefined' && d instanceof Blob) d.arrayBuffer().then(function (b) { safe(function () { tracker.handleFrame(new Uint8Array(b), pending); }); });
      else { var u8 = toU8(d); if (u8) safe(function () { tracker.handleFrame(u8, pending); }); }
    });
    var origSend = ws.send;
    ws.send = function (d) {
      var u8 = toU8(d);
      if (u8) safe(function () { tracker.handleFrame(u8, pending); });
      return origSend.apply(this, arguments);
    };
  }

  function HookedWS(url, protocols) {
    var ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    try { attach(ws); } catch (e) { log('attach failed', e); }
    return ws;
  }
  HookedWS.prototype = OrigWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { Object.defineProperty(HookedWS, k, { value: OrigWS[k] }); });
  window.WebSocket = HookedWS;
  log('installed; targets', TARGETS);
})();

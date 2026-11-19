// Tests the userscript's protobuf decoder + event normalization using hand-encoded frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../userscript/mahjong-soul-bridge.user.js', import.meta.url), 'utf8');
const mod = { exports: {} };
new Function('module', src)(mod);
const MSB = mod.exports;

// ---- tiny protobuf encoder ----
const enc = new TextEncoder();
function varint(n) {
  const out = [];
  let v = BigInt.asUintN(64, BigInt(n));
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return out;
}
const key = (no, wt) => varint((no << 3) | wt);
const fVar = (no, n) => [...key(no, 0), ...varint(n)];
const fBytes = (no, bytes) => [...key(no, 2), ...varint(bytes.length), ...bytes];
const fStr = (no, s) => fBytes(no, [...enc.encode(s)]);
const fPacked = (no, nums) => fBytes(no, nums.flatMap(varint));
const msg = (...fields) => fields.flat();

function mask(data) { // XOR is symmetric
  return [...MSB.unmask(Uint8Array.from(data))];
}
function notify(name, data) { return Uint8Array.from([1, ...msg(fStr(1, name), fBytes(2, data))]); }
function action(name, data) { return notify('.lq.ActionPrototype', msg(fVar(1, 1), fStr(2, name), fBytes(3, mask(data)))); }
function request(idx, name, data) { return Uint8Array.from([2, idx & 255, idx >> 8, ...msg(fStr(1, name), fBytes(2, data))]); }
function response(idx, data) { return Uint8Array.from([3, idx & 255, idx >> 8, ...msg(fStr(1, ''), fBytes(2, data))]); }

function setup() {
  const events = [];
  const t = MSB.createTracker((e) => events.push(e));
  const pending = {};
  const feed = (f) => t.handleFrame(f, pending);
  // auth: I am account 222 in seat 1
  feed(request(7, '.lq.FastTest.authGame', msg(fVar(1, 222), fStr(3, 'uuid'))));
  const view = (id, n) => fBytes(2, msg(fVar(1, id), fStr(4, n)));
  feed(response(7, msg(view(111, 'Alice'), view(222, 'Me'), view(333, 'Carol'), view(444, 'Dave'), fPacked(3, [111, 222, 333, 444]))));
  return { events, feed };
}

test('game_start identifies my seat and nicknames', () => {
  const { events } = setup();
  assert.equal(events[0].type, 'game_start');
  assert.equal(events[0].mySeat, 1);
  assert.deepEqual(events[0].players.map((p) => p.nickname), ['Alice', 'Me', 'Carol', 'Dave']);
});

test('round_start decodes wind, round, scores (packed int32)', () => {
  const { events, feed } = setup();
  feed(action('ActionNewRound', msg(fVar(1, 1), fVar(2, 2), fVar(3, 1), fPacked(6, [25000, 24000, 26000, 25000]), fVar(8, 1))));
  const e = events.at(-1);
  assert.equal(e.label, 'South 3');
  assert.equal(e.honba, 1);
  assert.equal(e.riichiSticks, 1);
  assert.deepEqual(e.scores, [25000, 24000, 26000, 25000]);
});

test('riichi from discard', () => {
  const { events, feed } = setup();
  feed(action('ActionDiscardTile', msg(fVar(1, 1), fStr(2, '5m'), fVar(3, 1))));
  feed(action('ActionDiscardTile', msg(fVar(1, 2), fStr(2, '1z')))); // plain discard: no event
  const r = events.filter((e) => e.type === 'riichi');
  assert.equal(r.length, 1);
  assert.equal(r[0].isMe, true);
});

test('ron: winner, deal-in source, negative deltas', () => {
  const { events, feed } = setup();
  const fan = (name, val) => fBytes(12, msg(fStr(1, name), fVar(2, val)));
  const hule = fBytes(1, msg(fVar(4, 0), fVar(5, 0), fVar(7, 1), fVar(11, 4), fan('Riichi', 1), fan('Dora', 3), fVar(13, 30)));
  feed(action('ActionHule', msg(hule, fPacked(3, [11600, -11600, 0, 0]), fPacked(5, [36600, 13400, 25000, 25000]))));
  const w = events.at(-1);
  assert.equal(w.type, 'win');
  assert.equal(w.method, 'ron');
  assert.equal(w.player, 'Alice');
  assert.equal(w.from, 1);
  assert.equal(w.dealtInByMe, true);
  assert.equal(w.han, 4);
  assert.equal(w.fu, 30);
  assert.equal(w.points, 11600);
  assert.deepEqual(w.yaku, ['Riichi', 'Dora']);
});

test('exhaustive draw with tenpai list', () => {
  const { events, feed } = setup();
  const p = (t) => fBytes(2, t ? fVar(3, 1) : []);
  feed(action('ActionNoTile', msg(p(false), p(true), p(true), p(false), fBytes(3, msg(fVar(1, 0), fPacked(3, [-1500, 1500, 1500, -1500]))))));
  const d = events.at(-1);
  assert.equal(d.type, 'draw');
  assert.deepEqual(d.tenpai, [1, 2]);
  assert.equal(d.iAmTenpai, true);
});

test('game_end placement', () => {
  const { events, feed } = setup();
  const item = (seat, score) => fBytes(1, msg(fVar(1, seat), fVar(3, score)));
  feed(notify('.lq.NotifyGameEndResult', fBytes(1, msg(item(2, 40000), item(1, 30000), item(0, 20000), item(3, 10000)))));
  const g = events.at(-1);
  assert.equal(g.type, 'game_end');
  assert.equal(g.myPlace, 2);
  assert.equal(g.myScore, 30000);
  assert.equal(g.results[0].player, 'Carol');
});

test('negative int32 non-packed decodes correctly', () => {
  const r = MSB.decode(Uint8Array.from(fVar(2, -5000)), { x: [2, 'i32'] });
  assert.equal(r.x, -5000);
});

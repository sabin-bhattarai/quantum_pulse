import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { GameServer } from '../src/server/GameServer.js';
import { MODES } from '../src/shared/constants.js';
import { validateHello } from '../src/shared/validation.js';
import { PROTOCOL_VERSION } from '../src/shared/constants.js';

const sink = () => ({ send() {}, snapshot() {} });

function server() {
  const gs = new GameServer({
    server: http.createServer(),
    config: { allowedOrigins: [], maxConnections: 50, maxRooms: 20, ffaArenas: ['neon_rupture'], ffaMaxPlayers: 12, ffaDuration: 300 },
  });
  return gs;
}

const hello = (mode, action, room = '') => {
  const r = validateHello({ t: 'hello', v: PROTOCOL_VERSION, name: 'T', mode, room, action });
  assert.ok(r.ok, r.error);
  return r.value;
};

test('co-op needs a room code: quick match is refused, create hands out a code, join uses it', () => {
  const gs = server();
  assert.match(gs.resolveRoom(hello(MODES.COOP, 'quick')).error, /room code/);
  const created = gs.resolveRoom(hello(MODES.COOP, 'create')).room;
  assert.match(created.code, /^[A-HJ-NP-Z2-9]{5}$/, 'a readable five-character code');
  created.join({ name: 'Host', token: null }, sink());
  assert.equal(gs.resolveRoom(hello(MODES.COOP, 'join', created.code)).room, created);
  assert.match(gs.resolveRoom(hello(MODES.COOP, 'join', 'ZZZZZ')).error, /No co-op room/);
  assert.match(gs.resolveRoom(hello(MODES.COOP, 'join')).error, /Enter a room code/);
  assert.equal(gs.listRooms().length, 0, 'co-op rooms are never listed');
  gs.wss.close();
});

test('free-for-all rooms are listed for everyone and joinable from the list or by code', () => {
  const gs = server();
  const mine = gs.resolveRoom(hello(MODES.FFA, 'create')).room;
  mine.join({ name: 'Host', token: null }, sink());
  const list = gs.listRooms();
  assert.equal(list.length, 1);
  assert.deepEqual({ ...list[0], phase: undefined }, { code: mine.code, arena: 'neon_rupture', players: 1, max: 12, phase: undefined, joinable: true });
  assert.equal(gs.resolveRoom(hello(MODES.FFA, 'join', mine.code)).room, mine, 'join by code');
  assert.equal(gs.resolveRoom(hello(MODES.FFA, 'quick')).room, mine, 'quick match fills the open room');
  const second = gs.resolveRoom(hello(MODES.FFA, 'create')).room;
  assert.notEqual(second, mine, 'create always opens a new room');
  assert.notEqual(second.code, mine.code);
  gs.wss.close();
});

test('hello actions are validated', () => {
  assert.equal(validateHello({ t: 'hello', v: PROTOCOL_VERSION, name: 'T', mode: 'ffa', action: 'steal' }).ok, false);
  assert.equal(hello(MODES.FFA, undefined, 'ABCDE').action, 'join', 'a code without an action joins');
  assert.equal(hello(MODES.FFA, undefined).action, 'quick');
});

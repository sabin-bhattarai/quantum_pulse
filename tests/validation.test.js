import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMessage, sanitizeName, validateHello, validateInputPacket, validateInputArray, validateUpgrade, validatePing,
} from '../src/shared/validation.js';
import { PROTOCOL_VERSION, NET, BTN_ALL, LIMITS } from '../src/shared/constants.js';

const goodInput = (seq) => [seq, 1, -1, 0.5, 0.2, 3, 0, 10];

test('parseMessage rejects malformed, oversized and unknown frames', () => {
  assert.equal(parseMessage('{not json').ok, false);
  assert.equal(parseMessage('[]').ok, false);
  assert.equal(parseMessage('{"x":1}').ok, false);
  assert.equal(parseMessage('{"t":"damage","amount":9999}').ok, false, 'clients cannot send damage');
  assert.equal(parseMessage('x'.repeat(NET.MAX_PACKET_BYTES + 1)).ok, false);
  assert.equal(parseMessage('{"t":"ping","c":1}').ok, true);
});

test('sanitizeName strips markup, control and bidi characters', () => {
  assert.equal(sanitizeName('<b>Alice</b>'), 'bAliceb'); // < > / removed, no markup survives
  assert.equal(sanitizeName('  a\u0000b\u202Ec  '), 'abc');
  assert.equal(sanitizeName('x'.repeat(50)).length, LIMITS.MAX_NAME_LENGTH);
  assert.match(sanitizeName(''), /^Runner-\d{4}$/);
  assert.match(sanitizeName(42), /^Runner-\d{4}$/);
  assert.ok(!/[<>&"'`]/.test(sanitizeName('"\'`&<>ok')));
});

test('validateHello enforces protocol, mode, fields and formats', () => {
  const base = { t: 'hello', v: PROTOCOL_VERSION, name: 'Neo', mode: 'ffa' };
  assert.equal(validateHello(base).ok, true);
  assert.equal(validateHello({ ...base, v: PROTOCOL_VERSION - 1 }).ok, false);
  assert.equal(validateHello({ ...base, mode: 'godmode' }).ok, false);
  assert.equal(validateHello({ ...base, admin: true }).ok, false, 'unknown fields are rejected');
  assert.equal(validateHello({ ...base, room: 'bad room!' }).ok, false);
  assert.equal(validateHello({ ...base, token: 'not-a-token' }).ok, false);
  assert.equal(validateHello({ ...base, arena: 'nowhere' }).ok, false);
  assert.equal(validateHello({ ...base, mode: 'survival' }).ok, false, 'offline modes are not accepted by the server');
  assert.equal(validateHello({ ...base, mode: 'survival' }, { allowOffline: true }).ok, true);
  const r = validateHello({ ...base, room: 'abc12' });
  assert.equal(r.value.room, 'ABC12');
});

test('validateInputArray clamps and rejects bad values', () => {
  const r = validateInputArray([1, 5, -5, 100, 9, 0, 0, 0]);
  assert.equal(r.ok, true);
  assert.equal(r.value.mx, 1);
  assert.equal(r.value.mz, -1);
  assert.ok(r.value.yaw > -Math.PI - 1e-9 && r.value.yaw <= Math.PI);
  assert.equal(r.value.pitch, 1.55);
  assert.equal(validateInputArray([1, 0, 0, NaN, 0, 0, 0, 0]).ok, false);
  assert.equal(validateInputArray([1, 0, 0, 0, 0, BTN_ALL + 1, 0, 0]).ok, false);
  assert.equal(validateInputArray([1, 0, 0, 0, 0, 0, 99, 0]).ok, false, 'unknown weapon index');
  assert.equal(validateInputArray([-1, 0, 0, 0, 0, 0, 0, 0]).ok, false);
  assert.equal(validateInputArray([1.5, 0, 0, 0, 0, 0, 0, 0]).ok, false);
  assert.equal(validateInputArray([1, 0, 0, 0, 0, 0, 0]).ok, false, 'wrong length');
  assert.equal(validateInputArray([1, 0, 0, '0', 0, 0, 0, 0]).ok, false, 'strings are not numbers');
});

test('validateInputPacket bounds count, order and fields', () => {
  assert.equal(validateInputPacket({ t: 'in', i: [goodInput(1), goodInput(2)] }).ok, true);
  assert.equal(validateInputPacket({ t: 'in', i: [] }).ok, false);
  assert.equal(validateInputPacket({ t: 'in', i: Array.from({ length: NET.MAX_INPUTS_PER_PACKET + 1 }, (_, k) => goodInput(k)) }).ok, false);
  assert.equal(validateInputPacket({ t: 'in', i: [goodInput(2), goodInput(1)] }).ok, false, 'out of order');
  assert.equal(validateInputPacket({ t: 'in', i: [goodInput(1)], pos: [0, 0, 0] }).ok, false, 'client positions are never accepted');
});

test('validateUpgrade and validatePing', () => {
  assert.equal(validateUpgrade({ t: 'up', c: 1 }).ok, true);
  assert.equal(validateUpgrade({ t: 'up', c: 99 }).ok, false);
  assert.equal(validateUpgrade({ t: 'up', c: 1, id: 'overclock' }).ok, false);
  assert.equal(validatePing({ t: 'ping', c: 123.4 }).ok, true);
  assert.equal(validatePing({ t: 'ping', c: 1, r: 99999 }).value.r, 5000);
  assert.equal(validatePing({ t: 'ping', c: 'x' }).ok, false);
});

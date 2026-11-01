import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { httpServer } from '../server/index.js';
import { parseMoxfieldUrl, moxfieldToText, importMoxfield } from '../server/moxfield.js';
import { hashPassword, verifyPassword } from '../server/auth.js';

let base;
before(async () => {
  httpServer.listen(0);
  await once(httpServer, 'listening');
  base = `http://localhost:${httpServer.address().port}`;
});
after(() => httpServer.close());

/** Cliente mínimo que guarda la cookie de sesión. */
function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  return { call, get cookie() { return cookie; } };
}

const resolved = {
  commanders: [{ name: 'Tymna the Weaver', image: 'https://img.test/t.jpg' }],
  cards: Array.from({ length: 99 }, (_, i) => ({ name: `Carta ${i}`, image: `https://img.test/${i}.jpg`, evil: '<script>' })),
};

test('contraseñas: hash scrypt verificable y distinto cada vez', () => {
  const a = hashPassword('secreta123');
  assert.notEqual(a, hashPassword('secreta123'));
  assert.equal(verifyPassword('secreta123', a), true);
  assert.equal(verifyPassword('otra-cosa', a), false);
});

test('registro, sesión, logout y login', async () => {
  const c = client();
  assert.equal((await c.call('POST', '/api/auth/register', { username: 'ab', password: 'x' })).status, 400);
  const reg = await c.call('POST', '/api/auth/register', { username: 'alejandro', password: 'blue-farm-2026' });
  assert.equal(reg.status, 201);
  assert.ok(c.cookie.startsWith('edh_sid='));
  assert.equal((await c.call('GET', '/api/auth/me')).body.user.username, 'alejandro');
  assert.equal((await client().call('POST', '/api/auth/register', { username: 'ALEJANDRO', password: 'otra-clave-123' })).status, 409, 'sin distinguir mayúsculas');

  await c.call('POST', '/api/auth/logout', {});
  assert.equal((await c.call('GET', '/api/auth/me')).body.user, null);
  assert.equal((await c.call('POST', '/api/auth/login', { username: 'alejandro', password: 'mala-clave-1' })).status, 401);
  const ok = await c.call('POST', '/api/auth/login', { username: 'Alejandro', password: 'blue-farm-2026' });
  assert.equal(ok.status, 200);
  assert.equal((await c.call('GET', '/api/auth/me')).body.user.username, 'alejandro');
});

test('límite de intentos de login', async () => {
  const c = client();
  await c.call('POST', '/api/auth/register', { username: 'victima', password: 'clave-segura-1' });
  const tries = [];
  for (let i = 0; i < 11; i++) tries.push((await client().call('POST', '/api/auth/login', { username: 'victima', password: `mala-${i}-xx` })).status);
  assert.equal(tries.at(-1), 429);
});

test('mazos: crear, listar, leer, actualizar y borrar; aislados por usuario', async () => {
  const c = client();
  await c.call('POST', '/api/auth/register', { username: 'jugador1', password: 'clave-de-prueba' });
  assert.equal((await client().call('GET', '/api/decks')).status, 401, 'sin sesión');

  const created = await c.call('POST', '/api/decks', { name: 'Blue Farm', commandersText: '1 Tymna the Weaver', listText: '1 Sol Ring', resolved });
  assert.equal(created.status, 201);
  assert.equal(created.body.deck.cardCount, 100);
  assert.equal(created.body.deck.commanders, 'Tymna the Weaver');
  const id = created.body.deck.id;

  const full = await c.call('GET', `/api/decks/${id}`);
  assert.equal(full.body.deck.resolved.cards.length, 99);
  assert.equal(full.body.deck.resolved.cards[0].evil, undefined, 'se sanean los campos');

  const upd = await c.call('PUT', `/api/decks/${id}`, { name: 'Blue Farm v2', resolved });
  assert.equal(upd.body.deck.name, 'Blue Farm v2');
  assert.equal((await c.call('GET', '/api/decks')).body.decks.length, 1);

  const other = client();
  await other.call('POST', '/api/auth/register', { username: 'jugador2', password: 'clave-de-prueba' });
  assert.equal((await other.call('GET', `/api/decks/${id}`)).status, 404, 'otro usuario no lo ve');
  assert.equal((await other.call('DELETE', `/api/decks/${id}`)).status, 404, 'ni lo borra');
  assert.equal((await other.call('GET', '/api/decks')).body.decks.length, 0);

  assert.equal((await c.call('POST', '/api/decks', { name: '', resolved })).status, 400);
  assert.equal((await c.call('POST', '/api/decks', { name: 'Vacío', resolved: { cards: [] } })).status, 400);
  assert.equal((await c.call('DELETE', `/api/decks/${id}`)).status, 200);
  assert.equal((await c.call('GET', '/api/decks')).body.decks.length, 0);
});

test('CSRF: se rechazan escrituras desde otro origen', async () => {
  const c = client();
  const res = await c.call('POST', '/api/auth/register', { username: 'csrf_test', password: 'clave-de-prueba' }, { Origin: 'https://malo.example' });
  assert.equal(res.status, 403);
});

test('el socket reconoce la cuenta y usa su nombre por defecto', async () => {
  const c = client();
  await c.call('POST', '/api/auth/register', { username: 'conCuenta', password: 'clave-de-prueba' });
  const s = connect(base, { transports: ['websocket'], extraHeaders: { Cookie: c.cookie } });
  try {
    const statePromise = once(s, 'state');
    await new Promise((r) => s.emit('createRoom', { name: '' }, r));
    const [state] = await statePromise;
    assert.equal(state.players[0].name, 'conCuenta');
  } finally {
    s.disconnect();
  }
});

test('Moxfield: ids desde links y conversión de formatos v2 y v3', () => {
  assert.equal(parseMoxfieldUrl('https://moxfield.com/decks/AbC123_xyz-9?tab=1'), 'AbC123_xyz-9');
  assert.equal(parseMoxfieldUrl('https://www.moxfield.com/decks/AbC123_xyz'), 'AbC123_xyz');
  assert.throws(() => parseMoxfieldUrl('https://evil.com/decks/AbC123'), /moxfield\.com/);
  assert.throws(() => parseMoxfieldUrl('no es un link'), /Pega un link/);

  const entry = (name, quantity = 1, set = 'cmr', cn = '51') => ({ quantity, card: { name, set, cn } });
  const v3 = { name: 'Blue Farm', boards: { commanders: { cards: { a: entry('Tymna the Weaver'), b: entry("Kraum, Ludevic's Opus", 1, 'c16', '28') } }, mainboard: { cards: { c: entry('Island', 4, 'unf', '236') } } } };
  const out3 = moxfieldToText(v3);
  assert.equal(out3.name, 'Blue Farm');
  assert.equal(out3.commandersText, "1 Tymna the Weaver (CMR) 51\n1 Kraum, Ludevic's Opus (C16) 28");
  assert.equal(out3.listText, '4 Island (UNF) 236');

  const v2 = { name: 'Viejo', commanders: { 'Tymna the Weaver': entry('Tymna the Weaver') }, mainboard: { 'Sol Ring': entry('Sol Ring', 1, 'c21', '263') } };
  assert.equal(moxfieldToText(v2).listText, '1 Sol Ring (C21) 263');
  assert.throws(() => moxfieldToText({}), /vacío/);
});

test('Moxfield: apagado sin autorización y usa el User-Agent cuando existe', async () => {
  await assert.rejects(importMoxfield('https://moxfield.com/decks/AbC123', { userAgent: '' }), (e) => e.status === 501);
  let seen;
  const fakeFetch = async (url, opts) => {
    seen = { url, ua: opts.headers['User-Agent'] };
    return { ok: true, status: 200, json: async () => ({ name: 'X', mainboard: { 'Sol Ring': { quantity: 1, card: { name: 'Sol Ring' } } } }) };
  };
  const deck = await importMoxfield('https://moxfield.com/decks/AbC123', { userAgent: 'EDHPlatform/1.0 (autorizado)', fetchImpl: fakeFetch });
  assert.equal(seen.url, 'https://api2.moxfield.com/v3/decks/all/AbC123');
  assert.equal(seen.ua, 'EDHPlatform/1.0 (autorizado)');
  assert.equal(deck.listText, '1 Sol Ring');
  const res = await fetch(`${base}/api/import/moxfield?url=https://moxfield.com/decks/AbC123`);
  assert.equal(res.status, 501, 'el endpoint está apagado sin MOXFIELD_USER_AGENT');
});

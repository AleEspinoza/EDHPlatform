import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { createRoom, addPlayer, applyAction, viewFor } from '../server/game.js';
import { httpServer } from '../server/index.js';

const deck = (n) => Array.from({ length: n }, (_, i) => ({ name: `Carta ${i}`, image: `https://img.test/${i}.jpg` }));

function setup() {
  const room = createRoom('TEST01');
  const a = addPlayer(room, 'Ale');
  const b = addPlayer(room, 'Rival');
  applyAction(room, a.id, { type: 'setDeck', cards: deck(99), commanders: [{ name: "K'rrik" }] });
  return { room, a, b };
}

test('cargar mazo: comandante en zona de mando y 99 en biblioteca', () => {
  const { a } = setup();
  assert.equal(a.zones.command.length, 1);
  assert.equal(a.zones.command[0].commander, true);
  assert.equal(a.zones.library.length, 99);
  assert.equal(a.life, 40);
});

test('robar, mulligan y moler', () => {
  const { room, a } = setup();
  applyAction(room, a.id, { type: 'draw', n: 7 });
  assert.equal(a.zones.hand.length, 7);
  applyAction(room, a.id, { type: 'mulligan' });
  assert.equal(a.zones.hand.length, 7);
  assert.equal(a.zones.library.length, 92);
  applyAction(room, a.id, { type: 'mill', n: 3 });
  assert.equal(a.zones.graveyard.length, 3);
});

test('jugar, tapear, enderezar, contadores y mover a cementerio', () => {
  const { room, a } = setup();
  applyAction(room, a.id, { type: 'draw', n: 1 });
  const iid = a.zones.hand[0].iid;
  applyAction(room, a.id, { type: 'move', iid, to: 'battlefield', x: 0.3, y: 0.6 });
  const card = a.zones.battlefield[0];
  assert.deepEqual([card.x, card.y], [0.3, 0.6]);
  applyAction(room, a.id, { type: 'tap', iid });
  assert.equal(card.tapped, true);
  applyAction(room, a.id, { type: 'counters', iid, delta: 2 });
  assert.equal(card.counters, 2);
  applyAction(room, a.id, { type: 'untapAll' });
  assert.equal(card.tapped, false);
  applyAction(room, a.id, { type: 'tap', iid });
  applyAction(room, a.id, { type: 'move', iid, to: 'graveyard' });
  assert.equal(a.zones.graveyard.at(-1).iid, iid);
  assert.equal(card.tapped, false, 'al salir del campo se resetea');
  assert.equal(card.counters, 0);
});

test('tope y fondo de biblioteca', () => {
  const { room, a } = setup();
  applyAction(room, a.id, { type: 'draw', n: 2 });
  const [c1, c2] = a.zones.hand;
  applyAction(room, a.id, { type: 'move', iid: c1.iid, to: 'library', position: 'top' });
  applyAction(room, a.id, { type: 'move', iid: c2.iid, to: 'library', position: 'bottom' });
  assert.equal(a.zones.library.at(-1).iid, c1.iid);
  assert.equal(a.zones.library[0].iid, c2.iid);
});

test('los tokens desaparecen al salir del campo', () => {
  const { room, a } = setup();
  applyAction(room, a.id, { type: 'token', name: 'Zombi 2/2' });
  const iid = a.zones.battlefield[0].iid;
  applyAction(room, a.id, { type: 'move', iid, to: 'graveyard' });
  assert.equal(a.zones.graveyard.length, 0);
  assert.equal(a.zones.battlefield.length, 0);
});

test('daño de comandante descuenta vida', () => {
  const { room, a, b } = setup();
  applyAction(room, b.id, { type: 'cmdDamage', source: a.id, delta: 7 });
  assert.equal(b.cmdDamage[a.id], 7);
  assert.equal(b.life, 33);
});

test('la vista oculta mano, biblioteca y cartas boca abajo del rival', () => {
  const { room, a, b } = setup();
  applyAction(room, a.id, { type: 'draw', n: 3 });
  const iid = a.zones.hand[0].iid;
  applyAction(room, a.id, { type: 'move', iid, to: 'battlefield', faceDown: true });
  const rivalView = viewFor(room, b.id).players.find((p) => p.id === a.id);
  assert.equal(rivalView.zones.hand.length, 0);
  assert.equal(rivalView.counts.hand, 2);
  assert.equal(rivalView.counts.library, 96);
  assert.equal(rivalView.zones.battlefield[0].name, undefined);
  const ownView = viewFor(room, a.id).players.find((p) => p.id === a.id);
  assert.equal(ownView.zones.hand.length, 2);
  assert.equal(ownView.zones.battlefield[0].name.startsWith('Carta'), true);
});

test('no se pueden manipular cartas de otro jugador', () => {
  const { room, a, b } = setup();
  applyAction(room, a.id, { type: 'draw', n: 1 });
  assert.throws(() => applyAction(room, b.id, { type: 'move', iid: a.zones.hand[0].iid, to: 'graveyard' }));
});

test('peek devuelve el tope primero', () => {
  const { room, a } = setup();
  const top = a.zones.library.at(-1);
  const res = applyAction(room, a.id, { type: 'peek', n: 3 });
  assert.equal(res.private.cards.length, 3);
  assert.equal(res.private.cards[0].iid, top.iid);
});

test('partida por sockets: crear sala, unirse, reconectar', async () => {
  httpServer.listen(0);
  await once(httpServer, 'listening');
  const url = `http://localhost:${httpServer.address().port}`;
  const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
  const s1 = connect(url, { transports: ['websocket'] });
  const s2 = connect(url, { transports: ['websocket'] });
  try {
    const created = await emit(s1, 'createRoom', { name: 'Ale' });
    assert.equal(created.ok, true);
    assert.match(created.code, /^[A-Z2-9]{6}$/);
    const joined = await emit(s2, 'joinRoom', { code: created.code.toLowerCase(), name: 'Rival' });
    assert.equal(joined.ok, true);

    const stateP = once(s2, 'state');
    await emit(s1, 'action', { type: 'setDeck', cards: deck(10), commanders: [] });
    const [state] = await stateP;
    assert.equal(state.players.length, 2);

    const bad = await emit(s2, 'joinRoom', { code: 'ZZZZZZ', name: 'x' });
    assert.equal(bad.ok, false);

    s1.disconnect();
    const s3 = connect(url, { transports: ['websocket'] });
    const back = await emit(s3, 'joinRoom', { code: created.code, token: created.token });
    assert.equal(back.playerId, created.playerId, 'reconecta al mismo asiento');
    s3.disconnect();
  } finally {
    s1.disconnect();
    s2.disconnect();
    httpServer.close();
  }
});

test('el log no filtra el nombre de una carta jugada boca abajo', () => {
  const { room, a } = setup();
  applyAction(room, a.id, { type: 'draw', n: 1 });
  const card = a.zones.hand[0];
  applyAction(room, a.id, { type: 'move', iid: card.iid, to: 'battlefield', faceDown: true });
  const last = room.log.at(-1).text;
  assert.equal(last.includes(card.name), false, last);
  assert.match(last, /mueve una carta de la mano al campo de batalla boca abajo/);
});

test('comandos de chat: moneda, dados y anuncios', () => {
  const { room, a } = setup();
  const coin = applyAction(room, a.id, { type: 'chat', text: '/moneda' });
  assert.match(coin.event.result, /^(cara|sello)$/);
  const d = applyAction(room, a.id, { type: 'chat', text: '/dado 2d6' });
  assert.equal(d.event.rolls.length, 2);
  assert.ok(d.event.total >= 2 && d.event.total <= 12);
  assert.equal(applyAction(room, a.id, { type: 'chat', text: '/d20' }).event.label, 'd20');
  assert.equal(applyAction(room, a.id, { type: 'chat', text: '/Respondo' }).event.ann, 'respond');
  assert.equal(applyAction(room, a.id, { type: 'chat', text: '/trigger' }).event.text, 'Tengo un trigger');
  applyAction(room, a.id, { type: 'chat', text: '/robar 3' });
  assert.equal(a.zones.hand.length, 3);
  assert.equal(applyAction(room, a.id, { type: 'chat', text: '/ayuda' }).private.kind, 'help');
  assert.throws(() => applyAction(room, a.id, { type: 'chat', text: '/inventado' }), /desconocido/);
});

test('anunciar trigger de una carta pública pero no de la mano', () => {
  const { room, a } = setup();
  applyAction(room, a.id, { type: 'draw', n: 2 });
  const [c1, c2] = a.zones.hand;
  assert.throws(() => applyAction(room, a.id, { type: 'announce', kind: 'trigger', iid: c1.iid }), /no es pública/);
  applyAction(room, a.id, { type: 'move', iid: c2.iid, to: 'battlefield' });
  const ev = applyAction(room, a.id, { type: 'announce', kind: 'trigger', iid: c2.iid }).event;
  assert.equal(ev.card.name, c2.name);
});

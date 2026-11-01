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

test('partida por sockets: exige cuenta, crear sala, unirse, reconectar, terminar y guardar historial', async () => {
  httpServer.listen(0);
  await once(httpServer, 'listening');
  const url = `http://localhost:${httpServer.address().port}`;
  const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
  const account = async (username) => {
    const res = await fetch(`${url}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'clave-de-prueba' }) });
    return res.headers.get('set-cookie').split(';')[0];
  };
  const cookieA = await account('ale_sock');
  const cookieB = await account('rival_sock');
  const anon = connect(url, { transports: ['websocket'] });
  const s1 = connect(url, { transports: ['websocket'], extraHeaders: { Cookie: cookieA } });
  const s2 = connect(url, { transports: ['websocket'], extraHeaders: { Cookie: cookieB } });
  try {
    const denied = await emit(anon, 'createRoom', {});
    assert.equal(denied.code, 'login', 'sin cuenta no se puede jugar');

    const created = await emit(s1, 'createRoom', {});
    assert.equal(created.ok, true);
    assert.match(created.code, /^[A-Z2-9]{6}$/);
    const joined = await emit(s2, 'joinRoom', { code: created.code.toLowerCase() });
    assert.equal(joined.ok, true);

    const stateP = once(s2, 'state');
    await emit(s1, 'action', { type: 'setDeck', cards: deck(10), commanders: [{ name: 'Tymna' }] });
    const [state] = await stateP;
    assert.deepEqual(state.players.map((p) => p.name), ['ale_sock', 'rival_sock']);
    await emit(s2, 'action', { type: 'setDeck', cards: deck(10), commanders: [{ name: "K'rrik" }] });

    const bad = await emit(s2, 'joinRoom', { code: 'ZZZZZZ' });
    assert.equal(bad.ok, false);

    s1.disconnect();
    const s3 = connect(url, { transports: ['websocket'], extraHeaders: { Cookie: cookieA } });
    const back = await emit(s3, 'joinRoom', { code: created.code });
    assert.equal(back.playerId, created.playerId, 'la cuenta vuelve a su mismo asiento');

    // Dos turnos y gana el rival
    await emit(s3, 'action', { type: 'passTurn' });
    await emit(s3, 'action', { type: 'passTurn' });
    const over = once(s3, 'event');
    const end = await emit(s3, 'action', { type: 'endGame', winner: joined.playerId, rematch: true });
    assert.equal(end.ok, true);
    const [ev] = await over;
    assert.equal(ev.winner, 'rival_sock');

    const games = await (await fetch(`${url}/api/games`, { headers: { Cookie: cookieA } })).json();
    assert.equal(games.games.length, 1);
    assert.equal(games.games[0].result, 'loss');
    assert.equal(games.games[0].turns, 2);
    assert.equal(games.games[0].myCommanders, 'Tymna');
    const stats = await (await fetch(`${url}/api/stats`, { headers: { Cookie: cookieB } })).json();
    assert.equal(stats.stats.wins, 1);
    assert.equal(stats.stats.winRate, 1);
    assert.equal(stats.stats.byCommander[0].commanders, "K'rrik");
    s3.disconnect();
  } finally {
    anon.disconnect();
    s1.disconnect();
    s2.disconnect();
    httpServer.close();
  }
});

test('fin de partida: empate, revancha y resumen', () => {
  const { room, a, b } = setup();
  applyAction(room, b.id, { type: 'setDeck', cards: deck(20), commanders: [] });
  applyAction(room, a.id, { type: 'passTurn' });
  applyAction(room, a.id, { type: 'draw', n: 5 });
  const res = applyAction(room, a.id, { type: 'endGame', rematch: true });
  assert.equal(res.record.result, 'draw');
  assert.equal(res.record.players.length, 2);
  assert.equal(room.turn, 0);
  assert.equal(a.zones.hand.length, 0, 'la revancha rebaraja');
  assert.equal(a.zones.library.length, 99);
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

// ---------- v0.3: adjuntar, control, zonas ajenas, solitario ----------
function playOne(room, p) {
  applyAction(room, p.id, { type: 'draw', n: 1 });
  const iid = p.zones.hand.at(-1).iid;
  applyAction(room, p.id, { type: 'move', iid, to: 'battlefield', x: 0.5, y: 0.5 });
  return p.zones.battlefield.find((c) => c.iid === iid);
}

test('adjuntar a un permanente propio o rival, y soltar cuando el anfitrión deja el campo', () => {
  const { room, a, b } = setup();
  applyAction(room, b.id, { type: 'setDeck', cards: deck(20), commanders: [] });
  const aura = playOne(room, a);
  const host = playOne(room, b);
  applyAction(room, a.id, { type: 'attach', iid: aura.iid, target: host.iid });
  assert.equal(aura.attachedTo, host.iid);
  assert.match(room.log.at(-1).text, /adjunta .* de Rival/);
  applyAction(room, b.id, { type: 'move', iid: host.iid, to: 'graveyard' });
  assert.equal(aura.attachedTo, null, 'se suelta al morir el anfitrión');
  assert.throws(() => applyAction(room, a.id, { type: 'attach', iid: aura.iid, target: aura.iid }), /sí misma/);
});

test('mover una carta adjunta la desadjunta; los ciclos se rechazan', () => {
  const { room, a } = setup();
  const x = playOne(room, a);
  const y = playOne(room, a);
  applyAction(room, a.id, { type: 'attach', iid: x.iid, target: y.iid });
  assert.throws(() => applyAction(room, a.id, { type: 'attach', iid: y.iid, target: x.iid }), /ciclo/);
  applyAction(room, a.id, { type: 'setPos', iid: x.iid, x: 0.1, y: 0.1 });
  assert.equal(x.attachedTo, null);
});

test('cambio de control: el controlador la maneja y al salir del campo vuelve al dueño', () => {
  const { room, a, b } = setup();
  const card = playOne(room, a);
  applyAction(room, a.id, { type: 'giveControl', iid: card.iid, to: b.id });
  assert.equal(b.zones.battlefield.at(-1).iid, card.iid);
  assert.throws(() => applyAction(room, a.id, { type: 'tap', iid: card.iid }), 'el dueño ya no la controla');
  applyAction(room, b.id, { type: 'tap', iid: card.iid });
  applyAction(room, b.id, { type: 'move', iid: card.iid, to: 'graveyard' });
  assert.equal(a.zones.graveyard.at(-1).iid, card.iid, 'va al cementerio del dueño');
  assert.equal(b.zones.graveyard.length, 0);
});

test('reiniciar devuelve las cartas cedidas y recupera las propias', () => {
  const { room, a, b } = setup();
  applyAction(room, b.id, { type: 'setDeck', cards: deck(20), commanders: [] });
  const mine = playOne(room, a);
  const theirs = playOne(room, b);
  applyAction(room, a.id, { type: 'giveControl', iid: mine.iid, to: b.id });
  applyAction(room, b.id, { type: 'giveControl', iid: theirs.iid, to: a.id });
  applyAction(room, a.id, { type: 'reset' });
  assert.equal(b.zones.battlefield.some((c) => c.iid === mine.iid), false);
  assert.equal(b.zones.battlefield.some((c) => c.iid === theirs.iid), true);
  assert.equal(a.zones.library.length, 99);
});

test('acciones sobre la zona de un rival quedan en el log', () => {
  const { room, a, b } = setup();
  applyAction(room, b.id, { type: 'setDeck', cards: deck(20), commanders: [] });
  applyAction(room, a.id, { type: 'targetZone', target: b.id, op: 'mill', n: 2 });
  assert.equal(b.zones.graveyard.length, 2);
  applyAction(room, a.id, { type: 'targetZone', target: b.id, op: 'exileTop', n: 1 });
  assert.equal(b.zones.exile.length, 1);
  applyAction(room, b.id, { type: 'draw', n: 3 });
  applyAction(room, a.id, { type: 'targetZone', target: b.id, op: 'discardRandom' });
  assert.equal(b.zones.hand.length, 2);
  assert.match(room.log.at(-1).text, /descarte al azar/);
  const req = applyAction(room, a.id, { type: 'targetZone', target: b.id, op: 'requestHand' });
  assert.equal(req.event.target, b.id);
  const rev = applyAction(room, a.id, { type: 'targetZone', target: b.id, op: 'revealTop', n: 2 });
  assert.equal(rev.event.cards.length, 2);
});

test('modo solitario: asientos controlados por el anfitrión', () => {
  const room = createRoom('SOLO01', { solo: true });
  const host = addPlayer(room, 'Ale');
  applyAction(room, host.id, { type: 'setDeck', cards: deck(99), commanders: [{ name: 'Tymna' }] });
  applyAction(room, host.id, { type: 'addSeat', name: 'Rival 1', copyDeck: true });
  const seat = room.players[1];
  assert.equal(seat.controlledBy, host.id);
  assert.equal(seat.zones.library.length, 99);
  applyAction(room, host.id, { type: 'draw', n: 7, seat: seat.id });
  assert.equal(seat.zones.hand.length, 7);
  assert.equal(host.zones.hand.length, 0);
  const view = viewFor(room, host.id).players.find((p) => p.id === seat.id);
  assert.equal(view.zones.hand.length, 7, 'el anfitrión ve la mano de sus asientos');
  const other = createRoom('X', {});
  const intruder = addPlayer(room, 'otro');
  assert.throws(() => applyAction(room, intruder.id, { type: 'draw', seat: seat.id }), /No controlas/);
  assert.throws(() => applyAction(other, addPlayer(other, 'z').id, { type: 'addSeat' }), /solitario/);
  applyAction(room, host.id, { type: 'removeSeat', target: seat.id });
  assert.equal(room.players.includes(seat), false);
});

// ---------- v0.7: mecánicas de los atajos de EDHPlay ----------
test('fuerza/resistencia, contadores en bloque, fases, maná, flechas, reacciones y fondo de biblioteca', () => {
  const { room, a, b } = setup();
  const x = playOne(room, a);
  const y = playOne(room, a);
  applyAction(room, a.id, { type: 'pt', iid: x.iid, dp: 1, dt: 0 });
  applyAction(room, a.id, { type: 'pt', iid: x.iid, dp: 0, dt: 2 });
  assert.deepEqual(x.ptMod, { p: 1, t: 2 });
  applyAction(room, a.id, { type: 'counters', iid: y.iid, delta: 3 });
  applyAction(room, a.id, { type: 'countersAll', op: 'double' });
  assert.equal(y.counters, 6);
  assert.equal(x.counters, 0, 'sin contadores no se toca');
  applyAction(room, a.id, { type: 'move', iid: x.iid, to: 'graveyard' });
  assert.equal(x.ptMod, null, 'se limpia al dejar el campo');

  applyAction(room, a.id, { type: 'phase' });
  assert.equal(viewFor(room, a.id).phaseName, 'Principal 1');
  assert.throws(() => applyAction(room, b.id, { type: 'phase' }), /activo/);
  applyAction(room, a.id, { type: 'mana', color: 'U', delta: 2 });
  assert.equal(a.mana.U, 2);
  applyAction(room, a.id, { type: 'arrow', from: y.iid, to: b.id });
  applyAction(room, a.id, { type: 'arrow', from: y.iid, to: { kind: 'zone', pid: b.id, zone: 'graveyard' } });
  applyAction(room, a.id, { type: 'arrow', from: y.iid, to: { kind: 'point', pid: b.id, x: 0.3, y: 0.7 } });
  applyAction(room, a.id, { type: 'arrow', from: y.iid, to: { kind: 'zone', pid: b.id, zone: 'hand' } });
  assert.equal(room.arrows.length, 4);
  assert.deepEqual(room.arrows[0].to, { kind: 'player', pid: b.id });
  assert.throws(() => applyAction(room, a.id, { type: 'arrow', from: y.iid, to: { kind: 'zone', pid: b.id, zone: 'bolsillo' } }), /Zona/);
  applyAction(room, a.id, { type: 'draw', n: 1 });
  assert.throws(() => applyAction(room, a.id, { type: 'arrow', from: a.zones.hand.at(-1).iid, to: b.id }), /vista/, 'no desde la mano');
  applyAction(room, a.id, { type: 'passTurn' });
  assert.equal(room.phase, 0);
  assert.equal(room.arrows.length, 0, 'las flechas se borran al pasar el turno');
  assert.equal(a.mana.U, 0);

  assert.equal(applyAction(room, a.id, { type: 'react', kind: 'think' }).event.emoji, '🤔');
  const bottom = a.zones.library[0];
  const res = applyAction(room, a.id, { type: 'peek', n: 2, from: 'bottom' });
  assert.equal(res.private.cards[0].iid, bottom.iid);
});

test('enviar mis cartas a las zonas de otro jugador', () => {
  const { room, a, b } = setup();
  applyAction(room, b.id, { type: 'setDeck', cards: deck(20), commanders: [] });
  applyAction(room, a.id, { type: 'draw', n: 3 });
  const [c1, c2, c3] = a.zones.hand;
  applyAction(room, a.id, { type: 'move', iid: c1.iid, to: 'battlefield', toPlayer: b.id, x: 0.2, y: 0.3 });
  const onB = b.zones.battlefield.find((c) => c.iid === c1.iid);
  assert.ok(onB, 'queda en el campo del rival');
  assert.deepEqual([onB.x, onB.y], [0.2, 0.3]);
  assert.match(room.log.at(-1).text, /al campo de batalla de Rival/);
  applyAction(room, a.id, { type: 'move', iid: c2.iid, to: 'graveyard', toPlayer: b.id });
  assert.equal(b.zones.graveyard.at(-1).iid, c2.iid);
  applyAction(room, a.id, { type: 'move', iid: c3.iid, to: 'library', toPlayer: b.id, position: 'top' });
  assert.equal(b.zones.library.at(-1).iid, c3.iid);
  // El rival la controla; al morir vuelve al cementerio de su dueño
  applyAction(room, b.id, { type: 'move', iid: c1.iid, to: 'graveyard' });
  assert.equal(a.zones.graveyard.at(-1).iid, c1.iid);
  // Del campo propio al de otro, conservando posición
  const mine = playOne(room, a);
  applyAction(room, a.id, { type: 'move', iid: mine.iid, to: 'battlefield', toPlayer: b.id, x: 0.6, y: 0.1 });
  assert.equal(b.zones.battlefield.at(-1).iid, mine.iid);
  assert.equal(a.zones.battlefield.some((c) => c.iid === mine.iid), false);
});

test('tapetes: color o imagen de assets/mats, visibles para todos', () => {
  const { room, a, b } = setup();
  applyAction(room, a.id, { type: 'setMat', mat: { kind: 'color', value: '#43A5BE' } });
  assert.deepEqual(viewFor(room, b.id).players[0].mat, { kind: 'color', value: '#43a5be' });
  applyAction(room, a.id, { type: 'setMat', mat: { kind: 'image', value: 'mats/forest.webp' } });
  assert.equal(a.mat.value, 'mats/forest.webp');
  assert.throws(() => applyAction(room, a.id, { type: 'setMat', mat: { kind: 'image', value: '../../server/db.js' } }), /inválido/);
  assert.throws(() => applyAction(room, a.id, { type: 'setMat', mat: { kind: 'color', value: 'red;background:url(x)' } }), /inválido/);
  applyAction(room, a.id, { type: 'setMat', mat: { kind: 'anim', value: 'lava-neon' } });
  assert.equal(a.mat.kind, 'anim');
  assert.throws(() => applyAction(room, a.id, { type: 'setMat', mat: { kind: 'anim', value: 'otra' } }), /inválido/);
  applyAction(room, a.id, { type: 'setMat', mat: null });
  assert.equal(a.mat, null);
});

// Motor de juego: estado autoritativo de una sala y aplicación de acciones.
// Convención de zonas ordenadas: el ÚLTIMO elemento del arreglo es el "tope".
import { randomUUID, randomInt } from 'node:crypto';

export const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];
export const MAX_PLAYERS = 6;
const STARTING_LIFE = 40;
const COLORS = ['#e2574c', '#4c8de2', '#4cc28a', '#e2b84c', '#a46ae2', '#e27ac4'];
const ZONE_FROM = {
  library: 'de la biblioteca', hand: 'de la mano', battlefield: 'del campo de batalla',
  graveyard: 'del cementerio', exile: 'del exilio', command: 'de la zona de mando',
};
const ZONE_TO = {
  library: 'al tope de la biblioteca', hand: 'a la mano', battlefield: 'al campo de batalla',
  graveyard: 'al cementerio', exile: 'al exilio', command: 'a la zona de mando',
};

export class GameError extends Error {}

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v, min, max, def) => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const frac = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : def;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v) => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null);
const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v) ? v.slice(0, 500) : null);

export const PHASES = ['Inicio', 'Principal 1', 'Combate', 'Principal 2', 'Final'];
export const REACTIONS = { up: '👍', think: '🤔', wow: '😮', cry: '😢' };
const MANA = ['W', 'U', 'B', 'R', 'G', 'C'];
const emptyMana = () => Object.fromEntries(MANA.map((m) => [m, 0]));

function emptyZones() {
  return Object.fromEntries(ZONES.map((z) => [z, []]));
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeCard(data, extra = {}) {
  return {
    iid: randomUUID(),
    name: str(data.name, 150) || 'Carta',
    image: httpsUrl(data.image),
    backImage: httpsUrl(data.backImage),
    typeLine: str(data.typeLine, 150),
    scryfallId: uuid(data.scryfallId),
    tokens: sanitizeTokens(data.tokens),
    ownerId: null,
    attachedTo: null, // iid del permanente al que está adjunta
    tapped: false,
    faceDown: false,
    transformed: false,
    counters: 0,
    ptMod: null, // { p, t } modificadores de fuerza/resistencia
    x: 0.05,
    y: 0.05,
    token: false,
    commander: false,
    ...extra,
  };
}

function sanitizeTokens(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 12).map((t) => ({ name: str(t?.name, 80), id: uuid(t?.id) })).filter((t) => t.name && t.id);
}

function resetCardState(card) {
  card.attachedTo = null;
  card.ptMod = null;
  card.tapped = false;
  card.faceDown = false;
  card.transformed = false;
  card.counters = 0;
}

export function createRoom(code, { solo = false } = {}) {
  return { code, solo, hostId: null, createdAt: Date.now(), lastActive: Date.now(), players: [], log: [], activePlayerId: null, turn: 0, gameStartedAt: null, phase: 0, arrows: [] };
}

export function addPlayer(room, name, { controlledBy = null, userId = null } = {}) {
  if (room.players.length >= MAX_PLAYERS) throw new GameError('La sala está llena');
  const used = new Set(room.players.map((p) => p.color));
  const player = {
    id: randomUUID(),
    token: randomUUID(),
    name: str(name, 24).trim() || `Jugador ${room.players.length + 1}`,
    color: COLORS.find((c) => !used.has(c)) ?? COLORS[0],
    life: STARTING_LIFE,
    poison: 0,
    cmdDamage: {},
    mana: emptyMana(),
    mat: null, // tapete elegido: { kind: 'color'|'image', value } (null = el de la taberna)
    zones: emptyZones(),
    deck: null, // lista original para reiniciar
    connected: true,
    controlledBy, // asiento extra del modo solitario, manejado por este jugador
    userId, // cuenta dueña del asiento (para el historial)
  };
  room.players.push(player);
  if (!room.activePlayerId) room.activePlayerId = player.id;
  if (!room.hostId) room.hostId = player.id;
  log(room, controlledBy ? `Se agregó el asiento ${player.name}` : `${player.name} se unió a la sala`);
  return player;
}

export function removePlayer(room, playerId) {
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return;
  const p = room.players[idx];
  releaseCards(room, p);
  room.players.splice(idx, 1);
  cleanupAttachments(room);
  for (const other of room.players) delete other.cmdDamage[p.id];
  if (room.hostId === p.id) room.hostId = room.players.find((o) => !o.controlledBy)?.id ?? null;
  if (room.activePlayerId === p.id) room.activePlayerId = room.players[idx % room.players.length]?.id ?? null;
  log(room, `${p.name} salió de la sala`);
}

export function log(room, text, kind = 'game') {
  room.log.push({ t: Date.now(), text, kind });
  if (room.log.length > 300) room.log.splice(0, room.log.length - 300);
}

function getPlayer(room, id) {
  const p = room.players.find((pl) => pl.id === id);
  if (!p) throw new GameError('Jugador no encontrado');
  return p;
}

function findCard(player, iid) {
  for (const zone of ZONES) {
    const index = player.zones[zone].findIndex((c) => c.iid === iid);
    if (index !== -1) return { zone, index, card: player.zones[zone][index] };
  }
  throw new GameError('Carta no encontrada');
}

function ownerOf(room, card, fallback) {
  return room.players.find((pl) => pl.id === card.ownerId) ?? fallback;
}

function allBattlefieldCards(room) {
  return room.players.flatMap((pl) => pl.zones.battlefield.map((card) => ({ card, controller: pl })));
}

/** Busca un permanente en el campo de cualquier jugador. */
function findOnAnyBattlefield(room, iid) {
  const hit = allBattlefieldCards(room).find((x) => x.card.iid === iid);
  if (!hit) throw new GameError('Ese permanente no está en el campo');
  return hit;
}

export const ANIM_MATS = new Set(['lava-atardecer', 'lava-oceano', 'lava-bosque', 'lava-neon', 'lava-magma', 'lava-aurora']);

/** Tapete: un color #rrggbb, una imagen dentro de assets/mats o un tapete animado. */
export function sanitizeMat(mat) {
  if (!mat || typeof mat !== 'object') return null;
  if (mat.kind === 'color' && /^#[0-9a-f]{6}$/i.test(mat.value)) return { kind: 'color', value: mat.value.toLowerCase() };
  if (mat.kind === 'anim' && ANIM_MATS.has(mat.value)) return { kind: 'anim', value: mat.value };
  if (mat.kind === 'image' && /^mats\/[\w.-]{1,80}\.(webp|png|jpe?g)$/i.test(mat.value) && !mat.value.includes('..')) return { kind: 'image', value: mat.value };
  throw new GameError('Tapete inválido');
}

/** Una carta visible para todos (campo, cementerio, exilio o mando) de cualquier jugador. */
function findPublicCard(room, iid) {
  for (const pl of room.players) {
    for (const zone of ['battlefield', 'graveyard', 'exile', 'command']) {
      const card = pl.zones[zone].find((c) => c.iid === iid);
      if (card) return { card, zone, owner: pl };
    }
  }
  throw new GameError('Esa carta no está a la vista');
}

const ARROW_ZONES = new Set(['library', 'hand', 'graveyard', 'exile', 'command', 'battlefield']);
function arrowTarget(room, t) {
  // Compatibilidad: un string es el iid de una carta o el id de un jugador.
  if (typeof t === 'string') t = room.players.some((pl) => pl.id === t) ? { kind: 'player', pid: t } : { kind: 'card', iid: t };
  if (!t || typeof t !== 'object') throw new GameError('Destino de flecha inválido');
  switch (t.kind) {
    case 'card':
      findPublicCard(room, str(t.iid, 64));
      return { kind: 'card', iid: str(t.iid, 64) };
    case 'player':
      return { kind: 'player', pid: getPlayer(room, str(t.pid, 64)).id };
    case 'zone': {
      if (!ARROW_ZONES.has(t.zone)) throw new GameError('Zona inválida');
      return { kind: 'zone', pid: getPlayer(room, str(t.pid, 64)).id, zone: t.zone };
    }
    case 'point':
      return { kind: 'point', pid: getPlayer(room, str(t.pid, 64)).id, x: frac(t.x, 0.5), y: frac(t.y, 0.5) };
    default:
      throw new GameError('Destino de flecha inválido');
  }
}

/** Suelta lo que estaba adjunto a una carta que deja el campo. */
function detachFrom(room, hostIid) {
  for (const { card } of allBattlefieldCards(room)) if (card.attachedTo === hostIid) card.attachedTo = null;
}

function cleanupAttachments(room) {
  const onField = new Set(allBattlefieldCards(room).map((x) => x.card.iid));
  for (const { card } of allBattlefieldCards(room)) if (card.attachedTo && !onField.has(card.attachedTo)) card.attachedTo = null;
}

/**
 * Devuelve a sus dueños las cartas ajenas que controla `p` y retira las cartas de `p`
 * que controlan otros. Se usa al reiniciar o salir de la sala.
 */
function releaseCards(room, p) {
  for (const q of room.players) {
    if (q === p) continue;
    for (const zone of ZONES) q.zones[zone] = q.zones[zone].filter((c) => c.ownerId !== p.id);
  }
  for (const zone of ZONES) {
    for (const c of p.zones[zone]) {
      const owner = ownerOf(room, c, p);
      if (owner !== p && !c.token) owner.zones.battlefield.push(c);
    }
  }
}

function battlefieldCard(player, iid) {
  const found = findCard(player, iid);
  if (found.zone !== 'battlefield') throw new GameError('La carta no está en el campo');
  return found.card;
}

// Nombre visible en el log: oculto si se mueve entre zonas ocultas o está boca abajo.
function publicName(card, from, to, faceDownAfter) {
  const hidden = new Set(['library', 'hand']);
  if (card.faceDown || faceDownAfter || (hidden.has(from) && hidden.has(to))) return 'una carta';
  return card.name;
}

function draw(room, p, n) {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const c = p.zones.library.pop();
    if (!c) break;
    p.zones.hand.push(c);
    drawn++;
  }
  return drawn;
}

function moveCard(room, p, iid, to, opts = {}) {
  if (!ZONES.includes(to)) throw new GameError('Zona inválida');
  const { zone: from, index, card } = findCard(p, iid);
  p.zones[from].splice(index, 1);
  // Destino: la zona de otro jugador si se pidió explícitamente; si no, al dejar el
  // campo la carta vuelve a las zonas de su dueño (cambio de control).
  const target = opts.toPlayer && opts.toPlayer !== p ? opts.toPlayer : null;
  const dest = target ?? (to === 'battlefield' ? p : ownerOf(room, card, p));
  if (from === 'battlefield' && to !== 'battlefield') detachFrom(room, card.iid);
  const entersFaceDown = from !== 'battlefield' && to === 'battlefield' && Boolean(opts.faceDown);
  const name = publicName(card, from, to, entersFaceDown);

  // Los tokens dejan de existir fuera del campo.
  if (card.token && to !== 'battlefield') {
    log(room, `${p.name}: el token ${card.name} deja de existir`);
    return;
  }
  if (from === 'battlefield' && to !== 'battlefield') resetCardState(card);
  if (from !== 'battlefield' && to === 'battlefield') {
    card.tapped = false;
    card.faceDown = Boolean(opts.faceDown);
  }
  if (to === 'library' || to === 'hand') card.faceDown = false;
  if (to === 'battlefield') {
    card.x = frac(opts.x, card.x);
    card.y = frac(opts.y, card.y);
  }

  if (opts.position === 'bottom') dest.zones[to].unshift(card);
  else dest.zones[to].push(card);

  if (from === to && to === 'battlefield' && dest === p) return; // solo reposicionó
  const where = to === 'library' && opts.position === 'bottom' ? 'al fondo de la biblioteca' : ZONE_TO[to];
  const whose = dest !== p ? ` de ${dest.name}` : '';
  log(room, `${p.name} mueve ${name} ${ZONE_FROM[from]} ${where}${whose}${entersFaceDown ? ' boca abajo' : ''}`);
}

export function sanitizeDeckCard(c) {
  return {
    name: str(c?.name, 150), image: httpsUrl(c?.image), backImage: httpsUrl(c?.backImage),
    typeLine: str(c?.typeLine, 150), scryfallId: uuid(c?.scryfallId), tokens: sanitizeTokens(c?.tokens),
  };
}

function setupDeck(room, p) {
  releaseCards(room, p);
  p.zones = emptyZones();
  p.zones.command = p.deck.commanders.map((c) => makeCard(c, { commander: true, ownerId: p.id }));
  p.zones.library = shuffle(p.deck.cards.map((c) => makeCard(c, { ownerId: p.id })));
  cleanupAttachments(room);
}

/** En el modo solitario, el anfitrión puede actuar por los asientos que controla. */
function resolveActor(room, playerId, seatId) {
  const p = getPlayer(room, playerId);
  if (!seatId || seatId === playerId) return p;
  const seat = getPlayer(room, str(seatId, 64));
  if (seat.controlledBy !== p.id) throw new GameError('No controlas ese asiento');
  return seat;
}

/**
 * Aplica una acción de un jugador. Devuelve { private } con datos que solo ve el actor
 * (p. ej. el contenido de la biblioteca) o { event } para difundir a toda la sala.
 */
export function applyAction(room, playerId, action) {
  if (!action || typeof action.type !== 'string') throw new GameError('Acción inválida');
  const p = resolveActor(room, playerId, action.seat);
  room.lastActive = Date.now();
  const a = action;

  switch (a.type) {
    case 'setDeck': {
      const cards = Array.isArray(a.cards) ? a.cards : [];
      const commanders = Array.isArray(a.commanders) ? a.commanders : [];
      if (cards.length + commanders.length > 300) throw new GameError('Mazo demasiado grande');
      if (cards.length === 0 && commanders.length === 0) throw new GameError('El mazo está vacío');
      p.deck = { cards: cards.map(sanitizeDeckCard), commanders: commanders.slice(0, 4).map(sanitizeDeckCard) };
      setupDeck(room, p);
      p.life = STARTING_LIFE;
      p.poison = 0;
      p.cmdDamage = {};
      const cmd = p.deck.commanders.map((c) => c.name).join(' + ') || 'sin comandante';
      log(room, `${p.name} cargó un mazo (${p.deck.cards.length + p.deck.commanders.length} cartas, ${cmd})`);
      return {};
    }
    case 'draw': {
      const n = int(a.n, 1, 30, 1);
      const drawn = draw(room, p, n);
      log(room, drawn === 0 ? `${p.name} intenta robar pero su biblioteca está vacía` : `${p.name} roba ${drawn} carta${drawn > 1 ? 's' : ''}`);
      return {};
    }
    case 'mill': {
      const n = int(a.n, 1, 100, 1);
      const milled = [];
      for (let i = 0; i < n; i++) {
        const c = p.zones.library.pop();
        if (!c) break;
        p.zones.graveyard.push(c);
        milled.push(c.name);
      }
      log(room, `${p.name} muele ${milled.length}: ${milled.join(', ') || '—'}`);
      return {};
    }
    case 'shuffle':
      shuffle(p.zones.library);
      log(room, `${p.name} baraja su biblioteca`);
      return {};
    case 'untapAll':
      for (const c of p.zones.battlefield) c.tapped = false;
      log(room, `${p.name} endereza todos sus permanentes`);
      return {};
    case 'mulligan': {
      p.zones.library.push(...p.zones.hand.splice(0));
      shuffle(p.zones.library);
      draw(room, p, 7);
      log(room, `${p.name} hace mulligan y roba 7`);
      return {};
    }
    case 'move':
      moveCard(room, p, str(a.iid, 64), a.to, {
        position: a.position, x: a.x, y: a.y, faceDown: a.faceDown,
        toPlayer: a.toPlayer ? getPlayer(room, str(a.toPlayer, 64)) : null,
      });
      return {};
    case 'tap': {
      const c = battlefieldCard(p, str(a.iid, 64));
      c.tapped = typeof a.value === 'boolean' ? a.value : !c.tapped;
      log(room, `${p.name} ${c.tapped ? 'gira' : 'endereza'} ${c.faceDown ? 'una carta boca abajo' : c.name}`);
      return {};
    }
    case 'flip': {
      const c = battlefieldCard(p, str(a.iid, 64));
      c.faceDown = !c.faceDown;
      log(room, c.faceDown ? `${p.name} pone ${c.name} boca abajo` : `${p.name} voltea boca arriba: ${c.name}`);
      return {};
    }
    case 'transform': {
      const c = battlefieldCard(p, str(a.iid, 64));
      if (!c.backImage) throw new GameError('Esta carta no tiene otra cara');
      c.transformed = !c.transformed;
      log(room, `${p.name} transforma ${c.name}`);
      return {};
    }
    case 'counters': {
      const c = battlefieldCard(p, str(a.iid, 64));
      c.counters = int(c.counters + int(a.delta, -99, 99, 0), -99, 999, 0);
      log(room, `${p.name}: ${c.name} queda con ${c.counters} contador${Math.abs(c.counters) === 1 ? '' : 'es'}`);
      return {};
    }
    case 'setPos': {
      const c = battlefieldCard(p, str(a.iid, 64));
      c.x = frac(a.x, c.x);
      c.y = frac(a.y, c.y);
      if (c.attachedTo && a.detach !== false) {
        c.attachedTo = null;
        log(room, `${p.name} desadjunta ${c.faceDown ? 'una carta' : c.name}`);
      }
      return {};
    }
    case 'attach': {
      const c = battlefieldCard(p, str(a.iid, 64));
      const { card: host, controller } = findOnAnyBattlefield(room, str(a.target, 64));
      if (host.iid === c.iid) throw new GameError('Una carta no puede adjuntarse a sí misma');
      for (let h = host; h; h = h.attachedTo && findOnAnyBattlefield(room, h.attachedTo).card) {
        if (h.attachedTo === c.iid) throw new GameError('Eso formaría un ciclo de adjuntos');
      }
      detachFrom(room, c.iid);
      c.attachedTo = host.iid;
      c.tapped = false;
      const hostName = host.faceDown ? 'una carta boca abajo' : host.name;
      log(room, `${p.name} adjunta ${c.faceDown ? 'una carta' : c.name} a ${hostName}${controller !== p ? ` de ${controller.name}` : ''}`);
      return {};
    }
    case 'detach': {
      const c = battlefieldCard(p, str(a.iid, 64));
      c.attachedTo = null;
      c.y = Math.min(1, c.y + 0.15);
      log(room, `${p.name} desadjunta ${c.faceDown ? 'una carta' : c.name}`);
      return {};
    }
    case 'giveControl': {
      const target = getPlayer(room, str(a.to, 64));
      if (target === p) throw new GameError('Ya controlas esa carta');
      const { index, card } = findCard(p, str(a.iid, 64));
      if (p.zones.battlefield[index] !== card) throw new GameError('Solo se puede ceder el control de permanentes');
      p.zones.battlefield.splice(index, 1);
      card.x = 0.4 + Math.random() * 0.2;
      card.y = 0.45;
      target.zones.battlefield.push(card);
      log(room, `${p.name} le da el control de ${card.faceDown ? 'una carta boca abajo' : card.name} a ${target.name}`);
      return {};
    }
    case 'targetZone':
      return targetZone(room, p, getPlayer(room, str(a.target, 64)), a.op, int(a.n, 1, 30, 1));
    case 'addSeat': {
      if (!room.solo) throw new GameError('Solo se pueden agregar asientos en modo solitario');
      if (p.controlledBy) throw new GameError('Agrega asientos desde tu propio jugador');
      const seat = addPlayer(room, str(a.name, 24).trim() || `Asiento ${room.players.length + 1}`, { controlledBy: p.id });
      if (p.deck && a.copyDeck) {
        seat.deck = structuredClone(p.deck);
        setupDeck(room, seat);
      }
      return {};
    }
    case 'removeSeat': {
      const seat = getPlayer(room, str(a.target, 64));
      if (seat.controlledBy !== p.id) throw new GameError('Ese asiento no es tuyo');
      removePlayer(room, seat.id);
      return {};
    }
    case 'token': {
      const name = str(a.name, 60).trim() || 'Token';
      const c = makeCard({ name, typeLine: str(a.typeLine, 150) || 'Token', image: a.image, backImage: a.backImage, scryfallId: a.scryfallId },
        { token: true, ownerId: p.id, x: frac(a.x, 0.45), y: frac(a.y, 0.4) });
      p.zones.battlefield.push(c);
      log(room, `${p.name} crea un token: ${name}`);
      return {};
    }
    case 'clone': {
      const src = battlefieldCard(p, str(a.iid, 64));
      const c = makeCard(src, { token: true, ownerId: p.id, x: Math.min(1, src.x + 0.04), y: Math.min(1, src.y + 0.04) });
      p.zones.battlefield.push(c);
      log(room, `${p.name} crea una copia de ${src.name}`);
      return {};
    }
    case 'life': {
      const delta = int(a.delta, -999, 999, 0);
      p.life += delta;
      log(room, `${p.name}: vida ${delta > 0 ? '+' : ''}${delta} → ${p.life}`);
      return {};
    }
    case 'poison': {
      p.poison = int(p.poison + int(a.delta, -20, 20, 0), 0, 99, 0);
      log(room, `${p.name}: veneno → ${p.poison}`);
      return {};
    }
    case 'cmdDamage': {
      // Daño de comandante RECIBIDO por p desde el comandante de `source`.
      const src = getPlayer(room, str(a.source, 64));
      const delta = int(a.delta, -99, 99, 0);
      const prev = p.cmdDamage[src.id] ?? 0;
      const next = Math.max(0, prev + delta);
      p.cmdDamage[src.id] = next;
      p.life -= next - prev; // el daño de comandante también es pérdida de vida
      log(room, `${p.name}: daño de comandante de ${src.name} → ${next} (vida ${p.life})`);
      return {};
    }
    case 'peek': {
      // Ver las N cartas del tope (0 = toda la biblioteca). Solo para el dueño.
      const n = int(a.n, 0, 300, 0);
      const lib = p.zones.library;
      const bottom = a.from === 'bottom';
      // Siempre ordenadas desde el tope; las del fondo, desde la más profunda hacia arriba.
      const cards = n === 0 ? lib.slice().reverse() : bottom ? lib.slice(0, n) : lib.slice(-n).reverse();
      log(room, n === 0 ? `${p.name} busca en su biblioteca` : `${p.name} mira las ${n} cartas del ${bottom ? 'fondo' : 'tope'} de su biblioteca`);
      return { private: { kind: 'library', n, from: bottom ? 'bottom' : 'top', cards } };
    }
    case 'reveal': {
      const { card } = findCard(p, str(a.iid, 64));
      log(room, `${p.name} revela ${card.name}`);
      return { event: { kind: 'reveal', player: p.name, card: { name: card.name, image: card.image } } };
    }
    case 'revealHand': {
      log(room, `${p.name} revela su mano: ${p.zones.hand.map((c) => c.name).join(', ') || 'vacía'}`);
      return { event: { kind: 'revealHand', player: p.name, cards: p.zones.hand.map((c) => ({ name: c.name, image: c.image })) } };
    }
    case 'roll':
      return rollDice(room, p, int(a.count, 1, 20, 1), int(a.sides, 2, 1000, 20));
    case 'coin':
      return flipCoin(room, p);
    case 'announce':
      return announce(room, p, a.kind, a.iid);
    case 'passTurn': {
      if (room.players.length === 0) return {};
      const idx = room.players.findIndex((pl) => pl.id === room.activePlayerId);
      const next = room.players[(idx + 1) % room.players.length];
      room.activePlayerId = next.id;
      room.turn += 1;
      room.phase = 0;
      room.arrows = [];
      for (const pl of room.players) pl.mana = emptyMana();
      room.gameStartedAt ??= Date.now();
      log(room, `Turno ${room.turn}: ${next.name}`);
      return {};
    }
    case 'endGame': {
      const winner = a.winner ? getPlayer(room, str(a.winner, 64)) : null;
      const record = gameRecord(room, winner ? 'win' : 'draw', winner);
      log(room, winner ? `🏆 ${winner.name} gana la partida (turno ${room.turn})` : `La partida termina en empate (turno ${room.turn})`, 'announce');
      room.turn = 0;
      room.gameStartedAt = null;
      if (a.rematch) {
        for (const pl of room.players) {
          if (!pl.deck) continue;
          setupDeck(room, pl);
          pl.life = STARTING_LIFE;
          pl.poison = 0;
          pl.cmdDamage = {};
        }
        log(room, 'Revancha: todos los mazos se barajan de nuevo');
      }
      return { record, event: { kind: 'gameOver', winner: winner?.name ?? null, color: winner?.color ?? null, by: p.name } };
    }
    case 'pt': {
      const c = battlefieldCard(p, str(a.iid, 64));
      const dp = int(a.dp, -20, 20, 0);
      const dt = int(a.dt, -20, 20, 0);
      const mod = { p: (c.ptMod?.p ?? 0) + dp, t: (c.ptMod?.t ?? 0) + dt };
      c.ptMod = mod.p || mod.t ? mod : null;
      const fmt = (v) => (v >= 0 ? `+${v}` : `${v}`);
      log(room, `${p.name}: ${c.faceDown ? 'una carta' : c.name} queda en ${fmt(mod.p)}/${fmt(mod.t)}`);
      return {};
    }
    case 'countersAll': {
      const op = a.op;
      if (!['inc', 'double', 'dec'].includes(op)) throw new GameError('Operación de contadores inválida');
      let changed = 0;
      for (const c of p.zones.battlefield) {
        if (!c.counters) continue;
        c.counters = op === 'inc' ? c.counters + 1 : op === 'dec' ? c.counters - 1 : c.counters * 2;
        changed++;
      }
      const verb = { inc: 'suma 1 contador a', double: 'duplica los contadores de', dec: 'quita 1 contador a' }[op];
      log(room, `${p.name} ${verb} ${changed} permanente${changed === 1 ? '' : 's'}`);
      return {};
    }
    case 'phase': {
      if (room.activePlayerId !== p.id && !p.controlledBy) throw new GameError('Solo el jugador activo avanza la fase');
      room.phase = (room.phase + 1) % PHASES.length;
      log(room, `Fase: ${PHASES[room.phase]}`);
      return {};
    }
    case 'mana': {
      const color = String(a.color);
      if (!MANA.includes(color)) throw new GameError('Color de maná inválido');
      p.mana[color] = int(p.mana[color] + int(a.delta, -20, 20, 0), 0, 99, 0);
      return {};
    }
    case 'clearMana':
      p.mana = emptyMana();
      return {};
    case 'arrow': {
      // Flecha desde una carta pública hacia cualquier cosa de la mesa: una carta, un
      // jugador, una zona (incluida la mano) o un punto del campo de un jugador.
      const from = str(a.from, 64);
      findPublicCard(room, from);
      const to = arrowTarget(room, a.to);
      if (room.arrows.length >= 40) room.arrows.shift();
      room.arrows.push({ id: randomUUID(), owner: p.id, color: p.color, from, to });
      return {};
    }
    case 'clearArrows':
      room.arrows = room.arrows.filter((ar) => ar.owner !== p.id);
      return {};
    case 'setMat': {
      p.mat = sanitizeMat(a.mat);
      return {};
    }
    case 'react': {
      const emoji = REACTIONS[a.kind];
      if (!emoji) throw new GameError('Reacción desconocida');
      return { event: { kind: 'react', pid: p.id, emoji } };
    }
    case 'reset': {
      if (!p.deck) throw new GameError('No hay mazo cargado');
      setupDeck(room, p);
      p.life = STARTING_LIFE;
      p.poison = 0;
      p.cmdDamage = {};
      log(room, `${p.name} reinicia su partida`);
      return {};
    }
    case 'chat': {
      const text = str(a.text, 300).trim();
      if (text.startsWith('/')) return chatCommand(room, p, text);
      if (text) log(room, `${p.name}: ${text}`, 'chat');
      return {};
    }
    default:
      throw new GameError(`Acción desconocida: ${a.type}`);
  }
}

// ---------- Historial ----------
/** Resumen de la partida para guardar en el historial de cada cuenta. */
export function gameRecord(room, result, winner = null) {
  const humans = room.players.filter((pl) => !pl.controlledBy);
  return {
    roomCode: room.code,
    solo: room.solo,
    startedAt: room.gameStartedAt ?? room.createdAt,
    endedAt: Date.now(),
    turns: room.turn,
    result,
    winnerName: winner?.name ?? null,
    players: humans.map((pl, seat) => ({
      userId: pl.userId,
      seat,
      name: pl.name,
      commanders: pl.deck?.commanders.map((c) => c.name).join(' + ') ?? '',
      isWinner: winner?.id === pl.id,
      life: pl.life,
    })),
  };
}

/** ¿Vale la pena guardar como «sin terminar» una partida al cerrarse la sala? */
export function hasGameInProgress(room) {
  return !room.solo && room.gameStartedAt !== null && room.players.filter((pl) => !pl.controlledBy && pl.deck).length >= 2;
}

// ---------- Acciones sobre zonas de otro jugador ----------
// Como en papel, se confía en los jugadores: todo queda en el log público.
function targetZone(room, p, target, op, n) {
  const lib = target.zones.library;
  const takeTop = (to) => {
    const moved = [];
    for (let i = 0; i < n && lib.length; i++) {
      const c = lib.pop();
      target.zones[to].push(c);
      moved.push(c.name);
    }
    return moved;
  };
  switch (op) {
    case 'mill': {
      const moved = takeTop('graveyard');
      log(room, `${p.name} muele ${moved.length} de la biblioteca de ${target.name}: ${moved.join(', ') || '—'}`);
      return {};
    }
    case 'exileTop': {
      const moved = takeTop('exile');
      log(room, `${p.name} exilia ${moved.length} del tope de la biblioteca de ${target.name}: ${moved.join(', ') || '—'}`);
      return {};
    }
    case 'revealTop': {
      const cards = lib.slice(-n).reverse().map((c) => ({ name: c.name, image: c.image }));
      log(room, `${p.name} revela el tope de la biblioteca de ${target.name}: ${cards.map((c) => c.name).join(', ') || '—'}`);
      return { event: { kind: 'revealHand', player: `Tope de la biblioteca de ${target.name}`, cards } };
    }
    case 'discardRandom': {
      if (!target.zones.hand.length) throw new GameError(`${target.name} no tiene cartas en la mano`);
      const [c] = target.zones.hand.splice(randomInt(target.zones.hand.length), 1);
      target.zones.graveyard.push(c);
      log(room, `${p.name} hace que ${target.name} descarte al azar: ${c.name}`);
      return {};
    }
    case 'requestHand':
      log(room, `${p.name} pide a ${target.name} que revele su mano`);
      return { event: { kind: 'handRequest', from: p.name, target: target.id } };
    default:
      throw new GameError('Acción de zona desconocida');
  }
}

// ---------- Dados, moneda, anuncios y comandos de chat ----------
export const ANNOUNCEMENTS = {
  respond: '¡Respondo!',
  trigger: 'Tengo un trigger',
  wait: '¡Espera!',
  ok: 'OK, sigue',
};

function rollDice(room, p, count, sides) {
  const rolls = Array.from({ length: count }, () => randomInt(sides) + 1);
  const total = rolls.reduce((s, r) => s + r, 0);
  const label = `${count > 1 ? count : ''}d${sides}`;
  log(room, `🎲 ${p.name} lanza ${label}: ${count > 1 ? `${rolls.join(' + ')} = ${total}` : total}`);
  return { event: { kind: 'dice', player: p.name, color: p.color, label, rolls, total } };
}

function flipCoin(room, p) {
  const result = randomInt(2) ? 'cara' : 'sello';
  log(room, `🪙 ${p.name} lanza una moneda: ${result}`);
  return { event: { kind: 'coin', player: p.name, color: p.color, result } };
}

function announce(room, p, kind, iid) {
  if (!ANNOUNCEMENTS[kind]) throw new GameError('Anuncio desconocido');
  let card = null;
  if (iid) {
    const found = findCard(p, str(iid, 64));
    if (found.zone === 'library' || found.zone === 'hand' || found.card.faceDown) throw new GameError('Esa carta no es pública');
    card = { name: found.card.name, image: found.card.image };
  }
  log(room, `📣 ${p.name}: ${ANNOUNCEMENTS[kind]}${card ? ` (${card.name})` : ''}`, 'announce');
  return { event: { kind: 'announce', ann: kind, text: ANNOUNCEMENTS[kind], player: p.name, color: p.color, card } };
}

const HELP = '/moneda · /dado [NdM] (ej. /dado, /d6, /dado 2d6) · /respondo · /trigger · /espera · /ok · /robar [n] · /enderezar · /barajar · /vida ±n';

function chatCommand(room, p, text) {
  const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/);
  const cmd = (rawCmd ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const arg = args.join(' ');
  const dice = (spec) => {
    const m = /^(\d{0,2})d(\d{1,4})$/i.exec(spec);
    if (!m) throw new GameError('Formato de dado: NdM, por ejemplo 2d6');
    return rollDice(room, p, int(m[1] || 1, 1, 20, 1), int(m[2], 2, 1000, 20));
  };
  if (/^\d{0,2}d\d{1,4}$/.test(cmd)) return dice(cmd);
  switch (cmd) {
    case 'moneda': case 'coin': case 'flip': return flipCoin(room, p);
    case 'dado': case 'roll': case 'r': return dice(arg || 'd20');
    case 'respondo': case 'respond': case 'resp': return announce(room, p, 'respond');
    case 'trigger': case 'trig': return announce(room, p, 'trigger');
    case 'espera': case 'wait': return announce(room, p, 'wait');
    case 'ok': case 'paso': return announce(room, p, 'ok');
    case 'robar': case 'draw': return applyAction(room, p.id, { type: 'draw', n: arg || 1 });
    case 'enderezar': case 'untap': return applyAction(room, p.id, { type: 'untapAll' });
    case 'barajar': case 'shuffle': return applyAction(room, p.id, { type: 'shuffle' });
    case 'vida': case 'life': {
      if (!/^[+-]?\d+$/.test(arg)) throw new GameError('Uso: /vida +3 o /vida -2');
      return applyAction(room, p.id, { type: 'life', delta: arg });
    }
    case 'ayuda': case 'help': case 'comandos':
      return { private: { kind: 'help', text: HELP } };
    default:
      throw new GameError(`Comando desconocido: /${rawCmd}. Escribe /ayuda`);
  }
}

const HIDDEN_CARD = (c) => ({
  iid: c.iid, faceDown: true, tapped: c.tapped, x: c.x, y: c.y, counters: c.counters, token: c.token,
  attachedTo: c.attachedTo, ownerId: c.ownerId, ptMod: c.ptMod,
});

/** Vista del estado para un jugador: oculta mano y biblioteca ajenas y cartas boca abajo. */
export function viewFor(room, viewerId) {
  return {
    code: room.code,
    activePlayerId: room.activePlayerId,
    turn: room.turn,
    gameStartedAt: room.gameStartedAt,
    phase: room.phase,
    phaseName: PHASES[room.phase],
    arrows: room.arrows,
    you: viewerId,
    solo: room.solo,
    hostId: room.hostId,
    log: room.log.slice(-150),
    players: room.players.map((p) => {
      const mine = p.id === viewerId || p.controlledBy === viewerId;
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        life: p.life,
        poison: p.poison,
        cmdDamage: p.cmdDamage,
        mana: p.mana,
        mat: p.mat,
        connected: p.connected,
        controlledBy: p.controlledBy,
        hasDeck: Boolean(p.deck),
        commanderNames: p.deck?.commanders.map((c) => c.name) ?? [],
        commanderImages: p.deck?.commanders.map((c) => c.image).filter(Boolean) ?? [],
        counts: Object.fromEntries(ZONES.map((z) => [z, p.zones[z].length])),
        zones: {
          hand: mine ? p.zones.hand : [],
          battlefield: p.zones.battlefield.map((c) => (c.faceDown && !mine ? HIDDEN_CARD(c) : c)),
          graveyard: p.zones.graveyard,
          exile: p.zones.exile,
          command: p.zones.command,
        },
      };
    }),
  };
}

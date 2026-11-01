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
const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v) ? v.slice(0, 500) : null);

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
    tapped: false,
    faceDown: false,
    transformed: false,
    counters: 0,
    x: 0.05,
    y: 0.05,
    token: false,
    commander: false,
    ...extra,
  };
}

function resetCardState(card) {
  card.tapped = false;
  card.faceDown = false;
  card.transformed = false;
  card.counters = 0;
}

export function createRoom(code) {
  return { code, createdAt: Date.now(), lastActive: Date.now(), players: [], log: [], activePlayerId: null, turn: 0 };
}

export function addPlayer(room, name) {
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
    zones: emptyZones(),
    deck: null, // lista original para reiniciar
    connected: true,
  };
  room.players.push(player);
  if (!room.activePlayerId) room.activePlayerId = player.id;
  log(room, `${player.name} se unió a la sala`);
  return player;
}

export function removePlayer(room, playerId) {
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return;
  const [p] = room.players.splice(idx, 1);
  for (const other of room.players) delete other.cmdDamage[p.id];
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

  if (opts.position === 'bottom') p.zones[to].unshift(card);
  else p.zones[to].push(card);

  if (from === to && to === 'battlefield') return; // solo reposicionó
  const where = to === 'library' && opts.position === 'bottom' ? 'al fondo de la biblioteca' : ZONE_TO[to];
  log(room, `${p.name} mueve ${name} ${ZONE_FROM[from]} ${where}${entersFaceDown ? ' boca abajo' : ''}`);
}

function sanitizeDeckCard(c) {
  return { name: str(c?.name, 150), image: httpsUrl(c?.image), backImage: httpsUrl(c?.backImage), typeLine: str(c?.typeLine, 150) };
}

function setupDeck(p) {
  p.zones = emptyZones();
  p.zones.command = p.deck.commanders.map((c) => makeCard(c, { commander: true }));
  p.zones.library = shuffle(p.deck.cards.map((c) => makeCard(c)));
}

/**
 * Aplica una acción de un jugador. Devuelve { private } con datos que solo ve el actor
 * (p. ej. el contenido de la biblioteca) o { event } para difundir a toda la sala.
 */
export function applyAction(room, playerId, action) {
  if (!action || typeof action.type !== 'string') throw new GameError('Acción inválida');
  const p = getPlayer(room, playerId);
  room.lastActive = Date.now();
  const a = action;

  switch (a.type) {
    case 'setDeck': {
      const cards = Array.isArray(a.cards) ? a.cards : [];
      const commanders = Array.isArray(a.commanders) ? a.commanders : [];
      if (cards.length + commanders.length > 300) throw new GameError('Mazo demasiado grande');
      if (cards.length === 0 && commanders.length === 0) throw new GameError('El mazo está vacío');
      p.deck = { cards: cards.map(sanitizeDeckCard), commanders: commanders.slice(0, 4).map(sanitizeDeckCard) };
      setupDeck(p);
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
      moveCard(room, p, str(a.iid, 64), a.to, { position: a.position, x: a.x, y: a.y, faceDown: a.faceDown });
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
      return {};
    }
    case 'token': {
      const name = str(a.name, 60).trim() || 'Token';
      const c = makeCard({ name, typeLine: 'Token', image: a.image }, { token: true, x: 0.45, y: 0.4 });
      p.zones.battlefield.push(c);
      log(room, `${p.name} crea un token: ${name}`);
      return {};
    }
    case 'clone': {
      const src = battlefieldCard(p, str(a.iid, 64));
      const c = makeCard(src, { token: true, x: Math.min(1, src.x + 0.04), y: Math.min(1, src.y + 0.04) });
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
      const cards = (n === 0 ? lib.slice() : lib.slice(-n)).reverse(); // tope primero
      log(room, n === 0 ? `${p.name} busca en su biblioteca` : `${p.name} mira las ${n} cartas del tope de su biblioteca`);
      return { private: { kind: 'library', n, cards } };
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
      log(room, `Turno ${room.turn}: ${next.name}`);
      return {};
    }
    case 'reset': {
      if (!p.deck) throw new GameError('No hay mazo cargado');
      setupDeck(p);
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

const HIDDEN_CARD = (c) => ({ iid: c.iid, faceDown: true, tapped: c.tapped, x: c.x, y: c.y, counters: c.counters, token: c.token });

/** Vista del estado para un jugador: oculta mano y biblioteca ajenas y cartas boca abajo. */
export function viewFor(room, viewerId) {
  return {
    code: room.code,
    activePlayerId: room.activePlayerId,
    turn: room.turn,
    you: viewerId,
    log: room.log.slice(-150),
    players: room.players.map((p) => {
      const mine = p.id === viewerId;
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        life: p.life,
        poison: p.poison,
        cmdDamage: p.cmdDamage,
        connected: p.connected,
        hasDeck: Boolean(p.deck),
        commanderNames: p.deck?.commanders.map((c) => c.name) ?? [],
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

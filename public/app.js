// Cliente de EDH Platform: lobby, tablero, arrastrar y soltar, menús y modales.
import { parseDeckList, resolveDeck, fetchCard, fetchRulings, searchTokens, toCardData } from './deck.js';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    } else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
};

const store = {
  get(k, def = null) { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* sin almacenamiento */ } },
};

// ---------- Arte (public/assets) ----------
// Cada imagen es opcional: si existe (.webp o .png) se expone como variable CSS --a-<nombre>
// y clase .has-<nombre> en <html>; si no, la interfaz usa su respaldo dibujado con CSS.
const ASSETS = [
  'table', 'lobby', 'card-back', 'hand-tray',
  'mats/tavern', 'mats/crypt', 'mats/forest', 'mats/arcane', 'mats/volcano', 'mats/sea',
  'zones/frame', 'zones/deck', 'zones/graveyard', 'zones/exile', 'zones/command', 'zones/deck-stack',
  'hero/frame', 'hero/life', 'hero/poison', 'hero/commander',
  'ui/end-turn', 'ui/end-turn-active', 'ui/coin-heads', 'ui/coin-tails', 'ui/d20',
  'banners/trigger', 'banners/respond', 'banners/wait', 'banners/ok', 'banners/your-turn', 'banners/victory',
];
const assetUrls = {};
const assetSlug = (name) => name.replace(/\//g, '-');
let matImages = []; // imágenes disponibles en assets/mats
const assetsReady = fetch('/assets-manifest.json').then((r) => r.json()).then(({ files }) => {
  const have = new Set(files);
  matImages = files.filter((f) => f.startsWith('mats/'));
  for (const name of ASSETS) {
    const file = ['webp', 'png', 'jpg'].map((ext) => `${name}.${ext}`).find((f) => have.has(f));
    if (!file) continue;
    const url = `/assets/${file}`;
    assetUrls[name] = url;
    document.documentElement.style.setProperty(`--a-${assetSlug(name)}`, `url("${url}")`);
    document.documentElement.classList.add(`has-${assetSlug(name)}`);
  }
}).catch(() => { /* sin arte: se usan los respaldos */ });
const asset = (name) => assetUrls[name] ?? null;

const socket = io({ transports: ['websocket', 'polling'] });
let state = null; // última vista recibida del servidor
let session = store.get('edh.session'); // { code, token, name }
let hovered = null; // { iid, zone, owner } bajo el mouse (para atajos)
let zoneView = null; // { pid, zone } | { library: true, pid, cards, n }
let handSeat = null; // asiento cuya mano se muestra (modo solitario)
let targeting = null; // { iid, pid, name } mientras se elige a qué adjuntar
let deckFor = null; // asiento al que se le carga el mazo
let tokenFor = null; // { pid, x, y } para el modal de tokens
let account = null; // { id, username } si hay sesión
let editingDeck = null; // id del mazo guardado que se está editando
let moxEnabled = null; // importador de Moxfield disponible en el servidor

const ZONE_NAMES = { library: 'Biblioteca', hand: 'Mano', battlefield: 'Campo', graveyard: 'Cementerio', exile: 'Exilio', command: 'Zona de mando' };

// ---------- Comunicación ----------
function send(action) {
  return new Promise((resolve) => {
    socket.emit('action', action, (res) => {
      if (!res?.ok) toast(res?.error ?? 'Error', true);
      resolve(res);
    });
  });
}
/** Envía una acción en nombre de un asiento que controlo (yo o un asiento del modo solitario). */
const act = (pid, action) => send(pid && pid !== state?.you ? { ...action, seat: pid } : action);
const emit = (ev, data) => new Promise((r) => socket.emit(ev, data, r));

function showScreen(name) {
  for (const id of ['login', 'lobby', 'room']) $(`#${id}`).classList.toggle('hidden', id !== name);
}

async function enterRoom(res) {
  if (!res?.ok) {
    if (res?.code === 'login') return showScreen('login'), false;
    $('#lobby-error').textContent = res?.error ?? 'No se pudo entrar';
    return false;
  }
  session = { code: res.code, token: res.token };
  store.set('edh.session', session);
  history.replaceState(null, '', `?sala=${res.code}`);
  showScreen('room');
  return true;
}

socket.on('connect', async () => {
  if (!account) return; // sin sesión no hay sala a la cual volver
  // Reconexión automática al asiento si había sesión en esta sala.
  const urlCode = new URLSearchParams(location.search).get('sala')?.toUpperCase();
  if (session?.token && (!urlCode || urlCode === session.code)) {
    const res = await emit('joinRoom', { code: session.code, token: session.token });
    if (!(await enterRoom(res))) {
      store.del('edh.session');
      session = null;
      $('#lobby-error').textContent = '';
      if (urlCode) $('#lobby-code').value = urlCode;
    }
  } else if (urlCode) {
    $('#lobby-code').value = urlCode;
  }
});
socket.on('disconnect', () => toast('Conexión perdida, reintentando…', true));
socket.on('state', (s) => {
  const first = !state;
  state = s;
  if (!handSeat || !isMine(handSeat)) handSeat = state.you;
  render();
  if (first) {
    const saved = store.get('edh.mat.v2', null);
    if (saved && JSON.stringify(saved.mat) !== JSON.stringify(me()?.mat ?? null)) send({ type: 'setMat', mat: saved.mat });
  }
  if (first && !me()?.hasDeck) openDeckModal(state.you);
});
socket.on('event', (ev) => {
  if (ev.kind === 'announce') return showAnnouncement(ev);
  if (ev.kind === 'gameOver') return showGameOver(ev);
  if (ev.kind === 'react') return showReaction(ev);
  if (ev.kind === 'coin') return showCoin(ev);
  if (ev.kind === 'dice') return showDice(ev);
  if (ev.kind === 'reveal') return toastCards(`${ev.player} revela`, [ev.card]);
  if (ev.kind === 'revealHand') return toastCards(ev.player.startsWith('Tope') ? ev.player : `${ev.player} revela su mano`, ev.cards);
  if (ev.kind === 'handRequest' && isMine(ev.target)) return handRequestToast(ev);
});

// ---------- API REST ----------
async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? `Error ${res.status}`), { status: res.status });
  return json;
}

// ---------- Cuenta ----------
let accMode = 'login';
function renderAccount() {
  $('#acc-name').textContent = account?.displayName ?? account?.username ?? '';
  const av = $('#me-avatar');
  av.style.backgroundImage = account?.avatar ? `url("${account.avatar}")` : '';
  av.textContent = account?.avatar ? '' : (account?.displayName ?? account?.username ?? '?').slice(0, 1).toUpperCase();
}
async function refreshAccount() {
  try { account = (await api('GET', '/auth/me')).user; } catch { account = null; }
  renderAccount();
  if (!account) return showScreen('login');
  if ($('#room').classList.contains('hidden')) {
    showScreen('lobby');
    loadHome();
  }
  if (socket.connected) socket.disconnect().connect(); // el socket toma la cookie de sesión
}
async function initLogin() {
  const params = new URLSearchParams(location.search);
  const loginError = params.get('login_error');
  if (loginError) {
    $('#acc-error').textContent = loginError;
    params.delete('login_error');
    history.replaceState(null, '', params.toString() ? `?${params}` : '/');
  }
  try {
    const { google } = await api('GET', '/auth/providers');
    $('#btn-google').classList.toggle('hidden', !google);
    $('#login-divider').classList.toggle('hidden', !google);
  } catch { /* sin proveedores extra */ }
}
document.querySelectorAll('#acc-form [data-mode]').forEach((b) => b.addEventListener('click', () => {
  accMode = b.dataset.mode;
  document.querySelectorAll('#acc-form [data-mode]').forEach((x) => x.classList.toggle('on', x === b));
  $('#btn-acc').textContent = accMode === 'login' ? 'Entrar' : 'Crear cuenta';
  $('#acc-pass').autocomplete = accMode === 'login' ? 'current-password' : 'new-password';
  $('#acc-error').textContent = '';
}));
$('#acc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-acc');
  btn.disabled = true;
  $('#acc-error').textContent = '';
  try {
    const { user } = await api('POST', accMode === 'login' ? '/auth/login' : '/auth/register', { username: $('#acc-user').value.trim(), password: $('#acc-pass').value });
    $('#acc-pass').value = '';
    await refreshAccount();
    toast(accMode === 'login' ? `Hola, ${user.displayName ?? user.username}` : `Cuenta creada. ¡Bienvenido, ${user.username}!`);
  } catch (err) {
    $('#acc-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
$('#btn-logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout', {}).catch(() => {});
  account = null;
  store.del('edh.session');
  session = null;
  renderAccount();
  showScreen('login');
  socket.disconnect().connect();
});
initLogin();
refreshAccount();

// ---------- Inicio: jugar ----------
$('#btn-create').addEventListener('click', async () => enterRoom(await emit('createRoom', {})));
$('#btn-solo').addEventListener('click', async () => enterRoom(await emit('createRoom', { solo: true })));
async function join() {
  const code = $('#lobby-code').value.trim().toUpperCase();
  if (code.length !== 6) return ($('#lobby-error').textContent = 'El código tiene 6 caracteres');
  enterRoom(await emit('joinRoom', { code }));
}
$('#btn-join').addEventListener('click', join);
$('#lobby-code').addEventListener('keydown', (e) => e.key === 'Enter' && join());

// ---------- Inicio: mazos, partidas y estadísticas ----------
let homeTab = 'decks';
document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
  homeTab = b.dataset.tab;
  document.querySelectorAll('.tabs [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
  for (const t of ['decks', 'games', 'stats']) $(`#tab-${t}`).classList.toggle('hidden', t !== homeTab);
  loadHome();
}));
$('#btn-new-deck').addEventListener('click', () => openDeckModal(null));

function loadHome() {
  if (homeTab === 'decks') return renderHomeDecks();
  if (homeTab === 'games') return renderHomeGames();
  return renderHomeStats();
}
async function renderHomeDecks() {
  const box = $('#home-decks');
  try {
    const { decks } = await api('GET', '/decks');
    if (!decks.length) return box.replaceChildren(h('div', { class: 'saved-empty' }, 'Aún no tienes mazos. Crea uno con «+ Nuevo mazo»: pegas la lista y queda listo para jugar.'));
    box.replaceChildren(...decks.map((d) => h('div', { class: 'saved-item' },
      h('div', { class: 'meta' }, h('b', {}, d.name), h('span', {}, `${d.commanders || 'Sin comandante'} · ${d.cardCount} cartas · editado ${relTime(d.updatedAt)}`)),
      h('button', { class: 'btn small ghost', onclick: async () => { openDeckModal(null); await editSavedDeck(d); } }, 'Editar'),
      h('button', { class: 'btn small ghost danger', title: 'Borrar', onclick: async () => { await deleteSavedDeck(d); renderHomeDecks(); } }, 'Borrar'))));
  } catch (err) {
    box.replaceChildren(h('div', { class: 'saved-empty' }, `No se pudieron cargar tus mazos: ${err.message}`));
  }
}
const RESULT = { win: ['win', 'Victoria'], loss: ['loss', 'Derrota'], draw: ['draw', 'Empate'], unfinished: ['unfinished', 'Sin terminar'] };
function relTime(t) {
  const d = Math.round((Date.now() - t) / 86400000);
  if (d <= 0) return 'hoy';
  if (d === 1) return 'ayer';
  if (d < 30) return `hace ${d} días`;
  return new Date(t).toLocaleDateString('es-CL');
}
const minutes = (ms) => `${Math.max(1, Math.round(ms / 60000))} min`;
async function renderHomeGames() {
  const box = $('#home-games');
  try {
    const { games } = await api('GET', '/games');
    if (!games.length) return box.replaceChildren(h('div', { class: 'saved-empty' }, 'Todavía no hay partidas. Al terminar una con «Terminar partida» aparece aquí.'));
    box.replaceChildren(...games.map((g) => {
      const [cls, label] = RESULT[g.result] ?? ['draw', g.result];
      const rivals = g.players.filter((p) => !p.isMe);
      return h('article', { class: `game-row ${cls}` },
        h('span', { class: `result-badge ${cls}` }, label),
        h('div', { class: 'game-main' },
          h('b', {}, g.myCommanders || 'Sin comandante'),
          h('span', { class: 'muted small' }, `vs ${rivals.map((r) => `${r.name}${r.commanders ? ` (${r.commanders})` : ''}${r.isWinner ? ' 🏆' : ''}`).join(', ') || '—'}`)),
        h('div', { class: 'game-meta' },
          h('span', {}, new Date(g.endedAt).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })),
          h('span', { class: 'muted small' }, `${g.turns} turnos · ${minutes(g.endedAt - g.startedAt)}`)));
    }));
  } catch (err) {
    box.replaceChildren(h('div', { class: 'saved-empty' }, `No se pudo cargar el historial: ${err.message}`));
  }
}
async function renderHomeStats() {
  const box = $('#home-stats');
  try {
    const { stats } = await api('GET', '/stats');
    if (!stats.games) return box.replaceChildren(h('div', { class: 'saved-empty' }, 'Las estadísticas aparecen después de tu primera partida terminada.'));
    const tile = (value, label) => h('div', { class: 'stat-tile' }, h('b', {}, value), h('span', {}, label));
    box.replaceChildren(
      h('div', { class: 'stat-tiles' },
        tile(stats.games, 'partidas'),
        tile(stats.winRate == null ? '—' : `${Math.round(stats.winRate * 100)}%`, 'victorias'),
        tile(`${stats.wins}–${stats.losses}${stats.draws ? `–${stats.draws}` : ''}`, 'récord'),
        tile(stats.avgTurns ?? '—', 'turnos por partida'),
        tile(stats.avgMinutes ? `${stats.avgMinutes} min` : '—', 'duración media')),
      stats.byCommander.length ? h('table', { class: 'cmd-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Comandante'), h('th', {}, 'Partidas'), h('th', {}, 'Victorias'), h('th', {}, '% victorias'))),
        h('tbody', {}, ...stats.byCommander.map((c) => h('tr', {},
          h('td', {}, c.commanders), h('td', {}, c.games), h('td', {}, c.wins), h('td', {}, `${Math.round((c.wins / c.games) * 100)}%`))))) : null,
      stats.unfinished ? h('p', { class: 'muted small' }, `${stats.unfinished} partida${stats.unfinished === 1 ? '' : 's'} sin terminar no cuentan para el porcentaje.`) : null);
  } catch (err) {
    box.replaceChildren(h('div', { class: 'saved-empty' }, `No se pudieron cargar las estadísticas: ${err.message}`));
  }
}

// ---------- Utilidades de estado ----------
const me = () => state?.players.find((p) => p.id === state.you);
const playerById = (id) => state?.players.find((p) => p.id === id);
/** ¿Controlo este asiento? (yo, o un asiento mío del modo solitario) */
const isMine = (pid) => Boolean(state) && (pid === state.you || playerById(pid)?.controlledBy === state.you);
const myPlayers = () => state?.players.filter((p) => isMine(p.id)) ?? [];

function findMyCard(iid) {
  for (const p of myPlayers()) {
    for (const [zone, cards] of Object.entries(p.zones)) {
      const card = cards.find((c) => c.iid === iid);
      if (card) return { card, zone, pid: p.id };
    }
  }
  if (zoneView?.library) {
    const card = zoneView.cards.find((c) => c.iid === iid);
    if (card) return { card, zone: 'library', pid: zoneView.pid };
  }
  return null;
}
/** Cualquier carta visible para mí, en cualquier jugador. */
function findVisibleCard(iid) {
  for (const p of state?.players ?? []) {
    for (const [zone, cards] of Object.entries(p.zones)) {
      const card = cards.find((c) => c.iid === iid);
      if (card) return { card, zone, pid: p.id };
    }
  }
  return findMyCard(iid);
}
const cardImage = (c) => (c.faceDown ? null : c.transformed && c.backImage ? c.backImage : c.image);
const allBattlefield = () => state.players.flatMap((p) => p.zones.battlefield.map((card) => ({ card, pid: p.id })));

// ---------- Render ----------
const artCrop = (url) => (url ? url.replace('/normal/', '/art_crop/') : null);
let seenOnField = null; // iids en el campo en el render anterior
let lastActive = null;
function render() {
  if (!state) return;
  const fieldNow = new Set(state.players.flatMap((pl) => pl.zones.battlefield.map((c) => c.iid)));
  const entering = seenOnField ? new Set([...fieldNow].filter((iid) => !seenOnField.has(iid))) : new Set();
  seenOnField = fieldNow;
  if (lastActive !== null && state.activePlayerId !== lastActive && state.turn > 0) turnBanner(playerById(state.activePlayerId));
  lastActive = state.activePlayerId;
  $('#room-code').textContent = state.code;
  $('#btn-copy').classList.toggle('hidden', state.solo);
  $('#solo-chip').classList.toggle('hidden', !state.solo);
  $('#btn-seat').classList.toggle('hidden', !state.solo);
  $('#turn-num').textContent = state.turn;
  const active = playerById(state.activePlayerId);
  $('#turn-player').textContent = active?.name ?? '—';
  $('#turn-player').style.color = active?.color ?? '';

  const mineIds = new Set(myPlayers().flatMap((pl) => pl.zones.battlefield.map((c) => c.iid)));
  for (const iid of selected) if (!mineIds.has(iid)) selected.delete(iid);
  if (focusPid && !playerById(focusPid)) focusPid = null;
  $('#phase-chip').textContent = state.phaseName ?? '';
  const opps = state.players.filter((p) => p.id !== state.you && (!focusPid || p.id === focusPid));
  const oppBox = $('#opponents');
  oppBox.classList.toggle('focus', Boolean(focusPid));
  oppBox.style.setProperty('--opp-cols', Math.min(3, Math.max(1, opps.length)));
  oppBox.style.height = opps.length > 3 ? '46%' : '';
  oppBox.replaceChildren(...opps.map((p) => renderPanel(p)));
  const mine = me();
  $('#me').replaceChildren(mine ? renderPanel(mine) : '');
  renderHand();
  renderLog();
  for (const iid of entering) document.querySelector(`.battlefield .card[data-iid="${CSS.escape(iid)}"]`)?.classList.add('enter');
  requestAnimationFrame(drawArrows);
  if (zoneView && !zoneView.library) renderZoneModal();
  if (!$('#modal-mat').classList.contains('hidden')) renderMatPicker();
}
addEventListener('resize', () => { if (state) { renderHand(); drawArrows(); } });

// ---------- Flechas ----------
function drawArrows() {
  const svg = $('#arrows');
  if (!state?.arrows?.length || $('#room').classList.contains('hidden')) return svg.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  const mid = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; };
  const cardEl = (iid) => document.querySelector(`.battlefield .card[data-iid="${CSS.escape(iid)}"]`) ?? document.querySelector(`.card[data-iid="${CSS.escape(iid)}"]`);
  const center = (target) => {
    if (typeof target === 'string') return mid(cardEl(target)) ?? mid(document.querySelector(`.panel[data-pid="${CSS.escape(target)}"] .portrait`));
    const panel = target.pid && document.querySelector(`.panel[data-pid="${CSS.escape(target.pid)}"]`);
    switch (target.kind) {
      case 'card': return mid(cardEl(target.iid));
      case 'player': return mid(panel?.querySelector('.portrait'));
      case 'zone':
        if (target.zone === 'hand') return target.pid === $('#hand').dataset.owner ? mid($('#hand-wrap')) : mid(panel?.querySelector('[data-hand-of]') ?? panel?.querySelector('.portrait'));
        if (target.zone === 'battlefield') return mid(panel?.querySelector('.battlefield'));
        return mid(panel?.querySelector(`.pile[data-pile="${target.zone}"]`));
      case 'point': {
        const bf = panel?.querySelector('.battlefield');
        if (!bf) return null;
        const r = bf.getBoundingClientRect();
        return { x: r.left + target.x * r.width, y: r.top + target.y * r.height };
      }
      default: return null;
    }
  };
  const out = [];
  const defs = document.createElementNS(ns, 'defs');
  for (const ar of state.arrows) {
    const a = center(ar.from);
    const b = center(ar.to);
    if (!a || !b) continue;
    const mid = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - Math.max(40, Math.abs(a.x - b.x) * 0.25) };
    const marker = document.createElementNS(ns, 'marker');
    marker.setAttribute('id', `m-${ar.id}`);
    for (const [k, v] of Object.entries({ viewBox: '0 0 10 10', refX: 6, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' })) marker.setAttribute(k, v);
    const tip = document.createElementNS(ns, 'path');
    tip.setAttribute('d', 'M0,0 L10,5 L0,10 z');
    tip.setAttribute('fill', ar.color);
    marker.append(tip);
    defs.append(marker);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', `M${a.x},${a.y} Q${mid.x},${mid.y} ${b.x},${b.y}`);
    path.setAttribute('stroke', ar.color);
    path.setAttribute('class', 'arrow-path');
    path.setAttribute('marker-end', `url(#m-${ar.id})`);
    out.push(path);
  }
  svg.replaceChildren(defs, ...out);
}

// ---------- Reacciones ----------
function showReaction(ev) {
  const portrait = document.querySelector(`.panel[data-pid="${CSS.escape(ev.pid)}"] .portrait`);
  if (!portrait) return;
  const r = portrait.getBoundingClientRect();
  const el = h('div', { class: 'reaction', style: { left: `${r.left + r.width / 2}px`, top: `${r.top}px` } }, ev.emoji);
  document.body.append(el);
  setTimeout(() => el.remove(), 2200);
}

function turnBanner(p) {
  if (!p) return;
  const mineTurn = isMine(p.id);
  if (mineTurn && p.id === state.you && asset('banners/your-turn')) {
    const el = h('div', { class: 'comic-pop', style: { '--pc': p.color } }, h('div', { class: 'comic-rays' }), h('img', { class: 'comic-card', src: asset('banners/your-turn'), alt: 'Tu turno' }));
    return onStage(el, 1800);
  }
  const el = h('div', { class: `turn-banner${mineTurn ? ' mine' : ''}`, style: { '--pc': p.color } },
    h('span', { class: 'turn-title' }, mineTurn ? (p.id === state.you ? 'Tu turno' : `Turno de ${p.name}`) : `Turno de ${p.name}`),
    h('span', { class: 'turn-sub' }, `Turno ${state.turn}`));
  onStage(el, mineTurn ? 1900 : 1300);
}

function renderCard(c, { owner, zone, att = 0 }) {
  const mine = isMine(owner);
  const img = cardImage(c);
  const classes = ['card'];
  if (c.tapped && zone === 'battlefield') classes.push('tapped');
  if (c.faceDown) classes.push('back');
  else if (!img) classes.push('noimg');
  if (c.token) classes.push('token');
  if (att) classes.push('attached');
  const el = h('div', {
    class: classes.join(' '),
    dataset: { iid: c.iid, zone, owner },
    style: { backgroundImage: img ? `url("${img}")` : '' },
    title: c.faceDown && !mine ? 'Carta boca abajo' : c.name,
  });
  if (!img && !c.faceDown) el.append(c.name);
  if (c.counters) el.append(h('span', { class: `badge${c.counters < 0 ? ' neg' : ''}` }, c.counters > 0 ? `+${c.counters}` : c.counters));
  if (c.ptMod) el.append(h('span', { class: 'pt' }, `${c.ptMod.p >= 0 ? '+' : ''}${c.ptMod.p}/${c.ptMod.t >= 0 ? '+' : ''}${c.ptMod.t}`));
  if (selected.has(c.iid)) el.classList.add('selected');
  if (c.token) el.append(h('span', { class: 'tag' }, 'TOKEN'));
  else if (c.faceDown && mine && zone === 'battlefield') el.append(h('span', { class: 'tag' }, 'OCULTA'));
  // Carta controlada por alguien que no es su dueño: marca con el color del dueño.
  if (zone === 'battlefield' && c.ownerId && c.ownerId !== owner) {
    const ownerP = playerById(c.ownerId);
    if (ownerP) el.append(h('span', { class: 'tag ctl', style: { '--ctl': ownerP.color }, title: `Dueño: ${ownerP.name}` }, ownerP.name.slice(0, 8)));
  }
  if (zone === 'battlefield') {
    el.style.setProperty('--x', c.x);
    el.style.setProperty('--y', c.y);
    if (att) el.style.setProperty('--att', att);
  }
  if (mine) el.dataset.drag = '1';
  el.addEventListener('mouseenter', () => { hovered = { iid: c.iid, zone, owner }; showPreview(c, mine); });
  el.addEventListener('mouseleave', () => { if (hovered?.iid === c.iid) hovered = null; });
  return el;
}

/** Campo de batalla de un jugador, con las cartas adjuntas (de cualquiera) bajo su anfitrión. */
function renderBattlefield(p, mine) {
  const field = allBattlefield();
  const onField = new Set(field.map((x) => x.card.iid));
  const attachedTo = new Map(); // hostIid -> [{card, pid}]
  for (const x of field) {
    if (x.card.attachedTo && onField.has(x.card.attachedTo)) {
      if (!attachedTo.has(x.card.attachedTo)) attachedTo.set(x.card.attachedTo, []);
      attachedTo.get(x.card.attachedTo).push(x);
    }
  }
  const els = [];
  const pushWithAttachments = (card, pid) => {
    const atts = attachedTo.get(card.iid) ?? [];
    atts.forEach((a, i) => {
      // El adjunto se dibuja en la posición de su anfitrión, asomando por arriba.
      const el = renderCard({ ...a.card, x: card.x, y: card.y }, { owner: a.pid, zone: 'battlefield', att: atts.length - i });
      el.title = `${el.title} (adjunta a ${card.faceDown ? 'una carta' : card.name})`;
      els.push(el);
    });
    const hostEl = renderCard(card, { owner: pid, zone: 'battlefield' });
    if (atts.length) hostEl.classList.add('host');
    els.push(hostEl);
  };
  for (const card of p.zones.battlefield) {
    if (card.attachedTo && onField.has(card.attachedTo)) continue; // se dibuja junto a su anfitrión
    pushWithAttachments(card, p.id);
  }
  const bf = h('div', { class: 'battlefield', dataset: { owner: p.id, drop: 'battlefield' } }, ...els);
  if (!p.zones.battlefield.length && !els.length) {
    bf.append(h('div', { class: 'empty-hint' }, mine ? (p.hasDeck ? 'Arrastra cartas aquí para jugarlas' : 'Carga el mazo con el botón «Mazo»') : (p.hasDeck ? '' : 'Esperando su mazo…')));
  }
  return bf;
}

function pile(p, zone) {
  const mine = isMine(p.id);
  const count = p.counts[zone];
  const el = h('div', { class: 'pile', dataset: { pile: zone, owner: p.id, drop: zone }, title: `${ZONE_NAMES[zone]} (${count})${!mine && zone === 'library' ? ' · clic derecho: acciones' : ''}` });
  if (zone === 'library') {
    el.append(count ? h('div', { class: 'card back' }) : h('div', { class: 'pile-empty' }));
  } else {
    const top = p.zones[zone]?.at(-1);
    el.append(top ? renderCard(top, { owner: p.id, zone }) : h('div', { class: 'pile-empty' }));
  }
  el.append(h('span', { class: 'pile-label' }, { library: 'Mazo', graveyard: 'Cementerio', exile: 'Exilio' }[zone], h('b', {}, count)));
  return el;
}

function renderPanel(p) {
  const mine = isMine(p.id);
  const isMe = p.id === state.you;
  const isSeat = Boolean(p.controlledBy);
  const others = state.players.filter((o) => o.id !== p.id);
  const lifeBtn = (delta, label) => h('button', {
    title: 'Shift: ±5',
    onclick: (e) => act(p.id, { type: 'life', delta: e.shiftKey ? delta * 5 : delta }),
  }, label);

  const cmdStats = others.map((o) => {
    const dmg = p.cmdDamage[o.id] ?? 0;
    if (!mine && !dmg) return null;
    return h('span', {
      class: `stat${mine ? ' click' : ''}${dmg >= 21 ? ' lethal' : ''}`,
      style: { borderColor: dmg >= 21 ? '' : o.color },
      title: mine ? `Daño de comandante recibido de ${o.name}. Clic +1, clic derecho −1` : `Daño de comandante de ${o.name}`,
      onclick: mine ? () => act(p.id, { type: 'cmdDamage', source: o.id, delta: 1 }) : null,
      oncontextmenu: mine ? (e) => { e.preventDefault(); act(p.id, { type: 'cmdDamage', source: o.id, delta: -1 }); } : null,
    }, `⚔ ${o.name.slice(0, 10)} ${dmg}`);
  });

  const poison = (mine || p.poison) ? h('span', {
    class: `stat${mine ? ' click' : ''}${p.poison >= 10 ? ' lethal' : ''}`,
    title: mine ? 'Veneno. Clic +1, clic derecho −1' : 'Veneno',
    onclick: mine ? () => act(p.id, { type: 'poison', delta: 1 }) : null,
    oncontextmenu: mine ? (e) => { e.preventDefault(); act(p.id, { type: 'poison', delta: -1 }); } : null,
  }, `☠ ${p.poison}`) : null;

  const handChip = !mine ? h('span', {
    class: 'counts click', dataset: { drop: 'hand', owner: p.id, handOf: p.id },
    title: 'Clic: acciones sobre su mano y biblioteca',
    onclick: (e) => opponentZoneMenu(e, p),
  }, `✋ ${p.counts.hand} · 📚 ${p.counts.library}`) : null;

  const art = artCrop(p.commanderImages?.[0]);
  const portrait = h('div', { class: `portrait${art ? '' : ' empty'}`, style: art ? { backgroundImage: `url("${art}")` } : {}, title: p.commanderNames.join(' + ') || p.name },
    p.commanderImages?.[1] ? h('span', { class: 'partner', style: { backgroundImage: `url("${artCrop(p.commanderImages[1])}")` } }) : null);

  const life = h('span', { class: `life${p.life <= 10 ? ' low' : ''}` },
    mine ? lifeBtn(-1, '−') : null, h('b', { title: 'Vida' }, p.life), mine ? lifeBtn(1, '+') : null);

  const hero = h('div', { class: 'hero' },
    h('div', { class: 'hero-portrait' }, portrait, life),
    h('div', { class: 'hero-info' },
      h('span', { class: 'pname' },
        h('span', { class: `dot${p.connected ? '' : ' off'}`, title: p.connected ? 'Conectado' : 'Desconectado' }), p.name,
        isMe ? h('span', { class: 'muted small' }, '(tú)') : null,
        isSeat && mine ? h('span', { class: 'muted small' }, '(asiento)') : null,
        isSeat && mine ? h('button', { class: 'seat-x', title: 'Quitar asiento', onclick: () => confirm(`¿Quitar el asiento ${p.name}?`) && send({ type: 'removeSeat', target: p.id }) }, '×') : null),
      h('span', { class: 'cmdnames' }, p.commanderNames.join(' + ')),
      h('div', { class: 'hero-stats' }, handChip, poison, ...cmdStats, isSeat && mine ? h('button', { class: 'btn small ghost', onclick: () => openDeckModal(p.id) }, 'Mazo') : null),
      renderMana(p, mine)));

  // Zona de mando: un espacio por comandante (uno o dos).
  const cmdCards = p.zones.command;
  const slots = Math.max(1, Math.min(2, Math.max(p.commanderNames.length, cmdCards.length)), cmdCards.length);
  const commandSlots = Array.from({ length: slots }, (_, i) => {
    const el = h('div', { class: 'pile cmd', dataset: { pile: 'command', owner: p.id, drop: 'command' }, title: 'Zona de mando' });
    el.append(cmdCards[i] ? renderCard(cmdCards[i], { owner: p.id, zone: 'command' }) : h('div', { class: 'pile-empty' }));
    el.append(h('span', { class: 'pile-label' }, 'Mando'));
    return el;
  });

  const myTurn = state.activePlayerId === state.you;
  const endTurn = isMe ? h('button', {
    id: 'btn-pass', class: `end-turn${myTurn ? ' ready' : ''}`, title: 'Pasar el turno (Espacio)',
    onclick: () => send({ type: 'passTurn' }),
  }, h('span', {}, myTurn ? 'Pasar turno' : 'Turno rival')) : null;

  return h('div', { class: `panel${isMe ? ' mine' : ' opp'}${state.activePlayerId === p.id ? ' active' : ''}${focusPid === p.id ? ' focused' : ''}`, style: { '--pc': p.color }, dataset: { pid: p.id } },
    h('div', { class: `mat${p.mat ? ` custom ${p.mat.kind}` : ''}`, style: matStyle(p.mat) }, matLayers(p.mat), renderBattlefield(p, mine)),
    endTurn,
    h('div', { class: 'rail' },
      hero,
      h('div', { class: 'rail-spacer' }),
      h('div', { class: 'zones' }, pile(p, 'library'), pile(p, 'graveyard'), pile(p, 'exile'), ...commandSlots)));
}

// ---------- Tapetes ----------
const MAT_COLORS = [
  ['Naranja', '#F07857'], ['Verde azulado', '#43A5BE'], ['Verde mar', '#53BDA5'], ['Arena', '#F5C26B'], ['Casi negro', '#253342'],
  ['Gris claro', '#CBD6E2'], ['Verde', '#4FB06D'], ['Azul marino', '#1260B0'], ['Rosa', '#EBB8DD'], ['Índigo', '#5C62D6'],
  ['Blanco', '#FFFFFF'], ['Magenta', '#BE398D'], ['Dorado', '#D49137'], ['Menta', '#CAE7D3'], ['Rojo oscuro', '#BF2C34'],
];
// Tapetes animados: cuatro manchas de luz difusas que flotan y se mezclan (puro CSS).
const ANIM_MATS = [
  ['lava-atardecer', 'Atardecer en movimiento'], ['lava-oceano', 'Océano en movimiento'], ['lava-bosque', 'Bosque en movimiento'],
  ['lava-neon', 'Neón en movimiento'], ['lava-magma', 'Magma'], ['lava-aurora', 'Aurora'],
];
function matLayers(mat) {
  if (mat?.kind !== 'anim') return null;
  return h('div', { class: `lava ${mat.value}`, 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'), h('u'), h('u'), h('b'));
}
function matStyle(mat) {
  if (mat?.kind === 'color') return { background: `radial-gradient(120% 100% at 50% 40%, rgba(255,255,255,.12), transparent 60%), radial-gradient(140% 120% at 50% 50%, transparent 55%, rgba(0,0,0,.35)), ${mat.value}` };
  if (mat?.kind === 'image') return { background: `url("/assets/${mat.value}") center / cover no-repeat` };
  return {};
}
const MAT_NAMES = { 'mats/olas.webp': 'Olas (por defecto)', 'mats/ranas.webp': 'Ranas hechiceras', 'mats/runas.webp': 'Pergamino rúnico', 'mats/carton.webp': 'Cartón', 'mats/bosque-nocturno.webp': 'Bosque nocturno', 'mats/oceano.webp': 'Océano', 'mats/neon.webp': 'Neón' };
const matName = (file) => MAT_NAMES[file] ?? file.replace(/^mats\//, '').replace(/\.\w+$/, '').replace(/[-_]+/g, ' ');
const MAT_ORDER = ['mats/olas.webp', 'mats/ranas.webp', 'mats/runas.webp', 'mats/carton.webp'];
const matRank = (f) => (MAT_ORDER.includes(f) ? MAT_ORDER.indexOf(f) : f.includes('/prueba-') ? 200 : 100);
async function chooseMat(mat) {
  const res = await send({ type: 'setMat', mat });
  if (!res?.ok) return;
  store.set('edh.mat.v2', { mat });
  renderMatPicker();
}
function renderMatPicker() {
  const current = me()?.mat ?? null;
  const same = (m) => JSON.stringify(m ?? null) === JSON.stringify(current);
  const images = matImages.filter((f) => f !== 'mats/tavern.webp').sort((a, b) => matRank(a) - matRank(b) || a.localeCompare(b));
  $('#mat-images').replaceChildren(...[...images.map((f) => ({ kind: 'image', value: f })), null].map((m) => h('button', {
    class: `mat-option${same(m) ? ' on' : ''}`, title: m ? matName(m.value) : 'Taberna (por defecto)',
    style: m ? { backgroundImage: `url("/assets/${m.value}")` } : { backgroundImage: asset('mats/tavern') ? `url("${asset('mats/tavern')}")` : '' },
    onclick: () => chooseMat(m),
  }, h('span', {}, m ? matName(m.value) : 'Taberna'))));
  $('#mat-anims').replaceChildren(...ANIM_MATS.map(([value, name]) => {
    const m = { kind: 'anim', value };
    return h('button', { class: `mat-option anim${same(m) ? ' on' : ''}`, title: name, onclick: () => chooseMat(m) }, matLayers(m), h('span', {}, name));
  }));
  $('#mat-colors').replaceChildren(...MAT_COLORS.map(([name, hex]) => {
    const m = { kind: 'color', value: hex.toLowerCase() };
    return h('button', { class: `mat-option swatch${same(m) ? ' on' : ''}`, title: `${name} ${hex}`, style: { background: hex }, onclick: () => chooseMat(m) }, h('span', {}, name));
  }));
}
$('#btn-mat').addEventListener('click', () => { renderMatPicker(); openModal('#modal-mat'); });

const MANA_COLORS = [['W', '#f4ecc8', 'Blanco'], ['U', '#4f8fd8', 'Azul'], ['B', '#4b3f52', 'Negro'], ['R', '#d9553f', 'Rojo'], ['G', '#3f9b5c', 'Verde'], ['C', '#b9b3a8', 'Incoloro']];
function renderMana(p, mine) {
  const any = Object.values(p.mana ?? {}).some(Boolean);
  if (!any && !(mine && showMana)) return null;
  return h('div', { class: 'mana', title: mine ? 'Maná flotante. Clic +1, clic derecho −1 (se vacía al pasar el turno)' : 'Maná flotante' },
    ...MANA_COLORS.filter(([c]) => mine || p.mana[c]).map(([c, color, name]) => h('button', {
      class: `pip${p.mana[c] ? ' on' : ''}`, style: { '--mc': color }, title: name, disabled: !mine,
      onclick: mine ? () => act(p.id, { type: 'mana', color: c, delta: 1 }) : null,
      oncontextmenu: mine ? (e) => { e.preventDefault(); act(p.id, { type: 'mana', color: c, delta: -1 }); } : null,
    }, h('i', {}, c), h('b', {}, p.mana[c] || ''))));
}

/** Siguiente hueco libre del campo: tierras en la fila de abajo, el resto arriba. */
function freeSpot(p, card) {
  const isLand = /\bLand\b/.test(card.typeLine ?? '');
  const taken = p.zones.battlefield.map((c) => [c.x, c.y]);
  const rows = isLand ? [0.56, 0.3] : [0.04, 0.3, 0.56];
  for (const y of rows) {
    for (let x = 0.02; x <= 0.98; x += 0.1) {
      if (!taken.some(([tx, ty]) => Math.abs(tx - x) < 0.07 && Math.abs(ty - y) < 0.2)) return { x, y };
    }
  }
  return { x: 0.45 + Math.random() * 0.1, y: 0.4 };
}

function renderHand() {
  const seats = myPlayers();
  const p = playerById(handSeat) ?? me();
  const hand = p?.zones.hand ?? [];
  $('#hand-count').textContent = `(${hand.length})`;
  $('#hand').dataset.owner = p?.id ?? '';
  $('#hand-tabs').replaceChildren(...(seats.length > 1 ? seats.map((s) => h('button', {
    class: s.id === p?.id ? 'on' : '',
    style: { '--pc': s.color },
    onclick: () => { handSeat = s.id; renderHand(); },
  }, s.id === state.you ? 'Tú' : s.name)) : []));
  const n = hand.length;
  const width = $('#hand').clientWidth || 900;
  const cw = 112;
  const gap = n > 1 ? Math.min(cw * 0.78, (width - cw - 40) / (n - 1)) : 0;
  // Cada carta va dentro de un «hueco» quieto que detecta el mouse; la carta se levanta
  // dentro de él sin que el área de detección se mueva (así no parpadea).
  $('#hand').replaceChildren(...hand.map((c, i) => {
    const el = renderCard(c, { owner: p.id, zone: 'hand' });
    el.addEventListener('dblclick', () => act(p.id, { type: 'move', iid: c.iid, to: 'battlefield', ...freeSpot(p, c) }));
    const off = i - (n - 1) / 2; // posición relativa al centro del abanico
    const slot = h('div', { class: 'hand-slot' }, el);
    slot.style.setProperty('--off', off);
    slot.style.setProperty('--gap', `${gap}px`);
    slot.style.setProperty('--rot', `${off * Math.min(4, 22 / Math.max(n, 1))}deg`);
    slot.style.setProperty('--drop', `${Math.abs(off) ** 2 * Math.min(3.2, 26 / Math.max(n, 1))}px`);
    slot.style.zIndex = String(10 + i);
    return slot;
  }));
}

let lastLogLen = 0;
function renderLog() {
  const box = $('#log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.replaceChildren(...state.log.map((e) => h('p', { class: `log-${e.kind}` },
    h('time', {}, new Date(e.t).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })), e.text)));
  if (atBottom || state.log.length !== lastLogLen) box.scrollTop = box.scrollHeight;
  lastLogLen = state.log.length;
}

function showPreview(c, mine) {
  const box = $('#preview');
  const img = cardImage(c);
  if (c.faceDown && !mine) return box.replaceChildren(h('div', { class: 'preview-name' }, 'Carta boca abajo'));
  const src = c.faceDown ? c.image : img;
  box.replaceChildren(src ? h('img', { src, alt: c.name }) : h('div', { class: 'preview-name' }, c.name, h('br'), h('span', { class: 'muted small' }, c.typeLine ?? '')));
}

// ---------- Apuntar (adjuntar) ----------
function startTargeting(iid, pid, name, kind = 'attach') {
  targeting = { iid, pid, name, kind };
  document.body.classList.add('targeting');
  const banner = $('#target-banner');
  banner.textContent = kind === 'arrow'
    ? 'Elige a qué apunta la flecha: una carta, una zona, un jugador o cualquier punto de la mesa · Esc para cancelar'
    : `Elige el permanente al que adjuntar ${name} · Esc para cancelar`;
  banner.classList.remove('hidden');
}
/** ¿A qué apunta el mouse? Una carta pública, una zona, un jugador o un punto del campo. */
function arrowTargetAt(e) {
  const t = e.target;
  const card = t.closest('.card[data-iid]');
  if (card && !t.closest('#hand') && ['battlefield', 'graveyard', 'exile', 'command'].includes(card.dataset.zone)) {
    if (card.dataset.zone === 'battlefield') return { kind: 'card', iid: card.dataset.iid };
  }
  const pileEl = t.closest('.pile[data-pile]');
  if (pileEl) return { kind: 'zone', pid: pileEl.dataset.owner, zone: pileEl.dataset.pile };
  const handEl = t.closest('[data-hand-of]') ?? (t.closest('#hand-wrap') ? { dataset: { handOf: $('#hand').dataset.owner } } : null);
  if (handEl) return { kind: 'zone', pid: handEl.dataset.handOf, zone: 'hand' };
  if (t.closest('.portrait, .hero-portrait, .hero')) return { kind: 'player', pid: t.closest('.panel').dataset.pid };
  const bf = t.closest('.panel[data-pid]')?.querySelector('.battlefield');
  if (bf) {
    const r = bf.getBoundingClientRect();
    return { kind: 'point', pid: bf.dataset.owner, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
  return null;
}
function stopTargeting() {
  targeting = null;
  document.body.classList.remove('targeting');
  $('#target-banner').classList.add('hidden');
}
let swallowClick = false; // el clic que cierra el modo apuntar no debe abrir nada más
document.addEventListener('click', (e) => {
  if (!swallowClick) return;
  swallowClick = false;
  e.preventDefault();
  e.stopPropagation();
}, true);
document.addEventListener('pointerdown', (e) => {
  if (!targeting) return;
  e.preventDefault();
  e.stopPropagation();
  swallowClick = true;
  const el = e.target.closest('.battlefield .card');
  const t = targeting;
  stopTargeting();
  if (t.kind === 'arrow') {
    const to = arrowTargetAt(e);
    if (to && !(to.kind === 'card' && to.iid === t.iid)) send({ type: 'arrow', from: t.iid, to });
    return;
  }
  if (el && el.dataset.iid !== t.iid) act(t.pid, { type: 'attach', iid: t.iid, target: el.dataset.iid });
}, true);

// ---------- Arrastrar y soltar ----------
let drag = null;
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || targeting) return;
  const el = e.target.closest('.card[data-drag]');
  if (!el || el.closest('.modal')) return;
  const rect = el.getBoundingClientRect();
  drag = { el, iid: el.dataset.iid, zone: el.dataset.zone, owner: el.dataset.owner, startX: e.clientX, startY: e.clientY, offX: e.clientX - rect.left, offY: e.clientY - rect.top, fx: (e.clientX - rect.left) / rect.width, fy: (e.clientY - rect.top) / rect.height, moved: false, ghost: null, shift: e.shiftKey };
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
  if (!drag.moved) {
    drag.moved = true;
    const ghost = drag.el.cloneNode(true);
    const r = drag.el.getBoundingClientRect();
    ghost.classList.add('ghost');
    ghost.classList.remove('tapped', 'attached');
    ghost.style.width = `${drag.el.offsetWidth}px`;
    drag.offX = drag.fx * drag.el.offsetWidth;
    drag.offY = drag.fy * drag.el.offsetHeight;
    ghost.style.left = `${r.left}px`;
    ghost.style.top = `${r.top}px`;
    document.body.append(ghost);
    drag.ghost = ghost;
    drag.w = drag.el.offsetWidth;
    drag.el.classList.add('dragging-src');
  }
  drag.ghost.style.left = `${e.clientX - drag.offX}px`;
  drag.ghost.style.top = `${e.clientY - drag.offY}px`;
  document.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
  dropTarget(e)?.classList.add('drop-hover');
});
document.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  document.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
  d.el.classList.remove('dragging-src');
  d.ghost?.remove();
  if (!d.moved) return onCardClick(d);
  const target = dropTarget(e);
  if (!target) return;
  const to = target.dataset.drop;
  const toPlayer = target.dataset.owner && target.dataset.owner !== d.owner ? target.dataset.owner : undefined;
  if (toPlayer) {
    // A la zona de otro jugador
    let pos = {};
    if (to === 'battlefield') {
      const r = target.getBoundingClientRect();
      const cw = parseFloat(getComputedStyle(target).getPropertyValue('--cw')) || d.w;
      pos = {
        x: Math.min(1, Math.max(0, (e.clientX - d.fx * cw - r.left) / Math.max(1, r.width - cw))),
        y: Math.min(1, Math.max(0, (e.clientY - d.fy * cw * 1.397 - r.top) / Math.max(1, r.height - cw * 1.397))),
      };
    }
    act(d.owner, { type: 'move', iid: d.iid, to, toPlayer, position: to === 'library' && e.shiftKey ? 'bottom' : 'top', ...pos });
  } else if (to === 'battlefield') {
    const r = target.getBoundingClientRect();
    const cw = parseFloat(getComputedStyle(target).getPropertyValue('--cw')) || d.w;
    const ch = cw * 1.397;
    const x = Math.min(1, Math.max(0, (e.clientX - d.fx * cw - r.left) / Math.max(1, r.width - cw)));
    const y = Math.min(1, Math.max(0, (e.clientY - d.fy * ch - r.top) / Math.max(1, r.height - ch)));
    act(d.owner, d.zone === 'battlefield' ? { type: 'setPos', iid: d.iid, x, y } : { type: 'move', iid: d.iid, to, x, y });
  } else if (to !== d.zone || to === 'library') {
    act(d.owner, { type: 'move', iid: d.iid, to, position: to === 'library' && e.shiftKey ? 'bottom' : 'top' });
  }
});
/** Cualquier zona de cualquier jugador; si es de otro, la carta se le envía. */
function dropTarget(e) {
  return document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-drop]') ?? null;
}
function onCardClick(d) {
  if (d.zone === 'battlefield' && d.shift) {
    // Shift + clic: agregar o quitar de la selección múltiple.
    if (selected.has(d.iid)) selected.delete(d.iid);
    else selected.add(d.iid);
    return render();
  }
  if (d.zone === 'battlefield') act(d.owner, { type: 'tap', iid: d.iid });
  else if (d.zone === 'graveyard' || d.zone === 'exile' || d.zone === 'command') openZone(d.owner, d.zone);
}

// Clic en las pilas (biblioteca: robar; cementerio/exilio: ver).
document.addEventListener('click', (e) => {
  const pileEl = e.target.closest('.pile');
  if (!pileEl || e.target.closest('.card[data-drag]')) return;
  const { pile: zone, owner } = pileEl.dataset;
  if (zone === 'library') { if (isMine(owner)) act(owner, { type: 'draw', n: 1 }); }
  else openZone(owner, zone);
});

// ---------- Menú contextual ----------
const menu = $('#menu');
function openMenu(x, y, title, items) {
  menu.replaceChildren(
    ...(title ? [h('div', { class: 'menu-title' }, title)] : []),
    ...items.filter(Boolean).map((it) => (it === '-' ? h('hr') : h('button', { onclick: () => { closeMenu(); it.run(); } }, it.label, it.key ? h('kbd', {}, it.key) : null))),
  );
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}
const closeMenu = () => menu.classList.add('hidden');
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#menu')) closeMenu(); }, true);
document.addEventListener('scroll', closeMenu, true);

const askNumber = (msg, def = 1) => {
  const v = prompt(msg, String(def));
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function moveItems(pid, iid, from) {
  const mv = (to, label, position) => ({ label, run: () => afterLibraryMove(iid, act(pid, { type: 'move', iid, to, position, x: 0.45, y: 0.5 })) });
  return [
    from !== 'battlefield' && mv('battlefield', 'Al campo de batalla'),
    from !== 'battlefield' && { label: 'Al campo boca abajo', run: () => afterLibraryMove(iid, act(pid, { type: 'move', iid, to: 'battlefield', faceDown: true, x: 0.45, y: 0.5 })) },
    from !== 'hand' && mv('hand', 'A la mano'),
    from !== 'graveyard' && mv('graveyard', 'Al cementerio'),
    from !== 'exile' && mv('exile', 'Al exilio'),
    mv('library', 'Al tope de la biblioteca', 'top'),
    mv('library', 'Al fondo de la biblioteca', 'bottom'),
    from !== 'command' && mv('command', 'A la zona de mando'),
  ];
}

function cardMenu(e, iid, zone) {
  const found = findMyCard(iid);
  if (!found) return;
  const { card: c, pid } = found;
  const others = state.players.filter((o) => o.id !== pid);
  const items = [];
  if (zone === 'battlefield') {
    items.push(
      { label: c.tapped ? 'Enderezar' : 'Girar', key: 'T', run: () => act(pid, { type: 'tap', iid }) },
      { label: c.faceDown ? 'Voltear boca arriba' : 'Poner boca abajo', key: 'F', run: () => act(pid, { type: 'flip', iid }) },
      c.backImage && { label: 'Transformar', run: () => act(pid, { type: 'transform', iid }) },
      { label: 'Agregar contador +1', key: '+', run: () => act(pid, { type: 'counters', iid, delta: 1 }) },
      { label: 'Quitar contador −1', key: '−', run: () => act(pid, { type: 'counters', iid, delta: -1 }) },
      { label: 'Contadores…', run: () => { const n = Number.parseInt(prompt('Cantidad a sumar (usa negativo para restar)', '1') ?? '', 10); if (n) act(pid, { type: 'counters', iid, delta: n }); } },
      '-',
      { label: '📎 Adjuntar a…', run: () => startTargeting(iid, pid, c.faceDown ? 'la carta' : c.name) },
      c.attachedTo && { label: 'Desadjuntar', run: () => act(pid, { type: 'detach', iid }) },
      ...others.map((o) => ({ label: `🤝 Dar control a ${o.name}`, run: () => act(pid, { type: 'giveControl', iid, to: o.id }) })),
      '-',
      ...(c.tokens ?? []).map((t) => ({ label: `✨ Crear token: ${t.name}`, run: () => createRelatedToken(pid, t, c) })),
      { label: 'Crear copia (token)', run: () => act(pid, { type: 'clone', iid }) },
      '-',
    );
  } else if (c.tokens?.length) {
    items.push(...c.tokens.map((t) => ({ label: `✨ Crear token: ${t.name}`, run: () => createRelatedToken(pid, t) })), '-');
  }
  if (zone !== 'library' && zone !== 'hand' && !c.faceDown) {
    items.push({ label: '⚡ Anunciar trigger de esta carta', key: 'G', run: () => act(pid, { type: 'announce', kind: 'trigger', iid }) }, '-');
  }
  if (c.scryfallId) items.push({ label: '📖 Ver ficha (oráculo y rulings)', run: () => openCardInfo(c) }, '-');
  items.push(...moveItems(pid, iid, zone));
  const otherPlayers = state.players.filter((o) => o.id !== pid);
  if (otherPlayers.length && zone !== 'library') {
    items.push(...otherPlayers.map((o) => ({ label: `📤 Enviar a ${o.name}…`, run: () => sendToMenu(e, pid, iid, o) })));
  }
  if (zone !== 'library' || zoneView?.library) items.push('-', { label: 'Revelar a todos', run: () => act(pid, { type: 'reveal', iid }) });
  openMenu(e.clientX, e.clientY, c.faceDown && zone !== 'battlefield' ? 'Carta' : c.name, items);
}

function sendToMenu(e, pid, iid, target) {
  const go = (to, position) => () => {
    const extra = to === 'battlefield' ? freeSpot(target, findMyCard(iid)?.card ?? {}) : {};
    act(pid, { type: 'move', iid, to, toPlayer: target.id, position, ...extra });
  };
  openMenu(e.clientX, e.clientY, `Enviar a ${target.name}`, [
    { label: 'A su campo de batalla', run: go('battlefield') },
    { label: 'A su mano', run: go('hand') },
    { label: 'A su cementerio', run: go('graveyard') },
    { label: 'A su exilio', run: go('exile') },
    { label: 'Al tope de su biblioteca', run: go('library', 'top') },
    { label: 'Al fondo de su biblioteca', run: go('library', 'bottom') },
  ]);
}

function libraryMenu(e, pid) {
  openMenu(e.clientX, e.clientY, `Biblioteca${pid !== state.you ? ` de ${playerById(pid)?.name}` : ''}`, [
    { label: 'Robar 1', key: 'D', run: () => act(pid, { type: 'draw', n: 1 }) },
    { label: 'Robar X…', run: () => { const n = askNumber('¿Cuántas cartas robar?', 7); if (n) act(pid, { type: 'draw', n }); } },
    { label: 'Moler X…', run: () => { const n = askNumber('¿Cuántas cartas moler?', 1); if (n) act(pid, { type: 'mill', n }); } },
    { label: 'Mirar el tope X…', run: () => { const n = askNumber('¿Cuántas cartas mirar?', 3); if (n) peekLibrary(pid, n); } },
    { label: 'Buscar en la biblioteca', run: () => peekLibrary(pid, 0) },
    { label: 'Barajar', run: () => act(pid, { type: 'shuffle' }) },
    '-',
    { label: 'Mulligan (mano a la biblioteca y robar 7)', run: () => confirm('¿Hacer mulligan?') && act(pid, { type: 'mulligan' }) },
    { label: 'Revelar la mano', run: () => act(pid, { type: 'revealHand' }) },
    { label: 'Enderezar todo', key: 'U', run: () => act(pid, { type: 'untapAll' }) },
    '-',
    { label: 'Reiniciar la partida', run: () => confirm('Todas las cartas vuelven a la biblioteca y la vida a 40. ¿Seguro?') && act(pid, { type: 'reset' }) },
  ]);
}

/** Acciones sobre la biblioteca y la mano de un rival (todo queda en el log). */
function opponentZoneMenu(e, target) {
  const tz = (op, n) => send({ type: 'targetZone', target: target.id, op, n });
  openMenu(e.clientX, e.clientY, `Zonas de ${target.name}`, [
    { label: 'Moler X de su biblioteca…', run: () => { const n = askNumber(`¿Cuántas cartas moler a ${target.name}?`, 1); if (n) tz('mill', n); } },
    { label: 'Exiliar X del tope de su biblioteca…', run: () => { const n = askNumber('¿Cuántas cartas exiliar?', 1); if (n) tz('exileTop', n); } },
    { label: 'Revelar X del tope de su biblioteca…', run: () => { const n = askNumber('¿Cuántas cartas revelar?', 1); if (n) tz('revealTop', n); } },
    '-',
    { label: 'Hacer que descarte una carta al azar', run: () => confirm(`¿${target.name} descarta al azar?`) && tz('discardRandom') },
    { label: 'Pedirle que revele su mano', run: () => tz('requestHand') },
    '-',
    { label: 'Ver su cementerio', run: () => openZone(target.id, 'graveyard') },
    { label: 'Ver su exilio', run: () => openZone(target.id, 'exile') },
  ]);
}

document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (targeting) { e.preventDefault(); return stopTargeting(); }
  const cardEl = e.target.closest('.card[data-drag]');
  const anyCard = e.target.closest('.card[data-iid]');
  const pileEl = e.target.closest('.pile');
  const bf = e.target.closest('.battlefield[data-drop]');
  if (cardEl) { e.preventDefault(); return cardMenu(e, cardEl.dataset.iid, cardEl.dataset.lib ? 'library' : cardEl.dataset.zone); }
  if (pileEl?.dataset.pile === 'library') {
    e.preventDefault();
    const owner = pileEl.dataset.owner;
    return isMine(owner) ? libraryMenu(e, owner) : opponentZoneMenu(e, playerById(owner));
  }
  if (anyCard) {
    // Carta de un rival: solo lectura.
    const found = findVisibleCard(anyCard.dataset.iid);
    if (found?.card.scryfallId && !found.card.faceDown) {
      e.preventDefault();
      return openMenu(e.clientX, e.clientY, found.card.name, [{ label: '📖 Ver ficha (oráculo y rulings)', run: () => openCardInfo(found.card) }]);
    }
  }
  if (bf) {
    e.preventDefault();
    const pid = bf.dataset.owner;
    const r = bf.getBoundingClientRect();
    const pos = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width - 0.03)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height - 0.1)) };
    openMenu(e.clientX, e.clientY, 'Campo de batalla', [
      { label: 'Enderezar todo', key: 'U', run: () => act(pid, { type: 'untapAll' }) },
      { label: 'Crear token…', run: () => openTokenModal(pid, pos) },
      { label: 'Lanzar d20', run: () => act(pid, { type: 'roll', sides: 20 }) },
    ]);
  }
});

// ---------- Modales ----------
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) {
  $(id).classList.add('hidden');
  if (id === '#modal-zone') zoneView = null;
}
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModal(`#${m.id}`); });
});

function openZone(pid, zone) {
  zoneView = { pid, zone };
  renderZoneModal();
  openModal('#modal-zone');
}
function renderZoneModal() {
  const grid = $('#zone-cards');
  $('#btn-zone-shuffle').classList.toggle('hidden', !zoneView?.library);
  if (zoneView.library) {
    const who = zoneView.pid === state.you ? 'tu biblioteca' : `la biblioteca de ${playerById(zoneView.pid)?.name}`;
    $('#zone-title').textContent = zoneView.n ? `${zoneView.from === 'bottom' ? 'Fondo' : 'Tope'} de ${who} (${zoneView.cards.length})` : `Buscar en ${who} (${zoneView.cards.length})`;
    $('#zone-hint').textContent = 'Ordenadas desde el tope. Clic en una carta para moverla. Tus rivales no ven estas cartas.';
    grid.replaceChildren(...zoneView.cards.map((c) => {
      const el = renderCard(c, { owner: zoneView.pid, zone: 'library' });
      delete el.dataset.drag;
      el.dataset.lib = '1';
      el.addEventListener('click', (e) => cardMenu(e, c.iid, 'library'));
      return el;
    }));
    return;
  }
  const p = playerById(zoneView.pid);
  if (!p) return closeModal('#modal-zone');
  const cards = [...(p.zones[zoneView.zone] ?? [])].reverse();
  const mine = isMine(p.id);
  $('#zone-title').textContent = `${ZONE_NAMES[zoneView.zone]} de ${p.id === state.you ? 'ti' : p.name} (${cards.length})`;
  $('#zone-hint').textContent = mine ? 'La más reciente primero. Clic en una carta para moverla.' : 'Solo lectura. Clic derecho en una carta para ver su ficha.';
  grid.replaceChildren(...cards.map((c) => {
    const el = renderCard(c, { owner: p.id, zone: zoneView.zone });
    delete el.dataset.drag;
    if (mine) el.addEventListener('click', (e) => cardMenu(e, c.iid, zoneView.zone));
    return el;
  }));
}

async function peekLibrary(pid, n, from = 'top') {
  const res = await act(pid, { type: 'peek', n, from });
  if (!res?.ok) return;
  zoneView = { library: true, pid, n, from, cards: res.private.cards };
  renderZoneModal();
  openModal('#modal-zone');
}
async function afterLibraryMove(iid, promise) {
  const res = await promise;
  if (res?.ok && zoneView?.library) {
    zoneView.cards = zoneView.cards.filter((c) => c.iid !== iid);
    renderZoneModal();
  }
}
$('#btn-zone-shuffle').addEventListener('click', () => { act(zoneView?.pid, { type: 'shuffle' }); closeModal('#modal-zone'); });

// ---------- Mazo ----------
function openDeckModal(pid = state?.you) {
  deckFor = pid;
  const saved = store.get('edh.deck', {});
  const forSeat = pid && pid !== state?.you;
  $('#deck-for').textContent = forSeat ? `Para el asiento: ${playerById(pid)?.name}` : '';
  $('#deck-for').classList.toggle('hidden', !forSeat);
  $('#deck-commanders').value = forSeat ? '' : saved.commanders ?? '';
  $('#deck-list').value = forSeat ? '' : saved.list ?? '';
  $('#deck-status').textContent = '';
  $('#deck-status').className = 'status';
  editingDeck = null;
  $('#deck-name').value = '';
  $('#deck-save').checked = Boolean(account) && !forSeat;
  $('#deck-save').disabled = !account;
  $('#deck-name').disabled = !account;
  $('#deck-save-row').classList.toggle('disabled', !account);
  $('#deck-save-row').title = account ? '' : 'Inicia sesión desde la pantalla de inicio para guardar mazos';
  $('#mox-url').value = '';
  // Fuera de una sala, el modal solo crea o edita mazos de la cuenta.
  const inRoom = Boolean(state);
  $('#deck-title').textContent = inRoom ? 'Cargar mazo' : 'Nuevo mazo';
  $('#btn-deck-load').textContent = inRoom ? 'Cargar y barajar' : 'Guardar mazo';
  $('#saved-decks').classList.toggle('hidden', !inRoom);
  if (!inRoom) {
    $('#deck-save').checked = true;
    $('#deck-save').disabled = true;
    $('#deck-commanders').value = '';
    $('#deck-list').value = '';
  }
  openModal('#modal-deck');
  renderSavedDecks();
  renderMoxfield();
}

async function renderSavedDecks() {
  const list = $('#saved-list');
  $('#saved-hint').textContent = '';
  if (!account) {
    list.replaceChildren(h('div', { class: 'saved-empty' }, 'Crea una cuenta en la pantalla de inicio para guardar tus mazos y cargarlos con un clic.'));
    return;
  }
  list.replaceChildren(h('div', { class: 'saved-empty' }, 'Cargando…'));
  try {
    const { decks } = await api('GET', '/decks');
    $('#saved-hint').textContent = decks.length ? `${decks.length} guardado${decks.length === 1 ? '' : 's'}` : '';
    if (!decks.length) return list.replaceChildren(h('div', { class: 'saved-empty' }, 'Aún no tienes mazos guardados. Carga uno abajo con «Guardar en mi cuenta» marcado.'));
    list.replaceChildren(...decks.map((d) => h('div', { class: `saved-item${editingDeck === d.id ? ' editing' : ''}` },
      h('div', { class: 'meta' }, h('b', {}, d.name), h('span', {}, `${d.commanders || 'Sin comandante'} · ${d.cardCount} cartas`)),
      h('button', { class: 'btn small primary', onclick: () => playSavedDeck(d) }, 'Jugar'),
      h('button', { class: 'btn small ghost', onclick: () => editSavedDeck(d) }, 'Editar'),
      h('button', { class: 'btn small ghost danger', title: 'Borrar', onclick: () => deleteSavedDeck(d) }, '🗑'))));
  } catch (err) {
    list.replaceChildren(h('div', { class: 'saved-empty' }, `No se pudieron cargar tus mazos: ${err.message}`));
  }
}
async function playSavedDeck(d) {
  try {
    const { deck } = await api('GET', `/decks/${d.id}`);
    const res = await act(deckFor, { type: 'setDeck', commanders: deck.resolved.commanders, cards: deck.resolved.cards });
    if (res?.ok) {
      closeModal('#modal-deck');
      toast(`Mazo «${deck.name}» listo. ¡Roba 7!`);
    }
  } catch (err) {
    toast(err.message, true);
  }
}
async function editSavedDeck(d) {
  try {
    const { deck } = await api('GET', `/decks/${d.id}`);
    editingDeck = deck.id;
    $('#deck-commanders').value = deck.commandersText;
    $('#deck-list').value = deck.listText;
    $('#deck-name').value = deck.name;
    $('#deck-save').checked = true;
    $('#deck-status').className = 'status';
    $('#deck-status').textContent = `Editando «${deck.name}». Al cargar se actualiza en tu cuenta.`;
    renderSavedDecks();
  } catch (err) {
    toast(err.message, true);
  }
}
async function deleteSavedDeck(d) {
  if (!confirm(`¿Borrar «${d.name}» de tu cuenta?`)) return;
  try {
    await api('DELETE', `/decks/${d.id}`);
    if (editingDeck === d.id) editingDeck = null;
    renderSavedDecks();
  } catch (err) {
    toast(err.message, true);
  }
}

async function renderMoxfield() {
  if (moxEnabled === null) {
    try { moxEnabled = (await api('GET', '/import/moxfield/status')).enabled; } catch { moxEnabled = false; }
  }
  $('#mox-url').disabled = !moxEnabled;
  $('#btn-mox').disabled = !moxEnabled;
  $('#mox-note').textContent = moxEnabled
    ? 'Solo mazos públicos.'
    : 'Importar por link se activa cuando Moxfield autorice la app. Mientras tanto: en Moxfield, abre el mazo → «More» → «Export» → copia el texto y pégalo abajo.';
}
$('#btn-mox').addEventListener('click', async () => {
  const url = $('#mox-url').value.trim();
  if (!url) return;
  const btn = $('#btn-mox');
  btn.disabled = true;
  $('#deck-status').className = 'status';
  $('#deck-status').textContent = 'Trayendo el mazo desde Moxfield…';
  try {
    const { deck } = await api('GET', `/import/moxfield?url=${encodeURIComponent(url)}`);
    $('#deck-commanders').value = deck.commandersText;
    $('#deck-list').value = deck.listText;
    if (!$('#deck-name').value.trim()) $('#deck-name').value = deck.name;
    $('#deck-status').textContent = `«${deck.name}» importado. Revisa la lista y pulsa «Cargar y barajar».`;
  } catch (err) {
    $('#deck-status').className = 'status err';
    $('#deck-status').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
$('#btn-deck').addEventListener('click', () => openDeckModal(state.you));
$('#btn-deck-load').addEventListener('click', async () => {
  const status = $('#deck-status');
  const btn = $('#btn-deck-load');
  const cmdText = $('#deck-commanders').value;
  const listText = $('#deck-list').value;
  const fromCmd = parseDeckList(cmdText, { commanderSection: true });
  const fromList = parseDeckList(listText);
  const parsed = { commanders: [...fromCmd.commanders, ...fromList.commanders], cards: [...fromCmd.cards, ...fromList.cards] };
  const total = [...parsed.commanders, ...parsed.cards].reduce((s, e) => s + e.qty, 0);
  if (!total) { status.textContent = 'La lista está vacía.'; status.className = 'status err'; return; }
  if (state && deckFor === state.you) store.set('edh.deck', { commanders: cmdText, list: listText });
  btn.disabled = true;
  status.className = 'status';
  status.textContent = `Buscando ${total} cartas en Scryfall…`;
  try {
    const deck = await resolveDeck(parsed, (done, all) => { status.textContent = `Buscando cartas en Scryfall… ${done}/${all}`; });
    const res = state ? await act(deckFor, { type: 'setDeck', commanders: deck.commanders, cards: deck.cards }) : { ok: true };
    if (res?.ok && account && (!state || $('#deck-save').checked)) {
      const name = $('#deck-name').value.trim() || deck.commanders.map((c) => c.name).join(' + ') || 'Mi mazo';
      const body = { name, commandersText: cmdText, listText: listText, resolved: { commanders: deck.commanders, cards: deck.cards } };
      try {
        const saved = editingDeck ? await api('PUT', `/decks/${editingDeck}`, body) : await api('POST', '/decks', body);
        editingDeck = saved.deck.id;
        toast(`Guardado en tu cuenta como «${saved.deck.name}»`);
      } catch (err) {
        toast(`No se pudo guardar: ${err.message}`, true);
      }
    }
    if (res?.ok && !state) {
      if (deck.notFound.length) {
        status.className = 'status warn';
        status.textContent = `Guardado. No encontradas: ${deck.notFound.join(', ')}`;
      } else closeModal('#modal-deck');
      renderHomeDecks();
    } else if (res?.ok) {
      const count = deck.commanders.length + deck.cards.length;
      if (deck.notFound.length) {
        status.className = 'status warn';
        status.textContent = `Cargadas ${count}. No encontradas: ${deck.notFound.join(', ')}`;
        toast(`Mazo cargado (${count}). Faltaron ${deck.notFound.length}; revisa el modal de mazo.`);
      } else {
        closeModal('#modal-deck');
        toast(`Mazo cargado: ${count} cartas. ¡Roba 7 con clic derecho en la biblioteca!`);
      }
    }
  } catch (err) {
    status.className = 'status err';
    status.textContent = `No se pudo consultar Scryfall: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Tokens ----------
function openTokenModal(pid = handSeat ?? state.you, pos = {}) {
  tokenFor = { pid, ...pos };
  $('#token-query').value = '';
  $('#token-results').replaceChildren();
  $('#token-status').textContent = 'Escribe para buscar tokens con imagen, o crea uno sin imagen.';
  openModal('#modal-token');
  setTimeout(() => $('#token-query').focus(), 30);
}
let tokenTimer = null;
$('#token-query').addEventListener('input', () => {
  clearTimeout(tokenTimer);
  const q = $('#token-query').value.trim();
  if (q.length < 2) return;
  tokenTimer = setTimeout(async () => {
    $('#token-status').textContent = 'Buscando…';
    try {
      const results = await searchTokens(q);
      if ($('#token-query').value.trim() !== q) return;
      $('#token-status').textContent = results.length ? `${results.length} resultados. Clic para crear.` : 'Sin resultados; puedes crearlo sin imagen.';
      $('#token-results').replaceChildren(...results.map((t) => h('div', {
        class: 'card', style: { backgroundImage: `url("${t.image}")` }, title: `${t.name} — ${t.typeLine}`,
        onclick: () => { createToken(tokenFor.pid, t, tokenFor); closeModal('#modal-token'); },
      })));
    } catch (err) {
      $('#token-status').textContent = `No se pudo consultar Scryfall: ${err.message}`;
    }
  }, 350);
});
$('#btn-token-plain').addEventListener('click', () => {
  const name = $('#token-query').value.trim() || prompt('Nombre del token (ej: Zombi 2/2, Tesoro)', 'Tesoro');
  if (!name?.trim()) return;
  createToken(tokenFor.pid, { name: name.trim() }, tokenFor);
  closeModal('#modal-token');
});
function createToken(pid, t, pos = {}) {
  return act(pid, { type: 'token', name: t.name, image: t.image, backImage: t.backImage, typeLine: t.typeLine, scryfallId: t.scryfallId, x: pos.x, y: pos.y });
}
async function createRelatedToken(pid, t, source) {
  try {
    const card = await fetchCard(t.id);
    const pos = source ? { x: Math.min(1, source.x + 0.06), y: Math.min(1, source.y + 0.05) } : {};
    createToken(pid, card ? toCardData(card) : { name: t.name }, pos);
  } catch {
    createToken(pid, { name: t.name });
  }
}

// ---------- Ficha de carta ----------
const LEGAL = { legal: ['ok', 'Legal en Commander'], banned: ['no', 'Prohibida en Commander'], not_legal: ['no', 'No legal en Commander'], restricted: ['no', 'Restringida'] };
async function openCardInfo(c) {
  const body = $('#info-body');
  $('#info-title').textContent = c.name;
  body.replaceChildren(h('p', { class: 'muted' }, 'Cargando desde Scryfall…'));
  openModal('#modal-info');
  try {
    const [card, rulings] = await Promise.all([fetchCard(c.scryfallId), fetchRulings(c.scryfallId)]);
    if (!card) return body.replaceChildren(h('p', {}, 'No se encontró la carta en Scryfall.'));
    const faces = card.card_faces?.length ? card.card_faces : [card];
    const legal = LEGAL[card.legalities?.commander] ?? ['no', card.legalities?.commander ?? 'Sin datos'];
    const images = faces.map((f) => f.image_uris?.normal ?? card.image_uris?.normal).filter((v, i, a) => v && a.indexOf(v) === i);
    body.replaceChildren(
      h('div', {}, ...images.map((src) => h('img', { src, alt: card.name }))),
      h('div', {},
        h('span', { class: `legal ${legal[0]}` }, legal[1]),
        ...faces.map((f) => h('div', {},
          h('h3', {}, f.name, f.mana_cost ? h('span', { class: 'muted small' }, `  ${f.mana_cost}`) : null),
          h('p', { class: 'type' }, f.type_line ?? card.type_line, f.power != null ? ` · ${f.power}/${f.toughness}` : '', f.loyalty ? ` · Lealtad ${f.loyalty}` : ''),
          f.oracle_text ? h('p', { class: 'oracle' }, f.oracle_text) : null)),
        h('h3', {}, `Rulings (${rulings.length})`),
        rulings.length
          ? h('ul', { class: 'rulings' }, ...rulings.map((r) => h('li', {}, h('time', {}, r.published_at), r.comment)))
          : h('p', { class: 'muted small' }, 'Sin rulings publicados.'),
        h('p', { class: 'small' }, h('a', { href: card.scryfall_uri, target: '_blank', rel: 'noopener', style: { color: 'var(--gold)' } }, 'Ver en Scryfall ↗')),
      ),
    );
  } catch (err) {
    body.replaceChildren(h('p', { class: 'status err' }, `No se pudo consultar Scryfall: ${err.message}`));
  }
}

// ---------- Barra superior ----------
$('#phase-chip').addEventListener('click', () => send({ type: 'phase' }));
$('#btn-d20').addEventListener('click', () => send({ type: 'roll', sides: 20 }));
$('#btn-coin').addEventListener('click', () => send({ type: 'coin' }));
$('#btn-token').addEventListener('click', () => openTokenModal(handSeat ?? state.you));
$('#btn-seat').addEventListener('click', () => {
  const name = prompt('Nombre del asiento', `Rival ${state.players.length}`);
  if (name === null) return;
  const copyDeck = me()?.hasDeck && confirm('¿Usar tu mismo mazo en el nuevo asiento? (Cancelar = cargarlo después)');
  send({ type: 'addSeat', name, copyDeck });
});
document.querySelectorAll('[data-ann]').forEach((b) => b.addEventListener('click', () => send({ type: 'announce', kind: b.dataset.ann })));
$('#btn-help').addEventListener('click', () => openModal('#modal-help'));
$('#btn-copy').addEventListener('click', async () => {
  const link = `${location.origin}/?sala=${state.code}`;
  try { await navigator.clipboard.writeText(link); toast('Enlace copiado. Compártelo con tus rivales.'); }
  catch { prompt('Copia este enlace:', link); }
});
$('#btn-leave').addEventListener('click', async () => {
  if (!confirm(state.solo ? '¿Terminar la práctica?' : '¿Salir de la sala? Perderás tu asiento y tus cartas.')) return;
  await emit('leaveRoom');
  store.del('edh.session');
  session = null;
  state = null;
  history.replaceState(null, '', '/');
  showScreen('lobby');
  loadHome();
});

// ---------- Terminar partida ----------
$('#btn-end').addEventListener('click', () => {
  if (state.solo) return toast('Las prácticas en solitario no se guardan en el historial. Usa «Salir» para terminar.');
  const humans = state.players.filter((p) => !p.controlledBy);
  $('#end-players').replaceChildren(...humans.map((p) => h('button', {
    class: 'end-player', style: { '--pc': p.color },
    onclick: () => endGame(p.id),
  },
  h('span', { class: 'end-portrait', style: artCrop(p.commanderImages?.[0]) ? { backgroundImage: `url("${artCrop(p.commanderImages[0])}")` } : {} }),
  h('span', {}, h('b', {}, p.name), h('span', { class: 'muted small' }, p.commanderNames.join(' + ') || 'Sin comandante')),
  h('span', { class: 'end-cta' }, 'Ganó'))));
  openModal('#modal-end');
});
$('#btn-end-draw').addEventListener('click', () => endGame(null));
async function endGame(winner) {
  const res = await send({ type: 'endGame', winner, rematch: $('#end-rematch').checked });
  if (res?.ok) closeModal('#modal-end');
}
function showGameOver(ev) {
  if (ev.winner && asset('banners/victory')) {
    const el = h('div', { class: 'comic-pop', style: { '--pc': ev.color ?? 'var(--gold)' } }, h('div', { class: 'comic-rays' }),
      h('img', { class: 'comic-card', src: asset('banners/victory'), alt: 'Victoria' }), h('div', { class: 'comic-who' }, `${ev.winner} gana`));
    return onStage(el, 3400);
  }
  const el = h('div', { class: 'turn-banner mine', style: { '--pc': ev.color ?? 'var(--brass)' } },
    h('span', { class: 'turn-title' }, ev.winner ? `🏆 ${ev.winner} gana` : 'Empate'),
    h('span', { class: 'turn-sub' }, 'La partida quedó guardada en el historial'));
  onStage(el, 3200);
}
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  input.value = '';
  if (!text) return;
  send({ type: 'chat', text }).then((res) => {
    if (res?.private?.kind === 'help') toast(`Comandos: ${res.private.text}`);
  });
});

// ---------- Atajos de teclado (reasignables, por defecto los de EDHPlay) ----------
// Combinación: «Ctrl+», «Alt+», «Shift+» + tecla. Letras y números se leen por posición
// física (e.code), así funcionan igual con Alt en Mac; los símbolos por carácter (+, -, =, _).
const seatNow = () => handSeat ?? state.you;
let selected = new Set(); // cartas seleccionadas (selección múltiple)
let cardScale = Number(store.get('edh.scale', 1)) || 1;
let showMana = store.get('edh.mana', false);
let focusPid = null;

/** Carta bajo el mouse que controlo. */
const hoveredMine = (zones) => (hovered && isMine(hovered.owner) && (!zones || zones.includes(hovered.zone)) ? hovered : null);
/** Objetivos de una acción de carta: la selección, o si no hay, la carta bajo el mouse. */
function targets(zones) {
  if (selected.size) {
    return [...selected].map((iid) => ({ iid, ...findMyCard(iid) })).filter((t) => t.card && (!zones || zones.includes(t.zone))).map((t) => ({ iid: t.iid, owner: t.pid, zone: t.zone }));
  }
  const hv = hoveredMine(zones);
  return hv ? [hv] : [];
}
const eachTarget = (zones, fn) => () => { for (const t of targets(zones)) fn(t); };
const moveTargets = (to, extra = {}) => eachTarget(null, (t) => {
  const found = findMyCard(t.iid);
  const pos = to === 'battlefield' && found ? freeSpot(playerById(t.owner), found.card) : {};
  act(t.owner, { type: 'move', iid: t.iid, to, ...pos, ...extra });
});
const onHovered = (zones, fn) => () => { const hv = hoveredMine(zones); if (hv) fn(hv); };
const BF = ['battlefield'];

const SHORTCUTS = [
  // Acciones globales
  { group: 'Acciones globales', id: 'passTurn', label: 'Pasar turno', keys: 'Space', run: () => send({ type: 'passTurn' }) },
  { group: 'Acciones globales', id: 'draw', label: 'Robar carta', keys: 'd', run: () => act(seatNow(), { type: 'draw', n: 1 }) },
  { group: 'Acciones globales', id: 'untapAll', label: 'Enderezar todo', keys: 'u', run: () => act(seatNow(), { type: 'untapAll' }) },
  { group: 'Acciones globales', id: 'sizeUp', label: 'Aumentar tamaño de carta', keys: '=', run: () => setScale(cardScale + 0.1) },
  { group: 'Acciones globales', id: 'sizeDown', label: 'Reducir tamaño de carta', keys: '-', run: () => setScale(cardScale - 0.1) },
  { group: 'Acciones globales', id: 'mana', label: 'Alternar rastreador de maná', keys: 'm', run: () => { showMana = !showMana; store.set('edh.mana', showMana); render(); } },
  { group: 'Acciones globales', id: 'phase', label: 'Avanzar fase', keys: 'q', run: () => send({ type: 'phase' }) },
  { group: 'Acciones globales', id: 'lifeUp', label: 'Aumentar vida', keys: 'ArrowUp', run: () => act(seatNow(), { type: 'life', delta: 1 }) },
  { group: 'Acciones globales', id: 'lifeDown', label: 'Disminuir vida', keys: 'ArrowDown', run: () => act(seatNow(), { type: 'life', delta: -1 }) },
  { group: 'Acciones globales', id: 'chat', label: 'Alternar chat', keys: 'c', run: () => { document.body.classList.toggle('no-side'); renderHand(); drawArrows(); } },
  { group: 'Acciones globales', id: 'shuffle', label: 'Barajar biblioteca', keys: 's', run: () => act(seatNow(), { type: 'shuffle' }) },
  { group: 'Acciones globales', id: 'library', label: 'Ver biblioteca', keys: 'v', run: () => peekLibrary(seatNow(), 0) },
  { group: 'Acciones globales', id: 'peekTop', label: 'Ver las X cartas superiores', keys: 'p', run: () => { const n = askNumber('¿Cuántas cartas del tope?', 3); if (n) peekLibrary(seatNow(), n); } },
  { group: 'Acciones globales', id: 'peekBottom', label: 'Ver las X cartas inferiores', keys: 'Shift+p', run: () => { const n = askNumber('¿Cuántas cartas del fondo?', 1); if (n) peekLibrary(seatNow(), n, 'bottom'); } },
  { group: 'Acciones globales', id: 'coin', label: 'Lanzar una moneda', keys: 'o', run: () => send({ type: 'coin' }) },
  { group: 'Acciones globales', id: 'token', label: 'Crear ficha', keys: 'n', run: () => openTokenModal(seatNow()) },
  { group: 'Acciones globales', id: 'keys', label: 'Abrir atajos', keys: 'i', run: () => openKeys() },
  { group: 'Acciones globales', id: 'clearArrows', label: 'Eliminar todas mis flechas', keys: '', run: () => send({ type: 'clearArrows' }) },
  { group: 'Acciones globales', id: 'topCard', label: 'Ver la carta superior de la biblioteca', keys: '', run: () => peekLibrary(seatNow(), 1) },
  { group: 'Acciones globales', id: 'bottomCard', label: 'Ver la carta inferior de la biblioteca', keys: '', run: () => peekLibrary(seatNow(), 1, 'bottom') },
  { group: 'Acciones globales', id: 'selectAll', label: 'Seleccionar todas las cartas (campo)', keys: 'Ctrl+a', run: () => { selected = new Set((playerById(seatNow())?.zones.battlefield ?? []).map((c) => c.iid)); render(); } },
  // Acciones de carta (al pasar el cursor; con selección, sobre todas las seleccionadas)
  { group: 'Acciones de carta (al pasar el cursor)', id: 'tap', label: 'Girar / enderezar', keys: 't', run: eachTarget(BF, (t) => act(t.owner, { type: 'tap', iid: t.iid })) },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'transform', label: 'Voltear (cartas de doble cara)', keys: 'f', run: eachTarget(BF, (t) => act(t.owner, { type: 'transform', iid: t.iid })) },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'faceDown', label: 'Alternar boca abajo', keys: 'z', run: eachTarget(BF, (t) => act(t.owner, { type: 'flip', iid: t.iid })) },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'clone', label: 'Crear copia de ficha', keys: 'x', run: eachTarget(BF, (t) => act(t.owner, { type: 'clone', iid: t.iid })) },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'reveal', label: 'Revelar', keys: 'r', run: onHovered(null, (hv) => act(hv.owner, { type: 'reveal', iid: hv.iid })) },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'toHand', label: 'Mover a la mano', keys: 'h', run: moveTargets('hand') },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'toGraveyard', label: 'Mover al cementerio', keys: 'g', run: moveTargets('graveyard') },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'toExile', label: 'Mover al exilio', keys: 'e', run: moveTargets('exile') },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'toBattlefield', label: 'Mover al campo de batalla', keys: 'a', run: moveTargets('battlefield') },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'toTop', label: 'Mover al tope de la biblioteca', keys: 'l', run: moveTargets('library', { position: 'top' }) },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'toBottom', label: 'Mover al fondo de la biblioteca', keys: 'b', run: moveTargets('library', { position: 'bottom' }) },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'arrow', label: 'Dibujar flecha', keys: 'w', run: () => { const hv = hovered && ['battlefield', 'graveyard', 'exile', 'command'].includes(findVisibleCard(hovered.iid)?.zone) ? hovered : null; if (hv) startTargeting(hv.iid, hv.owner, 'la flecha', 'arrow'); } },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'counters', label: 'Abrir contadores', keys: 'j', run: onHovered(BF, (hv) => { const n = Number.parseInt(prompt('Contadores a sumar (negativo para restar)', '1') ?? '', 10); if (n) act(hv.owner, { type: 'counters', iid: hv.iid, delta: n }); }) },
  { group: 'Acciones de carta (al pasar el cursor)', id: 'info', label: 'Ver ficha (oráculo y rulings)', keys: 'Shift+i', run: () => { const c = hovered && findVisibleCard(hovered.iid)?.card; if (c?.scryfallId && !c.faceDown) openCardInfo(c); } },
  // Contadores y fuerza/resistencia
  { group: 'Contadores y fuerza/resistencia', id: 'counterUp', label: 'Añadir contador +1/+1', keys: '+', run: eachTarget(BF, (t) => act(t.owner, { type: 'counters', iid: t.iid, delta: 1 })) },
  { group: 'Contadores y fuerza/resistencia', id: 'counterDown', label: 'Añadir contador −1/−1', keys: '_', run: eachTarget(BF, (t) => act(t.owner, { type: 'counters', iid: t.iid, delta: -1 })) },
  { group: 'Contadores y fuerza/resistencia', id: 'countersInc', label: 'Incrementar todos los contadores', keys: 'Ctrl+1', run: () => act(seatNow(), { type: 'countersAll', op: 'inc' }) },
  { group: 'Contadores y fuerza/resistencia', id: 'countersDouble', label: 'Duplicar todos los contadores', keys: 'Ctrl+2', run: () => act(seatNow(), { type: 'countersAll', op: 'double' }) },
  { group: 'Contadores y fuerza/resistencia', id: 'countersDec', label: 'Decrementar todos los contadores', keys: 'Ctrl+3', run: () => act(seatNow(), { type: 'countersAll', op: 'dec' }) },
  { group: 'Contadores y fuerza/resistencia', id: 'powerUp', label: 'Incrementar fuerza', keys: 'Alt+1', run: eachTarget(BF, (t) => act(t.owner, { type: 'pt', iid: t.iid, dp: 1, dt: 0 })) },
  { group: 'Contadores y fuerza/resistencia', id: 'toughUp', label: 'Incrementar resistencia', keys: 'Alt+2', run: eachTarget(BF, (t) => act(t.owner, { type: 'pt', iid: t.iid, dp: 0, dt: 1 })) },
  { group: 'Contadores y fuerza/resistencia', id: 'powerDown', label: 'Decrementar fuerza', keys: 'Alt+3', run: eachTarget(BF, (t) => act(t.owner, { type: 'pt', iid: t.iid, dp: -1, dt: 0 })) },
  { group: 'Contadores y fuerza/resistencia', id: 'toughDown', label: 'Decrementar resistencia', keys: 'Alt+4', run: eachTarget(BF, (t) => act(t.owner, { type: 'pt', iid: t.iid, dp: 0, dt: -1 })) },
  // Enfocar jugadores
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ group: 'Enfocar jugadores', id: `focus${n}`, label: `Enfocar jugador ${n}`, keys: String(n), run: () => focusPlayer(n) })),
  // Reacciones
  { group: 'Reacciones', id: 'reactUp', label: 'Pulgar arriba 👍', keys: '7', run: () => send({ type: 'react', kind: 'up' }) },
  { group: 'Reacciones', id: 'reactThink', label: 'Pensando 🤔', keys: '8', run: () => send({ type: 'react', kind: 'think' }) },
  { group: 'Reacciones', id: 'reactWow', label: 'Asombro 😮', keys: '9', run: () => send({ type: 'react', kind: 'wow' }) },
  { group: 'Reacciones', id: 'reactCry', label: 'Llanto 😢', keys: '0', run: () => send({ type: 'react', kind: 'cry' }) },
  // Extras de EDH Platform (EDHPlay no los tiene)
  { group: 'Anuncios (extra)', id: 'respond', label: 'Anunciar «¡Respondo!»', keys: 'Shift+r', run: () => send({ type: 'announce', kind: 'respond' }) },
  { group: 'Anuncios (extra)', id: 'trigger', label: 'Anunciar trigger (de la carta, si hay una)', keys: 'Shift+g', run: () => { const hv = hoveredMine(['battlefield', 'graveyard', 'exile', 'command']); act(hv?.owner ?? state.you, { type: 'announce', kind: 'trigger', iid: hv?.iid }); } },
  { group: 'Anuncios (extra)', id: 'wait', label: 'Anunciar «¡Espera!»', keys: 'Shift+e', run: () => send({ type: 'announce', kind: 'wait' }) },
  { group: 'Anuncios (extra)', id: 'ok', label: 'Anunciar «OK, sigue»', keys: 'Shift+o', run: () => send({ type: 'announce', kind: 'ok' }) },
  { group: 'Anuncios (extra)', id: 'drawX', label: 'Robar X cartas', keys: 'Shift+d', run: () => { const n = askNumber('¿Cuántas cartas robar?', 7); if (n) act(seatNow(), { type: 'draw', n }); } },
  { group: 'Anuncios (extra)', id: 'mulligan', label: 'Mulligan', keys: '', run: () => confirm('¿Hacer mulligan?') && act(seatNow(), { type: 'mulligan' }) },
  { group: 'Anuncios (extra)', id: 'chatFocus', label: 'Escribir en el chat', keys: 'Enter', run: () => $('#chat-input').focus() },
];
let keyOverrides = store.get('edh.keys.v2', {});
const bindingOf = (sc) => keyOverrides[sc.id] ?? sc.keys;

function comboFromEvent(e) {
  if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null;
  const mods = `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}`;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (letter) return `${mods}${e.shiftKey ? 'Shift+' : ''}${letter[1].toLowerCase()}`;
  if (digit) return `${mods}${e.shiftKey ? 'Shift+' : ''}${digit[1]}`;
  const named = { ' ': 'Space', Backspace: 'Delete', Del: 'Delete', NumpadAdd: '+', NumpadSubtract: '-' };
  const key = named[e.key] ?? named[e.code] ?? e.key;
  if (key.length === 1) return `${mods}${key}`; // símbolos: el carácter ya incluye Shift
  return `${mods}${e.shiftKey ? 'Shift+' : ''}${key}`;
}
const KEY_NAMES = { Space: 'Espacio', Delete: 'Supr', Enter: 'Enter', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
const comboLabel = (combo) => (combo ? combo.split(/\+(?!$)/).map((part) => KEY_NAMES[part] ?? (part.length === 1 ? part.toUpperCase() : part)).join(' + ') : 'Sin asignar');

let capturing = null;
function openKeys() {
  renderKeys();
  openModal('#modal-keys');
}
function renderKeys() {
  const groups = [...new Set(SHORTCUTS.map((sc) => sc.group))];
  $('#keys-list').replaceChildren(...groups.map((g) => h('section', { class: 'keys-group' },
    h('h3', {}, g),
    ...SHORTCUTS.filter((sc) => sc.group === g).map((sc) => h('div', { class: 'key-row' },
      h('button', {
        class: `keycap${capturing === sc.id ? ' capturing' : ''}${keyOverrides[sc.id] !== undefined ? ' custom' : ''}${bindingOf(sc) ? '' : ' unset'}`,
        onclick: () => { capturing = sc.id; renderKeys(); },
      }, capturing === sc.id ? 'Presiona…' : comboLabel(bindingOf(sc))),
      h('span', {}, sc.label))))),
  h('p', { class: 'muted small keys-note' }, 'En Chrome, Ctrl+1, Ctrl+2 y Ctrl+3 cambian de pestaña y no se pueden capturar; si los usas, reasígnalos. Próximamente: «Agregar a la pila».'));
}
$('#btn-keys').addEventListener('click', openKeys);
$('#btn-keys-reset').addEventListener('click', () => {
  keyOverrides = {};
  store.del('edh.keys.v2');
  capturing = null;
  renderKeys();
  toast('Atajos restaurados a los de EDHPlay');
});

function setScale(v) {
  cardScale = Math.round(Math.min(1.8, Math.max(0.6, v)) * 10) / 10;
  store.set('edh.scale', cardScale);
  document.documentElement.style.setProperty('--scale', cardScale);
  drawArrows();
}
document.documentElement.style.setProperty('--scale', cardScale);

function focusPlayer(n) {
  const p = state.players[n - 1];
  if (!p) return;
  focusPid = focusPid === p.id || p.id === state.you ? null : p.id;
  render();
  if (focusPid) toast(`Enfocando a ${p.name}. Presiona ${n} otra vez para volver.`);
}

document.addEventListener('keydown', (e) => {
  if (capturing) {
    e.preventDefault();
    if (e.key === 'Escape') { capturing = null; return renderKeys(); }
    const combo = comboFromEvent(e);
    if (!combo) return;
    for (const sc of SHORTCUTS) if (sc.id !== capturing && bindingOf(sc) === combo) keyOverrides[sc.id] = '';
    keyOverrides[capturing] = combo;
    store.set('edh.keys.v2', keyOverrides);
    capturing = null;
    return renderKeys();
  }
  if (e.key === 'Escape') {
    if (targeting) return stopTargeting();
    if (selected.size) { selected.clear(); return render(); }
    closeMenu();
    document.querySelectorAll('.modal:not(.hidden)').forEach((m) => closeModal(`#${m.id}`));
    return;
  }
  if (!state || e.target.closest('input, textarea, select')) return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  const combo = comboFromEvent(e);
  const sc = combo && SHORTCUTS.find((x) => bindingOf(x) === combo);
  if (!sc) return;
  e.preventDefault(); // que Espacio no desplace la página ni Ctrl+A seleccione texto
  closeMenu();
  sc.run();
});

// ---------- Toasts ----------
function toast(text, isError = false) {
  const t = h('div', { class: `toast${isError ? ' error' : ''}`, onclick: () => t.remove() }, text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}
function toastCards(title, cards) {
  const t = h('div', { class: 'toast', onclick: () => t.remove() }, h('b', {}, title),
    h('div', { class: 'imgs' }, ...(cards.length ? cards.map((c) => (c.image ? h('img', { src: c.image, alt: c.name, title: c.name }) : h('span', { class: 'stat' }, c.name))) : [h('span', { class: 'muted' }, '(nada)')])));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 9000);
}
function handRequestToast(ev) {
  const t = h('div', { class: 'toast' },
    h('b', {}, `${ev.from} te pide que reveles tu mano`),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn small ghost', onclick: () => t.remove() }, 'Ignorar'),
      h('button', { class: 'btn small primary', onclick: () => { act(ev.target, { type: 'revealHand' }); t.remove(); } }, 'Revelar mi mano')));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 20000);
}

// ---------- Animaciones de mesa ----------
const ANN_ICON = { respond: '✋', trigger: '⚡', wait: '⏸', ok: '✓' };
function onStage(el, ms) {
  $('#stage').append(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 400); }, ms);
}
function chime(freqs) {
  try {
    const ctx = chime.ctx ??= new AudioContext();
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = 'triangle';
      const t = ctx.currentTime + i * 0.09;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.4);
    });
  } catch { /* audio no disponible */ }
}
const BANNER_FOR = { trigger: 'banners/trigger', respond: 'banners/respond', wait: 'banners/wait', ok: 'banners/ok' };
function showAnnouncement(ev) {
  const art = asset(BANNER_FOR[ev.ann]);
  if (art) {
    const el = h('div', { class: `comic-pop ann-${ev.ann}`, style: { '--pc': ev.color } },
      h('div', { class: 'comic-rays' }),
      h('img', { class: 'comic-card', src: art, alt: ev.text }),
      h('div', { class: 'comic-who' }, ev.player),
      ev.card?.image ? h('img', { class: 'comic-source', src: ev.card.image, alt: ev.card.name }) : null);
    onStage(el, ev.card ? 3400 : 2600);
    if (ev.ann !== 'ok') chime(ev.ann === 'trigger' ? [660, 880, 1320] : [520, 780]);
    return;
  }
  const el = h('div', { class: `announce ann-${ev.ann}`, style: { '--pc': ev.color } },
    h('div', { class: 'announce-icon' }, ANN_ICON[ev.ann] ?? '📣'),
    h('div', { class: 'announce-text' }, h('div', { class: 'announce-who' }, ev.player), h('div', { class: 'announce-what' }, ev.text)),
    ev.card?.image ? h('img', { src: ev.card.image, alt: ev.card.name }) : ev.card ? h('span', { class: 'stat' }, ev.card.name) : null);
  onStage(el, ev.card ? 4200 : 2800);
  if (ev.ann !== 'ok') chime(ev.ann === 'trigger' ? [660, 880, 1320] : [520, 780]);
}
function showCoin(ev) {
  const el = h('div', { class: 'roll-card', style: { '--pc': ev.color } },
    h('div', { class: `coin ${ev.result === 'cara' ? 'heads' : 'tails'}` }, h('div', { class: 'face front' }, 'CARA'), h('div', { class: 'face back' }, 'SELLO')),
    h('div', { class: 'roll-caption' }, h('b', {}, ev.player), ' lanzó una moneda: ', h('b', { class: 'result' }, ev.result.toUpperCase())));
  onStage(el, 3600);
}
function showDice(ev) {
  const die = h('div', { class: 'die' }, '?');
  const el = h('div', { class: 'roll-card', style: { '--pc': ev.color } }, die,
    h('div', { class: 'roll-caption' }, h('b', {}, ev.player), ` lanzó ${ev.label}`, ev.rolls.length > 1 ? `: ${ev.rolls.join(' + ')}` : ''));
  let ticks = 0;
  const max = Number(ev.label.split('d')[1]) || 20;
  const spin = setInterval(() => {
    die.textContent = 1 + Math.floor(Math.random() * max);
    if (++ticks >= 12) { clearInterval(spin); die.textContent = ev.total; die.classList.add('landed'); }
  }, 60);
  onStage(el, 3600);
}

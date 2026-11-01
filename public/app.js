// Cliente de EDH Platform: lobby, tablero, arrastrar y soltar, menús y modales.
import { parseDeckList, resolveDeck } from './deck.js';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
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

const socket = io({ transports: ['websocket', 'polling'] });
let state = null; // última vista recibida del servidor
let session = store.get('edh.session'); // { code, token, name }
let hovered = null; // { iid, zone } bajo el mouse (para atajos)
let zoneView = null; // { pid, zone } | { library: true, cards, n }

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
const emit = (ev, data) => new Promise((r) => socket.emit(ev, data, r));

async function enterRoom(res, name) {
  if (!res?.ok) {
    $('#lobby-error').textContent = res?.error ?? 'No se pudo entrar';
    return false;
  }
  session = { code: res.code, token: res.token, name };
  store.set('edh.session', session);
  history.replaceState(null, '', `?sala=${res.code}`);
  $('#lobby').classList.add('hidden');
  $('#room').classList.remove('hidden');
  return true;
}

socket.on('connect', async () => {
  // Reconexión automática al asiento si había sesión en esta sala.
  const urlCode = new URLSearchParams(location.search).get('sala')?.toUpperCase();
  if (session?.token && (!urlCode || urlCode === session.code)) {
    const res = await emit('joinRoom', { code: session.code, token: session.token, name: session.name });
    if (!(await enterRoom(res, session.name))) {
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
  render();
  if (first && !me()?.hasDeck) openDeckModal();
});
socket.on('event', (ev) => {
  if (ev.kind === 'announce') return showAnnouncement(ev);
  if (ev.kind === 'coin') return showCoin(ev);
  if (ev.kind === 'dice') return showDice(ev);
  if (ev.kind === 'reveal') toastCards(`${ev.player} revela`, [ev.card]);
  if (ev.kind === 'revealHand') toastCards(`${ev.player} revela su mano`, ev.cards);
});

// ---------- Lobby ----------
$('#lobby-name').value = store.get('edh.name', '');
const lobbyName = () => {
  const name = $('#lobby-name').value.trim();
  store.set('edh.name', name);
  return name;
};
$('#btn-create').addEventListener('click', async () => {
  const name = lobbyName();
  if (!name) return ($('#lobby-error').textContent = 'Escribe tu nombre');
  enterRoom(await emit('createRoom', { name }), name);
});
async function join() {
  const name = lobbyName();
  const code = $('#lobby-code').value.trim().toUpperCase();
  if (!name) return ($('#lobby-error').textContent = 'Escribe tu nombre');
  if (code.length !== 6) return ($('#lobby-error').textContent = 'El código tiene 6 caracteres');
  enterRoom(await emit('joinRoom', { code, name }), name);
}
$('#btn-join').addEventListener('click', join);
$('#lobby-code').addEventListener('keydown', (e) => e.key === 'Enter' && join());

// ---------- Utilidades de estado ----------
const me = () => state?.players.find((p) => p.id === state.you);
const playerById = (id) => state?.players.find((p) => p.id === id);
const isMine = (pid) => pid === state?.you;
function findMyCard(iid) {
  const p = me();
  for (const [zone, cards] of Object.entries(p?.zones ?? {})) {
    const card = cards.find((c) => c.iid === iid);
    if (card) return { card, zone };
  }
  if (zoneView?.library) {
    const card = zoneView.cards.find((c) => c.iid === iid);
    if (card) return { card, zone: 'library' };
  }
  return null;
}
const cardImage = (c) => (c.faceDown ? null : c.transformed && c.backImage ? c.backImage : c.image);

// ---------- Render ----------
function render() {
  if (!state) return;
  $('#room-code').textContent = state.code;
  $('#turn-num').textContent = state.turn;
  const active = playerById(state.activePlayerId);
  $('#turn-player').textContent = active?.name ?? '—';
  $('#turn-player').style.color = active?.color ?? '';

  const opps = state.players.filter((p) => p.id !== state.you);
  const oppBox = $('#opponents');
  oppBox.style.setProperty('--opp-cols', Math.min(3, Math.max(1, opps.length)));
  oppBox.style.height = opps.length > 3 ? '46%' : '';
  oppBox.replaceChildren(...opps.map((p) => renderPanel(p)));
  const mine = me();
  $('#me').replaceChildren(mine ? renderPanel(mine) : '');
  renderHand(mine);
  renderLog();
  if (zoneView && !zoneView.library) renderZoneModal();
}

function renderCard(c, { owner, zone }) {
  const mine = isMine(owner);
  const img = cardImage(c);
  const classes = ['card'];
  if (c.tapped && zone === 'battlefield') classes.push('tapped');
  if (c.faceDown) classes.push('back');
  else if (!img) classes.push('noimg');
  if (c.token) classes.push('token');
  const el = h('div', {
    class: classes.join(' '),
    dataset: { iid: c.iid, zone, owner },
    style: { backgroundImage: img ? `url("${img}")` : '' },
    title: c.faceDown && !mine ? 'Carta boca abajo' : c.name,
  });
  if (!img && !c.faceDown) el.append(c.name);
  if (c.counters) el.append(h('span', { class: `badge${c.counters < 0 ? ' neg' : ''}` }, c.counters > 0 ? `+${c.counters}` : c.counters));
  if (c.token) el.append(h('span', { class: 'tag' }, 'TOKEN'));
  else if (c.faceDown && mine && zone === 'battlefield') el.append(h('span', { class: 'tag' }, 'OCULTA'));
  if (zone === 'battlefield') {
    el.style.setProperty('--x', c.x);
    el.style.setProperty('--y', c.y);
  }
  if (mine) el.dataset.drag = '1';
  el.addEventListener('mouseenter', () => { hovered = { iid: c.iid, zone, owner }; showPreview(c, mine); });
  el.addEventListener('mouseleave', () => { if (hovered?.iid === c.iid) hovered = null; });
  return el;
}

function pile(p, zone) {
  const mine = isMine(p.id);
  const count = p.counts[zone];
  const el = h('div', { class: 'pile', dataset: { pile: zone, owner: p.id, ...(mine ? { drop: zone } : {}) }, title: `${ZONE_NAMES[zone]} (${count})` });
  if (zone === 'library') {
    if (count) el.append(h('div', { class: 'card back' }));
    else el.append(h('div', { class: 'pile-empty' }));
  } else {
    const top = p.zones[zone]?.at(-1);
    if (top) el.append(renderCard(top, { owner: p.id, zone }));
    else el.append(h('div', { class: 'pile-empty' }));
  }
  el.append(h('span', { class: 'pile-label' }, `${zone === 'library' ? 'Biblio' : zone === 'graveyard' ? 'Cement.' : 'Exilio'} ${count}`));
  return el;
}

function renderPanel(p) {
  const mine = isMine(p.id);
  const others = state.players.filter((o) => o.id !== p.id);
  const lifeBtn = (delta, label) => h('button', {
    title: 'Shift: ±5',
    onclick: (e) => send({ type: 'life', delta: e.shiftKey ? delta * 5 : delta }),
  }, label);

  const cmdStats = others.map((o) => {
    const dmg = p.cmdDamage[o.id] ?? 0;
    if (!mine && !dmg) return null;
    return h('span', {
      class: `stat${mine ? ' click' : ''}${dmg >= 21 ? ' lethal' : ''}`,
      style: { borderColor: dmg >= 21 ? '' : o.color },
      title: mine ? `Daño de comandante recibido de ${o.name}. Clic +1, clic derecho −1` : `Daño de comandante de ${o.name}`,
      onclick: mine ? () => send({ type: 'cmdDamage', source: o.id, delta: 1 }) : null,
      oncontextmenu: mine ? (e) => { e.preventDefault(); send({ type: 'cmdDamage', source: o.id, delta: -1 }); } : null,
    }, `⚔ ${o.name.slice(0, 10)} ${dmg}`);
  });

  const poison = (mine || p.poison) ? h('span', {
    class: `stat${mine ? ' click' : ''}${p.poison >= 10 ? ' lethal' : ''}`,
    title: mine ? 'Veneno. Clic +1, clic derecho −1' : 'Veneno',
    onclick: mine ? () => send({ type: 'poison', delta: 1 }) : null,
    oncontextmenu: mine ? (e) => { e.preventDefault(); send({ type: 'poison', delta: -1 }); } : null,
  }, `☠ ${p.poison}`) : null;

  const head = h('div', { class: 'panel-head' },
    h('span', { class: 'pname' }, h('span', { class: `dot${p.connected ? '' : ' off'}`, title: p.connected ? 'Conectado' : 'Desconectado' }), p.name, mine ? h('span', { class: 'muted small' }, '(tú)') : null),
    h('span', { class: 'cmdnames' }, p.commanderNames.join(' + ')),
    !mine ? h('span', { class: 'counts' }, `✋ ${p.counts.hand} · 📚 ${p.counts.library}`) : null,
    poison, ...cmdStats,
    h('span', { class: 'life' }, mine ? lifeBtn(-1, '−') : null, h('b', { title: 'Vida' }, p.life), mine ? lifeBtn(1, '+') : null),
  );

  const command = h('div', { class: 'pile cmd', dataset: { pile: 'command', owner: p.id, ...(mine ? { drop: 'command' } : {}) }, title: 'Zona de mando' });
  const cmdTop = p.zones.command.at(-1);
  if (cmdTop) command.append(renderCard(cmdTop, { owner: p.id, zone: 'command' }));
  else command.append(h('div', { class: 'pile-empty' }));
  command.append(h('span', { class: 'pile-label' }, `Mando ${p.counts.command}`));

  const bf = h('div', { class: 'battlefield', dataset: { owner: p.id, ...(mine ? { drop: 'battlefield' } : {}) } },
    ...p.zones.battlefield.map((c) => renderCard(c, { owner: p.id, zone: 'battlefield' })));
  if (!p.zones.battlefield.length) bf.append(h('div', { class: 'empty-hint' }, mine ? (p.hasDeck ? 'Arrastra cartas aquí para jugarlas' : 'Carga tu mazo con el botón «Mazo»') : (p.hasDeck ? '' : 'Esperando su mazo…')));

  return h('div', { class: `panel${mine ? ' mine' : ' opp'}${state.activePlayerId === p.id ? ' active' : ''}`, style: { '--pc': p.color }, dataset: { pid: p.id } },
    head,
    h('div', { class: 'panel-body' }, h('div', { class: 'zones' }, command, pile(p, 'library'), pile(p, 'graveyard'), pile(p, 'exile')), bf),
  );
}

function renderHand(p) {
  const hand = p?.zones.hand ?? [];
  $('#hand-count').textContent = `(${hand.length})`;
  $('#hand').replaceChildren(...hand.map((c) => {
    const el = renderCard(c, { owner: p.id, zone: 'hand' });
    el.addEventListener('dblclick', () => send({ type: 'move', iid: c.iid, to: 'battlefield', x: 0.4 + Math.random() * 0.2, y: 0.55 }));
    return el;
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

// ---------- Arrastrar y soltar ----------
let drag = null;
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const el = e.target.closest('.card[data-drag]');
  if (!el || el.closest('.modal')) return;
  const rect = el.getBoundingClientRect();
  drag = { el, iid: el.dataset.iid, zone: el.dataset.zone, startX: e.clientX, startY: e.clientY, offX: e.clientX - rect.left, offY: e.clientY - rect.top, moved: false, ghost: null };
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
  if (!drag.moved) {
    drag.moved = true;
    const ghost = drag.el.cloneNode(true);
    const r = drag.el.getBoundingClientRect();
    ghost.classList.add('ghost');
    ghost.classList.remove('tapped');
    ghost.style.width = `${drag.el.offsetWidth}px`;
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
  if (to === 'battlefield') {
    const r = target.getBoundingClientRect();
    const cw = parseFloat(getComputedStyle(target).getPropertyValue('--cw')) || d.w;
    const ch = cw * 1.397;
    const x = Math.min(1, Math.max(0, (e.clientX - d.offX * (cw / d.w) - r.left) / Math.max(1, r.width - cw)));
    const y = Math.min(1, Math.max(0, (e.clientY - d.offY * (cw / d.w) - r.top) / Math.max(1, r.height - ch)));
    send(d.zone === 'battlefield' ? { type: 'setPos', iid: d.iid, x, y } : { type: 'move', iid: d.iid, to, x, y });
  } else if (to !== d.zone || to === 'library') {
    send({ type: 'move', iid: d.iid, to, position: to === 'library' && e.shiftKey ? 'bottom' : 'top' });
  }
});
function dropTarget(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-drop]');
  return el && (el.dataset.owner === undefined || isMine(el.dataset.owner)) ? el : null;
}
function onCardClick(d) {
  if (d.zone === 'battlefield') send({ type: 'tap', iid: d.iid });
  else if (d.zone === 'graveyard' || d.zone === 'exile' || d.zone === 'command') openZone(state.you, d.zone);
}

// Clic en las pilas (biblioteca: robar; cementerio/exilio: ver).
document.addEventListener('click', (e) => {
  const pileEl = e.target.closest('.pile');
  if (!pileEl || e.target.closest('.card[data-drag]')) return;
  const { pile: zone, owner } = pileEl.dataset;
  if (zone === 'library') { if (isMine(owner)) send({ type: 'draw', n: 1 }); }
  else openZone(owner, zone);
});

// ---------- Menú contextual ----------
const menu = $('#menu');
function openMenu(x, y, title, items) {
  menu.replaceChildren(
    ...(title ? [h('div', { class: 'menu-title' }, title)] : []),
    ...items.map((it) => (it === '-' ? h('hr') : h('button', { onclick: () => { closeMenu(); it.run(); } }, it.label, it.key ? h('kbd', {}, it.key) : null))),
  );
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}
const closeMenu = () => menu.classList.add('hidden');
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#menu')) closeMenu(); }, true);
document.addEventListener('scroll', closeMenu, true);

const askNumber = (msg, def = 1) => {
  const v = prompt(msg, String(def));
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function moveItems(iid, from) {
  const mv = (to, label, position) => ({ label, run: () => afterLibraryMove(iid, send({ type: 'move', iid, to, position, x: 0.45, y: 0.5 })) });
  return [
    from !== 'battlefield' && mv('battlefield', 'Al campo de batalla'),
    from !== 'battlefield' && { label: 'Al campo boca abajo', run: () => afterLibraryMove(iid, send({ type: 'move', iid, to: 'battlefield', faceDown: true, x: 0.45, y: 0.5 })) },
    from !== 'hand' && mv('hand', 'A la mano'),
    from !== 'graveyard' && mv('graveyard', 'Al cementerio'),
    from !== 'exile' && mv('exile', 'Al exilio'),
    mv('library', 'Al tope de la biblioteca', 'top'),
    mv('library', 'Al fondo de la biblioteca', 'bottom'),
    from !== 'command' && mv('command', 'A la zona de mando'),
  ].filter(Boolean);
}

function cardMenu(e, iid, zone) {
  const found = findMyCard(iid);
  if (!found) return;
  const c = found.card;
  const items = [];
  if (zone === 'battlefield') {
    items.push(
      { label: c.tapped ? 'Enderezar' : 'Girar', key: 'T', run: () => send({ type: 'tap', iid }) },
      { label: c.faceDown ? 'Voltear boca arriba' : 'Poner boca abajo', key: 'F', run: () => send({ type: 'flip', iid }) },
      c.backImage && { label: 'Transformar', run: () => send({ type: 'transform', iid }) },
      { label: 'Agregar contador +1', key: '+', run: () => send({ type: 'counters', iid, delta: 1 }) },
      { label: 'Quitar contador −1', key: '−', run: () => send({ type: 'counters', iid, delta: -1 }) },
      { label: 'Contadores…', run: () => { const v = prompt('Cantidad a sumar (usa negativo para restar)', '1'); const n = Number.parseInt(v ?? '', 10); if (n) send({ type: 'counters', iid, delta: n }); } },
      { label: 'Crear copia (token)', run: () => send({ type: 'clone', iid }) },
      '-',
    );
  }
  if (zone !== 'library' && zone !== 'hand' && !c.faceDown) {
    items.push({ label: '⚡ Anunciar trigger de esta carta', key: 'G', run: () => send({ type: 'announce', kind: 'trigger', iid }) }, '-');
  }
  items.push(...moveItems(iid, zone));
  if (zone !== 'library' || zoneView?.library) items.push('-', { label: 'Revelar a todos', run: () => send({ type: 'reveal', iid }) });
  openMenu(e.clientX, e.clientY, c.faceDown && zone !== 'battlefield' ? 'Carta' : c.name, items.filter(Boolean));
}

function libraryMenu(e) {
  openMenu(e.clientX, e.clientY, 'Biblioteca', [
    { label: 'Robar 1', key: 'D', run: () => send({ type: 'draw', n: 1 }) },
    { label: 'Robar X…', run: () => { const n = askNumber('¿Cuántas cartas robar?', 7); if (n) send({ type: 'draw', n }); } },
    { label: 'Moler X…', run: () => { const n = askNumber('¿Cuántas cartas moler?', 1); if (n) send({ type: 'mill', n }); } },
    { label: 'Mirar el tope X…', run: () => { const n = askNumber('¿Cuántas cartas mirar?', 3); if (n) peekLibrary(n); } },
    { label: 'Buscar en la biblioteca', run: () => peekLibrary(0) },
    { label: 'Barajar', run: () => send({ type: 'shuffle' }) },
    '-',
    { label: 'Mulligan (mano a la biblioteca y robar 7)', run: () => confirm('¿Hacer mulligan?') && send({ type: 'mulligan' }) },
    { label: 'Revelar mi mano', run: () => send({ type: 'revealHand' }) },
    { label: 'Enderezar todo', key: 'U', run: () => send({ type: 'untapAll' }) },
    '-',
    { label: 'Reiniciar mi partida', run: () => confirm('Todas tus cartas vuelven a la biblioteca y la vida a 40. ¿Seguro?') && send({ type: 'reset' }) },
  ]);
}

document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, textarea')) return;
  const cardEl = e.target.closest('.card[data-drag]');
  const pileEl = e.target.closest('.pile');
  const bf = e.target.closest('.battlefield[data-drop]');
  if (cardEl) { e.preventDefault(); return cardMenu(e, cardEl.dataset.iid, cardEl.dataset.lib ? 'library' : cardEl.dataset.zone); }
  if (pileEl?.dataset.pile === 'library' && isMine(pileEl.dataset.owner)) { e.preventDefault(); return libraryMenu(e); }
  if (bf) {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, 'Campo de batalla', [
      { label: 'Enderezar todo', key: 'U', run: () => send({ type: 'untapAll' }) },
      { label: 'Crear token…', run: createToken },
      { label: 'Lanzar d20', run: () => send({ type: 'roll', sides: 20 }) },
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
    $('#zone-title').textContent = zoneView.n ? `Tope de tu biblioteca (${zoneView.cards.length})` : `Tu biblioteca (${zoneView.cards.length})`;
    $('#zone-hint').textContent = 'Ordenadas desde el tope. Clic en una carta para moverla. Tus rivales no ven estas cartas.';
    grid.replaceChildren(...zoneView.cards.map((c) => {
      const el = renderCard(c, { owner: state.you, zone: 'library' });
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
  $('#zone-title').textContent = `${ZONE_NAMES[zoneView.zone]} de ${mine ? 'ti' : p.name} (${cards.length})`;
  $('#zone-hint').textContent = mine ? 'La más reciente primero. Clic en una carta para moverla.' : 'Solo lectura.';
  grid.replaceChildren(...cards.map((c) => {
    const el = renderCard(c, { owner: p.id, zone: zoneView.zone });
    delete el.dataset.drag;
    if (mine) el.addEventListener('click', (e) => cardMenu(e, c.iid, zoneView.zone));
    return el;
  }));
}

async function peekLibrary(n) {
  const res = await send({ type: 'peek', n });
  if (!res?.ok) return;
  zoneView = { library: true, n, cards: res.private.cards };
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
$('#btn-zone-shuffle').addEventListener('click', () => { send({ type: 'shuffle' }); closeModal('#modal-zone'); });

// Mazo
function openDeckModal() {
  const saved = store.get('edh.deck', {});
  $('#deck-commanders').value = saved.commanders ?? '';
  $('#deck-list').value = saved.list ?? '';
  $('#deck-status').textContent = '';
  $('#deck-status').className = 'status';
  openModal('#modal-deck');
}
$('#btn-deck').addEventListener('click', openDeckModal);
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
  store.set('edh.deck', { commanders: cmdText, list: listText });
  btn.disabled = true;
  status.className = 'status';
  status.textContent = `Buscando ${total} cartas en Scryfall…`;
  try {
    const deck = await resolveDeck(parsed, (done, all) => { status.textContent = `Buscando cartas en Scryfall… ${done}/${all}`; });
    const res = await send({ type: 'setDeck', commanders: deck.commanders, cards: deck.cards });
    if (res?.ok) {
      const count = deck.commanders.length + deck.cards.length;
      if (deck.notFound.length) {
        status.className = 'status warn';
        status.textContent = `Cargadas ${count}. No encontradas: ${deck.notFound.join(', ')}`;
        toast(`Mazo cargado (${count}). Faltaron ${deck.notFound.length}; revisa el modal de mazo.`);
      } else {
        closeModal('#modal-deck');
        toast(`Mazo cargado: ${count} cartas. ¡Roba 7 con clic derecho en tu biblioteca!`);
      }
    }
  } catch (err) {
    status.className = 'status err';
    status.textContent = `No se pudo consultar Scryfall: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

function createToken() {
  const name = prompt('Nombre del token (ej: Zombi 2/2, Tesoro)', 'Tesoro');
  if (name?.trim()) send({ type: 'token', name: name.trim() });
}

// ---------- Barra superior ----------
$('#btn-pass').addEventListener('click', () => send({ type: 'passTurn' }));
$('#btn-d20').addEventListener('click', () => send({ type: 'roll', sides: 20 }));
$('#btn-coin').addEventListener('click', () => send({ type: 'coin' }));
$('#btn-token').addEventListener('click', createToken);
document.querySelectorAll('[data-ann]').forEach((b) => b.addEventListener('click', () => send({ type: 'announce', kind: b.dataset.ann })));
$('#btn-help').addEventListener('click', () => openModal('#modal-help'));
$('#btn-copy').addEventListener('click', async () => {
  const link = `${location.origin}/?sala=${state.code}`;
  try { await navigator.clipboard.writeText(link); toast('Enlace copiado. Compártelo con tus rivales.'); }
  catch { prompt('Copia este enlace:', link); }
});
$('#btn-leave').addEventListener('click', async () => {
  if (!confirm('¿Salir de la sala? Perderás tu asiento y tus cartas.')) return;
  await emit('leaveRoom');
  store.del('edh.session');
  session = null;
  state = null;
  history.replaceState(null, '', '/');
  $('#room').classList.add('hidden');
  $('#lobby').classList.remove('hidden');
});
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

// ---------- Atajos ----------
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || !state || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$('#modal-deck').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') { closeMenu(); document.querySelectorAll('.modal:not(.hidden)').forEach((m) => closeModal(`#${m.id}`)); return; }
  if (k === 'd') return send({ type: 'draw', n: 1 });
  if (k === 'u') return send({ type: 'untapAll' });
  if (k === 'r') return send({ type: 'announce', kind: 'respond' });
  if (k === 'g') {
    const pub = hovered && isMine(hovered.owner) && !['hand', 'library'].includes(hovered.zone) ? hovered : null;
    return send({ type: 'announce', kind: 'trigger', iid: pub?.iid });
  }
  const hv = hovered && isMine(hovered.owner) && hovered.zone === 'battlefield' ? hovered : null;
  if (!hv) return;
  if (k === 't') send({ type: 'tap', iid: hv.iid });
  if (k === 'f') send({ type: 'flip', iid: hv.iid });
  if (e.key === '+' || e.key === '=') send({ type: 'counters', iid: hv.iid, delta: 1 });
  if (e.key === '-') send({ type: 'counters', iid: hv.iid, delta: -1 });
});

// ---------- Toasts ----------
function toast(text, isError = false) {
  const t = h('div', { class: `toast${isError ? ' error' : ''}`, onclick: () => t.remove() }, text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}
function toastCards(title, cards) {
  const t = h('div', { class: 'toast', onclick: () => t.remove() }, h('b', {}, title),
    h('div', { class: 'imgs' }, ...cards.map((c) => (c.image ? h('img', { src: c.image, alt: c.name, title: c.name }) : h('span', { class: 'stat' }, c.name)))));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 9000);
}

// ---------- Animaciones de mesa ----------
const ANN_ICON = { respond: '✋', trigger: '⚡', wait: '⏸', ok: '✓' };
function onStage(el, ms) {
  const stage = $('#stage');
  stage.append(el);
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
function showAnnouncement(ev) {
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

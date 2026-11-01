// API REST: cuentas, mazos guardados e importación desde Moxfield.
import express from 'express';
import { AuthError, SESSION_COOKIE, parseCookies, sessionCookie, clearCookie } from './auth.js';
import { sanitizeDeckCard } from './game.js';
import { importMoxfield, ImportError } from './moxfield.js';

const MAX_DECKS_PER_USER = 100;
const MAX_DECK_CARDS = 300;

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function sanitizeResolved(resolved) {
  const commanders = Array.isArray(resolved?.commanders) ? resolved.commanders : [];
  const cards = Array.isArray(resolved?.cards) ? resolved.cards : [];
  if (commanders.length + cards.length === 0) throw new ApiError('El mazo está vacío');
  if (commanders.length + cards.length > MAX_DECK_CARDS) throw new ApiError('Mazo demasiado grande');
  return { commanders: commanders.slice(0, 4).map(sanitizeDeckCard), cards: cards.map(sanitizeDeckCard) };
}

function deckFromBody(body) {
  const name = text(body?.name, 80).trim();
  if (!name) throw new ApiError('Ponle un nombre al mazo');
  const resolved = sanitizeResolved(body?.resolved);
  return {
    name,
    commandersText: text(body?.commandersText, 2000),
    listText: text(body?.listText, 20000),
    resolved,
    commanderNames: resolved.commanders.map((c) => c.name).join(' + '),
    cardCount: resolved.commanders.length + resolved.cards.length,
  };
}

const deckSummary = (r) => ({ id: r.id, name: r.name, commanders: r.commander_names, cardCount: r.card_count, updatedAt: r.updated_at });

export function createApi({ db, auth }) {
  const q = {
    list: db.prepare('SELECT id, name, commander_names, card_count, updated_at FROM decks WHERE user_id = ? ORDER BY updated_at DESC'),
    count: db.prepare('SELECT COUNT(*) AS n FROM decks WHERE user_id = ?'),
    get: db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?'),
    insert: db.prepare(`INSERT INTO decks (user_id, name, commanders_text, list_text, resolved_json, commander_names, card_count, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE decks SET name = ?, commanders_text = ?, list_text = ?, resolved_json = ?, commander_names = ?, card_count = ?, updated_at = ?
                        WHERE id = ? AND user_id = ?`),
    remove: db.prepare('DELETE FROM decks WHERE id = ? AND user_id = ?'),
  };

  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  // Protección CSRF: las peticiones que modifican algo deben venir de nuestro propio origen.
  router.use((req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) return next(new ApiError('Origen no permitido', 403));
    if (!req.is('application/json') && req.method !== 'DELETE') return next(new ApiError('Se esperaba JSON', 415));
    next();
  });

  router.use((req, _res, next) => {
    req.sessionToken = parseCookies(req.get('cookie'))[SESSION_COOKIE];
    req.user = auth.userFromToken(req.sessionToken);
    next();
  });

  const requireUser = (req, _res, next) => (req.user ? next() : next(new ApiError('Inicia sesión para usar tus mazos', 401)));
  const secure = (req) => req.secure || process.env.NODE_ENV === 'production';

  // ---- Cuentas ----
  router.post('/auth/register', (req, res) => {
    const { user, token } = auth.register(req.body?.username, req.body?.password);
    res.setHeader('Set-Cookie', sessionCookie(token, { secure: secure(req) }));
    res.status(201).json({ user });
  });
  router.post('/auth/login', (req, res) => {
    const { user, token } = auth.login(req.body?.username, req.body?.password, req.ip);
    res.setHeader('Set-Cookie', sessionCookie(token, { secure: secure(req) }));
    res.json({ user });
  });
  router.post('/auth/logout', (req, res) => {
    auth.logout(req.sessionToken);
    res.setHeader('Set-Cookie', clearCookie());
    res.json({ ok: true });
  });
  router.get('/auth/me', (req, res) => res.json({ user: req.user }));

  // ---- Mazos ----
  router.get('/decks', requireUser, (req, res) => res.json({ decks: q.list.all(req.user.id).map(deckSummary) }));

  router.get('/decks/:id', requireUser, (req, res) => {
    const row = q.get.get(Number(req.params.id), req.user.id);
    if (!row) throw new ApiError('Mazo no encontrado', 404);
    res.json({
      deck: { ...deckSummary(row), commandersText: row.commanders_text, listText: row.list_text, resolved: JSON.parse(row.resolved_json) },
    });
  });

  router.post('/decks', requireUser, (req, res) => {
    if (q.count.get(req.user.id).n >= MAX_DECKS_PER_USER) throw new ApiError(`Máximo ${MAX_DECKS_PER_USER} mazos por cuenta`);
    const d = deckFromBody(req.body);
    const now = Date.now();
    const { lastInsertRowid } = q.insert.run(req.user.id, d.name, d.commandersText, d.listText, JSON.stringify(d.resolved), d.commanderNames, d.cardCount, now, now);
    res.status(201).json({ deck: deckSummary(q.get.get(Number(lastInsertRowid), req.user.id)) });
  });

  router.put('/decks/:id', requireUser, (req, res) => {
    const d = deckFromBody(req.body);
    const { changes } = q.update.run(d.name, d.commandersText, d.listText, JSON.stringify(d.resolved), d.commanderNames, d.cardCount, Date.now(), Number(req.params.id), req.user.id);
    if (!changes) throw new ApiError('Mazo no encontrado', 404);
    res.json({ deck: deckSummary(q.get.get(Number(req.params.id), req.user.id)) });
  });

  router.delete('/decks/:id', requireUser, (req, res) => {
    const { changes } = q.remove.run(Number(req.params.id), req.user.id);
    if (!changes) throw new ApiError('Mazo no encontrado', 404);
    res.json({ ok: true });
  });

  // ---- Importación ----
  router.get('/import/moxfield/status', (_req, res) => res.json({ enabled: Boolean(process.env.MOXFIELD_USER_AGENT) }));
  router.get('/import/moxfield', async (req, res, next) => {
    try {
      res.json({ deck: await importMoxfield(req.query.url) });
    } catch (err) {
      next(err);
    }
  });

  router.use((err, _req, res, _next) => {
    const known = err instanceof ApiError || err instanceof AuthError || err instanceof ImportError;
    if (!known && err.type === 'entity.too.large') return res.status(413).json({ error: 'El mazo es demasiado grande' });
    if (!known && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    if (!known) console.error(err);
    res.status(known ? err.status : 500).json({ error: known ? err.message : 'Error interno' });
  });

  return router;
}

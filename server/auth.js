// Cuentas y sesiones: contraseñas con scrypt, tokens de sesión aleatorios guardados como hash.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

export const SESSION_COOKIE = 'edh_sid';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

const DUMMY_HASH = hashPassword('contraseña-de-relleno');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME.test(username)) {
    throw new AuthError('El usuario debe tener 3 a 20 caracteres: letras, números o _');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new AuthError('La contraseña debe tener al menos 8 caracteres');
  }
}

export function createAuth(db) {
  const q = {
    insertUser: db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionUser: db.prepare(`SELECT u.id, u.username, u.display_name, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id
                             WHERE s.token_hash = ? AND s.expires_at > ?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    userByGoogle: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
    insertGoogleUser: db.prepare(`INSERT INTO users (username, password_hash, created_at, email, google_sub, avatar_url, display_name)
                                  VALUES (?, '', ?, ?, ?, ?, ?)`),
    updateGoogleProfile: db.prepare('UPDATE users SET email = ?, avatar_url = ?, display_name = COALESCE(display_name, ?) WHERE id = ?'),
  };
  const publicUser = (row) => ({ id: row.id, username: row.username, displayName: row.display_name || row.username, avatar: row.avatar_url || null });

  /** Nombre de usuario único a partir del nombre o correo de Google. */
  async function freeUsername(profile) {
    const base = (profile.name || profile.email?.split('@')[0] || 'jugador')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16) || 'jugador';
    const seed = base.length >= 3 ? base : `${base}_mtg`;
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? seed : `${seed.slice(0, 16)}${i + 1}`;
      if (!await q.userByName.get(candidate)) return candidate;
    }
    return `jugador_${randomBytes(4).toString('hex')}`;
  }

  // Límite simple de intentos de login por IP + usuario (en memoria).
  const attempts = new Map();
  const WINDOW = 15 * 60 * 1000;
  const MAX_ATTEMPTS = 10;
  function checkRate(key) {
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || now - entry.start > WINDOW) return attempts.set(key, { start: now, count: 0 }).get(key);
    if (entry.count >= MAX_ATTEMPTS) throw new AuthError('Demasiados intentos. Espera unos minutos.', 429);
    return entry;
  }

  async function startSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    await q.insertSession.run(sha256(token), userId, now, now + SESSION_DAYS * 86400e3);
    return token;
  }

  return {
    async register(username, password) {
      validateCredentials(username, password);
      if (await q.userByName.get(username)) throw new AuthError('Ese nombre de usuario ya existe', 409);
      const { lastInsertRowid } = await q.insertUser.run(username, hashPassword(password), Date.now());
      const user = { id: Number(lastInsertRowid), username, displayName: username, avatar: null };
      return { user, token: await startSession(user.id) };
    },
    async login(username, password, ip = '') {
      const entry = checkRate(`${ip}|${String(username).toLowerCase()}`);
      const row = typeof username === 'string' ? await q.userByName.get(username) : null;
      // Se verifica igual aunque no exista el usuario, para no revelar cuáles existen por tiempo.
      const ok = verifyPassword(String(password ?? ''), row?.password_hash || DUMMY_HASH) && row?.password_hash && row;
      if (!ok) {
        entry.count++;
        throw new AuthError('Usuario o contraseña incorrectos', 401);
      }
      attempts.delete(`${ip}|${String(username).toLowerCase()}`);
      return { user: publicUser(row), token: await startSession(row.id) };
    },
    async userFromToken(token) {
      if (!token) return null;
      const row = await q.sessionUser.get(sha256(token), Date.now());
      return row ? publicUser(row) : null;
    },
    /** Entra (o crea la cuenta) con un perfil ya verificado de Google. */
    async googleLogin(profile) {
      let row = await q.userByGoogle.get(profile.sub);
      if (row) {
        await q.updateGoogleProfile.run(profile.email, profile.picture, profile.name, row.id);
        row = await q.userByGoogle.get(profile.sub);
      } else {
        const username = await freeUsername(profile);
        const { lastInsertRowid } = await q.insertGoogleUser.run(username, Date.now(), profile.email, profile.sub, profile.picture, profile.name || username);
        row = await q.userByName.get(username);
        if (Number(lastInsertRowid) !== row.id) throw new AuthError('No se pudo crear la cuenta', 500);
      }
      return { user: publicUser(row), token: await startSession(row.id) };
    },
    async logout(token) {
      if (token) await q.deleteSession.run(sha256(token));
    },
    async purge() {
      await q.purgeSessions.run(Date.now());
    },
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { secure }) {
  const attrs = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

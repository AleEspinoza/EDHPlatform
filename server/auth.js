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
    sessionUser: db.prepare(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
                             WHERE s.token_hash = ? AND s.expires_at > ?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  };

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

  function startSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    q.insertSession.run(sha256(token), userId, now, now + SESSION_DAYS * 86400e3);
    return token;
  }

  return {
    register(username, password) {
      validateCredentials(username, password);
      if (q.userByName.get(username)) throw new AuthError('Ese nombre de usuario ya existe', 409);
      const { lastInsertRowid } = q.insertUser.run(username, hashPassword(password), Date.now());
      const user = { id: Number(lastInsertRowid), username };
      return { user, token: startSession(user.id) };
    },
    login(username, password, ip = '') {
      const entry = checkRate(`${ip}|${String(username).toLowerCase()}`);
      const row = typeof username === 'string' ? q.userByName.get(username) : null;
      // Se verifica igual aunque no exista el usuario, para no revelar cuáles existen por tiempo.
      const ok = verifyPassword(String(password ?? ''), row?.password_hash ?? DUMMY_HASH) && row;
      if (!ok) {
        entry.count++;
        throw new AuthError('Usuario o contraseña incorrectos', 401);
      }
      attempts.delete(`${ip}|${String(username).toLowerCase()}`);
      return { user: { id: row.id, username: row.username }, token: startSession(row.id) };
    },
    userFromToken(token) {
      if (!token) return null;
      const row = q.sessionUser.get(sha256(token), Date.now());
      return row ? { id: row.id, username: row.username } : null;
    },
    logout(token) {
      if (token) q.deleteSession.run(sha256(token));
    },
    purge() {
      q.purgeSessions.run(Date.now());
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

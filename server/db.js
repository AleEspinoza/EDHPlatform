// Persistencia con libSQL: el mismo código sirve para un archivo local (desarrollo)
// y para Turso (producción, los datos viven fuera del servidor y no se borran).
//
//   TURSO_DATABASE_URL + TURSO_AUTH_TOKEN  → base remota en Turso
//   DB_FILE                                → archivo local (por defecto data/edhplatform.db)
//
// La interfaz imita a better-sqlite3 (`prepare(sql).get/all/run`) pero es asíncrona.
import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function defaultTarget(env = process.env) {
  if (env.TURSO_DATABASE_URL) return { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN, remote: true };
  if (env.DB_FILE === ':memory:' || (!env.DB_FILE && env.NODE_TEST_CONTEXT)) return { url: ':memory:', remote: false };
  const file = env.DB_FILE || path.join(ROOT, 'data', 'edhplatform.db');
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  return { url: pathToFileURL(path.resolve(file)).href, remote: false };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS decks (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    commanders_text TEXT NOT NULL DEFAULT '',
    list_text TEXT NOT NULL DEFAULT '',
    resolved_json TEXT NOT NULL,
    commander_names TEXT NOT NULL DEFAULT '',
    card_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS decks_user ON decks(user_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY,
    room_code TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    turns INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL,             -- 'win' | 'draw' | 'unfinished'
    winner_name TEXT
  );
  CREATE TABLE IF NOT EXISTS game_players (
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    seat INTEGER NOT NULL,
    name TEXT NOT NULL,
    commanders TEXT NOT NULL DEFAULT '',
    is_winner INTEGER NOT NULL DEFAULT 0,
    final_life INTEGER
  );
  CREATE INDEX IF NOT EXISTS game_players_user ON game_players(user_id, game_id DESC);
`;

const toObject = (columns, row) => Object.fromEntries(columns.map((c, i) => [c, row[i]]));

/** Envuelve el cliente libSQL con la forma prepare(sql).get/all/run (asíncrona). */
function wrap(client, info) {
  const exec = (sql, args) => client.execute({ sql, args });
  return {
    info,
    prepare(sql) {
      return {
        async get(...args) {
          const r = await exec(sql, args);
          return r.rows.length ? toObject(r.columns, r.rows[0]) : undefined;
        },
        async all(...args) {
          const r = await exec(sql, args);
          return r.rows.map((row) => toObject(r.columns, row));
        },
        async run(...args) {
          const r = await exec(sql, args);
          return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid == null ? 0 : Number(r.lastInsertRowid) };
        },
      };
    },
    exec: (sql) => client.executeMultiple(sql),
    close: () => client.close(),
  };
}

/** Abre (y migra) la base. `target` permite forzar una URL, p. ej. ':memory:' en pruebas. */
export async function openDb(target = defaultTarget()) {
  if (typeof target === 'string') target = { url: target === ':memory:' ? ':memory:' : target, remote: false };
  const client = createClient({ url: target.url, authToken: target.authToken });
  const db = wrap(client, { remote: Boolean(target.remote), url: target.remote ? target.url : 'local' });
  // Los PRAGMA de conexión solo tienen sentido en un archivo local.
  if (!target.remote && target.url !== ':memory:') await db.exec('PRAGMA journal_mode = WAL;');
  if (!target.remote) await db.exec('PRAGMA foreign_keys = ON;');
  await db.exec(SCHEMA);
  await migrateUsers(db);
  return db;
}

/** Columnas agregadas después de la v0.4 (login con Google y perfil). */
async function migrateUsers(db) {
  const cols = new Set((await db.prepare('PRAGMA table_info(users)').all()).map((c) => c.name));
  const add = { email: 'TEXT', google_sub: 'TEXT', avatar_url: 'TEXT', display_name: 'TEXT' };
  for (const [name, type] of Object.entries(add)) {
    if (!cols.has(name)) await db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type};`);
  }
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;');
}

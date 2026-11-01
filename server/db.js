// Persistencia con el SQLite integrado de Node (sin dependencias nativas).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function defaultFile() {
  if (process.env.DB_FILE) return process.env.DB_FILE;
  if (process.env.NODE_TEST_CONTEXT) return ':memory:'; // bajo `node --test`
  const dir = path.join(ROOT, 'data');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'edhplatform.db');
}

export function openDb(file = defaultFile()) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
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
  `);
  migrateUsers(db);
  return db;
}

/** Columnas agregadas después de la v0.4 (login con Google y perfil). */
function migrateUsers(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  const add = { email: 'TEXT', google_sub: 'TEXT', avatar_url: 'TEXT', display_name: 'TEXT' };
  for (const [name, type] of Object.entries(add)) if (!cols.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL');
}

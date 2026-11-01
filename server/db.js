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
  `);
  return db;
}

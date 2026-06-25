'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'domains.db');

const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS domains (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    domain       TEXT    NOT NULL UNIQUE,
    state        TEXT    NOT NULL DEFAULT 'parked'
                         CHECK (state IN ('live', 'redirect', 'parked')),
    target       TEXT,
    port         INTEGER,
    note         TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;

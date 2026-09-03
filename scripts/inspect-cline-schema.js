'use strict';

const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = path.join(process.env.CLINE_DIR || path.join(os.homedir(), '.cline'), 'data', 'db', 'sessions.db');
const database = new DatabaseSync(databasePath, { readOnly: true });
const rows = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
for (const row of rows) {
  const columns = database.prepare(`PRAGMA table_info(${JSON.stringify(row.name)})`).all().map(column => column.name);
  console.log(`${row.name}: ${columns.join(', ')}`);
}
database.close();

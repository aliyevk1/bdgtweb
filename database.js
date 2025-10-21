
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

let dbInstance;

function getDb() {
  if (!dbInstance) {
    const dbPath = path.join(__dirname, 'budget.db');
    dbInstance = new sqlite3.Database(dbPath);
    dbInstance.run('PRAGMA foreign_keys = ON');
  }

  return dbInstance;
}

function initializeDatabase() {
  const db = getDb();

  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS User (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS UserCategory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        budget_type TEXT NOT NULL CHECK (budget_type IN ('Necessities', 'Leisure', 'Savings')),
        UNIQUE (user_id, name COLLATE NOCASE),
        FOREIGN KEY (user_id) REFERENCES User(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS Income (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        source TEXT,
        date TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES User(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS Expenditure (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        user_category_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        description TEXT,
        date TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES User(id) ON DELETE CASCADE,
        FOREIGN KEY (user_category_id) REFERENCES UserCategory(id) ON DELETE RESTRICT
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS RecurringExpenditure (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        user_category_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        default_amount REAL NOT NULL,
        FOREIGN KEY (user_id) REFERENCES User(id) ON DELETE CASCADE,
        FOREIGN KEY (user_category_id) REFERENCES UserCategory(id) ON DELETE RESTRICT
      )
    `);
  });
}

function run(sql, params = []) {
  const db = getDb();

  return new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve(this);
    });
  });
}

function get(sql, params = []) {
  const db = getDb();

  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });
}

function all(sql, params = []) {
  const db = getDb();

  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

module.exports = {
  getDb,
  initializeDatabase,
  run,
  get,
  all,
};

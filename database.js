
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

let dbInstance;

function getDb() {
  if (!dbInstance) {
    const dbPath = path.join(__dirname, 'budget.db');
    dbInstance = new sqlite3.Database(dbPath);
  }

  return dbInstance;
}

function initializeDatabase() {
  const db = getDb();

  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS Income (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount REAL NOT NULL,
        source TEXT,
        date TEXT NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS Expenditure (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount REAL NOT NULL,
        description TEXT,
        budget_type TEXT NOT NULL CHECK(budget_type IN ('Necessities', 'Leisure', 'Savings')),
        date TEXT NOT NULL
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

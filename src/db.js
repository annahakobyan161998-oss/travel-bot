const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'travel-bot.db');

module.exports = initSqlJs().then((SQL) => {
  let db;

  function saveDb() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }

  function queryAll(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push(row);
    }
    stmt.free();
    return rows;
  }

  function queryOne(sql, params = []) {
    const rows = queryAll(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  function runSql(sql, params = []) {
    db.run(sql, params);
    saveDb();
    return { lastInsertRowid: queryOne('SELECT last_insert_rowid()').last_insert_rowid };
  }

  if (fs.existsSync(DB_PATH)) {
    const data = fs.readFileSync(DB_PATH);
    db = new SQL.Database(data);
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT, first_name TEXT, last_name TEXT,
    language TEXT DEFAULT 'hy',
    created_at DATETIME DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS agents (
    telegram_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL, company TEXT, phone TEXT,
    approved INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL, country TEXT NOT NULL,
    weekend_dates TEXT, flight_date TEXT, people_count INTEGER,
    budget TEXT, notes TEXT, status TEXT DEFAULT 'open',
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL, agent_id INTEGER NOT NULL,
    message TEXT, price TEXT, status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (request_id) REFERENCES requests(id),
    FOREIGN KEY (agent_id) REFERENCES agents(telegram_id)
  )`);
  saveDb();

  const stmts = {
    upsertUser: (id, username, firstName, lastName) => {
      runSql(
        `INSERT INTO users (telegram_id, username, first_name, last_name) VALUES (?, ?, ?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET
           username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name`,
        [id, username, firstName, lastName],
      );
    },
    setUserLanguage: (lang, id) => runSql('UPDATE users SET language = ? WHERE telegram_id = ?', [lang, id]),
    getUserLanguage: (id) => queryOne('SELECT language FROM users WHERE telegram_id = ?', [id]),
    registerAgent: (id, name, company, phone) => runSql('INSERT INTO agents (telegram_id, name, company, phone) VALUES (?, ?, ?, ?)', [id, name, company, phone]),
    approveAgent: (id) => runSql('UPDATE agents SET approved = 1 WHERE telegram_id = ?', [id]),
    getAgent: (id) => queryOne('SELECT * FROM agents WHERE telegram_id = ?', [id]),
    getApprovedAgents: () => queryAll('SELECT * FROM agents WHERE approved = 1'),
    createRequest: (userId, country, weekendDates, flightDate, peopleCount, budget, notes) => runSql(
      'INSERT INTO requests (user_id, country, weekend_dates, flight_date, people_count, budget, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, country, weekendDates, flightDate, peopleCount, budget, notes],
    ),
    getRequest: (id) => queryOne('SELECT * FROM requests WHERE id = ?', [id]),
    getUserRequests: (userId) => queryAll('SELECT * FROM requests WHERE user_id = ? ORDER BY created_at DESC', [userId]),
    createResponse: (requestId, agentId, message, price) => runSql('INSERT INTO responses (request_id, agent_id, message, price) VALUES (?, ?, ?, ?)', [requestId, agentId, message, price]),
    getRequestResponses: (requestId) => queryAll(
      `SELECT r.*, a.name as agent_name, a.company as agent_company
       FROM responses r JOIN agents a ON r.agent_id = a.telegram_id
       WHERE r.request_id = ? ORDER BY r.created_at DESC`,
      [requestId],
    ),
  };

  return { db, stmts, saveDb };
});

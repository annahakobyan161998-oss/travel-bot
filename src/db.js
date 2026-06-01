const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'travel-bot.json');

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('DB load error:', e.message);
  }
  return { users: {}, agents: {}, requests: [], responses: [], nextId: 1 };
}

let db = loadDb();

function saveDb() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

const stmts = {
  upsertUser: (id, username, firstName, lastName) => {
    if (!db.users[id]) {
      db.users[id] = { telegram_id: id, username: username || '', first_name: firstName || '', last_name: lastName || '', language: 'hy', created_at: new Date().toISOString() };
    } else {
      const u = db.users[id];
      if (username) u.username = username;
      if (firstName) u.first_name = firstName;
      if (lastName) u.last_name = lastName;
    }
    saveDb();
  },
  setUserLanguage: (lang, id) => {
    if (db.users[id]) db.users[id].language = lang;
    saveDb();
  },
  getUserLanguage: (id) => {
    const u = db.users[id];
    return u ? { language: u.language } : null;
  },
  registerAgent: (id, name, company, phone) => {
    db.agents[id] = { telegram_id: id, name, company, phone, approved: 0, created_at: new Date().toISOString() };
    saveDb();
  },
  approveAgent: (id) => {
    if (db.agents[id]) db.agents[id].approved = 1;
    saveDb();
  },
  getAgent: (id) => db.agents[id] || null,
  getApprovedAgents: () => Object.values(db.agents).filter(a => a.approved),
  createRequest: (userId, country, weekendDates, flightDate, peopleCount, budget, notes) => {
    const id = db.nextId++;
    db.requests.push({
      id, user_id: userId, country, weekend_dates: weekendDates || '', flight_date: flightDate || '',
      people_count: peopleCount || 1, budget: budget || '', notes: notes || '',
      status: 'open', created_at: new Date().toISOString(),
    });
    saveDb();
    return { lastInsertRowid: id };
  },
  getRequest: (id) => db.requests.find(r => r.id === id) || null,
  getUserRequests: (userId) => db.requests.filter(r => r.user_id === userId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
  createResponse: (requestId, agentId, message, price) => {
    db.responses.push({
      id: db.nextId++, request_id: requestId, agent_id: agentId,
      message: message || '', price: price || '', status: 'pending',
      created_at: new Date().toISOString(),
    });
    saveDb();
  },
  getRequestResponses: (requestId) => {
    return db.responses
      .filter(r => r.request_id === requestId)
      .map(r => {
        const agent = db.agents[r.agent_id] || {};
        return { ...r, agent_name: agent.name || 'Agent', agent_company: agent.company || '' };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
};

console.log('✅ JSON DB initialized, ' + Object.keys(db.users).length + ' users');
module.exports = Promise.resolve({ db, stmts });

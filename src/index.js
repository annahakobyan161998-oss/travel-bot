require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const OWNER_ID = Number(process.env.OWNER_ID) || null;

// Bypass SSL for corporate proxy (self-signed cert)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
  console.error('ERROR: BOT_TOKEN not set in .env file!');
  console.error('Go to @BotFather in Telegram, create a bot, and copy the token.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── User state store ──
const userStates = new Map();

// ── Initialize DB then start ──
require('./db').then(({ stmts }) => {

// ── Serve Web App ──
app.get('/webapp', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'webapp.html'));
});

// ── API: Submit travel request from Web App ──
app.post('/api/requests', (req, res) => {
  try {
    const { telegram_id, country, weekend_dates, flight_date, people_count, budget, notes } = req.body;

    if (!telegram_id || !country) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = stmts.createRequest(
      telegram_id, country, weekend_dates || '', flight_date || '',
      Number(people_count) || 1, budget || '', notes || '',
    );
    const requestId = result.lastInsertRowid;

    const request = stmts.getRequest(requestId);
    const agents = stmts.getApprovedAgents();
    const userLang = stmts.getUserLanguage(telegram_id)?.language || 'hy';
    const userName = req.body.first_name || 'User';

    for (const agent of agents) {
      const agentLang = stmts.getUserLanguage(agent.telegram_id)?.language || 'hy';
      const msg = t(agentLang, 'newRequestForAgent',
        requestId, userName, country, weekend_dates || '-', flight_date || '-',
        Number(people_count) || 1, budget || '-', notes || '-',
      );
      bot.sendMessage(agent.telegram_id, msg, {
        reply_markup: {
          inline_keyboard: [[
            { text: t(agentLang, 'respond'), callback_data: `respond:${requestId}` },
          ]],
        },
      }).catch(() => {});
    }

    res.json({ success: true, request_id: requestId });
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── API: Get user requests ──
app.get('/api/requests/:telegramId', (req, res) => {
  try {
    const requests = stmts.getUserRequests(req.params.telegramId);
    res.json(requests);
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── API: Get responses for a request ──
app.get('/api/responses/:requestId', (req, res) => {
  try {
    const responses = stmts.getRequestResponses(req.params.requestId);
    res.json(responses);
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Start command ──
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const from = msg.from;

  stmts.upsertUser(from.id, from.username || '', from.first_name || '', from.last_name || '');

  const lang = stmts.getUserLanguage(from.id)?.language || 'hy';

  bot.sendMessage(chatId, t(lang, 'welcome'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: t(lang, 'newRequest'), web_app: { url: `${WEBAPP_URL}/webapp?user_id=${from.id}&lang=${lang}` } }],
        [{ text: t(lang, 'becomeAgent'), callback_data: 'register_agent' }],
      ],
    },
  });
});

// ── Language selection ──
bot.onText(/\/lang/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Ընտրիր լեզուն / Choose language / Выберите язык:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🇦🇲 Հայերեն', callback_data: 'lang:hy' }],
        [{ text: '🇬🇧 English', callback_data: 'lang:en' }],
        [{ text: '🇷🇺 Русский', callback_data: 'lang:ru' }],
      ],
    },
  });
});

// ── Agent registration ──
bot.onText(/\/register/, async (msg) => {
  const chatId = msg.chat.id;
  const lang = stmts.getUserLanguage(msg.from.id)?.language || 'hy';
  stmts.upsertUser(msg.from.id, msg.from.username || '', msg.from.first_name || '', msg.from.last_name || '');
  bot.sendMessage(chatId, t(lang, 'registerPrompt'));
  // Set user state to expect registration data
  userStates.set(msg.from.id, { step: 'awaiting_agent_registration' });
});

// ── Callback query handler ──
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});

  const lang = stmts.getUserLanguage(userId)?.language || 'hy';

  // Owner approve/reject
  if (data.startsWith('approve:') || data.startsWith('reject:')) {
    if (query.from.id !== OWNER_ID) return;
    const agentId = Number(data.split(':')[1]);
    if (data.startsWith('approve:')) {
      stmts.approveAgent(agentId);
      bot.sendMessage(agentId, t(stmts.getUserLanguage(agentId)?.language || 'hy', 'approved'));
      bot.editMessageText(query.message.text + '\n\n✅ Approved!', {
        chat_id: query.message.chat.id, message_id: query.message.message_id,
      });
    } else {
      bot.editMessageText(query.message.text + '\n\n❌ Rejected.', {
        chat_id: query.message.chat.id, message_id: query.message.message_id,
      });
    }
    return;
  }

  if (data.startsWith('lang:')) {
    const l = data.split(':')[1];
    stmts.setUserLanguage(l, userId);
    bot.sendMessage(chatId, t(l, 'welcome'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: t(l, 'newRequest'), web_app: { url: `${WEBAPP_URL}/webapp?user_id=${userId}&lang=${l}` } }],
          [{ text: t(l, 'becomeAgent'), callback_data: 'register_agent' }],
        ],
      },
    });
  }

  else if (data === 'register_agent') {
    bot.sendMessage(chatId, t(lang, 'registerPrompt'));
    userStates.set(userId, { step: 'awaiting_agent_registration' });
  }

  else if (data.startsWith('respond:')) {
    const requestId = data.split(':')[1];
    const agent = stmts.getAgent(userId);
    if (!agent || !agent.approved) {
      return bot.sendMessage(chatId, t(lang, 'notAgent'));
    }
    userStates.set(userId, { step: 'awaiting_response', requestId: Number(requestId) });
    bot.sendMessage(chatId, t(lang, 'yourResponse'));
  }
});

// ── Handle text messages (agent registration, responses) ──
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const state = userStates.get(userId);

  if (!state) {
    // User sent text without a state — ignore
    return;
  }

  const lang = stmts.getUserLanguage(userId)?.language || 'hy';

  if (state.step === 'awaiting_agent_registration') {
    // Parse: name, company, phone
    const parts = msg.text.split(',').map(s => s.trim());
    if (parts.length < 3) {
      return bot.sendMessage(chatId, t(lang, 'registerPrompt'));
    }
    const [name, company, phone] = parts;
    stmts.upsertUser(userId, msg.from.username || '', msg.from.first_name || '', msg.from.last_name || '');
    stmts.registerAgent(userId, name, company, phone);
    userStates.delete(userId);

    // Notify owner for approval
    if (OWNER_ID) {
      bot.sendMessage(OWNER_ID,
        `🆕 New agent registration:\n\nName: ${name}\nCompany: ${company}\nPhone: ${phone}\nTelegram: @${msg.from.username || userId}\n\nApprove?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `approve:${userId}` },
                { text: '❌ Reject', callback_data: `reject:${userId}` },
              ],
            ],
          },
        },
      );
    } else {
      // Auto-approve if no owner
      stmts.approveAgent(userId);
      bot.sendMessage(chatId, t(lang, 'approved'));
    }
    bot.sendMessage(chatId, t(lang, 'registerSuccess'));
  }

  else if (state.step === 'awaiting_response') {
    const response = msg.text;
    const request = stmts.getRequest(state.requestId);
    if (!request) {
      return bot.sendMessage(chatId, t(lang, 'error'));
    }

    stmts.createResponse(state.requestId, userId, response, '');
    userStates.delete(userId);

    // Notify the original user
    const userLang = stmts.getUserLanguage(request.user_id)?.language || 'hy';
    const agent = stmts.getAgent(userId);

    bot.sendMessage(request.user_id,
      t(userLang, 'responseFromAgent', agent?.name || 'Agent', agent?.company || '', response),
    );

    bot.sendMessage(chatId, t(lang, 'responseSent'));
  }
});

  // ── Start server ──
  app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`🤖 Bot polling started...`);
    console.log(`🌐 Web App URL: ${WEBAPP_URL}/webapp`);
    console.log(`\n📌 To use Web App:`);
    console.log(`   1. Set WEBAPP_URL in .env to your public HTTPS URL (use ngrok for testing)`);
    console.log(`   2. Go to @BotFather → /mybots → your bot → Bot Settings → Menu Button → Web App URL`);
    console.log(`   3. Set the URL to ${WEBAPP_URL}/webapp`);
  });
}).catch(err => {
  console.error('Failed to initialize DB:', err);
  process.exit(1);
});

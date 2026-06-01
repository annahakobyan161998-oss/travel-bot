require('dotenv').config()
const express = require('express')
const path = require('path')
const fs = require('fs')
const { Telegraf, Markup } = require('telegraf')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')

/* ─── Config ─── */

const BOT_TOKEN = process.env.BOT_TOKEN
const PORT = process.env.PORT || 3000
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`
const DATA_DIR = path.join(__dirname, 'data')

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required in .env file')
  process.exit(1)
}

/* ─── Admin Auth ─── */

const adminTokens = new Set()

function generateToken() {
  return crypto.createHash('sha256').update(ADMIN_PASSWORD + Date.now() + Math.random()).digest('hex')
}

function adminAuth(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ') || !adminTokens.has(auth.slice(7))) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

/* ─── Data Store ─── */

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

function readJSON(file) {
  const fp = path.join(DATA_DIR, file)
  if (!fs.existsSync(fp)) return {}
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')) } catch { return {} }
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf8')
}

function getAgents() {
  return Object.values(readJSON('agents.json'))
}

function addAgent(chatId, username) {
  const agents = readJSON('agents.json')
  if (agents[chatId]) return false // already registered
  agents[chatId] = { chatId, username, registeredAt: new Date().toISOString() }
  writeJSON('agents.json', agents)
  return true
}

function removeAgent(chatId) {
  const agents = readJSON('agents.json')
  if (!agents[chatId]) return false
  delete agents[chatId]
  writeJSON('agents.json', agents)
  return true
}

function saveRequest(data) {
  const requests = readJSON('requests.json')
  const id = uuidv4()
  requests[id] = { id, ...data, createdAt: new Date().toISOString() }
  writeJSON('requests.json', requests)
  return requests[id]
}

/* ─── Bot Setup ─── */

const bot = new Telegraf(BOT_TOKEN)

// ── /start — show welcome + Mini App button ──
bot.start(async (ctx) => {
  const name = ctx.from.first_name || 'Dear'
  await ctx.reply(
    `✈️ *Welcome ${name}!*\n\nTell us about your dream trip and we'll send your request to all our partner tour agents.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✈️ Start a Travel Request', web_app: { url: `${APP_URL}/app` } }],
        ],
      },
    }
  )
})

// ── /register — for tour agents to subscribe ──
bot.command('register', async (ctx) => {
  const chatId = ctx.chat.id.toString()
  const username = ctx.from.username || ctx.from.first_name || 'Unknown'

  if (addAgent(chatId, username)) {
    await ctx.reply(
      '✅ *You are now registered as a tour agent!*\n\nYou will receive travel requests from clients in real-time.\n\nUse /unregister to stop receiving requests.',
      { parse_mode: 'Markdown' }
    )
  } else {
    await ctx.reply('ℹ️ You are already registered as an agent.')
  }
})

// ── /unregister ──
bot.command('unregister', async (ctx) => {
  const chatId = ctx.chat.id.toString()
  if (removeAgent(chatId)) {
    await ctx.reply('❌ You have been unregistered. You will no longer receive travel requests.')
  } else {
    await ctx.reply('ℹ️ You are not registered as an agent.')
  }
})

// ── /agents — show agent count (anyone can see) ──
bot.command('agents', async (ctx) => {
  const agents = getAgents()
  await ctx.reply(`👥 Registered agents: ${agents.length}`)
})

// ── Broadcast a request to all agents ──
async function broadcastToAgents(request) {
  const agents = getAgents()
  if (agents.length === 0) {
    console.log('No registered agents to notify')
    return
  }

  const message =
    `✈️ *New Travel Request!*\n\n` +
    `🌍 *Country:* ${request.country}\n` +
    `📅 *Date:* ${request.travelDate}\n` +
    `👥 *Travelers:* ${request.travelers}\n` +
    `💰 *Budget:* ${request.budget}\n` +
    `${request.notes ? `📝 *Notes:* ${request.notes}\n` : ''}\n` +
    `🆔 *Client:* ${request.clientName || 'Anonymous'}\n` +
    `🕐 *Requested:* ${new Date(request.createdAt).toLocaleString('hy-AM')}`

  // Send to ALL agents in PARALLEL for speed
  const results = await Promise.allSettled(
    agents.map(agent =>
      bot.telegram.sendMessage(agent.chatId, message, { parse_mode: 'Markdown' })
        .catch(err => {
          console.error(`Failed to send to agent ${agent.chatId}:`, err.message)
          if (err.message.includes('blocked') || err.message.includes('deactivated')) {
            removeAgent(agent.chatId)
          }
          throw err
        })
    )
  )

  const sent = results.filter(r => r.status === 'fulfilled').length
  const failed = results.filter(r => r.status === 'rejected').length
  console.log(`Broadcast: ${sent} sent, ${failed} failed`)
}

/* ─── Express Server ─── */

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ── Mini App page ──
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ── API: Submit travel request (from Mini App) ──
app.post('/api/requests', (req, res) => {
  const { country, travelDate, travelers, budget, notes, clientName, telegramId } = req.body

  if (!country || !travelDate || !travelers || !budget) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  const request = saveRequest({
    country,
    travelDate,
    travelers: Number(travelers),
    budget: Number(budget),
    notes: notes || '',
    clientName: clientName || 'Anonymous',
    telegramId: telegramId || '',
  })

  // Broadcast to all agents (async, don't block response)
  broadcastToAgents(request).catch(console.error)

  res.json({
    success: true,
    message: 'Your request has been sent to all our partner agents. They will contact you soon!',
    id: request.id,
  })
})

// ── API: Health check ──
app.get('/api/health', (req, res) => {
  const agents = getAgents()
  res.json({ status: 'ok', agents: agents.length })
})

/* ─── Admin API ─── */

// Serve admin dashboard page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'))
})

app.use('/admin', express.static(path.join(__dirname, 'admin')))

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' })
  }
  const token = generateToken()
  adminTokens.add(token)
  res.json({ token })
})

// GET /api/admin/stats
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const requests = Object.values(readJSON('requests.json'))
  const agents = getAgents()
  const today = new Date().toISOString().slice(0, 10)
  const todayRequests = requests.filter(r => r.createdAt?.startsWith(today))
  const recentRequests = requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5)

  res.json({
    totalRequests: requests.length,
    totalAgents: agents.length,
    todayRequests: todayRequests.length,
    recentRequests,
  })
})

// GET /api/admin/requests
app.get('/api/admin/requests', adminAuth, (req, res) => {
  const requests = Object.values(readJSON('requests.json'))
  requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  res.json({ requests })
})

// DELETE /api/admin/requests/:id
app.delete('/api/admin/requests/:id', adminAuth, (req, res) => {
  const data = readJSON('requests.json')
  if (!data[req.params.id]) {
    return res.status(404).json({ error: 'Request not found' })
  }
  delete data[req.params.id]
  writeJSON('requests.json', data)
  res.json({ success: true })
})

// GET /api/admin/agents
app.get('/api/admin/agents', adminAuth, (req, res) => {
  res.json({ agents: getAgents() })
})

// DELETE /api/admin/agents/:chatId
app.delete('/api/admin/agents/:chatId', adminAuth, (req, res) => {
  if (removeAgent(req.params.chatId)) {
    res.json({ success: true })
  } else {
    res.status(404).json({ error: 'Agent not found' })
  }
})

// ── Set bot webhook ──
async function startBot() {
  try {
    // Remove any existing webhook first
    await bot.telegram.deleteWebhook()

    // Determine if we should use webhook or polling
    const isProduction = APP_URL.startsWith('https://')

    if (isProduction) {
      const webhookUrl = `${APP_URL}/webhook`
      await bot.telegram.setWebhook(webhookUrl)
      console.log(`Bot webhook set to: ${webhookUrl}`)

      // Register express webhook endpoint
      app.post('/webhook', (req, res) => {
        bot.handleUpdate(req.body, res)
      })
    } else {
      // Polling mode for local dev
      bot.launch()
      console.log('Bot started in polling mode')
    }

    console.log(`Bot is running as @${(await bot.telegram.getMe()).username}`)
  } catch (err) {
    console.error('Failed to start bot:', err.message)
  }
}

/* ─── Start ─── */

ensureDir()

startBot().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`)
    console.log(`Mini App URL: ${APP_URL}/app`)
    console.log(`\n--- Instructions ---`)
    console.log(`1. Set BOT_TOKEN in .env`)
    console.log(`2. For production: set APP_URL to your HTTPS domain`)
    console.log(`3. For local dev: use "npx localtunnel --port ${PORT}" and set APP_URL to the tunnel URL`)
    console.log(`4. Open Telegram, find your bot, and press /start`)
    console.log(`5. Tour agents should use /register to receive requests`)
  })
})

// Graceful shutdown
process.on('SIGINT', () => { if (!process.env.APP_URL?.startsWith('https')) bot.stop('SIGINT'); process.exit() })
process.on('SIGTERM', () => { if (!process.env.APP_URL?.startsWith('https')) bot.stop('SIGTERM'); process.exit() })

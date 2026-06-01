let token = sessionStorage.getItem('adminToken')
const API = '/api/admin'

document.addEventListener('DOMContentLoaded', () => {
  if (token) {
    showDashboard()
    loadAllData()
  }
  document.getElementById('passwordInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') login()
  })
})

function showError(msg) {
  document.getElementById('loginError').textContent = msg
}

// ── Auth ──

async function login() {
  const password = document.getElementById('passwordInput').value
  if (!password) return showError('Enter password')

  try {
    const res = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const data = await res.json()
    if (res.ok) {
      token = data.token
      sessionStorage.setItem('adminToken', token)
      showDashboard()
      loadAllData()
    } else {
      showError(data.error || 'Invalid password')
    }
  } catch {
    showError('Network error')
  }
}

function logout() {
  token = null
  sessionStorage.removeItem('adminToken')
  document.getElementById('dashboardScreen').style.display = 'none'
  document.getElementById('loginScreen').style.display = 'flex'
  document.getElementById('passwordInput').value = ''
  document.getElementById('loginError').textContent = ''
}

function showDashboard() {
  document.getElementById('loginScreen').style.display = 'none'
  document.getElementById('dashboardScreen').style.display = 'block'
}

// ── API helper ──

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { ...options.headers, 'Authorization': `Bearer ${token}` },
  })
  if (res.status === 401) { logout(); return null }
  return res.json()
}

// ── Tabs ──

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))
  document.querySelector(`.tab[data-tab="${name}"]`).classList.add('active')
  document.getElementById(`tab-${name}`).classList.add('active')
}

// ── Load all data ──

async function loadAllData() {
  loadStats()
  loadRequests()
  loadAgents()
}

// ── Stats ──

async function loadStats() {
  const data = await api('/stats')
  if (!data) return
  document.getElementById('statTotalRequests').textContent = data.totalRequests
  document.getElementById('statTotalAgents').textContent = data.totalAgents
  document.getElementById('statTodayRequests').textContent = data.todayRequests

  const container = document.getElementById('recentRequestsList')
  if (data.recentRequests.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>No requests yet</p></div>'
    return
  }
  container.innerHTML = data.recentRequests.map(r => renderRequestCard(r)).join('')
}

// ── Requests ──

let allRequests = []

async function loadRequests() {
  const data = await api('/requests')
  if (!data) return
  allRequests = data.requests
  renderRequests(allRequests)
}

function filterRequests() {
  const q = document.getElementById('requestsSearch').value.toLowerCase()
  const filtered = allRequests.filter(r =>
    r.country.toLowerCase().includes(q) ||
    (r.clientName || '').toLowerCase().includes(q) ||
    (r.telegramId || '').includes(q)
  )
  renderRequests(filtered)
}

function renderRequests(requests) {
  const container = document.getElementById('requestsList')
  document.getElementById('requestsCount').textContent = `${requests.length} request${requests.length !== 1 ? 's' : ''}`

  if (requests.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>No requests found</p></div>'
    return
  }

  container.innerHTML = requests.map(r => renderRequestCard(r, true)).join('')
}

function renderRequestCard(r, showDelete = false) {
  const date = new Date(r.createdAt)
  const dateStr = date.toLocaleDateString('hy-AM', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  return `
    <div class="request-card" id="req-${r.id}">
      <div class="request-card-header">
        <div>
          <div class="request-country">🌍 ${r.country}</div>
          <div class="request-date">${dateStr}</div>
        </div>
        <div style="text-align:right;font-size:12px;color:var(--text-secondary)">
          ${r.clientName || 'Anonymous'}
          ${r.telegramId ? `<br>🆔 ${r.telegramId}` : ''}
        </div>
      </div>
      <dl class="request-details">
        <dt>📅 Date</dt><dd>${r.travelDate}</dd>
        <dt>👥 Travelers</dt><dd>${r.travelers}</dd>
        <dt>💰 Budget</dt><dd>${Number(r.budget).toLocaleString()} AMD</dd>
      </dl>
      ${r.notes ? `<div class="request-notes">💬 ${r.notes}</div>` : ''}
      ${showDelete ? `
        <div class="request-actions">
          <button class="btn btn-danger btn-sm" onclick="deleteRequest('${r.id}')">🗑 Delete</button>
        </div>
      ` : ''}
    </div>
  `
}

async function deleteRequest(id) {
  if (!confirm('Delete this request?')) return
  const data = await api(`/requests/${id}`, { method: 'DELETE' })
  if (data?.success) {
    document.getElementById(`req-${id}`)?.remove()
    allRequests = allRequests.filter(r => r.id !== id)
    document.getElementById('requestsCount').textContent = `${allRequests.length} request${allRequests.length !== 1 ? 's' : ''}`
    loadStats()
  }
}

// ── Agents ──

async function loadAgents() {
  const data = await api('/agents')
  if (!data) return
  const agents = data.agents

  document.getElementById('agentsCount').textContent = `${agents.length} agent${agents.length !== 1 ? 's' : ''}`

  const container = document.getElementById('agentsList')
  if (agents.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="icon">👥</div><p>No registered agents</p><p style="font-size:12px;margin-top:4px">Agents use /register in the bot to subscribe</p></div>'
    return
  }

  container.innerHTML = agents.map(a => {
    const initial = (a.username || '?')[0].toUpperCase()
    const date = new Date(a.registeredAt).toLocaleDateString('hy-AM', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    return `
      <div class="agent-card" id="agent-${a.chatId}">
        <div class="agent-info">
          <div class="agent-avatar">${initial}</div>
          <div>
            <div class="agent-name">${a.username}</div>
            <div class="agent-meta">🆔 ${a.chatId} · Registered: ${date}</div>
          </div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="deleteAgent('${a.chatId}')">Remove</button>
      </div>
    `
  }).join('')
}

async function deleteAgent(chatId) {
  if (!confirm('Remove this agent?')) return
  const data = await api(`/agents/${chatId}`, { method: 'DELETE' })
  if (data?.success) {
    document.getElementById(`agent-${chatId}`)?.remove()
    loadStats()
    loadAgents()
  }
}

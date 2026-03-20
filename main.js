// ── Auth & Dynamic Configuration ──
// ── Environment-aware API base URLs (proxy for localhost, direct for production) ──
const _isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const AUTH_URL = _isLocal ? '/n8n-webhook/webhook/setter-solar-auth' : 'https://optima-n8n.vhsxer.easypanel.host/webhook/setter-solar-auth';
const VERIFY_URL = _isLocal ? '/n8n-webhook/webhook/setter-solar-verify' : 'https://optima-n8n.vhsxer.easypanel.host/webhook/setter-solar-verify';
const VAPI_API_BASE = _isLocal ? '/vapi-api' : 'https://api.vapi.ai';
const NOCODB_PROXY_BASE = _isLocal ? '/nocodb-api' : 'https://optima-nocodb.vhsxer.easypanel.host';

// These will be populated dynamically after login
let API_BASE = '', LEADS_TABLE = '', CALL_LOGS_TABLE = '', CONFIRMED_TABLE = '',
    ERROR_LOGS_TABLE = '', XC_TOKEN = '', VAPI_API_KEY = '', GROQ_API_KEY = '',
    VAPI_PHONE_NUMBER_ID = '', VAPI_ASSISTANT_ID = '', VAPI_PUBLIC_KEY = '',
    ZADARMA_KEY = '', ZADARMA_SECRET = '', ZADARMA_FROM_NUMBER = '';

let _userConfig = {}; // Store the full user config

function applyConfig(config) {
    _userConfig = config;
    // Rewrite NocoDB base through Vite proxy on localhost to avoid CORS
    let rawBase = config.api_base || '';
    if (_isLocal && rawBase.includes('optima-nocodb.vhsxer.easypanel.host')) {
        rawBase = rawBase.replace('https://optima-nocodb.vhsxer.easypanel.host', '/nocodb-api');
    }
    API_BASE = rawBase;
    LEADS_TABLE = config.leads_table || '';
    CALL_LOGS_TABLE = config.call_logs_table || '';
    CONFIRMED_TABLE = config.confirmed_table || '';
    ERROR_LOGS_TABLE = config.error_logs_table || '';
    XC_TOKEN = config.xc_token || '';
    VAPI_API_KEY = config.vapi_api_key || '';
    VAPI_PUBLIC_KEY = config.vapi_public_key || '';
    GROQ_API_KEY = config.groq_api_key || config.GROQ_API_KEY || '';
    VAPI_PHONE_NUMBER_ID = config.vapi_phone_number_id || '';
    VAPI_ASSISTANT_ID = config.vapi_assistant_id || '';
    ZADARMA_KEY = config.zadarma_key || '';
    ZADARMA_SECRET = config.zadarma_secret || '';
    ZADARMA_FROM_NUMBER = config.zadarma_from_number || '';

    // Update UI with branding
    const companyEl = document.getElementById('header-company-name');
    if (companyEl) companyEl.textContent = config.company_name || 'Dashboard';
    if (config.logo_url) {
        const logoEl = document.getElementById('header-logo');
        if (logoEl) logoEl.src = config.logo_url;
    }
    document.title = (config.company_name || 'Dashboard') + ' — Panel de Control';

    // Show admin tab if user is admin
    const adminTab = document.getElementById('nav-tab-admin');
    if (adminTab) adminTab.style.display = config.is_admin ? '' : 'none';
}

let currentCalls = [];
let allCalls = [];
let callsChart = null;
let dateFilter = null;
let currentCallsPage = [];
let confirmedDataMap = {}; // vapi_call_id -> { name, phone, email }
let activeDetailCall = null; // Global state for the currently active call in the detail view

// ── Vapi API Cache & Rate Limiter ──
// Prevents 429 (Too Many Requests) errors by caching responses and serializing requests
const _vapiCache = new Map(); // Map<vapiCallId, { data, timestamp }>
const VAPI_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const VAPI_REQUEST_INTERVAL_MS = 3000; // Minimum 3s between Vapi API requests
let _vapiLastRequestTime = 0;
let _vapiRequestQueue = Promise.resolve(); // Serialize all Vapi requests

/**
 * Rate-limited, cached fetch for Vapi call details.
 * All calls to this function are serialized through a queue.
 */
function fetchVapiCall(vapiCallId, { skipCache = false } = {}) {
    // Check cache first (unless skipCache)
    if (!skipCache) {
        const cached = _vapiCache.get(vapiCallId);
        if (cached && (Date.now() - cached.timestamp) < VAPI_CACHE_TTL_MS) {
            return Promise.resolve(cached.data);
        }
    }

    // Queue the request to serialize all Vapi API calls
    _vapiRequestQueue = _vapiRequestQueue.then(async () => {
        // Re-check cache (another queued request may have populated it)
        if (!skipCache) {
            const cached = _vapiCache.get(vapiCallId);
            if (cached && (Date.now() - cached.timestamp) < VAPI_CACHE_TTL_MS) {
                return cached.data;
            }
        }

        // Rate limit: wait if last request was too recent
        const elapsed = Date.now() - _vapiLastRequestTime;
        if (elapsed < VAPI_REQUEST_INTERVAL_MS) {
            await new Promise(r => setTimeout(r, VAPI_REQUEST_INTERVAL_MS - elapsed));
        }

        _vapiLastRequestTime = Date.now();

        const res = await fetch(`${VAPI_API_BASE}/call/${vapiCallId}`, {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });

        if (!res.ok) {
            throw new Error(`Vapi HTTP ${res.status}`);
        }

        const data = await res.json();
        _vapiCache.set(vapiCallId, { data, timestamp: Date.now() });
        return data;
    }).catch(err => {
        // Don't break the queue on errors
        console.warn(`[VapiCache] Error fetching ${vapiCallId}:`, err.message);
        return null;
    });

    return _vapiRequestQueue;
}
let isEnriching = false; // Guard against multiple enrichment runs
let paginationPage = 1;
let paginationPageSize = 20;

// ── Data Cache ── Avoid redundant API calls across tabs
let _leadsCache = null;
let _leadsCacheTime = 0;
let _confirmedCache = null;
let _confirmedCacheTime = 0;
const DATA_CACHE_TTL = 60000; // 1 minute

// ── Persistent API Error Logger (server-side via NocoDB) ──
const API_ERROR_LOG_KEY = 'setter_api_error_log';
const API_ERROR_LOG_MAX = 500;
let _errorLogQueue = [];
let _errorLogFlushing = false;
let _errorLogFlushFailures = 0;
let _errorLogFlushPausedUntil = 0;

function logApiError({ url, method, status, statusText, context, detail }) {
    const entry = {
        timestamp: new Date().toISOString(),
        url: (url || '').substring(0, 500),
        method: method || 'GET',
        status: status || 0,
        status_text: (statusText || '').substring(0, 200),
        context: (context || '').substring(0, 200),
        detail: (detail || '').substring(0, 500)
    };
    console.warn(`[ErrorLog] ${entry.method} ${entry.status} ${entry.url} — ${entry.context}`);

    // Save to localStorage as backup
    try {
        const logs = JSON.parse(localStorage.getItem(API_ERROR_LOG_KEY) || '[]');
        logs.push(entry);
        if (logs.length > API_ERROR_LOG_MAX) logs.splice(0, logs.length - API_ERROR_LOG_MAX);
        localStorage.setItem(API_ERROR_LOG_KEY, JSON.stringify(logs));
    } catch (_) { }

    // Queue for server persistence (cap at 50 to prevent flood)
    if (_errorLogQueue.length < 50) {
        _errorLogQueue.push(entry);
        _flushErrorLogs();
    }
}

async function _flushErrorLogs() {
    if (_errorLogFlushing || _errorLogQueue.length === 0) return;
    // Circuit breaker: pause flushes for 60s after 3 consecutive failures
    if (Date.now() < _errorLogFlushPausedUntil) return;
    _errorLogFlushing = true;
    try {
        // Batch up to 10 at a time
        const batch = _errorLogQueue.splice(0, 10);
        await fetch(`${API_BASE}/${ERROR_LOGS_TABLE}/records`, {
            method: 'POST',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify(batch)
        });
        _errorLogFlushFailures = 0; // success resets counter
    } catch (e) {
        console.warn('[ErrorLog] Failed to flush to server:', e.message);
        _errorLogFlushFailures++;
        if (_errorLogFlushFailures >= 3) {
            _errorLogFlushPausedUntil = Date.now() + 60000;
            console.warn('[ErrorLog] Circuit breaker: pausing flush for 60s after 3 failures');
        }
    } finally {
        _errorLogFlushing = false;
        // If more queued, flush again after a short delay
        if (_errorLogQueue.length > 0) setTimeout(_flushErrorLogs, 2000);
    }
}

async function getApiErrorsFromServer(limit = 100) {
    try {
        const res = await fetch(`${API_BASE}/${ERROR_LOGS_TABLE}/records?limit=${limit}&sort=-CreatedAt`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data.list || [];
    } catch (e) {
        console.error('[ErrorLog] Failed to fetch server logs:', e);
        // Fallback to localStorage
        return JSON.parse(localStorage.getItem(API_ERROR_LOG_KEY) || '[]');
    }
}

function getApiErrors() {
    try { return JSON.parse(localStorage.getItem(API_ERROR_LOG_KEY) || '[]'); }
    catch { return []; }
}

function clearApiErrors() {
    localStorage.removeItem(API_ERROR_LOG_KEY);
    console.log('[ErrorLog] Logs locales borrados');
}

async function clearServerErrors() {
    try {
        const logs = await getApiErrorsFromServer(500);
        if (logs.length === 0) { console.log('[ErrorLog] No hay logs en servidor'); return; }
        for (let i = 0; i < logs.length; i += 50) {
            const batch = logs.slice(i, i + 50);
            await fetch(`${API_BASE}/${ERROR_LOGS_TABLE}/records`, {
                method: 'DELETE',
                headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify(batch.map(l => ({ Id: l.Id || l.id })))
            });
        }
        console.log(`[ErrorLog] ${logs.length} logs borrados del servidor`);
    } catch (e) {
        console.error('[ErrorLog] Error borrando logs del servidor:', e);
    }
}

function downloadApiErrors() {
    const logs = getApiErrors();
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `api_errors_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
}

// Expose to console for manual inspection
window._apiErrors = { get: getApiErrors, getServer: getApiErrorsFromServer, clear: clearApiErrors, clearServer: clearServerErrors, download: downloadApiErrors };

function updateGlobalSchedulerBadge(allRecords) {
    try {
        const scheduled = allRecords.filter(l => (l.status || '').toLowerCase() === 'programado' || l.fecha_planificada).length;
        const badge = document.getElementById('nav-tab-scheduler-badge');
        if (badge) {
            if (scheduled > 0) {
                badge.textContent = `(${scheduled})`;
                badge.style.display = 'inline';
            } else {
                badge.style.display = 'none';
                badge.textContent = '';
            }
        }
    } catch (e) {
        console.error('Error updating scheduler badge:', e);
    }
}

async function fetchCachedLeads(forceRefresh = false) {
    if (!forceRefresh && _leadsCache && (Date.now() - _leadsCacheTime) < DATA_CACHE_TTL) {
        updateGlobalSchedulerBadge(_leadsCache);
        return _leadsCache;
    }
    let allRecords = [];
    let offset = 0;
    const batchSize = 200;
    while (true) {
        const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records?limit=${batchSize}&offset=${offset}`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        const data = await res.json();
        const records = data.list || [];
        allRecords = allRecords.concat(records);
        if (records.length < batchSize || data.pageInfo?.isLastPage !== false) break;
        offset += batchSize;
        if (allRecords.length >= 10000) break;
    }
    _leadsCache = allRecords;
    _leadsCacheTime = Date.now();
    updateGlobalSchedulerBadge(allRecords);
    return allRecords;
}

function invalidateLeadsCache() {
    _leadsCache = null;
    _leadsCacheTime = 0;
}

function invalidateConfirmedCache() {
    _confirmedCache = null;
    _confirmedCacheTime = 0;
}

// Helper: Escape HTML to prevent XSS in innerHTML injections
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Helper: Format transcript with AI/User colors
function formatTranscriptHTML(rawTranscript) {
    if (!rawTranscript || rawTranscript.trim().length === 0) return '';
    const lines = rawTranscript.split('\n').filter(l => l.trim());
    return lines.map(line => {
        const trimmed = line.trim();
        const escaped = escapeHtml(trimmed);
        if (trimmed.startsWith('AI:') || trimmed.startsWith('Assistant:') || trimmed.startsWith('Bot:')) {
            return `<div style="margin: 4px 0; padding: 6px 10px; border-left: 3px solid var(--accent); background: rgba(99,102,241,0.06); border-radius: 0 6px 6px 0;"><span style="color: var(--accent); font-weight: 600; font-size: 11px;">🤖 IA</span> <span style="color: var(--text-primary);">${escapeHtml(trimmed.replace(/^(AI:|Assistant:|Bot:)\s*/, ''))}</span></div>`;
        } else if (trimmed.startsWith('User:') || trimmed.startsWith('Customer:') || trimmed.startsWith('Cliente:')) {
            return `<div style="margin: 4px 0; padding: 6px 10px; border-left: 3px solid var(--success); background: rgba(16,185,129,0.06); border-radius: 0 6px 6px 0;"><span style="color: var(--success); font-weight: 600; font-size: 11px;">👤 Cliente</span> <span style="color: var(--text-primary);">${escapeHtml(trimmed.replace(/^(User:|Customer:|Cliente:)\s*/, ''))}</span></div>`;
        }
        return `<div style="margin: 4px 0; padding: 4px 10px; color: var(--text-secondary);">${escaped}</div>`;
    }).join('');
}

// Helper: Populate original lead data section
async function populateOriginalLeadData(call) {
    const origName = document.getElementById('orig-name');
    const origPhone = document.getElementById('orig-phone');
    const origEmail = document.getElementById('orig-email');
    const origSector = document.getElementById('orig-sector');

    // Set basic data from the call record
    origName.textContent = call.lead_name || '—';
    origPhone.textContent = call.phone_called || '—';
    origEmail.textContent = '—';
    origSector.textContent = '—';

    // Try to fetch additional data from the Leads table
    try {
        const LEADS_TABLE_ID = LEADS_TABLE;
        const phoneCalled = call.phone_called;
        if (phoneCalled) {
            const normalizedSearch = normalizePhone(phoneCalled);
            const query = `(phone,eq,${encodeURIComponent(normalizedSearch)})`;
            const searchRes = await fetch(`${API_BASE}/${LEADS_TABLE_ID}/records?where=${query}`, {
                headers: { 'xc-token': XC_TOKEN }
            });
            const searchData = await searchRes.json();
            const lead = searchData.list && searchData.list[0];
            if (lead) {
                origName.textContent = lead.name || call.lead_name || '—';
                origEmail.textContent = lead.email || '—';
                origSector.textContent = lead.sector || '—';
            }
        }
    } catch (err) {
        console.warn('[populateOriginalLeadData] Error fetching lead:', err);
    }
}

async function fetchData(tableId, limit = 200) {
    // Paginate through ALL records from NocoDB
    let allRecords = [];
    let offset = 0;
    const batchSize = limit;

    while (true) {
        const url = `${API_BASE}/${tableId}/records?limit=${batchSize}&offset=${offset}&sort=-CreatedAt`;
        let res;
        try {
            res = await fetch(url, {
                headers: { 'xc-token': XC_TOKEN }
            });
        } catch (networkErr) {
            const err = new Error(`No se pudo conectar con el servidor de datos (${API_BASE}). Comprueba tu conexión a internet.`);
            err.type = 'NETWORK_ERROR';
            err.detail = networkErr.message;
            err.url = url;
            logApiError({ url, method: 'GET', status: 0, statusText: 'NETWORK_ERROR', context: 'fetchData', detail: networkErr.message });
            throw err;
        }
        if (!res.ok) {
            let body = '';
            try { body = await res.text(); } catch (_) { }
            logApiError({ url, method: 'GET', status: res.status, statusText: res.statusText, context: 'fetchData', detail: body.substring(0, 500) });
            const err = new Error(`El servidor de datos respondió con error HTTP ${res.status} (${res.statusText || 'sin descripción'})`);
            err.type = 'HTTP_ERROR';
            err.status = res.status;
            err.detail = body.substring(0, 300);
            err.url = url;
            throw err;
        }
        let data;
        try {
            data = await res.json();
        } catch (parseErr) {
            logApiError({ url, method: 'GET', status: 200, statusText: 'PARSE_ERROR', context: 'fetchData', detail: parseErr.message });
            const err = new Error('La respuesta del servidor no es JSON válido.');
            err.type = 'PARSE_ERROR';
            err.detail = parseErr.message;
            err.url = url;
            throw err;
        }
        const records = data.list || [];
        allRecords = allRecords.concat(records);
        if (records.length < batchSize || data.pageInfo?.isLastPage !== false) break;
        offset += batchSize;
        if (allRecords.length >= 500) break; // Limit to last 500 records for performance
    }
    return allRecords;
}

const STATUS_MAP = {
    'voicemail': 'Buzón de Voz',
    'customer-ended-call': 'Llamada Finalizada',
    'assistant-ended-call': 'Llamada Finalizada',
    'call-in-progress.error-sip-outbound-call-failed-to-connect': 'Fallo de Conexión',
    'call-in-progress.error-vapi-internal': 'Error Interno',
    'call-initiated': 'Iniciando...',
    'no-answer': 'Sin Respuesta',
    'busy': 'Ocupado'
};

function formatStatus(reason) {
    if (!reason) return '-';
    // Clean and match
    const clean = reason.toLowerCase().trim();
    return STATUS_MAP[clean] || reason;
}

function formatDate(dateStr, short = false) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (short) return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function getBadgeClass(evaluation) {
    if (!evaluation || evaluation === false || evaluation === 'false') return 'pending';
    const e = String(evaluation).toLowerCase();
    if (e.includes('contestador') || e.includes('voicemail') || e.includes('buzón') || e.includes('máquina')) return 'voicemail';
    if (e.includes('success') || e.includes('completed') || e.includes('confirmada') || e.includes('ok') || e.includes('completada')) return 'success';
    if (e.includes('fail') || e.includes('error') || e.includes('no contesta') || e.includes('rechazada') || e.includes('fallida') || e.includes('ocupado')) return 'fail';
    if (e.includes('sin datos') || e.includes('incompleta') || e.includes('colgó rápido') || e.includes('sin respuesta')) return 'warning';
    return 'pending';
}

function formatDuration(seconds) {
    if (!seconds) return '-';
    const s = parseInt(seconds);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── Call Quality Score System ──
function calculateCallScore(call) {
    const breakdown = { duration: 0, evaluation: 0, confirmed: 0, endReason: 0, transcript: 0, appointment: 0 };

    // Contestador (answering machine) calls always score 0
    const evalLower = (call.evaluation || '').toLowerCase();
    if (evalLower.includes('contestador') || evalLower.includes('voicemail') || evalLower.includes('buzón') || evalLower.includes('máquina')) {
        return { total: 0, breakdown };
    }

    // 1. Duration (max 20)
    const dur = parseInt(call.duration_seconds) || 0;
    if (dur >= 60) breakdown.duration = 20;
    else if (dur >= 30) breakdown.duration = 14;
    else if (dur >= 15) breakdown.duration = 8;
    else if (dur >= 10) breakdown.duration = 4;
    else breakdown.duration = 0;

    // 2. Evaluation (max 25)
    const evalText = (call.evaluation || '').toLowerCase();
    if (evalText.includes('confirmada')) breakdown.evaluation = 25;
    else if (evalText.includes('completada')) breakdown.evaluation = 18;
    else if (evalText.includes('sin datos') || evalText.includes('incompleta')) breakdown.evaluation = 8;
    else if (evalText.includes('buzón') || evalText.includes('no contesta')) breakdown.evaluation = 4;
    else if (evalText.includes('error') || evalText.includes('rechazada')) breakdown.evaluation = 0;
    else breakdown.evaluation = 6; // Pendiente

    // 3. Confirmed data (max 15)
    const callId = call.vapi_call_id || '';
    const confData = confirmedDataMap[callId];
    if (confData) {
        let confPoints = 0;
        if (confData.name && confData.name !== '-') confPoints += 5;
        if (confData.email && confData.email !== '-') confPoints += 5;
        if (confData.rawPhone && confData.rawPhone !== '-') confPoints += 5;
        breakdown.confirmed = confPoints;
    }

    // 4. End reason (max 10)
    const reason = (call.ended_reason || '').toLowerCase();
    if (reason.includes('customer-ended') || reason.includes('customer_ended')) breakdown.endReason = 10;
    else if (reason.includes('assistant-ended') || reason.includes('assistant_ended')) breakdown.endReason = 8;
    else if (reason.includes('manual') || reason === '') breakdown.endReason = 5;
    else if (reason.includes('voicemail') || reason.includes('buzón')) breakdown.endReason = 3;
    else if (reason.includes('error') || reason.includes('fail')) breakdown.endReason = 0;
    else breakdown.endReason = 4;

    // 5. Transcript (max 5)
    const transcript = call.transcript || '';
    if (transcript.length > 200) breakdown.transcript = 5;
    else if (transcript.length > 50) breakdown.transcript = 3;
    else breakdown.transcript = 0;

    // 6. Appointment scheduled (max 25)
    const apptData = confData || confirmedDataMap[callId];
    if (apptData && apptData.appointmentDate) {
        const apptDate = new Date(apptData.appointmentDate);
        if (!isNaN(apptDate.getTime())) {
            breakdown.appointment = 25; // Valid appointment date
        } else {
            breakdown.appointment = 10; // Date exists but invalid
        }
    }

    const total = breakdown.duration + breakdown.evaluation + breakdown.confirmed + breakdown.endReason + breakdown.transcript + breakdown.appointment;
    return { total, breakdown };
}

function getScoreLabel(score) {
    if (score >= 80) return { emoji: '🟢', text: 'Excelente', cls: 'score-excellent' };
    if (score >= 60) return { emoji: '🔵', text: 'Buena', cls: 'score-good' };
    if (score >= 40) return { emoji: '🟡', text: 'Regular', cls: 'score-regular' };
    if (score >= 20) return { emoji: '🟠', text: 'Deficiente', cls: 'score-poor' };
    return { emoji: '🔴', text: 'Muy mala', cls: 'score-bad' };
}

function getScoreColor(score) {
    if (score >= 80) return '#10b981';
    if (score >= 60) return '#3b82f6';
    if (score >= 40) return '#f59e0b';
    if (score >= 20) return '#f97316';
    return '#ef4444';
}

// Unified helper to detect if a call is confirmed
function isConfirmed(call) {
    const callId = call.vapi_call_id || (typeof call.id === 'string' ? call.id : '');
    return call['Data Confirmada'] === true || call['Data Confirmada'] === 1 || call['Data Confirmada'] === '1'
        || call.is_confirmed === true || call.is_confirmed === 1 || call.is_confirmed === '1'
        || (callId && confirmedDataMap[callId]);
}

// Sanitize AI-generated contact data
function sanitizeEmail(email) {
    if (!email || email === '-') return '-';
    // Convert spoken Spanish format to real email
    let e = email.toLowerCase().trim();
    e = e.replace(/\s*arroba\s*/gi, '@');
    e = e.replace(/\s*punto\s*/gi, '.');
    e = e.replace(/\s+/g, ''); // remove remaining spaces
    return e;
}

function sanitizePhone(phone, fallbackPhone) {
    if (!phone || phone === '-') return fallbackPhone || '-';
    // If it contains too many letters, it's not a real phone number — use fallback
    const letterCount = (phone.match(/[a-záéíóúñ]/gi) || []).length;
    if (letterCount > 3) return fallbackPhone || '-';
    return phone.replace(/[^\d+\s()-]/g, '').trim() || fallbackPhone || '-';
}

function sanitizeName(name) {
    if (!name || name === '-') return '-';
    // Capitalize each word
    return name.replace(/\b\w/g, c => c.toUpperCase());
}

// ── AI Diagnostic ──
async function generateCallDiagnostic(call) {
    const diagSection = document.getElementById('diagnostic-section');
    diagSection.style.display = 'block';
    diagSection.innerHTML = `
        <div class="diagnostic-container">
            <div class="diagnostic-loading">
                <div class="diagnostic-spinner"></div>
                <div>Analizando llamada con IA...</div>
                <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">Consultando Vapi + Groq Llama 3</div>
            </div>
        </div>`;

    const vapiId = call.vapi_call_id || call.lead_id || call.id || call.Id;
    let vapiData = null;

    // 1. Fetch full Vapi data
    try {
        if (vapiId && vapiId.startsWith('019')) {
            const res = await fetch(`${VAPI_API_BASE}/call/${vapiId}`, {
                headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
            });
            if (res.ok) vapiData = await res.json();
        }
    } catch (e) {
        console.warn('[Diagnostic] Vapi fetch error:', e);
    }

    // 2. Build context for OpenAI
    const transcript = vapiData?.artifact?.transcript || call.transcript || '';
    const summary = vapiData?.analysis?.summary || '';
    const successEval = vapiData?.analysis?.successEvaluation || '';
    const endedReason = vapiData?.endedReason || call.ended_reason || '';
    const duration = vapiData?.endedAt && vapiData?.startedAt
        ? Math.round((new Date(vapiData.endedAt) - new Date(vapiData.startedAt)) / 1000)
        : parseInt(call.duration_seconds) || 0;
    const costs = vapiData?.costs || [];
    const totalCost = costs.reduce((s, c) => s + (c.cost || 0), 0);
    const perf = vapiData?.artifact?.performanceMetrics || {};
    const structuredOutputs = vapiData?.artifact?.structuredOutputs || {};

    const costBreakdown = costs.map(c => `${c.type}: $${c.cost?.toFixed(4)}`).join(', ');
    const soList = Object.values(structuredOutputs).map(so => `${so.name}: ${so.result}`).join(', ');

    const prompt = `Eres un analista experto en llamadas de ventas con IA para una empresa de ciberseguridad (General Protection).
Analiza esta llamada individual y genera un diagnóstico detallado en español.

## DATOS DE LA LLAMADA
- Lead/Empresa: ${call.lead_name || 'Desconocida'}
- Teléfono: ${call.phone_called || '—'}
- Duración: ${duration}s
- Motivo de fin: ${endedReason}
- Evaluación: ${call.evaluation || 'Pendiente'}
- Success (Vapi): ${successEval}
- Structured Outputs: ${soList || 'N/A'}
- Coste total: $${totalCost.toFixed(4)}
- Costes: ${costBreakdown || 'N/A'}
- Latencia media turno: ${perf.turnLatencyAverage || 'N/A'}ms
- Resumen Vapi: ${summary || 'N/A'}

## TRANSCRIPCIÓN
${transcript || 'Sin transcripción'}

## INSTRUCCIONES
Responde EXACTAMENTE en JSON puro (sin markdown, sin \`\`\`):
{
  "resumen": "Párrafo de 2-3 líneas resumiendo qué pasó en la llamada, el tono del contacto y el resultado.",
  "problemas": ["problema 1", "problema 2", ...],
  "recomendaciones": ["recomendación 1", "recomendación 2", ...],
  "interes_lead": "alto/medio/bajo/nulo",
  "calidad_ia": "excelente/buena/regular/mala",
  "oportunidad_perdida": true/false,
  "siguiente_paso": "Qué acción concreta se debería tomar con este lead."
}`;

    let aiResult = null;
    try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: 'Eres un analista de ventas. Responde siempre en JSON válido, sin bloques de código markdown ni backticks.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 1500
            })
        });

        if (res.ok) {
            const data = await res.json();
            const content = data.choices[0]?.message?.content || '';
            let jsonStr = content.trim();
            if (jsonStr.startsWith('\`\`\`')) {
                jsonStr = jsonStr.replace(/^\`\`\`(?:json)?\n?/, '').replace(/\n?\`\`\`$/, '');
            }
            aiResult = JSON.parse(jsonStr);
        }
    } catch (e) {
        console.warn('[Diagnostic] Groq/API error:', e);
    }

    // 3. Render diagnostic
    const interesColors = { alto: '#22c55e', medio: '#f59e0b', bajo: '#f97316', nulo: '#ef4444' };
    const calidadColors = { excelente: '#22c55e', buena: '#3b82f6', regular: '#f59e0b', mala: '#ef4444' };
    const interes = aiResult?.interes_lead || 'nulo';
    const calidad = aiResult?.calidad_ia || 'regular';

    const costRows = costs.map(c => {
        const typeLabels = { transcriber: 'Transcriber', model: 'Modelo IA', voice: 'Voz', vapi: 'Vapi', 'voicemail-detection': 'VM Detection', 'knowledge-base': 'Knowledge', analysis: 'Análisis' };
        return `<div class="diagnostic-cost-row">
            <span class="diagnostic-cost-label">${typeLabels[c.type] || c.type}</span>
            <span class="diagnostic-cost-value">$${c.cost?.toFixed(4)}</span>
        </div>`;
    }).join('');

    const problemsHTML = (aiResult?.problemas || ['No se pudo generar el análisis']).map(p =>
        `<div class="diagnostic-problem-item">${p}</div>`
    ).join('');

    const recsHTML = (aiResult?.recomendaciones || ['Intentar nuevamente con más información']).map(r =>
        `<div class="diagnostic-rec-item">${r}</div>`
    ).join('');

    diagSection.innerHTML = `
        <div class="diagnostic-container">
            <div class="diagnostic-header">🔍 Diagnóstico IA</div>

            <div class="diagnostic-summary">${aiResult?.resumen || summary || 'No se pudo generar el resumen.'}</div>

            <div class="diagnostic-metrics">
                <div class="diagnostic-metric">
                    <div class="diagnostic-metric-value">${formatDuration(duration)}</div>
                    <div class="diagnostic-metric-label">Duración</div>
                </div>
                <div class="diagnostic-metric">
                    <div class="diagnostic-metric-value" style="color: ${interesColors[interes] || '#94a3b8'}">${interes.charAt(0).toUpperCase() + interes.slice(1)}</div>
                    <div class="diagnostic-metric-label">Interés Lead</div>
                </div>
                <div class="diagnostic-metric">
                    <div class="diagnostic-metric-value" style="color: ${calidadColors[calidad] || '#94a3b8'}">${calidad.charAt(0).toUpperCase() + calidad.slice(1)}</div>
                    <div class="diagnostic-metric-label">Calidad IA</div>
                </div>
                <div class="diagnostic-metric">
                    <div class="diagnostic-metric-value" style="color: ${aiResult?.oportunidad_perdida ? '#ef4444' : '#22c55e'}">${aiResult?.oportunidad_perdida ? 'Sí ⚠️' : 'No ✓'}</div>
                    <div class="diagnostic-metric-label">Oportunidad Perdida</div>
                </div>
                <div class="diagnostic-metric">
                    <div class="diagnostic-metric-value" style="font-size: 14px;">$${totalCost.toFixed(2)}</div>
                    <div class="diagnostic-metric-label">Coste Total</div>
                </div>
                <div class="diagnostic-metric">
                    <div class="diagnostic-metric-value" style="font-size: 14px;">${perf.turnLatencyAverage ? Math.round(perf.turnLatencyAverage) + 'ms' : '—'}</div>
                    <div class="diagnostic-metric-label">Latencia Media</div>
                </div>
            </div>

            <div class="diagnostic-problems">
                <div class="diagnostic-problems-title">⚠️ Problemas Detectados</div>
                ${problemsHTML}
            </div>

            <div class="diagnostic-problems">
                <div class="diagnostic-recs-title">💡 Recomendaciones</div>
                ${recsHTML}
            </div>

            ${aiResult?.siguiente_paso ? `
            <div style="background: rgba(99, 102, 241, 0.1); padding: 12px; border-radius: 10px; border-left: 3px solid var(--accent); margin-bottom: 16px;">
                <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--accent); margin-bottom: 4px;">📌 Siguiente Paso</div>
                <div style="font-size: 13px; color: var(--text-primary); line-height: 1.5;">${aiResult.siguiente_paso}</div>
            </div>` : ''}

            ${costs.length > 0 ? `
            <details style="margin-top: 12px;">
                <summary style="cursor: pointer; font-size: 12px; color: var(--text-secondary); user-select: none;">💰 Desglose de Costes</summary>
                <div class="diagnostic-cost-grid" style="margin-top: 8px;">${costRows}</div>
            </details>` : ''}
        </div>`;
}

window._runDiagnostic = async function () {
    if (!activeDetailCall) return;
    const btn = document.getElementById('diagnostic-btn');
    if (btn) {
        btn.disabled = true;
        btn.querySelector('.toggle-test-label').textContent = 'Analizando...';
    }
    try {
        await generateCallDiagnostic(activeDetailCall);
    } catch (e) {
        console.error('[Diagnostic] Error:', e);
        const sec = document.getElementById('diagnostic-section');
        if (sec) {
            sec.style.display = 'block';
            sec.innerHTML = `<div class="diagnostic-container"><div style="color: var(--danger); padding: 20px; text-align: center;">❌ Error al generar el diagnóstico: ${e.message}</div></div>`;
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.querySelector('.toggle-test-label').textContent = 'Diagnóstico IA';
        }
    }
};

// Pre-fetch all confirmed data into a map keyed by vapi_call_id (with cache)
async function fetchConfirmedData(forceRefresh = false) {
    if (!forceRefresh && _confirmedCache && (Date.now() - _confirmedCacheTime) < DATA_CACHE_TTL) {
        // Rebuild map from cache
        _rebuildConfirmedMap(_confirmedCache);
        return _confirmedCache;
    }
    try {
        const res = await fetch(`${API_BASE}/${CONFIRMED_TABLE}/records?limit=500&sort=-CreatedAt`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        const data = await res.json();
        const records = data.list || [];

        _rebuildConfirmedMap(records);
        _confirmedCache = records;
        _confirmedCacheTime = Date.now();
        return records;
    } catch (err) {
        console.error('Error fetching confirmed data:', err);
        return [];
    }
}

function _rebuildConfirmedMap(records) {
    confirmedDataMap = {};
    records.forEach(row => {
        const callId = row['Vapi Call ID'] || row.vapi_call_id || '';
        if (callId) {
            confirmedDataMap[callId] = {
                name: sanitizeName(row['Nombre Confirmado'] || row.lead_name || row.name || '-'),
                rawPhone: row['Teléfono Confirmado'] || row.lead_phone || row.phone || '-',
                email: sanitizeEmail(row['Email Confirmado'] || row.email || '-'),
                appointmentDate: row['Fecha Cita'] || row.call_date || row.appointment_date || null,
                createdAt: row['CreatedAt'] || row.created_at
            };
        }
    });
}

function getAppointmentStatus(dateStr) {
    if (!dateStr) return { label: 'Sin fecha', cls: 'past', icon: '❓' };
    const now = new Date();
    const apptDate = new Date(dateStr);
    if (isNaN(apptDate.getTime())) return { label: 'Sin fecha', cls: 'past', icon: '❓' };
    const madridOpts = { timeZone: 'Europe/Madrid' };
    const todayStr = now.toLocaleDateString('sv-SE', madridOpts);
    const apptDayStr = apptDate.toLocaleDateString('sv-SE', madridOpts);
    if (apptDayStr === todayStr) return { label: 'Hoy', cls: 'today', icon: '📍' };
    if (apptDate > now) return { label: 'Próxima', cls: 'upcoming', icon: '🟢' };
    return { label: 'Pasada', cls: 'past', icon: '✅' };
}

function formatAppointmentDate(dateStr) {
    if (!dateStr) return 'No definida';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'No definida';
    const madridOpts = { timeZone: 'Europe/Madrid' };
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayStr = d.toLocaleDateString('sv-SE', madridOpts);
    const todayStr = now.toLocaleDateString('sv-SE', madridOpts);
    const tomorrowStr = tomorrow.toLocaleDateString('sv-SE', madridOpts);
    const timeStr = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', ...madridOpts });
    if (dayStr === todayStr) return `Hoy ${timeStr}`;
    if (dayStr === tomorrowStr) return `Mañana ${timeStr}`;
    return d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', ...madridOpts }) + ' ' + timeStr;
}

let calendarWeekOffset = 0;

function renderAppointmentCalendar(records) {
    const grid = document.getElementById('appt-calendar-grid');
    const titleEl = document.getElementById('appt-cal-title');
    if (!grid) return;

    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay() + 1 + calendarWeekOffset * 7); // Monday
    startOfWeek.setHours(0, 0, 0, 0);

    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);

    // Title
    const opts = { day: 'numeric', month: 'short' };
    const startLabel = startOfWeek.toLocaleDateString('es-ES', opts);
    const endLabel = endOfWeek.toLocaleDateString('es-ES', opts);
    if (calendarWeekOffset === 0) {
        titleEl.textContent = `Esta semana · ${startLabel} — ${endLabel}`;
    } else if (calendarWeekOffset === 1) {
        titleEl.textContent = `Próx. semana · ${startLabel} — ${endLabel}`;
    } else if (calendarWeekOffset === -1) {
        titleEl.textContent = `Semana pasada · ${startLabel} — ${endLabel}`;
    } else {
        titleEl.textContent = `${startLabel} — ${endLabel}`;
    }

    const dayNames = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    const madridOpts = { timeZone: 'Europe/Madrid' };
    const todayStr = now.toLocaleDateString('sv-SE', madridOpts);

    grid.innerHTML = '';
    for (let i = 0; i < 7; i++) {
        const day = new Date(startOfWeek);
        day.setDate(startOfWeek.getDate() + i);
        const dayStr = day.toLocaleDateString('sv-SE', madridOpts);
        const isToday = dayStr === todayStr;

        // Find appointments for this day
        const dayAppts = (records || []).filter(r => {
            const fd = r['Fecha Cita'] || r.call_date;
            if (!fd) return false;
            const apptDate = new Date(fd);
            if (isNaN(apptDate.getTime())) return false;
            return apptDate.toLocaleDateString('sv-SE', madridOpts) === dayStr;
        });

        const col = document.createElement('div');
        col.className = `appt-day-col${isToday ? ' is-today' : ''}`;
        col.innerHTML = `
            <div class="appt-day-label">${dayNames[i]}</div>
            <div class="appt-day-num">${day.getDate()}</div>
            <div class="appt-day-dots">
                ${dayAppts.slice(0, 3).map(a => {
            const fd = a['Fecha Cita'] || a.call_date;
            const status = getAppointmentStatus(fd);
            const name = (a['Nombre Confirmado'] || a.lead_name || '').split(' ')[0] || '—';
            const time = new Date(fd).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
            return `<div class="appt-day-dot ${status.cls}" title="${a['Nombre Confirmado'] || ''} — ${time}">${time}</div>`;
        }).join('')}
                ${dayAppts.length > 3 ? `<div class="appt-day-count">+${dayAppts.length - 3} más</div>` : ''}
            </div>
        `;
        grid.appendChild(col);
    }
}

function updateAppointmentKPIs(records) {
    const now = new Date();
    const madridOpts = { timeZone: 'Europe/Madrid' };
    const todayStr = now.toLocaleDateString('sv-SE', madridOpts);
    let total = records.length;
    let upcoming = 0, today = 0, past = 0;

    records.forEach(r => {
        const fd = r['Fecha Cita'] || r.call_date;
        if (!fd) { past++; return; }
        const apptDate = new Date(fd);
        if (isNaN(apptDate.getTime())) { past++; return; }
        const apptDayStr = apptDate.toLocaleDateString('sv-SE', madridOpts);
        if (apptDayStr === todayStr) today++;
        else if (apptDate > now) upcoming++;
        else past++;
    });

    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setVal('appt-kpi-total', total);
    setVal('appt-kpi-upcoming', upcoming);
    setVal('appt-kpi-today', today);
    setVal('appt-kpi-past', past);
}

function renderAppointments(records) {
    const tbody = document.getElementById('appointments-table');
    if (!tbody) return;

    updateAppointmentKPIs(records);
    renderAppointmentCalendar(records);

    if (!records || records.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No hay citas registradas. ¡Usa ➕ Nueva Cita o espera a que Carolina agende una!</td></tr>';
        return;
    }

    // Sort: upcoming first, then today, then past (most recent first within each group)
    const now = new Date();
    const sorted = [...records].sort((a, b) => {
        const dateA = new Date(a['Fecha Cita'] || '1970-01-01');
        const dateB = new Date(b['Fecha Cita'] || '1970-01-01');
        const aFuture = dateA >= now ? 1 : 0;
        const bFuture = dateB >= now ? 1 : 0;
        if (aFuture !== bFuture) return bFuture - aFuture; // Future first
        return aFuture ? dateA - dateB : dateB - dateA; // Ascending for future, descending for past
    });

    tbody.innerHTML = '';
    sorted.forEach(row => {
        const tr = document.createElement('tr');
        const fd = row['Fecha Cita'] || row.call_date;
        const status = getAppointmentStatus(fd);
        const callId = row['Vapi Call ID'] || '-';
        const shortCallId = callId;
        const phone = row['Teléfono Confirmado'] || row.lead_phone || '-';
        const phoneCleaned = phone.replace(/\D/g, '');

        tr.innerHTML = `
            <td><span class="appt-status-badge ${status.cls}">${status.icon} ${status.label}</span></td>
            <td><strong>${formatAppointmentDate(fd)}</strong></td>
            <td>${escapeHtml(sanitizeName(row['Nombre Confirmado'] || row.lead_name || '-'))}</td>
            <td class="phone">${phone !== '-' ? `<button class="appt-phone-btn" onclick="window.open('tel:${escapeHtml(phoneCleaned)}')">📞 ${escapeHtml(phone)}</button>` : '-'}</td>
            <td>${escapeHtml(row['Email Confirmado'] || '-')}</td>
            <td><code style="font-family: monospace; color: var(--accent); font-size: 11px;" title="${escapeHtml(callId)}">${escapeHtml(shortCallId)}</code> <button class="copy-id-btn" data-copy-id="${escapeHtml(callId)}" title="Copiar ID completo" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px 4px;opacity:0.6;transition:opacity 0.2s;vertical-align:middle;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">📋</button></td>
            <td>
                <button class="action-btn" onclick="window._viewAppointmentCall('${escapeHtml(callId)}')">👁 Ver</button>
                ${row.calendar_link ? `<a href="${row.calendar_link}" target="_blank" class="action-btn" style="background: rgba(59, 130, 246, 0.1); color: #3b82f6; border-color: rgba(59, 130, 246, 0.2); text-decoration: none;">🗓️ GCal</a>` : ''}
                <button class="action-btn" onclick="window._deleteAppointment('${row.Id}', '${row.calendar_event_id || ''}')" style="background: rgba(239, 68, 68, 0.1); color: #ef4444; border-color: rgba(239, 68, 68, 0.2); margin-left: 4px;">🗑️ Borrar</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// Global helper for appointment actions
window._viewAppointmentCall = (vapiCallId) => {
    const call = allCalls.find(c => c.vapi_call_id === vapiCallId);
    if (call) {
        openDetailDirect(call);
    } else {
        alert('Llamada original no encontrada en el historial reciente.');
    }
};

window._deleteAppointment = async (recordId, eventId) => {
    if (!confirm('¿Seguro que quieres borrar esta cita? Esto la eliminará de NocoDB y de Google Calendar si estaba vinculada.')) return;
    
    try {
        // Step 1: Call n8n to delete Calendar Event (Fire and forget, or await)
        if (eventId) {
            await fetch(`https://optima-n8n.vhsxer.easypanel.host/webhook/delete-appointment?eventId=${eventId}`, { method: 'DELETE' })
                .catch(err => console.warn('GCal delete webhook warned:', err));
        }

        // Step 2: Delete from NocoDB
        const res = await fetch(`${API_BASE}/${CONFIRMED_TABLE}/records`, {
            method: 'DELETE',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify([recordId])
        });
        
        if (!res.ok) throw new Error('Error al borrar cita en la base de datos');
        
        loadAppointments();
    } catch (err) {
        alert('Error: ' + err.message);
    }
};

async function loadAppointments() {
    const tbody = document.getElementById('appointments-table');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="loading">Cargando citas...</td></tr>';

    const records = await fetchConfirmedData();
    renderAppointments(records);
}

// Manual appointment creation
async function saveManualAppointment() {
    const datetime = document.getElementById('new-appt-datetime')?.value;
    const name = document.getElementById('new-appt-name')?.value?.trim();
    const phone = document.getElementById('new-appt-phone')?.value?.trim();
    const email = document.getElementById('new-appt-email')?.value?.trim();
    const feedback = document.getElementById('new-appt-feedback');
    const btn = document.getElementById('save-new-appointment-btn');

    if (!datetime || !name || !phone) {
        if (feedback) { feedback.style.color = 'var(--danger)'; feedback.textContent = '⚠️ Rellena fecha, nombre y teléfono.'; }
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = '⏳ Guardando...'; }
    if (feedback) { feedback.style.color = 'var(--accent)'; feedback.textContent = 'Guardando en NocoDB...'; }

    try {
        const isoDate = new Date(datetime).toISOString();
        const res = await fetch(`${API_BASE}/${CONFIRMED_TABLE}/records`, {
            method: 'POST',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                'Nombre Confirmado': name,
                'Teléfono Confirmado': phone,
                'Email Confirmado': email || '',
                'Fecha Cita': isoDate,
                'call_date': isoDate,
                'lead_name': name,
                'lead_phone': phone,
                'Vapi Call ID': 'manual_' + Date.now()
            })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        if (feedback) { feedback.style.color = 'var(--success)'; feedback.textContent = '✅ ¡Cita creada correctamente!'; }

        // Reset form
        document.getElementById('new-appt-datetime').value = '';
        document.getElementById('new-appt-name').value = '';
        document.getElementById('new-appt-phone').value = '';
        document.getElementById('new-appt-email').value = '';

        // Close modal after a short delay and refresh
        setTimeout(() => {
            document.getElementById('new-appointment-modal').style.display = 'none';
            if (feedback) feedback.textContent = '';
            loadAppointments();
        }, 1200);
    } catch (err) {
        console.error('Error saving appointment:', err);
        if (feedback) { feedback.style.color = 'var(--danger)'; feedback.textContent = `❌ Error: ${err.message}`; }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar Cita'; }
    }
}

// ── Call Disposition Classification ──
// Classifies the commercial outcome of a call based on transcript content
function classifyCallDisposition(call, transcriptText) {
    const evalLower = (call.evaluation || '').toLowerCase();
    const reasonLower = (call.ended_reason || '').toLowerCase();
    const duration = parseInt(call.duration_seconds) || 0;
    const isConf = confirmedDataMap[call.vapi_call_id];

    // 1. Direct mappings from technical signals
    if (isConf) return 'Cita Agendada';

    if (evalLower.includes('error') || evalLower.includes('fallida') ||
        reasonLower.includes('error') || reasonLower.includes('fail') ||
        reasonLower.includes('sip') || reasonLower.includes('transport')) {
        return 'Error Técnico';
    }

    if (evalLower.includes('no contesta') || evalLower.includes('contestador') ||
        evalLower.includes('voicemail') || evalLower.includes('buzón') ||
        evalLower.includes('máquina') || evalLower.includes('no disponible') ||
        evalLower.includes('ocupado') || evalLower.includes('sin respuesta') ||
        reasonLower.includes('no contesta') || reasonLower.includes('voicemail') ||
        reasonLower.includes('machine') || reasonLower.includes('busy')) {
        return 'No Contactado';
    }

    // 2. No transcript or too short → insufficient data
    if (!transcriptText || transcriptText.trim().length < 30) {
        return duration < 10 ? 'No Contactado' : 'Datos Insuficientes';
    }

    // 3. Analyze transcript — focus on last client turns
    const text = transcriptText.toLowerCase();
    const lines = text.split('\n').filter(l => l.trim());

    // Extract client lines (lines containing "user:" or "cliente:" or lines not starting with "ai:" / "bot:" / "assistant:")
    const clientLines = lines.filter(l => {
        const trimmed = l.trim();
        return trimmed.startsWith('user:') || trimmed.startsWith('cliente:') ||
               (!trimmed.startsWith('ai:') && !trimmed.startsWith('bot:') && !trimmed.startsWith('assistant:'));
    });

    // Focus on the last 3 client turns for final intent
    const lastClientTurns = clientLines.slice(-3).join(' ');
    const allClientText = clientLines.join(' ');

    // Keywords for Cita Agendada (strongest signal)
    const citaPatterns = [
        'quedo a las', 'nos vemos', 'perfecto.*cita', 'cita.*confirmada',
        'apunta.*cita', 'agendar', 'visita.*técnica', 'paso por',
        'mañana a las', 'el lunes', 'el martes', 'el miércoles', 'el jueves', 'el viernes',
        'queda confirmad'
    ];
    if (citaPatterns.some(p => new RegExp(p).test(lastClientTurns)) ||
        citaPatterns.some(p => new RegExp(p).test(allClientText))) {
        return 'Cita Agendada';
    }

    // Keywords for No Interesado
    const noInteresPatterns = [
        'no me interesa', 'no estoy interesad', 'no quiero', 'no gracias',
        'quita mi número', 'no me llam', 'borr.*datos', 'lista robinson',
        'no necesito', 'ya tengo', 'no no no', 'déjame en paz',
        'no vuelvas a llamar', 'no quiero saber nada', 'no estamos interesad',
        'no nos interesa', 'no te preocupes.*no'
    ];
    if (noInteresPatterns.some(p => new RegExp(p).test(lastClientTurns))) {
        return 'No Interesado';
    }

    // Keywords for Llamar Otro Momento
    const otroMomentoPatterns = [
        'llam.*más tarde', 'llám.*otro', 'ahora no puedo', 'estoy ocupad',
        'estoy trabajando', 'otro momento', 'en otro momento', 'ahora mismo no',
        'llama.*luego', 'más tarde', 'no es buen momento', 'estoy liado',
        'llama mañana', 'llama.*semana', 'estoy conduciendo', 'estoy en una reunión',
        'puedes llamar.*después', 'me llama.*tarde', 'me pilla mal'
    ];
    if (otroMomentoPatterns.some(p => new RegExp(p).test(lastClientTurns))) {
        return 'Llamar Otro Momento';
    }

    // Keywords for Interesado
    const interesadoPatterns = [
        'sí.*interes', 'me interesa', 'cuéntame más', 'dime más',
        'quiero saber', 'está bien', 'de acuerdo', 'vale.*sí',
        'suena bien', 'cuánto.*ahorr', 'qué.*precio', 'me gustaría',
        'claro.*sí', 'por supuesto', 'sí.*quiero', 'adelante',
        'envíame información', 'mándame', 'pásate', 'cuánto cuesta',
        'cómo funciona', 'qué.*oferta'
    ];
    if (interesadoPatterns.some(p => new RegExp(p).test(lastClientTurns))) {
        return 'Interesado';
    }

    // Check broader context for No Interesado (entire conversation)
    if (noInteresPatterns.some(p => new RegExp(p).test(allClientText))) {
        return 'No Interesado';
    }

    // Check broader context for Llamar Otro Momento
    if (otroMomentoPatterns.some(p => new RegExp(p).test(allClientText))) {
        return 'Llamar Otro Momento';
    }

    // Fallback: if call was "Completada" with decent duration, mark as Interesado (they engaged)
    if ((evalLower.includes('completada') || evalLower.includes('confirmada')) && duration > 45) {
        return 'Interesado';
    }

    // If "Colgó rápido" → likely not interested
    if (evalLower.includes('colgó rápido')) {
        return 'No Interesado';
    }

    return 'Datos Insuficientes';
}

// Get disposition display props
function getDispositionProps(disposition) {
    const map = {
        'Interesado':           { icon: '🟢', cls: 'disposition-interesado', color: '#22c55e' },
        'Cita Agendada':        { icon: '📅', cls: 'disposition-cita', color: '#f59e0b' },
        'No Interesado':        { icon: '🔴', cls: 'disposition-no-interesado', color: '#ef4444' },
        'Llamar Otro Momento':  { icon: '🕐', cls: 'disposition-callback', color: '#3b82f6' },
        'No Contactado':        { icon: '⚪', cls: 'disposition-no-contacto', color: '#64748b' },
        'Datos Insuficientes':  { icon: '🟡', cls: 'disposition-insuficiente', color: '#eab308' },
        'Error Técnico':        { icon: '⚠️', cls: 'disposition-error', color: '#f97316' }
    };
    return map[disposition] || { icon: '❓', cls: 'disposition-unknown', color: '#94a3b8' };
}

// Enrich calls with missing data from Vapi API
async function enrichCallsFromVapi(calls) {
    // Only enrich calls that still look un-processed (Call Initiated or no evaluation)
    const callsToEnrich = calls.filter(c =>
        c.vapi_call_id && c.vapi_call_id.startsWith('019') &&
        (!c.evaluation || c.evaluation === 'Pendiente' ||
            c.ended_reason === 'Call Initiated' || c.ended_reason === 'call_initiated')
    ).slice(0, 5); // Process up to 5 per cycle (was 15 — reduced to avoid 429s)

    if (callsToEnrich.length === 0) return false;

    // Map Vapi endedReason to user-friendly Spanish labels
    function mapEndedReason(reason) {
        if (!reason) return 'Desconocido';
        const r = reason.toLowerCase();
        if (r.includes('sip') && r.includes('480')) return 'No disponible (apagado)';
        if (r.includes('sip') && r.includes('failed') && !r.includes('503')) return 'Sin conexión (SIP)';
        if (r.includes('sip') && r.includes('busy')) return 'Línea ocupada';
        if (r.includes('sip') && r.includes('503')) return 'Servicio no disponible';
        if (r === 'customer-busy') return 'Línea ocupada';
        if (r === 'customer-ended-call') return 'Cliente colgó';
        if (r === 'assistant-ended-call') return 'Asistente finalizó';
        if (r === 'silence-timed-out') return 'Sin respuesta (silencio)';
        if (r === 'voicemail') return 'Contestador automático';
        if (r === 'machine_detected') return 'Máquina detectada';
        if (r === 'assistant-error') return 'Error del asistente';
        if (r.includes('no-answer') || r.includes('noanswer') || r === 'customer-did-not-answer') return 'No contesta';
        if (r.includes('transport')) return 'Error de conexión';
        if (r.includes('error')) return 'Error: ' + reason.split('.').pop();
        return reason; // fallback: show raw reason
    }

    let updated = false;
    for (const call of callsToEnrich) {
        try {
            const vapiData = await fetchVapiCall(call.vapi_call_id, { skipCache: true });
            if (!vapiData) {
                logApiError({ url: `${VAPI_API_BASE}/call/${call.vapi_call_id}`, method: 'GET', status: 'error', statusText: 'null response', context: 'enrichCallsFromVapi', detail: `callId=${call.vapi_call_id}` });
                break; // Stop immediately to avoid spamming the rate-limited API
            }

            // If call has a failed status, mark as Error
            if (vapiData.status === 'failed') {
                const failReason = vapiData.endedReason || 'Error desconocido';
                call.evaluation = 'Error';
                call.ended_reason = mapEndedReason(failReason);
                call.duration_seconds = 0;
                call.call_disposition = 'Error Técnico';
                await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
                    method: 'PATCH',
                    headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                    body: JSON.stringify([{ Id: call.id || call.Id, evaluation: 'Error', ended_reason: mapEndedReason(failReason), duration_seconds: 0, call_disposition: 'Error Técnico' }])
                }).catch(err => console.warn('Failed to update failed call log:', err));
                updated = true;
                await new Promise(r => setTimeout(r, 400));
                continue;
            }

            if (vapiData.status !== 'ended') {
                const ageMinutes = (Date.now() - new Date(call.call_time || call.CreatedAt).getTime()) / 60000;
                if (ageMinutes > 30) {
                    call.evaluation = 'Error';
                    call.ended_reason = 'Atascado en Vapi';
                    call.call_disposition = 'Error Técnico';
                    await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
                        method: 'PATCH',
                        headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                        body: JSON.stringify([{ Id: call.id || call.Id, evaluation: 'Error', ended_reason: 'Atascado en Vapi', call_disposition: 'Error Técnico' }])
                    });
                    updated = true;
                }
                continue; // Call still in progress
            }

            // Calculate duration from messages or timestamps
            let duration = 0;
            const msgs = vapiData.artifact?.messages || [];
            if (msgs.length > 0) {
                duration = Math.round(msgs[msgs.length - 1].secondsFromStart || 0);
            } else if (vapiData.startedAt && vapiData.endedAt) {
                duration = Math.round((new Date(vapiData.endedAt) - new Date(vapiData.startedAt)) / 1000);
            }

            // Determine evaluation based on endedReason and call data
            const isConf = confirmedDataMap[call.vapi_call_id];
            const reason = vapiData.endedReason || '';
            const reasonLower = reason.toLowerCase();
            let evaluation = 'Sin datos';

            // Detect IVR/answering machine by transcript patterns
            const transcriptText = (vapiData.artifact?.transcript || '').toLowerCase();
            const ivrPatterns = ['pulse 1', 'pulse 2', 'marque 1', 'marque 2',
                'espere un momento', 'gracias por llamar',
                'horario de atención', 'fuera de horario',
                'deje su mensaje', 'buzón de voz', 'no disponible',
                'nuestro horario', 'de lunes a', 'extensión'];
            const ivrMatchCount = ivrPatterns.filter(p => transcriptText.includes(p)).length;
            const isIVR = ivrMatchCount >= 2;

            if (isConf) {
                evaluation = 'Confirmada ✓';
            } else if (reasonLower.includes('sip') && (reasonLower.includes('failed') || reasonLower.includes('error'))) {
                // Differentiate SIP 480 (phone unreachable) from SIP 503 (trunk error)
                if (reasonLower.includes('failed-to-connect') || reasonLower.includes('480')) {
                    evaluation = 'No disponible';
                } else {
                    evaluation = 'Fallida';
                }
            } else if (reason === 'customer-busy') {
                evaluation = 'Ocupado';
            } else if (reason === 'customer-did-not-answer') {
                evaluation = 'No contesta';
            } else if (reasonLower.includes('transport')) {
                evaluation = 'Fallida';
            } else if (isIVR || reason === 'voicemail' || reason === 'machine_detected' || (vapiData.analysis?.successEvaluation || '').toLowerCase().includes('contestador')) {
                evaluation = 'Contestador';
            } else if (reason === 'silence-timed-out') {
                evaluation = duration > 10 ? 'Sin respuesta' : 'No contesta';
            } else if (duration > 0 && duration < 10) {
                evaluation = 'No contesta';
            } else if (reason === 'customer-ended-call' && duration > 30) {
                evaluation = 'Completada';
            } else if (reason === 'assistant-ended-call' && duration > 30) {
                evaluation = 'Completada';
            } else if (reason === 'customer-ended-call' && duration <= 30) {
                evaluation = 'Colgó rápido';
            } else if (reason === 'assistant-error') {
                evaluation = 'Error';
            } else if (duration > 0) {
                evaluation = 'Completada';
            }

            // Build human-readable ended_reason
            const isTestCall = (call.ended_reason || '').includes('Manual Trigger') || call.is_test === true || call.is_test === 1;
            const endedReason = mapEndedReason(vapiData.endedReason);

            // Update local data
            call.duration_seconds = duration;
            call.evaluation = evaluation;
            call.ended_reason = endedReason;
            call.transcript = vapiData.artifact?.transcript || call.transcript;
            call.recording_url = vapiData.artifact?.recordingUrl || call.recording_url;

            // Classify disposition based on transcript content
            const disposition = classifyCallDisposition(call, vapiData.artifact?.transcript || call.transcript || '');
            call.call_disposition = disposition;

            // Update NocoDB in background
            const updateData = {
                Id: call.id || call.Id,
                duration_seconds: duration,
                evaluation: evaluation,
                ended_reason: endedReason,
                call_disposition: disposition
            };
            if (isTestCall) {
                updateData.is_test = true;
            }
            if (vapiData.artifact?.transcript) {
                updateData.transcript = vapiData.artifact.transcript.substring(0, 5000);
            }
            if (vapiData.artifact?.recordingUrl) {
                updateData.recording_url = vapiData.artifact.recordingUrl;
            }

            await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
                method: 'PATCH',
                headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify([updateData])
            }).catch(err => console.warn('Failed to update call log:', err));

            updated = true;

            // Wait 400ms between calls to avoid 429
            await new Promise(r => setTimeout(r, 400));
        } catch (err) {
            console.warn('Error enriching call', call.vapi_call_id, err);
        }
    }
    return updated;
}

function renderChart(calls) {
    const ctx = document.getElementById('callsChart').getContext('2d');

    // Process data for the last 7 days or matching the filter
    const last7Days = [...Array(7)].map((_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - i);
        return d.toISOString().split('T')[0];
    }).reverse();

    const statsByDate = last7Days.reduce((acc, date) => {
        acc[date] = { total: 0, success: 0 };
        return acc;
    }, {});

    calls.forEach(call => {
        const date = new Date(call.call_time || call.CreatedAt).toISOString().split('T')[0];
        if (statsByDate[date]) {
            statsByDate[date].total++;
            if (getBadgeClass(call.evaluation) === 'success') {
                statsByDate[date].success++;
            }
        }
    });

    const labels = Object.keys(statsByDate).map(d => d.split('-').slice(1).reverse().join('/'));
    const totalData = Object.values(statsByDate).map(s => s.total);
    const successData = Object.values(statsByDate).map(s => s.success);

    if (callsChart) {
        callsChart.destroy();
    }

    callsChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Total Llamadas',
                    data: totalData,
                    borderColor: '#6366f1',
                    backgroundColor: 'rgba(99, 102, 241, 0.1)',
                    fill: true,
                    tension: 0.4,
                    borderWidth: 3,
                    pointRadius: 4,
                    pointBackgroundColor: '#6366f1'
                },
                {
                    label: 'Éxitos',
                    data: successData,
                    borderColor: '#10b981',
                    backgroundColor: 'transparent',
                    fill: false,
                    tension: 0.4,
                    borderWidth: 3,
                    pointRadius: 4,
                    pointBackgroundColor: '#10b981'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    labels: { color: '#94a3b8', font: { family: 'Inter', size: 12 } }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 15, 20, 0.9)',
                    titleColor: '#fff',
                    bodyColor: '#94a3b8',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: true
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#94a3b8', stepSize: 1 }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8' }
                }
            }
        }
    });
}

function renderDashboard(calls) {
    currentCallsPage = calls;

    // Stats
    const totalCalls = calls.length;
    const successCalls = calls.filter(c => getBadgeClass(c.evaluation) === 'success').length;
    const successRate = totalCalls > 0 ? Math.round((successCalls / totalCalls) * 100) : 0;
    const totalDuration = calls.reduce((sum, c) => sum + (parseInt(c.duration_seconds) || 0), 0);
    const avgDuration = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;

    document.getElementById('total-calls').textContent = totalCalls;
    document.getElementById('success-rate').textContent = successRate + '%';
    document.getElementById('avg-duration').textContent = formatDuration(avgDuration);

    // Table
    const tbody = document.getElementById('call-table');
    if (calls.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No hay llamadas para el periodo seleccionado</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    calls.forEach((call, index) => {
        const tr = document.createElement('tr');
        const vapiId = call.vapi_call_id || call.lead_id || call.id || call.Id || '-';
        const shortId = vapiId;

        const isSyncing = !call.ended_reason || call.ended_reason === 'Call Initiated' || call.ended_reason.toLowerCase().includes('in progress');
        const statusText = isSyncing ? '<span class="loading" style="font-size: 11px; color: var(--accent);">⏳ Sincronizando...</span>' : formatStatus(call.ended_reason);

        // Preview notes
        const notePreview = call.notes || call.Notes ? `<span class="badge" style="background: rgba(99, 102, 241, 0.1); color: var(--accent); white-space: normal; line-height: 1.2; text-align: left;">${(call.notes || call.Notes).substring(0, 30)}${(call.notes || call.Notes).length > 30 ? '...' : ''}</span>` : '-';

        tr.innerHTML = `
            <td>
                <button class="action-btn" data-index="${index}">👁 Ver Detalle</button>
            </td>
            <td><code style="font-family: monospace; color: var(--accent); font-size: 11px;" title="${vapiId}">${shortId}</code> <button class="copy-id-btn" data-copy-id="${vapiId}" title="Copiar ID completo" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px 4px;opacity:0.6;transition:opacity 0.2s;vertical-align:middle;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">📋</button></td>
            <td><strong>${call.lead_name || '-'}</strong></td>
            <td class="phone">${call.phone_called || '-'}</td>
            <td>${formatDate(call.call_time || call.CreatedAt)}</td>
            <td>${statusText}</td>
            <td><span class="badge ${getBadgeClass(call.evaluation)}">${call.evaluation || 'Pendiente'}</span></td>
            <td>${formatDuration(call.duration_seconds)}</td>
            <td class="table-notes">${notePreview}</td>
        `;
        tbody.appendChild(tr);
    });

    updateChart(calls);
}

function applyFilters() {
    const rawRange = document.getElementById('date-range');
    const dateRange = rawRange ? rawRange.value : '';

    let filtered = allCalls;

    if (dateRange && dateRange.includes(' a ')) {
        const [startStr, endStr] = dateRange.split(' a ');
        const start = new Date(startStr);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endStr);
        end.setHours(23, 59, 59, 999);
        
        filtered = filtered.filter(c => {
            const callDate = new Date(c.CreatedAt || c.call_time);
            return callDate >= start && callDate <= end;
        });
    }

    renderDashboard(filtered);
}

async function openDetailDirect(call) {

    if (!call) return;

    // Show Modal FIRST so user sees it immediately even if content takes time to load
    document.getElementById('detail-modal').style.display = 'flex';

    activeDetailCall = call;

    const vapiId = call.vapi_call_id || call.lead_id || call.id || call.Id;

    try {
        document.getElementById('modal-title').textContent = call.lead_name || 'Llamada';
        document.getElementById('modal-subtitle').textContent = `${call.phone_called || ''} • ${formatDate(call.call_time || call.CreatedAt)}`;

        const transcriptEl = document.getElementById('modal-transcript');
        const audioSec = document.getElementById('recording-section');
        const audio = document.getElementById('modal-audio');

        transcriptEl.innerHTML = '<span class="loading-pulse">⌛ Obteniendo transcripción en tiempo real desde Vapi...</span>';
        audioSec.style.display = 'none';

        // Populate original lead data (async, non-blocking)
        populateOriginalLeadData(call);

        // Reset extraction and error sections (consistent with openDetail)
        const extractionTools = document.getElementById('extraction-tools');
        const extractionResults = document.getElementById('extraction-results');
        const errorSec = document.getElementById('error-section');
        if (extractionTools) extractionTools.style.display = 'none';
        if (extractionResults) extractionResults.style.display = 'none';
        if (errorSec) errorSec.style.display = 'none';
        const diagSec = document.getElementById('diagnostic-section');
        if (diagSec) { diagSec.style.display = 'none'; diagSec.innerHTML = ''; }

        document.getElementById('modal-notes').value = call.Notes || '';
        document.getElementById('save-notes-btn').setAttribute('data-id', call.id || call.Id);

        // Update test toggle button state in modal
        const testToggleBtn = document.getElementById('toggle-test-btn');
        const isCurrentlyTest = call.is_test === true || call.is_test === 1 || (call.ended_reason || '').includes('Manual Trigger') || (call.lead_name || '').toLowerCase() === 'test manual';
        if (testToggleBtn) {
            testToggleBtn.className = isCurrentlyTest ? 'toggle-test-pill active' : 'toggle-test-pill';
            testToggleBtn.querySelector('.toggle-test-label').textContent = isCurrentlyTest ? '✅ Marcada como Test' : 'Marcar como Test';
        }
        // Wire up the toggle handler for this specific call
        window._toggleDetailTest = async () => {
            const callId = call.id || call.Id;
            const newTestState = !(call.is_test === true || call.is_test === 1);
            await toggleTestStatus(callId, newTestState);
            closeModal();
        };
        // Wire up the retry handler for this specific call
        window._retryCall = async () => {
            const retryFeedback = document.getElementById('retry-feedback');
            if (retryFeedback) {
                retryFeedback.style.display = 'block';
                retryFeedback.textContent = '⏳ Preparando rellamada...';
                retryFeedback.style.color = 'var(--accent)';
            }
        };

        const confirmedSec = document.getElementById('confirmed-section');
        if (confirmedSec) confirmedSec.style.display = 'none';

        // ── Render Score Gauge ──
        const scoreSec = document.getElementById('score-section');
        if (scoreSec) {
            const scoreResult = call._scoreBreakdown ? { total: call._score, breakdown: call._scoreBreakdown } : calculateCallScore(call);
            const label = getScoreLabel(scoreResult.total);
            const color = getScoreColor(scoreResult.total);
            const bd = scoreResult.breakdown;
            const dims = [
                { name: 'Duración', val: bd.duration, max: 20, icon: '⏱️' },
                { name: 'Evaluación', val: bd.evaluation, max: 25, icon: '📊' },
                { name: 'Datos Confirmados', val: bd.confirmed, max: 15, icon: '✅' },
                { name: 'Motivo Fin', val: bd.endReason, max: 10, icon: '🔚' },
                { name: 'Transcripción', val: bd.transcript, max: 5, icon: '📝' },
                { name: 'Agendamiento', val: bd.appointment, max: 25, icon: '🗓️' }
            ];
            scoreSec.style.display = 'block';
            scoreSec.innerHTML = `
                <div class="section-title">🏆 Score de Calidad</div>
                <div class="score-gauge-container">
                    <div class="score-gauge-ring" style="--score-pct: ${scoreResult.total}%; --score-clr: ${color}">
                        <div class="score-gauge-inner">
                            <span class="score-gauge-value" style="color: ${color}">${scoreResult.total}</span>
                            <span class="score-gauge-label">${label.emoji} ${label.text}</span>
                        </div>
                    </div>
                    <div class="score-breakdown">
                        ${dims.map(d => `
                            <div class="score-dim">
                                <div class="score-dim-header">
                                    <span>${d.icon} ${d.name}</span>
                                    <span class="score-dim-val">${d.val}/${d.max}</span>
                                </div>
                                <div class="score-dim-bar">
                                    <div class="score-dim-fill" style="width: ${(d.val / d.max) * 100}%; background: ${getScoreColor((d.val / d.max) * 100)}"></div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        // ── Render Disposition ──
        const dispSec = document.getElementById('disposition-section') || (() => {
            const div = document.createElement('div');
            div.id = 'disposition-section';
            div.className = 'disposition-section';
            if (scoreSec) scoreSec.after(div);
            return div;
        })();
        if (dispSec) {
            const disp = call.call_disposition || classifyCallDisposition(call, call.transcript || '');
            const dp = getDispositionProps(disp);
            dispSec.style.display = 'flex';
            dispSec.innerHTML = `
                <span class="disposition-label">📋 Disposición:</span>
                <span class="badge disposition-badge ${dp.cls}">${dp.icon} ${disp}</span>
            `;
        }

        // Show error section if applicable
        const isErrorState = call.evaluation === 'Error' || call.evaluation === 'Fallida' || call.ended_reason?.includes('Error') || call.ended_reason?.includes('fail');
        if (isErrorState) {
            if (errorSec) {
                errorSec.style.display = 'block';
                document.getElementById('modal-error-detail').textContent = call.ended_reason;
            }
        }

        // Show confirmed data if applicable
        if (isConfirmed(call)) {
            const confData = confirmedDataMap[call.vapi_call_id];
            if (confData && confirmedSec) {
                confirmedSec.style.display = 'block';
                document.getElementById('conf-name').textContent = confData.name;
                document.getElementById('conf-phone').textContent = sanitizePhone(confData.rawPhone, call.phone_called);
                document.getElementById('conf-email').textContent = confData.email;
            }
        }

        // Show extraction tools
        if (extractionTools) extractionTools.style.display = 'block';
        if (extractionResults) extractionResults.style.display = 'none';

        // Fetch Vapi data
        if (vapiId && vapiId.startsWith('019')) {
            try {
                const vapi = await fetchVapiCall(vapiId);
                if (vapi) {
                    const transcript = vapi.artifact?.transcript || vapi.transcript || '';
                    const formattedTranscript = formatTranscriptHTML(transcript);
                    transcriptEl.innerHTML = formattedTranscript
                        ? formattedTranscript
                        : '<span style="color:var(--text-secondary)">Sin transcripción disponible</span>';

                    const recordingUrl = vapi.artifact?.recordingUrl || vapi.recordingUrl;
                    if (recordingUrl) {
                        audioSec.style.display = 'block';
                        audio.src = recordingUrl;
                    }
                } else {
                    transcriptEl.innerHTML = '<span style="color:var(--text-secondary)">No se pudo obtener la transcripción</span>';
                }
            } catch (e) {
                transcriptEl.innerHTML = '<span style="color:var(--danger)">Error al conectar con Vapi</span>';
            }
        } else {
            transcriptEl.innerHTML = '<span style="color:var(--text-secondary)">Sin ID de Vapi</span>';
        }
    } catch (err) {
        console.error('[openDetailDirect] Error populating modal:', err);
    }
}

async function openDetail(index) {
    const call = currentCallsPage[index];
    if (!call) return;
    activeDetailCall = call;

    const vapiId = call.vapi_call_id || call.lead_id || call.id || call.Id;

    document.getElementById('modal-title').textContent = call.lead_name || 'Llamada';
    document.getElementById('modal-subtitle').textContent = `${call.phone_called} • ${formatDate(call.call_time || call.CreatedAt)}`;

    // Set loading state for Vapi data
    const transcriptEl = document.getElementById('modal-transcript');
    const audioSec = document.getElementById('recording-section');
    const audio = document.getElementById('modal-audio');

    transcriptEl.innerHTML = '<span class="loading-pulse">⌛ Obteniendo transcripción en tiempo real desde Vapi...</span>';
    audioSec.style.display = 'none';

    // Populate original lead data (async, non-blocking)
    populateOriginalLeadData(call);

    document.getElementById('modal-notes').value = call.Notes || '';
    document.getElementById('save-notes-btn').setAttribute('data-id', call.id || call.Id);

    // Update test toggle button state in modal
    const testToggleBtn = document.getElementById('toggle-test-btn');
    const isCurrentlyTest = call.is_test === true || call.is_test === 1 || (call.ended_reason || '').includes('Manual Trigger') || (call.lead_name || '').toLowerCase() === 'test manual';
    if (testToggleBtn) {
        testToggleBtn.className = isCurrentlyTest ? 'toggle-test-pill active' : 'toggle-test-pill';
        testToggleBtn.querySelector('.toggle-test-label').textContent = isCurrentlyTest ? '✅ Marcada como Test' : 'Marcar como Test';
    }
    // Wire up the toggle handler for this specific call
    window._toggleDetailTest = async () => {
        const callId = call.id || call.Id;
        const newTestState = !(call.is_test === true || call.is_test === 1);
        await toggleTestStatus(callId, newTestState);
        closeModal();
    };
    const confirmedSec = document.getElementById('confirmed-section');
    if (confirmedSec) confirmedSec.style.display = 'none';

    // ── Render Score Gauge ──
    const scoreSec = document.getElementById('score-section');
    if (scoreSec) {
        const scoreResult = call._scoreBreakdown ? { total: call._score, breakdown: call._scoreBreakdown } : calculateCallScore(call);
        const label = getScoreLabel(scoreResult.total);
        const color = getScoreColor(scoreResult.total);
        const bd = scoreResult.breakdown;
        const dims = [
            { name: 'Duración', val: bd.duration, max: 20, icon: '⏱️' },
            { name: 'Evaluación', val: bd.evaluation, max: 25, icon: '📊' },
            { name: 'Datos Confirmados', val: bd.confirmed, max: 15, icon: '✅' },
            { name: 'Motivo Fin', val: bd.endReason, max: 10, icon: '🔚' },
            { name: 'Transcripción', val: bd.transcript, max: 5, icon: '📝' },
            { name: 'Agendamiento', val: bd.appointment, max: 25, icon: '🗓️' }
        ];
        scoreSec.style.display = 'block';
        scoreSec.innerHTML = `
            <div class="section-title">🏆 Score de Calidad</div>
            <div class="score-gauge-container">
                <div class="score-gauge-ring" style="--score-pct: ${scoreResult.total}%; --score-clr: ${color}">
                    <div class="score-gauge-inner">
                        <span class="score-gauge-value" style="color: ${color}">${scoreResult.total}</span>
                        <span class="score-gauge-label">${label.emoji} ${label.text}</span>
                    </div>
                </div>
                <div class="score-breakdown">
                    ${dims.map(d => `
                        <div class="score-dim">
                            <div class="score-dim-header">
                                <span>${d.icon} ${d.name}</span>
                                <span class="score-dim-val">${d.val}/${d.max}</span>
                            </div>
                            <div class="score-dim-bar">
                                <div class="score-dim-fill" style="width: ${(d.val / d.max) * 100}%; background: ${getScoreColor((d.val / d.max) * 100)}"></div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Show Modal early so user sees loading state
    document.getElementById('detail-modal').style.display = 'flex';

    // 1. Fetch Real-time data from Vapi
    if (vapiId && vapiId.startsWith('019')) { // Vapi IDs usually start with 019
        try {
            const vapiData = await fetchVapiCall(vapiId);

            if (vapiData) {
                const rawTranscript = vapiData.artifact?.transcript || vapiData.transcript || call.transcript || '';
                const formattedTranscript = formatTranscriptHTML(rawTranscript);
                transcriptEl.innerHTML = formattedTranscript
                    ? formattedTranscript
                    : '<span style="color:var(--text-secondary)">No hay transcripción disponible en Vapi ni en local.</span>';

                const recUrl = call.recording_url || vapiData.artifact?.recordingUrl || vapiData.recordingUrl;
                if (recUrl) {
                    audioSec.style.display = 'block';
                    audio.src = recUrl;
                }

                // Show extraction tools if transcript exists
                if (rawTranscript) {
                    document.getElementById('extraction-tools').style.display = 'block';
                    document.getElementById('extraction-results').style.display = 'none';
                }
            } else {
                console.warn('Vapi API error, fallback to local transcript');
                const fallbackFormatted = formatTranscriptHTML(call.transcript || '');
                transcriptEl.innerHTML = fallbackFormatted || '<span style="color:var(--text-secondary)">No hay transcripción disponible (error API Vapi).</span>';
                if (call.recording_url) {
                    audioSec.style.display = 'block';
                    audio.src = call.recording_url;
                }
            }
        } catch (err) {
            console.error('Error fetching Vapi detail:', err);
            const fallbackFormatted = formatTranscriptHTML(call.transcript || '');
            transcriptEl.innerHTML = fallbackFormatted || '<span style="color:var(--text-secondary)">No hay transcripción disponible (error de conexión).</span>';
            if (call.recording_url) {
                audioSec.style.display = 'block';
                audio.src = call.recording_url;
            }
        }
    } else {
        // Fallback to local data if no valid Vapi ID
        const fallbackFormatted = formatTranscriptHTML(call.transcript || '');
        transcriptEl.innerHTML = fallbackFormatted || '<span style="color:var(--text-secondary)">No hay transcripción disponible.</span>';
        if (call.recording_url) {
            audioSec.style.display = 'block';
            audio.src = call.recording_url;
        }
    }

    // Always show extraction tools (user can extract from transcript OR from notes)
    document.getElementById('extraction-tools').style.display = 'block';
    document.getElementById('extraction-results').style.display = 'none';

    // 2. Show Confirmed Data if applicable (use pre-fetched map first, fallback to API)
    if (isConfirmed(call)) {
        const confData = confirmedDataMap[call.vapi_call_id];
        if (confData && confirmedSec) {
            confirmedSec.style.display = 'block';
            document.getElementById('conf-name').textContent = confData.name;
            document.getElementById('conf-phone').textContent = sanitizePhone(confData.rawPhone, call.phone_called);
            document.getElementById('conf-email').textContent = confData.email;
        } else {
            // Fallback: fetch from API if not in map
            try {
                const query = `(vapi_call_id,eq,${encodeURIComponent(call.vapi_call_id)})`;
                const res = await fetch(`${API_BASE}/${CONFIRMED_TABLE}/records?where=${query}`, {
                    headers: { 'xc-token': XC_TOKEN }
                });
                const data = await res.json();
                const confirmed = data.list ? data.list[0] : null;

                if (confirmed && confirmedSec) {
                    confirmedSec.style.display = 'block';
                    document.getElementById('conf-name').textContent = confirmed.name || '-';
                    document.getElementById('conf-phone').textContent = confirmed.phone || '-';
                    document.getElementById('conf-email').textContent = confirmed.email || '-';
                }
            } catch (err) {
                console.error('Error fetching confirmed data:', err);
            }
        }
    }

    const errorSec = document.getElementById('error-section');
    const errorDetail = document.getElementById('modal-error-detail');
    const isErrorState = call.evaluation === 'Error' || call.evaluation === 'Fallida' || call.ended_reason?.includes('Error') || call.ended_reason?.includes('fail');
    if (isErrorState) {
        errorSec.style.display = 'block';
        errorDetail.textContent = call.ended_reason;
    } else {
        errorSec.style.display = 'none';
    }
}

function closeModal() {
    document.getElementById('detail-modal').style.display = 'none';
    document.getElementById('modal-audio').pause();
}

async function syncCallStatus(vapiCallId, recordId) {
    // Only process valid Vapi UUIDs (they look like '019...' hex UUIDs, 36+ chars)
    if (!vapiCallId || vapiCallId === '-' || vapiCallId === 'unknown' || vapiCallId.length < 36 || vapiCallId.startsWith('39')) return;

    try {
        const data = await fetchVapiCall(vapiCallId, { skipCache: true });
        if (!data) return;

        // Only update if the call has ended and we have a reason
        if (data.status === 'ended' && data.endedReason) {
            console.log(`Syncing call ${vapiCallId}: ${data.endedReason}`);

            let computedEval = data.analysis?.successEvaluation;
            if (!computedEval) {
                if (data.endedReason === 'voicemail') computedEval = 'Contestador Automático';
                else if (data.endedReason === 'silence-timed-out') computedEval = 'No contesta';
                else if (data.endedReason === 'customer-busy') computedEval = 'Comunica';
                else if (data.endedReason && data.endedReason.includes('error')) computedEval = 'Fallida';
                else if (data.durationSeconds && data.durationSeconds < 10) computedEval = 'Llamada muy corta';
                else computedEval = 'Llamada Finalizada';
            }

            const updatePayload = {
                Id: recordId, // Primary key for NocoDB
                ended_reason: data.endedReason,
                duration_seconds: data.durationSeconds || 0,
                cost: data.cost || 0,
                transcript: data.transcript || '',
                recording_url: data.recordingUrl || '',
                evaluation: computedEval
            };

            // NocoDB V2 PATCH expects an array of objects for /records
            await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
                method: 'PATCH',
                headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify([updatePayload])
            });

            return true; // Signal update
        }
    } catch (err) {
        console.error(`Error syncing ${vapiCallId}:`, err);
    }
    return false;
}

async function syncPendingCalls() {
    const pending = allCalls.filter(c =>
        c.vapi_call_id && c.vapi_call_id.length >= 36 && c.vapi_call_id !== 'unknown' &&
        (!c.ended_reason ||
            c.ended_reason === 'Call Initiated' ||
            c.ended_reason.toLowerCase().includes('in progress'))
    ).slice(0, 5); // Reduced from 10 → 5 to avoid API rate limits

    if (pending.length === 0) return;

    console.log(`Checking ${pending.length} pending calls...`);

    let updatedAny = false;
    for (const call of pending) {
        const success = await syncCallStatus(call.vapi_call_id, call.id || call.Id);
        if (success) updatedAny = true;
        // Delay between calls to avoid 429 rate limiting (was 300ms, increased to 2000ms)
        await new Promise(r => setTimeout(r, 2000));
    }

    if (updatedAny) {
        // Refresh local data silently
        const updatedCalls = await fetchData(CALL_LOGS_TABLE);
        allCalls = updatedCalls;
        applyFilters();
    }
}



// --- Planning / Scheduled Calls Section ---
async function fetchScheduledLeads() {
    try {

        // Paginate to fetch ALL leads (supports 200+ scheduled leads)
        let allRecords = [];
        let offset = 0;
        const batchSize = 200;

        while (true) {
            const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records?limit=${batchSize}&offset=${offset}`, {
                headers: { 'xc-token': XC_TOKEN }
            });
            const data = await res.json();
            const records = data.list || [];
            allRecords = allRecords.concat(records);
            if (records.length < batchSize || data.pageInfo?.isLastPage !== false) break;
            offset += batchSize;
            if (allRecords.length >= 2000) break; // Safety limit
        }

        const leads = allRecords.filter(lead => lead.fecha_planificada && (lead.status || '').toLowerCase() === 'programado');

        const plannedGrid = document.getElementById('planned-grid');
        const plannedSection = document.getElementById('planned-section');

        if (leads.length === 0) {
            plannedSection.style.display = 'none';
            return;
        }

        plannedSection.style.display = 'block';
        plannedGrid.innerHTML = '';

        const now = new Date();
        const sortedLeads = leads.sort((a, b) => utcStringToLocalDate(a.fecha_planificada) - utcStringToLocalDate(b.fecha_planificada));

        // Find next call and categorize
        const dueLeads = sortedLeads.filter(l => utcStringToLocalDate(l.fecha_planificada) <= now);
        const futureLeads = sortedLeads.filter(l => utcStringToLocalDate(l.fecha_planificada) > now);
        const nextCall = futureLeads[0];

        // Calculate time range
        const firstTime = utcStringToLocalDate(sortedLeads[0].fecha_planificada);
        const lastTime = utcStringToLocalDate(sortedLeads[sortedLeads.length - 1].fecha_planificada);
        const timeOpts = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
        const firstStr = isNaN(firstTime) ? '?' : firstTime.toLocaleString('es-ES', timeOpts);
        const lastStr = isNaN(lastTime) ? '?' : lastTime.toLocaleString('es-ES', timeOpts);

        // Summary banner
        const banner = document.createElement('div');
        banner.className = 'planned-summary-banner';
        banner.innerHTML = `
            <div class="planned-summary-stats">
                <div class="planned-summary-stat">
                    <span class="planned-summary-value">${sortedLeads.length}</span>
                    <span class="planned-summary-label">Programadas</span>
                </div>
                <div class="planned-summary-stat due">
                    <span class="planned-summary-value">${dueLeads.length}</span>
                    <span class="planned-summary-label">Vencidas</span>
                </div>
                <div class="planned-summary-stat future">
                    <span class="planned-summary-value">${futureLeads.length}</span>
                    <span class="planned-summary-label">Pendientes</span>
                </div>
            </div>
            <div class="planned-summary-range">
                <div>📅 ${firstStr} → ${lastStr}</div>
                ${nextCall ? `<div class="planned-next-timer" data-scheduled="${nextCall.fecha_planificada}">⏱️ Próxima: <span>--:--:--</span></div>` : ''}
            </div>
        `;
        plannedGrid.appendChild(banner);

        // Compact list (show max 50 initially)
        const MAX_VISIBLE = 50;
        const listContainer = document.createElement('div');
        listContainer.className = 'planned-compact-list';

        const renderLeadRow = (lead, idx) => {
            const plannedDate = utcStringToLocalDate(lead.fecha_planificada);
            const isDue = plannedDate <= now;
            const isNext = nextCall && (lead.unique_id === nextCall.unique_id || lead.Id === nextCall.Id);
            const timeStr = isNaN(plannedDate) ? '?' : plannedDate.toLocaleString('es-ES', { hour: '2-digit', minute: '2-digit' });
            const dateStr = isNaN(plannedDate) ? '' : plannedDate.toLocaleString('es-ES', { day: '2-digit', month: '2-digit' });

            const row = document.createElement('div');
            row.className = `planned-row ${isDue ? 'due' : ''} ${isNext ? 'is-next' : ''}`;
            row.innerHTML = `
                <span class="planned-row-idx">${idx + 1}</span>
                <span class="planned-row-time">${isDue ? '⚡' : '📅'} ${dateStr} ${timeStr}</span>
                <span class="planned-row-name">${lead.name || 'Sin nombre'}</span>
                <span class="planned-row-phone">${lead.phone || '-'}</span>
                ${isNext ? '<span class="planned-row-badge">PRÓXIMA</span>' : ''}
                <span class="planned-row-timer" data-scheduled="${lead.fecha_planificada}">--:--</span>
            `;
            row.style.cursor = 'pointer';
            row.addEventListener('click', () => {
                const leadId = lead.Id || lead.id || lead.unique_id;
                const modal = document.getElementById('lead-modal');
                const form = document.getElementById('lead-form');
                const title = document.getElementById('lead-modal-title');
                form.reset();
                title.innerText = 'Editar Lead';
                document.getElementById('edit-lead-id').value = leadId || '';
                document.getElementById('edit-lead-name').value = lead.name || '';
                document.getElementById('edit-lead-phone').value = lead.phone || '';
                document.getElementById('edit-lead-email').value = lead.email || '';
                document.getElementById('edit-lead-sector').value = lead.sector || '';
                document.getElementById('edit-lead-status').value = lead.status || 'Nuevo';
                document.getElementById('edit-lead-summary').value = lead.summary || '';
                document.getElementById('edit-lead-address').value = lead.address || '';
                if (lead.fecha_planificada) {
                    document.getElementById('edit-lead-planned').value = utcToLocalDatetime(lead.fecha_planificada);
                } else {
                    document.getElementById('edit-lead-planned').value = '';
                }
                modal.classList.add('active');
            });
            return row;
        };

        // Render initial batch
        const visibleLeads = sortedLeads.slice(0, MAX_VISIBLE);
        visibleLeads.forEach((lead, i) => {
            listContainer.appendChild(renderLeadRow(lead, i));
        });

        plannedGrid.appendChild(listContainer);

        // "Show more" button if > MAX_VISIBLE
        if (sortedLeads.length > MAX_VISIBLE) {
            const showMoreBtn = document.createElement('button');
            showMoreBtn.className = 'planned-show-more';
            showMoreBtn.textContent = `📋 Mostrar ${sortedLeads.length - MAX_VISIBLE} llamadas más...`;
            showMoreBtn.addEventListener('click', () => {
                sortedLeads.slice(MAX_VISIBLE).forEach((lead, i) => {
                    listContainer.appendChild(renderLeadRow(lead, MAX_VISIBLE + i));
                });
                showMoreBtn.remove();
            });
            plannedGrid.appendChild(showMoreBtn);
        }
    } catch (err) {
        console.error('Error fetching scheduled leads:', err);
    }
}

// --- Scheduled Calls in Scheduler Tab ---
async function renderScheduledCallsInScheduler() {
    const container = document.getElementById('sched-scheduled-calls');
    const list = document.getElementById('sched-scheduled-list');
    const stats = document.getElementById('sched-scheduled-stats');
    if (!container || !list) return;

    try {
        // Use cached leads data
        const allRecords = await fetchCachedLeads();
        console.log('[RenderScheduled] Total records from cache:', allRecords.length);

        const leads = allRecords.filter(lead => lead.fecha_planificada && (lead.status || '').toLowerCase() === 'programado');
        console.log('[RenderScheduled] Leads with fecha_planificada:', leads.length, leads.map(l => ({ name: l.name, phone: l.phone, fecha_planificada: l.fecha_planificada, status: l.status })));

        if (leads.length === 0) {
            console.log('[RenderScheduled] No scheduled leads found, hiding container');
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        list.innerHTML = '';

        const now = new Date();
        const sorted = leads.sort((a, b) => utcStringToLocalDate(a.fecha_planificada) - utcStringToLocalDate(b.fecha_planificada));
        const dueCount = sorted.filter(l => utcStringToLocalDate(l.fecha_planificada) <= now).length;
        const futureCount = sorted.length - dueCount;

        stats.innerHTML = `
            <span>📞 ${sorted.length} total</span>
            <span style="color: #fbbf24;">⚡ ${dueCount} vencidas</span>
            <span style="color: #4ade80;">📅 ${futureCount} pendientes</span>
            ${dueCount > 0 ? `<button onclick="rescheduleOverdueCalls()" 
                style="background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.25); 
                padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; white-space: nowrap; margin-left: 8px;">
                🔄 Reprogramar Vencidas
            </button>` : ''}
            <button onclick="cancelAllScheduledCalls()" 
                style="background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.25); 
                padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; white-space: nowrap; margin-left: 8px;">
                🗑️ Cancelar Todas
            </button>
        `;

        sorted.forEach((lead, idx) => {
            const plannedDate = utcStringToLocalDate(lead.fecha_planificada);
            const isDue = plannedDate <= now;
            const timeStr = isNaN(plannedDate) ? '?' : plannedDate.toLocaleString('es-ES', { hour: '2-digit', minute: '2-digit' });
            const dateStr = isNaN(plannedDate) ? '' : plannedDate.toLocaleString('es-ES', { day: '2-digit', month: '2-digit' });

            const row = document.createElement('div');
            row.style.cssText = `
                display: flex; align-items: center; gap: 12px; padding: 10px 14px;
                background: ${isDue ? 'rgba(251, 191, 36, 0.08)' : 'rgba(255,255,255,0.03)'};
                border-radius: 8px; margin-bottom: 4px; font-size: 13px;
                border-left: 3px solid ${isDue ? '#fbbf24' : 'var(--accent)'};
            `;
            row.innerHTML = `
                <span style="color: var(--text-secondary); min-width: 24px;">${idx + 1}</span>
                <span style="min-width: 110px; font-weight: 500;">${isDue ? '⚡' : '📅'} ${dateStr} ${timeStr}</span>
                <span style="flex: 1; font-weight: 600;">${lead.name || 'Sin nombre'}</span>
                <span style="color: var(--text-secondary); min-width: 120px;">${lead.phone || '-'}</span>
                <span class="planned-row-timer" data-scheduled="${lead.fecha_planificada}" style="min-width: 70px; font-family: monospace; font-size: 12px; color: ${isDue ? '#fbbf24' : '#4ade80'};">--:--</span>
                <button onclick="cancelScheduledCall(${lead.Id || lead.id})" 
                    style="background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.25); 
                    padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; white-space: nowrap;">
                    ❌ Cancelar
                </button>
            `;
            list.appendChild(row);
        });
    } catch (err) {
        console.error('Error rendering scheduled calls in scheduler:', err);
    }
}

async function cancelScheduledCall(recordId) {
    if (!confirm('¿Cancelar esta llamada programada?')) return;
    try {
        const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
            method: 'PATCH',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify([{ Id: recordId, fecha_planificada: null, status: 'Nuevo' }])
        });
        if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
        invalidateLeadsCache();
        renderScheduledCallsInScheduler();
        fetchScheduledLeads();
    } catch (err) {
        console.error('Error cancelling scheduled call:', err);
        alert('Error al cancelar la llamada programada');
    }
}
window.cancelScheduledCall = cancelScheduledCall;

async function cancelAllScheduledCalls() {
    if (!confirm('⚠️ ¿Cancelar TODAS las llamadas programadas?')) return;

    const btn = document.querySelector('[onclick="cancelAllScheduledCalls()"]');
    const originalText = btn ? btn.textContent : '';

    try {
        // Force-refresh to get latest data
        const allRecords = await fetchCachedLeads(true);
        const scheduled = allRecords.filter(l => l.fecha_planificada);
        if (scheduled.length === 0) {
            alert('No hay llamadas programadas para cancelar.');
            return;
        }

        if (btn) btn.textContent = `⏳ Cancelando 0/${scheduled.length}...`;

        let success = 0;
        let errors = 0;
        const BATCH_SIZE = 10;

        // Filter out leads without a valid record Id
        const validScheduled = scheduled.filter(l => l.Id || l.id);
        if (validScheduled.length === 0) {
            alert('No hay llamadas programadas con ID válido para cancelar.');
            return;
        }

        for (let i = 0; i < validScheduled.length; i += BATCH_SIZE) {
            const batch = validScheduled.slice(i, i + BATCH_SIZE).map(l => ({
                Id: l.Id || l.id,
                fecha_planificada: null,
                status: 'Nuevo'
            }));

            try {
                const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                    method: 'PATCH',
                    headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                    body: JSON.stringify(batch)
                });
                if (res.ok) {
                    success += batch.length;
                } else {
                    const errText = await res.text();
                    console.error(`[CancelAll] Batch error:`, res.status, errText);
                    errors += batch.length;
                }
            } catch (e) {
                console.error(`[CancelAll] Batch exception:`, e);
                errors += batch.length;
            }

            if (btn) btn.textContent = `⏳ Cancelando ${Math.min(i + BATCH_SIZE, validScheduled.length)}/${validScheduled.length}...`;

            // Small delay between batches to avoid rate-limiting
            if (i + BATCH_SIZE < validScheduled.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        alert(`✅ ${success} llamadas canceladas.${errors > 0 ? ` (${errors} errores)` : ''}`);
        invalidateLeadsCache();
        renderScheduledCallsInScheduler();
        fetchSchedulerKPIs();
        if (typeof fetchScheduledLeads === 'function') fetchScheduledLeads();
    } catch (err) {
        console.error('Error cancelling all scheduled calls:', err);
        alert('Error al cancelar las llamadas: ' + err.message);
    } finally {
        if (btn) btn.textContent = originalText || '🗑️ Cancelar Todas';
    }
}
window.cancelAllScheduledCalls = cancelAllScheduledCalls;

async function rescheduleOverdueCalls() {
    if (!confirm('🔄 ¿Reprogramar todas las llamadas vencidas a partir de ahora (cada 2 min)?')) return;

    const btn = document.querySelector('[onclick="rescheduleOverdueCalls()"]');
    const originalText = btn ? btn.innerHTML : '';

    try {
        const allRecords = await fetchCachedLeads(true);
        const now = new Date();
        const overdue = allRecords
            .filter(l => l.fecha_planificada && (l.status || '').toLowerCase() === 'programado')
            .filter(l => utcStringToLocalDate(l.fecha_planificada) <= now)
            .filter(l => l.Id || l.id);

        if (overdue.length === 0) {
            alert('No hay llamadas vencidas para reprogramar.');
            return;
        }

        if (btn) btn.textContent = `⏳ Reprogramando 0/${overdue.length}...`;

        // Stagger: start 1 min from now, every 2 min
        const startTime = new Date(now.getTime() + 60000);
        const SPACING_MS = 2 * 60000; // 2 minutes
        let success = 0;
        let errors = 0;
        const BATCH_SIZE = 10;

        for (let i = 0; i < overdue.length; i += BATCH_SIZE) {
            const batch = overdue.slice(i, i + BATCH_SIZE).map((l, idx) => {
                const callTime = new Date(startTime.getTime() + (i + idx) * SPACING_MS);
                const utcTime = `${callTime.getUTCFullYear()}-${String(callTime.getUTCMonth() + 1).padStart(2, '0')}-${String(callTime.getUTCDate()).padStart(2, '0')} ${String(callTime.getUTCHours()).padStart(2, '0')}:${String(callTime.getUTCMinutes()).padStart(2, '0')}:00`;
                return {
                    Id: l.Id || l.id,
                    fecha_planificada: utcTime
                };
            });

            try {
                const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                    method: 'PATCH',
                    headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                    body: JSON.stringify(batch)
                });
                if (res.ok) {
                    success += batch.length;
                } else {
                    console.error('[Reschedule] Batch error:', res.status);
                    errors += batch.length;
                }
            } catch (e) {
                console.error('[Reschedule] Batch exception:', e);
                errors += batch.length;
            }

            if (btn) btn.textContent = `⏳ Reprogramando ${Math.min(i + BATCH_SIZE, overdue.length)}/${overdue.length}...`;
            if (i + BATCH_SIZE < overdue.length) await new Promise(r => setTimeout(r, 200));
        }

        const firstCallTime = startTime.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        const lastCallTime = new Date(startTime.getTime() + (overdue.length - 1) * SPACING_MS).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        alert(`✅ ${success} llamadas reprogramadas: ${firstCallTime} → ${lastCallTime}${errors > 0 ? ` (${errors} errores)` : ''}`);
        invalidateLeadsCache();
        renderScheduledCallsInScheduler();
        fetchSchedulerKPIs();
        if (typeof fetchScheduledLeads === 'function') fetchScheduledLeads();
    } catch (err) {
        console.error('Error rescheduling overdue calls:', err);
        alert('Error al reprogramar: ' + err.message);
    } finally {
        if (btn) btn.innerHTML = originalText || '🔄 Reprogramar Vencidas';
    }
}
window.rescheduleOverdueCalls = rescheduleOverdueCalls;

// --- Tab Navigation ---
function switchToTab(target) {
    const tabs = document.querySelectorAll('.nav-tab');
    const views = document.querySelectorAll('.view-content');

    // Update tabs
    tabs.forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector(`.nav-tab[data-tab="${target}"]`);
    if (activeTab) activeTab.classList.add('active');

    // Update views
    views.forEach(v => {
        v.classList.remove('active');
        if (v.id === `view-${target}`) {
            v.classList.add('active');
        }
    });

    // Tab-specific side effects — lazy load only what this tab needs
    try {
        if (target === 'dashboard') loadData();
        if (target === 'leads') loadLeadsManager();
        if (target === 'appointments') loadAppointments();
        if (target === 'scheduler') { initSchedulerDefaults(); renderScheduledCallsInScheduler(); }
        if (target === 'reports') loadReports();
        if (target === 'agents') loadAgentPrompt();
        if (target === 'test') loadData();
        if (target === 'errorlogs') loadErrorLogs();
        if (target === 'admin') loadAdminUsers();
    } catch (e) {
        console.warn('[switchToTab] Deferred init, some handlers not ready yet:', e.message);
    }

    // Realtime polling — separate try-catch to avoid TDZ error with let variables
    try {
        if (target === 'realtime') { startRealtimePolling(); } else { stopRealtimePolling(); }
    } catch (e) {
        // Expected on first load before realtime variables are initialized
    }
}

function initTabs() {
    const tabs = document.querySelectorAll('.nav-tab');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.getAttribute('data-tab');
            // Update URL hash (without triggering hashchange handler redundantly)
            history.replaceState(null, '', `#${target}`);
            switchToTab(target);
        });
    });

    // Listen for browser back/forward navigation
    window.addEventListener('hashchange', () => {
        const hash = location.hash.replace('#', '');
        if (hash) {
            switchToTab(hash);
        }
    });

    // On initial load, activate the tab from the URL hash (if present)
    const initialHash = location.hash.replace('#', '');
    if (initialHash) {
        switchToTab(initialHash);
    }
}

// ── Bulk Scheduler Logic ──

let schedulerLeads = []; // leads fetched for preview

function initSchedulerDefaults() {
    const startInput = document.getElementById('sched-start');
    if (!startInput.value) {
        // Default: next round 5-min mark, +5 minutes from now
        const now = new Date();
        now.setMinutes(now.getMinutes() + 5);
        now.setMinutes(Math.ceil(now.getMinutes() / 5) * 5, 0, 0);
        const y = now.getFullYear();
        const mo = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const h = String(now.getHours()).padStart(2, '0');
        const mi = String(now.getMinutes()).padStart(2, '0');
        startInput.value = `${y}-${mo}-${d}T${h}:${mi}`;
    }

    // Initialize slider UI
    initSchedulerSlider();
    // Update duration estimate
    updateDurationEstimate();
    // Fetch KPI stats
    fetchSchedulerKPIs();
}

function initSchedulerSlider() {
    const slider = document.getElementById('sched-count');
    const bubble = document.getElementById('sched-slider-bubble');
    if (!slider || !bubble) return;

    function updateSlider() {
        const val = parseInt(slider.value);
        const min = parseInt(slider.min);
        const max = parseInt(slider.max);
        const pct = (val - min) / (max - min);

        // Update bubble text and position
        bubble.textContent = val;
        const sliderWidth = slider.offsetWidth;
        const bubbleWidth = bubble.offsetWidth;
        const thumbOffset = pct * (sliderWidth - 24) + 12; // 24px thumb width
        bubble.style.left = thumbOffset + 'px';
        bubble.style.transform = 'translateX(-50%)';

        // Update slider fill
        slider.style.background = `linear-gradient(90deg, var(--accent) ${pct * 100}%, rgba(255,255,255,0.08) ${pct * 100}%)`;

        // Update duration estimate when slider moves
        updateDurationEstimate();
    }

    slider.addEventListener('input', updateSlider);
    // Initial
    setTimeout(updateSlider, 50);
}

function updateDurationEstimate() {
    const count = parseInt(document.getElementById('sched-count')?.value) || 50;
    const spacing = parseInt(document.getElementById('sched-spacing')?.value) || 2;
    const totalMin = (count - 1) * spacing;
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    const durationStr = hours > 0 ? `≈ ${hours}h ${mins}m total` : `≈ ${mins}m total`;

    const el = document.getElementById('sched-duration-estimate');
    if (el) el.textContent = durationStr;
}

async function fetchSchedulerKPIs() {
    try {
        const allRecords = await fetchCachedLeads();

        const total = allRecords.length;
        const calledStatuses = ['completado', 'contestador', 'voicemail', 'no contesta', 'fallido', 'interesado', 'reintentar'];
        const scheduled = allRecords.filter(l => (l.status || '').toLowerCase() === 'programado' || l.fecha_planificada).length;
        const called = allRecords.filter(l => {
            const s = (l.status || '').toLowerCase();
            return calledStatuses.some(cs => s.includes(cs));
        }).length;

        // Eligible = has phone, not scheduled, not called (if skip enabled), deduplicated by phone
        const includeTestKPI = document.getElementById('sched-include-test')?.checked ?? false;
        const eligibleLeads = allRecords.filter(l => {
            const phone = String(l.phone || '').trim();
            if (!phone || phone === '0' || phone === 'null' || phone.length < 6) return false;
            const status = (l.status || '').toLowerCase();
            if (status === 'programado' || status === 'en proceso' || status === 'llamando...') return false;
            if (l.fecha_planificada) return false;
            if (calledStatuses.some(s => status.includes(s))) return false;
            if (!includeTestKPI && typeof isTestLead === 'function' && isTestLead(l)) return false;
            return true;
        });
        // Deduplicate by phone
        const seenPhones = new Set();
        const eligible = eligibleLeads.filter(l => {
            const normPhone = String(l.phone || '').replace(/\D/g, '');
            if (seenPhones.has(normPhone)) return false;
            seenPhones.add(normPhone);
            return true;
        }).length;

        // Animate KPI values
        animateKPIValue('sched-kpi-total', total);
        animateKPIValue('sched-kpi-eligible', eligible);
        animateKPIValue('sched-kpi-scheduled', scheduled);
        animateKPIValue('sched-kpi-called', called);

        // Update bars
        setTimeout(() => {
            const barEligible = document.getElementById('sched-kpi-bar-eligible');
            const barScheduled = document.getElementById('sched-kpi-bar-scheduled');
            const barCalled = document.getElementById('sched-kpi-bar-called');
            if (barEligible) barEligible.style.width = total > 0 ? `${(eligible / total) * 100}%` : '0%';
            if (barScheduled) barScheduled.style.width = total > 0 ? `${(scheduled / total) * 100}%` : '0%';
            if (barCalled) barCalled.style.width = total > 0 ? `${(called / total) * 100}%` : '0%';
        }, 100);

        // Update slider max to eligible count (if > 0)
        if (eligible > 0) {
            const slider = document.getElementById('sched-count');
            if (slider) {
                slider.max = Math.min(eligible, 500);
                if (parseInt(slider.value) > eligible) {
                    slider.value = eligible;
                }
                // Re-trigger slider update
                slider.dispatchEvent(new Event('input'));
            }
        }

    } catch (err) {
        console.error('[Scheduler] Error fetching KPIs:', err);
    }
}


// Test lead phones and names to exclude from scheduling by default
const SCHEDULER_TEST_PHONES = ['666532143', '34666532143'];
const SCHEDULER_TEST_NAMES = ['sergi', 'nayim', 'test manual', 'test', 'sergio', 'sergio test 3'];

function isTestLead(lead) {
    const phone = String(lead.phone || '').replace(/\D/g, '');
    if (SCHEDULER_TEST_PHONES.some(tp => phone.endsWith(tp))) return true;
    const name = (lead.name || '').toLowerCase().trim();
    if (SCHEDULER_TEST_NAMES.includes(name)) return true;
    if (/\btest\b/i.test(name)) return true;
    return false;
}

async function fetchEligibleLeads(count, source) {
    // Use centralized cache to get all leads
    const allRecords = [...(await fetchCachedLeads())];

    // Check if we should skip already-called leads
    const skipCalled = document.getElementById('sched-skip-called')?.checked ?? true;
    // Check if we should include test leads
    const includeTest = document.getElementById('sched-include-test')?.checked ?? false;

    // Sort
    if (source === 'oldest') {
        allRecords.sort((a, b) => new Date(a.CreatedAt) - new Date(b.CreatedAt));
    } else {
        allRecords.sort((a, b) => new Date(b.CreatedAt) - new Date(a.CreatedAt));
    }

    // Statuses that indicate the lead has already been called
    const calledStatuses = ['completado', 'contestador', 'voicemail', 'no contesta', 'fallido', 'interesado', 'reintentar'];

    // Filter: eligible leads — with debug breakdown
    let dbgNoPhone = 0, dbgBadStatus = 0, dbgPlanned = 0, dbgCalled = 0, dbgTest = 0;
    const eligible = allRecords.filter(lead => {
        const phone = String(lead.phone || '').trim();
        if (!phone || phone === '0' || phone === 'null' || phone.length < 6) { dbgNoPhone++; return false; }
        const status = (lead.status || '').toLowerCase();
        if (status === 'programado' || status === 'en proceso' || status === 'llamando...') { dbgBadStatus++; return false; }
        if (lead.fecha_planificada) { dbgPlanned++; return false; }
        if (skipCalled && status && calledStatuses.some(s => status.includes(s))) { dbgCalled++; return false; }
        if (!includeTest && isTestLead(lead)) { dbgTest++; return false; }
        return true;
    });
    console.log(`[Scheduler][DEBUG] Rejection breakdown: noPhone=${dbgNoPhone}, activeStatus=${dbgBadStatus}, hasPlanned=${dbgPlanned}, alreadyCalled=${dbgCalled}, testLead=${dbgTest}`);
    // Log sample of first 5 records to inspect their fields
    console.log('[Scheduler][DEBUG] Sample records:', allRecords.slice(0, 5).map(l => ({ phone: l.phone, status: l.status, fecha_planificada: l.fecha_planificada, name: l.name })));

    // Deduplicate by phone number — keep only the first lead per phone
    const seenPhones = new Set();
    const deduplicated = eligible.filter(lead => {
        const normPhone = String(lead.phone || '').replace(/\D/g, '');
        if (seenPhones.has(normPhone)) return false;
        seenPhones.add(normPhone);
        return true;
    });

    // Strictly enforce the requested count limit
    const result = deduplicated.slice(0, count);
    console.log(`[Scheduler] skipCalled=${skipCalled}, total=${allRecords.length}, eligible=${eligible.length}, deduplicated=${deduplicated.length}, requested=${count}, returning=${result.length}`);
    return result;
}

function renderSchedulePreview(leads, startTime, spacingMinutes) {
    const summaryEl = document.getElementById('sched-summary');
    const statsEl = document.getElementById('sched-summary-stats');
    const timelineEl = document.getElementById('sched-timeline');

    if (leads.length === 0) {
        summaryEl.style.display = 'block';
        statsEl.innerHTML = '';
        timelineEl.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-secondary);">⚠️ No se encontraron leads elegibles con los criterios seleccionados</div>';
        return;
    }

    const totalDuration = (leads.length - 1) * spacingMinutes;
    const endTime = new Date(startTime.getTime() + totalDuration * 60000);

    const hours = Math.floor(totalDuration / 60);
    const mins = totalDuration % 60;
    const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    statsEl.innerHTML = `
        <div class="sched-stat accent">📊 ${leads.length} leads</div>
        <div class="sched-stat warning">⏱️ ${durationStr} total</div>
        <div class="sched-stat success">🏁 Fin: ${endTime.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div>
    `;

    let html = '';
    leads.forEach((lead, i) => {
        const callTime = new Date(startTime.getTime() + i * spacingMinutes * 60000);
        const timeStr = callTime.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        const dateStr = callTime.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });

        html += `
            <div class="timeline-item" id="sched-item-${i}">
                <div class="timeline-index">${i + 1}</div>
                <div class="timeline-info">
                    <div class="timeline-name">${escapeHtml(lead.name || 'Sin nombre')}</div>
                    <div class="timeline-phone">📞 ${escapeHtml(lead.phone)}</div>
                </div>
                <div class="timeline-time">
                    ${timeStr}
                    <small>${dateStr}</small>
                </div>
            </div>
        `;
    });

    timelineEl.innerHTML = html;
    summaryEl.style.display = 'block';
}

async function executeScheduling(leads, startTime, spacingMinutes, assistantId) {
    const progressEl = document.getElementById('sched-progress');
    const progressBar = document.getElementById('sched-progress-bar');
    const progressText = document.getElementById('sched-progress-text');
    const progressLog = document.getElementById('sched-progress-log');
    const executeBtn = document.getElementById('sched-execute-btn');
    const previewBtn = document.getElementById('sched-preview-btn');

    progressEl.style.display = 'block';
    executeBtn.disabled = true;
    previewBtn.disabled = true;
    progressLog.innerHTML = '';

    let success = 0;
    let errors = 0;

    for (let i = 0; i < leads.length; i++) {
        const lead = leads[i];
        const leadId = lead.Id || lead.id;
        const callTime = new Date(startTime.getTime() + i * spacingMinutes * 60000);
        const utcTime = localDatetimeToUTC(callTime.getFullYear() + '-' +
            String(callTime.getMonth() + 1).padStart(2, '0') + '-' +
            String(callTime.getDate()).padStart(2, '0') + 'T' +
            String(callTime.getHours()).padStart(2, '0') + ':' +
            String(callTime.getMinutes()).padStart(2, '0'));

        console.log(`[Scheduler] Scheduling lead ${i + 1}/${leads.length}: Id=${leadId}, time=${utcTime}`);

        if (!leadId) {
            errors++;
            progressLog.innerHTML += `<div style="color: var(--danger);">✗ ${lead.name || lead.phone}: Sin ID válido para actualizar</div>`;
            continue;
        }

        try {
            const patchData = {
                Id: leadId,
                status: 'Programado',
                fecha_planificada: utcTime
            };
            if (assistantId) patchData.assistant_id = assistantId;

            const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                method: 'PATCH',
                headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify([patchData])
            });

            if (!res.ok) {
                logApiError({ url: `${API_BASE}/${LEADS_TABLE}/records`, method: 'PATCH', status: res.status, statusText: res.statusText, context: `executeScheduling lead=${lead.name || lead.phone}`, detail: await res.text().catch(() => '') });
                throw new Error(`HTTP ${res.status}`);
            }

            success++;
            const timelineItem = document.getElementById(`sched-item-${i}`);
            if (timelineItem) {
                timelineItem.classList.add('done');
                timelineItem.querySelector('.timeline-index').textContent = '✓';
            }
            progressLog.innerHTML += `<div style="color: var(--success);">✓ ${escapeHtml(lead.name || lead.phone)} → ${callTime.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div>`;
        } catch (err) {
            errors++;
            logApiError({ url: `${API_BASE}/${LEADS_TABLE}/records`, method: 'PATCH', status: 0, statusText: err.message, context: `executeScheduling lead=${lead.name || lead.phone}`, detail: err.stack || '' });
            const timelineItem = document.getElementById(`sched-item-${i}`);
            if (timelineItem) timelineItem.classList.add('error-item');
            progressLog.innerHTML += `<div style="color: var(--danger);">✗ ${lead.name || lead.phone}: ${err.message}</div>`;
        }

        // Update progress
        const pct = Math.round(((i + 1) / leads.length) * 100);
        progressBar.style.width = `${pct}%`;
        progressText.textContent = `${i + 1} / ${leads.length} — ${success} ✓ ${errors > 0 ? errors + ' ✗' : ''}`;

        // Scroll log to bottom
        progressLog.scrollTop = progressLog.scrollHeight;
    }

    // Final status
    progressText.innerHTML = `<span style="color: var(--success); font-weight: 600;">✅ Completado: ${success} programados</span>${errors > 0 ? ` <span style="color: var(--danger);">(${errors} errores)</span>` : ''}`;
    executeBtn.disabled = false;
    previewBtn.disabled = false;
    executeBtn.textContent = '🚀 Programar Llamadas';

    // Reset leads list to prevent stale data reuse
    schedulerLeads = [];
    
    // Ocultar resumen de programación al terminar
    const summaryEl = document.getElementById('sched-summary');
    if (summaryEl) {
        summaryEl.style.display = 'none';
    }

    // Refresh: invalidate cache and reload scheduled calls view + KPIs
    invalidateLeadsCache();
    renderScheduledCallsInScheduler();
    fetchSchedulerKPIs();
}

// Event listener for spacing input to update estimate
document.getElementById('sched-spacing')?.addEventListener('input', updateDurationEstimate);

// --- Test Lead Modal Logic ---
document.getElementById('sched-test-lead-btn')?.addEventListener('click', () => {
    document.getElementById('test-lead-modal').classList.add('active');
    document.getElementById('test-lead-name').value = '';
    document.getElementById('test-lead-phone').value = '';
    document.getElementById('test-lead-count').value = '1';
    document.getElementById('test-lead-feedback').innerHTML = '';
});

document.getElementById('close-test-lead-modal')?.addEventListener('click', () => {
    document.getElementById('test-lead-modal').classList.remove('active');
});

document.getElementById('save-test-lead-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('test-lead-name').value.trim();
    const phone = document.getElementById('test-lead-phone').value.trim();
    const count = Math.min(Math.max(parseInt(document.getElementById('test-lead-count')?.value) || 1, 1), 20);
    const feedback = document.getElementById('test-lead-feedback');

    if (!phone) {
        feedback.innerHTML = '<span style="color: var(--danger);">El teléfono es obligatorio</span>';
        return;
    }

    const saveBtn = document.getElementById('save-test-lead-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = `⏳ Creando ${count} lead${count > 1 ? 's' : ''}...`;

    try {
        // Find the last scheduled call time to append after it
        const allRecords = await fetchCachedLeads();
        const scheduledLeads = allRecords
            .filter(l => l.fecha_planificada && (l.status || '').toLowerCase() === 'programado')
            .sort((a, b) => utcStringToLocalDate(b.fecha_planificada) - utcStringToLocalDate(a.fecha_planificada));

        const SPACING_MS = 2 * 60000; // 2 minutes
        let startTime;

        if (scheduledLeads.length > 0) {
            // Start after the last scheduled call + spacing
            const lastScheduledTime = utcStringToLocalDate(scheduledLeads[0].fecha_planificada);
            startTime = new Date(Math.max(lastScheduledTime.getTime() + SPACING_MS, Date.now() + 60000));
        } else {
            // No queue — start from now + 1 min
            startTime = new Date(Date.now() + 60000);
        }

        const assistantId = document.getElementById('sched-assistant')?.value || '';
        const leadsToCreate = [];

        for (let i = 0; i < count; i++) {
            const callTime = new Date(startTime.getTime() + i * SPACING_MS);
            const utcTime = `${callTime.getUTCFullYear()}-${String(callTime.getUTCMonth() + 1).padStart(2, '0')}-${String(callTime.getUTCDate()).padStart(2, '0')} ${String(callTime.getUTCHours()).padStart(2, '0')}:${String(callTime.getUTCMinutes()).padStart(2, '0')}:00`;

            const leadData = {
                name: count > 1 ? `${name || 'Test'} #${i + 1}` : (name || 'Test Lead ' + new Date().toLocaleTimeString()),
                phone: count > 1 ? phone.replace(/(\d)$/, '') + (parseInt(phone.slice(-1)) + i) % 10 : phone,
                status: 'Programado',
                fecha_planificada: utcTime,
                unique_id: 'test_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5)
            };
            if (assistantId) leadData.assistant_id = assistantId;
            leadsToCreate.push(leadData);
        }

        console.log(`[TestLead] Creating ${leadsToCreate.length} test leads`);

        // Create in batches of 10
        let created = 0;
        for (let i = 0; i < leadsToCreate.length; i += 10) {
            const batch = leadsToCreate.slice(i, i + 10);
            const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                method: 'POST',
                headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify(batch)
            });
            if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
            created += batch.length;
            saveBtn.textContent = `⏳ Creando ${created}/${leadsToCreate.length}...`;
        }

        const firstTime = new Date(startTime).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        const lastTime = new Date(startTime.getTime() + (count - 1) * SPACING_MS).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        const timeRange = count > 1 ? `${firstTime} → ${lastTime}` : firstTime;

        feedback.innerHTML = `<span style="color: var(--success);">✅ ${created} lead${created > 1 ? 's' : ''} programado${created > 1 ? 's' : ''}: ${timeRange}</span>`;

        // Refresh UI
        await new Promise(r => setTimeout(r, 1000));
        invalidateLeadsCache();
        await renderScheduledCallsInScheduler();
        fetchSchedulerKPIs();

        setTimeout(() => {
            document.getElementById('test-lead-modal').classList.remove('active');
        }, 2500);

    } catch (err) {
        console.error('Error saving test leads:', err);
        feedback.innerHTML = `<span style="color: var(--danger);">Error: ${err.message}</span>`;
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Crear y Programar';
    }
});

// Event Listeners for Scheduler
document.getElementById('sched-preview-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sched-preview-btn');
    const count = parseInt(document.getElementById('sched-count').value) || 50;
    const source = document.getElementById('sched-source').value;
    const startStr = document.getElementById('sched-start').value;
    const spacing = parseInt(document.getElementById('sched-spacing').value) || 2;

    if (!startStr) {
        alert('Por favor, selecciona una fecha y hora de inicio');
        return;
    }

    btn.textContent = '⏳ Buscando leads...';
    btn.disabled = true;

    try {
        console.log('[Scheduler] Fetching eligible leads:', { count, source });
        schedulerLeads = await fetchEligibleLeads(count, source);
        console.log('[Scheduler] Found eligible leads:', schedulerLeads.length, schedulerLeads.map(l => ({ Id: l.Id, id: l.id, name: l.name, status: l.status })));
        const startTime = new Date(startStr);
        renderSchedulePreview(schedulerLeads, startTime, spacing);
    } catch (err) {
        console.error('[Scheduler] Error fetching leads:', err);
        alert('Error al buscar leads: ' + err.message);
    } finally {
        btn.textContent = '🔍 Ver Preview';
        btn.disabled = false;
    }
});

document.getElementById('sched-execute-btn').addEventListener('click', async () => {
    const executeBtn = document.getElementById('sched-execute-btn');
    const count = parseInt(document.getElementById('sched-count').value) || 50;
    const source = document.getElementById('sched-source').value;
    const startStr = document.getElementById('sched-start').value;
    const spacing = parseInt(document.getElementById('sched-spacing').value) || 2;
    const assistantId = document.getElementById('sched-assistant').value;

    if (!startStr) {
        alert('Por favor, selecciona una fecha y hora de inicio');
        return;
    }

    // Always re-fetch eligible leads with the CURRENT slider count to prevent stale data
    executeBtn.textContent = '⏳ Verificando leads...';
    executeBtn.disabled = true;

    try {
        console.log('[Scheduler] Execute: re-fetching eligible leads with count:', count);
        schedulerLeads = await fetchEligibleLeads(count, source);
        console.log('[Scheduler] Execute: got', schedulerLeads.length, 'leads (requested', count, ')');
    } catch (err) {
        console.error('[Scheduler] Error re-fetching leads:', err);
        alert('Error al verificar leads: ' + err.message);
        executeBtn.textContent = '🚀 Programar Llamadas';
        executeBtn.disabled = false;
        return;
    }

    if (schedulerLeads.length === 0) {
        alert('No se encontraron leads elegibles con los criterios actuales.');
        executeBtn.textContent = '🚀 Programar Llamadas';
        executeBtn.disabled = false;
        return;
    }

    const startTime = new Date(startStr);

    console.log('[Scheduler] Config:', { startStr, spacing, startTime, assistantId, leadsCount: schedulerLeads.length });

    executeBtn.textContent = '🚀 Programar Llamadas';
    executeBtn.disabled = false;

    const confirmed = confirm(`¿Programar ${schedulerLeads.length} llamadas empezando a las ${startTime.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}?`);
    if (!confirmed) return;

    executeBtn.textContent = '⏳ Programando...';
    await executeScheduling(schedulerLeads, startTime, spacing, assistantId);
});

// --- Lead Management Logic ---
let allLeads = [];

async function loadLeadsManager() {
    const tbody = document.getElementById('leads-master-table');
    tbody.innerHTML = '<tr><td colspan="7" class="loading">Cargando lista de leads...</td></tr>';

    try {
        const allRecords = await fetchCachedLeads();

        allLeads = allRecords;
        renderLeadsTable(allLeads);
        updateLeadsKPIs(allLeads);
    } catch (err) {
        console.error('Error loading leads:', err);
        tbody.innerHTML = '<tr><td colspan="7" class="error">Error al cargar leads</td></tr>';
    }
}

function updateLeadsKPIs(leads) {
    const total = leads.length;
    const nuevos = leads.filter(l => {
        const s = (l.status || '').toLowerCase();
        return !s || s === 'nuevo';
    }).length;
    const programados = leads.filter(l => (l.status || '').toLowerCase() === 'programado').length;
    const llamando = leads.filter(l => (l.status || '').toLowerCase() === 'llamando').length;
    const completados = leads.filter(l => (l.status || '').toLowerCase() === 'completado').length;
    const interesados = leads.filter(l => (l.status || '').toLowerCase() === 'interesado').length;
    const reintentar = leads.filter(l => (l.status || '').toLowerCase() === 'reintentar').length;
    const fallidos = leads.filter(l => (l.status || '').toLowerCase() === 'fallido').length;

    // Conversion rate = (interesados + completados) / total
    const conversionRate = total > 0 ? Math.round(((interesados + completados) / total) * 100) : 0;

    // Animate KPI values
    animateKPIValue('kpi-total-leads', total);
    animateKPIValue('kpi-nuevos', nuevos);
    animateKPIValue('kpi-programados', programados + llamando);
    animateKPIValue('kpi-completados', completados);
    animateKPIValue('kpi-interesados', interesados);
    animateKPIValue('kpi-fallidos', fallidos + reintentar);

    const convEl = document.getElementById('kpi-conversion');
    if (convEl) convEl.textContent = conversionRate + '%';

    // Update progress bars (percentage of total)
    setKPIBar('kpi-bar-nuevos', total > 0 ? (nuevos / total) * 100 : 0);
    setKPIBar('kpi-bar-programados', total > 0 ? ((programados + llamando) / total) * 100 : 0);
    setKPIBar('kpi-bar-completados', total > 0 ? (completados / total) * 100 : 0);
    setKPIBar('kpi-bar-interesados', total > 0 ? (interesados / total) * 100 : 0);
    setKPIBar('kpi-bar-fallidos', total > 0 ? ((fallidos + reintentar) / total) * 100 : 0);
}

function animateKPIValue(id, targetValue) {
    const el = document.getElementById(id);
    if (!el) return;
    // Use data attribute for start value to prevent mid-animation reads causing overflow
    const startVal = parseInt(el.getAttribute('data-kpi-target')) || 0;
    el.setAttribute('data-kpi-target', targetValue);
    const duration = 600;
    const start = performance.now();
    function step(now) {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
        el.textContent = Math.round(startVal + (targetValue - startVal) * eased);
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

function setKPIBar(id, pct) {
    const el = document.getElementById(id);
    if (!el) return;
    setTimeout(() => { el.style.width = Math.max(pct, 2) + '%'; }, 100);
}

// --- Automation Toggle Logic ---
async function initAutomationToggle() {
    const toggle = document.getElementById('automation-toggle');
    const CONFIG_TABLE = 'mkntvxkybs6jx8p'; // config table in new NocoDB instance

    try {
        const query = '(Key,eq,automation_enabled)';
        const res = await fetch(`${API_BASE}/${CONFIG_TABLE}/records?where=${query}`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        const data = await res.json();
        const config = data.list && data.list[0];
        if (config) {
            toggle.checked = config.Value === 'true';
            window.automationConfigId = config.Id || config.id;
        } else {
            console.warn('Automation config not found — toggle defaults to OFF');
            toggle.checked = false;
        }
    } catch (err) {
        console.error('Error fetching automation config:', err);
        toggle.checked = false;
    }

    toggle.addEventListener('change', async () => {
        try {
            await fetch(`${API_BASE}/${CONFIG_TABLE}/records`, {
                method: 'PATCH',
                headers: {
                    'xc-token': XC_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify([{
                    Id: window.automationConfigId,
                    Value: toggle.checked ? 'true' : 'false'
                }])
            });
        } catch (err) {
            console.error('Error updating automation config:', err);
        }
    });
}

// --- Bulk CSV Import ---
// --- Intelligent Bulk CSV Import ---
const SYSTEM_FIELDS = [
    { key: 'name', label: 'Nombre / Empresa', keywords: ['name', 'nombre', 'empresa', 'company', 'lead', 'contacto', 'razon'] },
    { key: 'phone', label: 'Teléfono', keywords: ['phone', 'telefono', 'movil', 'tel', 'whatsapp', 'mobile', 'celular', 'telefon'] },
    { key: 'email', label: 'Email', keywords: ['email', 'correo', 'mail', 'e-mail'] },
    { key: 'sector', label: 'Sector / Actividad', keywords: ['sector', 'actividad', 'industria', 'industry', 'category'] },
    { key: 'summary', label: 'Resumen / Notas', keywords: ['summary', 'resumen', 'description', 'descripcion', 'notes', 'notas'] },
    { key: 'address', label: 'Dirección', keywords: ['address', 'direccion', 'calle', 'street', 'city', 'ciudad', 'direccio'] },
    { key: 'website', label: 'Página Web', keywords: ['website', 'web', 'sitio', 'url', 'pagina'] },
    { key: 'localidad', label: 'Localidad', keywords: ['localidad', 'municipio', 'poblacion', 'ciudad', 'city', 'localida'] },
    { key: 'cod_postal', label: 'Código Postal', keywords: ['cod_postal', 'postal', 'cp', 'zip', 'codigo postal', 'cod_pos'] },
    { key: 'sexo', label: 'Sexo / Género', keywords: ['sexo', 'genero', 'gender'] },
    { key: 'edad', label: 'Edad', keywords: ['edad', 'age', 'años'] }
];

function initBulkImport() {
    const importBtn = document.getElementById('btn-import-csv');
    const fileInput = document.getElementById('csv-import');
    const mappingModal = document.getElementById('csv-mapping-modal');
    const closeMappingModal = document.getElementById('close-csv-mapping-modal');
    const cancelImportBtn = document.getElementById('cancel-import-btn');
    const confirmImportBtn = document.getElementById('confirm-import-btn');

    let parsedData = [];
    let headers = [];
    let currentMapping = {};

    const deleteBtn = document.getElementById('btn-delete-all-leads');

    if (deleteBtn) {
        deleteBtn.onclick = async () => {
            if (confirm('⚠️ ¿ESTÁS SEGURO? Esta acción borrará TODOS los leads de la base de datos permanentemente.')) {
                if (confirm('¿Confirmas que quieres BORRAR TODO? Esta acción no se puede deshacer.')) {
                    deleteBtn.disabled = true;
                    deleteBtn.textContent = '⏳ Borrando...';

                    try {
                        // Fetch all IDs to delete
                        const response = await fetch(`${API_BASE}/${LEADS_TABLE}/records?limit=1000&fields=Id`, {
                            headers: { 'xc-token': XC_TOKEN }
                        });
                        const data = await response.json();
                        const ids = data.list.map(l => l.Id || l.id);

                        if (ids.length === 0) {
                            alert('No hay leads para borrar.');
                            return;
                        }

                        // Batch delete (NocoDB v2 supports bulk delete)
                        for (let i = 0; i < ids.length; i += 50) {
                            const batch = ids.slice(i, i + 50);
                            await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                                method: 'DELETE',
                                headers: {
                                    'xc-token': XC_TOKEN,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify(batch.map(id => ({ Id: id })))
                            });
                        }

                        alert(`¡Base de Datos limpiada! Se han borrado ${ids.length} leads.`);
                        invalidateLeadsCache();
                        loadLeadsManager();
                    } catch (err) {
                        console.error('Error in bulk delete:', err);
                        alert('Error al intentar borrar los leads.');
                    } finally {
                        deleteBtn.disabled = false;
                        deleteBtn.innerHTML = '<span>🗑️</span> Borrar Todo de la BD';
                    }
                }
            }
        };
    }

    if (importBtn) importBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                parsedData = results.data;
                headers = results.meta.fields;

                if (headers.length === 0) return alert('El CSV no parece tener cabeceras válidas.');

                // Initialize mapping
                currentMapping = autoDetectMapping(headers);
                renderMappingUI(headers, parsedData.slice(0, 3), currentMapping);
                mappingModal.classList.add('active');
            }
        });
    });

    closeMappingModal.onclick = () => {
        mappingModal.classList.remove('active');
        fileInput.value = '';
    };

    cancelImportBtn.onclick = () => {
        mappingModal.classList.remove('active');
        fileInput.value = '';
    };

    confirmImportBtn.onclick = async () => {
        // Collect final mapping from selects
        const selects = document.querySelectorAll('.mapping-select');
        const finalMapping = {};
        selects.forEach(sel => {
            const csvHeader = sel.dataset.header;
            const systemKey = sel.value;
            if (systemKey && systemKey !== 'skip') {
                finalMapping[systemKey] = csvHeader;
            }
        });

        if (!finalMapping.phone) {
            return alert('Debes mapear al menos la columna del Teléfono para poder importar.');
        }

        // 1. Process and Normalize Map Data
        const normalizedLeadsMap = new Map();
        parsedData.forEach(row => {
            const rawPhone = row[finalMapping.phone];
            if (!rawPhone) return;

            // Normalize phone: keep only digits
            const phone = rawPhone.toString().replace(/\D/g, '');
            if (phone.length < 9) return;

            const leadData = {
                phone: phone,
                status: 'Nuevo'
            };

            for (const [sysKey, csvHeader] of Object.entries(finalMapping)) {
                if (sysKey !== 'phone') {
                    leadData[sysKey] = row[csvHeader] || '';
                }
            }

            // If duplicate phone in same CSV, the last one wins
            normalizedLeadsMap.set(phone, leadData);
        });

        const incomingLeads = Array.from(normalizedLeadsMap.values());
        if (incomingLeads.length === 0) {
            return alert('No se encontraron leads válidos (se requiere teléfono válido de al menos 9 dígitos).');
        }

        if (confirm(`¿Importar/Actualizar ${incomingLeads.length} leads? (Los teléfonos existentes se actualizarán)`)) {
            confirmImportBtn.disabled = true;
            confirmImportBtn.textContent = '⏳ Procesando duplicados...';

            try {
                // 2. Fetch all existing leads to check for duplicates
                // In a production app with many thousands of leads, we might do this via search filters,
                // but here local variable allLeads is available.
                const existingLeadsMap = new Map();
                allLeads.forEach(l => {
                    if (l.phone) {
                        const normPhone = l.phone.toString().replace(/\D/g, '');
                        existingLeadsMap.set(normPhone, l);
                    }
                });

                const toUpdate = [];
                const toCreate = [];

                incomingLeads.forEach(lead => {
                    const existing = existingLeadsMap.get(lead.phone);
                    if (existing) {
                        // Prepare update (only changed fields or all?)
                        // Prepare update — use unique_id for PATCH
                        lead.unique_id = existing.unique_id;
                        toUpdate.push(lead);
                    } else {
                        // Prepare creation
                        lead.unique_id = 'lead_' + lead.phone + '_' + Date.now().toString(36);
                        toCreate.push(lead);
                    }
                });

                confirmImportBtn.textContent = `⏳ Subiendo (${toCreate.length} nuevos, ${toUpdate.length} actualizaciones)...`;

                // 3. Batch Create
                for (let i = 0; i < toCreate.length; i += 50) {
                    const batch = toCreate.slice(i, i + 50);
                    await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                        method: 'POST',
                        headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                        body: JSON.stringify(batch)
                    });
                }

                // 4. Batch Update (NocoDB v2 supports bulk PATCH)
                for (let i = 0; i < toUpdate.length; i += 50) {
                    const batch = toUpdate.slice(i, i + 50);
                    await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                        method: 'PATCH',
                        headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                        body: JSON.stringify(batch)
                    });
                }

                alert(`¡Importación completada!\n- Nuevos: ${toCreate.length}\n- Actualizados: ${toUpdate.length}`);
                mappingModal.classList.remove('active');
                invalidateLeadsCache();
                loadLeadsManager();
            } catch (err) {
                console.error('Error importing leads:', err);
                alert('Error durante la importación');
            } finally {
                confirmImportBtn.disabled = false;
                confirmImportBtn.textContent = '🚀 Importar Leads';
                fileInput.value = '';
            }
        }
    };

    function autoDetectMapping(headers) {
        const mapping = {};
        const assignedSystemFields = new Set();

        headers.forEach(header => {
            const lowerHeader = header.toLowerCase().trim();

            // Find best matching system field
            let bestMatch = null;
            for (const field of SYSTEM_FIELDS) {
                if (assignedSystemFields.has(field.key)) continue;

                if (field.keywords.some(kw => lowerHeader.includes(kw) || kw.includes(lowerHeader))) {
                    bestMatch = field.key;
                    break;
                }
            }

            if (bestMatch) {
                mapping[header] = bestMatch;
                assignedSystemFields.add(bestMatch);
            } else {
                mapping[header] = 'skip';
            }
        });

        return mapping;
    }

    function renderMappingUI(headers, previewRows, mapping) {
        const body = document.getElementById('csv-mapping-body');
        const previewHead = document.getElementById('csv-preview-head');
        const previewBody = document.getElementById('csv-preview-body');

        body.innerHTML = '';
        headers.forEach(header => {
            const tr = document.createElement('tr');

            // CSV Header cell
            const tdHeader = document.createElement('td');
            tdHeader.innerHTML = `<strong>${header}</strong>`;

            // System Field Select cell
            const tdSelect = document.createElement('td');
            const select = document.createElement('select');
            select.className = 'mapping-select';
            select.dataset.header = header;

            let options = '<option value="skip">-- Saltar esta columna --</option>';
            SYSTEM_FIELDS.forEach(field => {
                const selected = mapping[header] === field.key ? 'selected' : '';
                options += `<option value="${field.key}" ${selected}>${field.label}</option>`;
            });
            select.innerHTML = options;
            tdSelect.appendChild(select);

            // Example data cell
            const tdExample = document.createElement('td');
            tdExample.style.color = 'var(--text-secondary)';
            tdExample.style.fontSize = '12px';
            tdExample.textContent = previewRows[0] ? previewRows[0][header] : '-';

            tr.appendChild(tdHeader);
            tr.appendChild(tdSelect);
            tr.appendChild(tdExample);
            body.appendChild(tr);
        });

        // Render Preview Table
        previewHead.innerHTML = '<tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>';
        previewBody.innerHTML = previewRows.map(row => {
            return '<tr>' + headers.map(h => `<td>${row[h] || ''}</td>`).join('') + '</tr>';
        }).join('');
    }
}

function renderLeadsTable(leads) {
    const tbody = document.getElementById('leads-master-table');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (leads.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 40px; color: var(--text-secondary);">No se encontraron leads</td></tr>';
        return;
    }

    tbody.innerHTML = leads.map(lead => {
        const leadId = lead.unique_id;
        // Escape single quotes for HTML onclick attributes
        const escapedName = (lead.name || 'Sin nombre').replace(/'/g, "\\'");
        const escapedPhone = (lead.phone || '').replace(/'/g, "\\'");
        const escapedId = (leadId || '').toString().replace(/'/g, "\\'");

        const otherInfo = [];
        const sexo = lead.sexo || lead.Sexo;
        const edad = lead.edad || lead.Edad;
        const cp = lead.cod_postal || lead['Código Postal'];
        const localidad = lead.localidad || lead.Localidad;

        if (sexo) otherInfo.push(sexo);
        if (edad) otherInfo.push(edad + ' años');
        if (cp) otherInfo.push('CP: ' + cp);

        return `
            <tr data-id="${escapedId}">
                <td class="actions-cell">
                    <button class="btn-detail" onclick="triggerManualCall('${escapedPhone}', '${escapedName}')" title="Llamar ahora">📞</button>
                    <button class="btn-detail" onclick="openLeadEditor('${escapedId}')" title="Editar">✏️</button>
                </td>
                <td><strong>${escapeHtml(lead.name || 'Sin nombre')}</strong></td>
                <td>
                    <div>${escapeHtml(lead.sector || '-')}</div>
                    <div style="font-size: 11px; color: var(--text-secondary);">${escapeHtml(localidad || '')}</div>
                </td>
                <td>${escapeHtml(lead.phone || '-')}</td>
                <td>${escapeHtml(lead.email || '-')}</td>
                <td><span class="status-badge ${getBadgeStatusClass(lead.status)}">${escapeHtml(lead.status || 'Nuevo')}</span></td>
                <td><small style="color: var(--text-secondary); line-height: 1.2; display: block;">${escapeHtml(otherInfo.join(' | ') || '-')}</small></td>
                <td>${lead.fecha_planificada ? utcStringToLocalDate(lead.fecha_planificada).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'}</td>
            </tr>
        `;
    }).join('');
}

function getBadgeStatusClass(status) {
    const s = (status || '').toLowerCase();
    if (s.includes('nuevo')) return 'nuevo';
    if (s.includes('completado')) return 'completado';
    if (s.includes('llamando')) return 'llamando';
    if (s.includes('reintentar')) return 're-intentar';
    if (s.includes('fallido')) return 'fallido';
    if (s.includes('interesado')) return 'interesado';
    if (s.includes('programado')) return 'programado';
    if (s.includes('contestador') || s.includes('voicemail')) return 'en-proceso';
    return '';
}

// Global search for leads
document.getElementById('lead-search').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const filtered = allLeads.filter(l =>
        (l.name || '').toLowerCase().includes(query) ||
        (l.email || '').toLowerCase().includes(query) ||
        (l.phone || '').toLowerCase().includes(query)
    );
    renderLeadsTable(filtered);
});

// --- Lead Editor Modal Control ---
function openLeadEditor(leadId = null) {
    const modal = document.getElementById('lead-modal');
    const form = document.getElementById('lead-form');
    const title = document.getElementById('lead-modal-title');

    form.reset();
    document.getElementById('edit-lead-id').value = leadId || '';

    if (leadId) {
        title.innerText = 'Editar Lead';
        const lead = allLeads.find(l => (l.unique_id || l.Id || l.id).toString() === leadId.toString());
        if (lead) {
            document.getElementById('edit-lead-name').value = lead.name || '';
            document.getElementById('edit-lead-phone').value = lead.phone || '';
            document.getElementById('edit-lead-email').value = lead.email || '';
            document.getElementById('edit-lead-sector').value = lead.sector || '';
            document.getElementById('edit-lead-status').value = lead.status || 'Nuevo';
            document.getElementById('edit-lead-summary').value = lead.summary || '';
            document.getElementById('edit-lead-address').value = lead.address || '';
            if (lead.fecha_planificada) {
                // Convert UTC NocoDB value to local datetime-local format
                document.getElementById('edit-lead-planned').value = utcToLocalDatetime(lead.fecha_planificada);
            } else {
                document.getElementById('edit-lead-planned').value = '';
            }
        }
    } else {
        title.innerText = 'Nuevo Lead';
        document.getElementById('edit-lead-status').value = 'Nuevo';
    }

    modal.classList.add('active');
}

function closeLeadModal() {
    document.getElementById('lead-modal').classList.remove('active');
}

// Attach event listeners for lead modal
document.getElementById('close-lead-modal').addEventListener('click', closeLeadModal);
document.getElementById('cancel-lead-save').addEventListener('click', closeLeadModal);
document.getElementById('btn-add-lead').addEventListener('click', () => openLeadEditor());

// Form submission for creating/updating leads
document.getElementById('lead-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const saveBtn = e.target.querySelector('button[type="submit"]');
    const leadId = document.getElementById('edit-lead-id').value;

    const leadData = {
        name: document.getElementById('edit-lead-name').value,
        phone: document.getElementById('edit-lead-phone').value,
        email: document.getElementById('edit-lead-email').value,
        sector: document.getElementById('edit-lead-sector').value,
        status: document.getElementById('edit-lead-status').value,
        summary: document.getElementById('edit-lead-summary').value,
        address: document.getElementById('edit-lead-address').value,
        fecha_planificada: document.getElementById('edit-lead-planned').value ? localDatetimeToUTC(document.getElementById('edit-lead-planned').value) : null
    };

    saveBtn.innerText = 'Guardando...';
    saveBtn.disabled = true;

    try {

        let res;

        if (leadId) {
            // Update
            leadData.unique_id = leadId;
            res = await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                method: 'PATCH',
                headers: {
                    'xc-token': XC_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify([leadData])
            });
        } else {
            // Create - Generate a unique_id if not present (usually NocoDB handles PK, but unique_id is our custom pk)
            leadData.unique_id = 'lead_' + Date.now();
            res = await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                method: 'POST',
                headers: {
                    'xc-token': XC_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify([leadData])
            });
        }

        if (res.ok) {
            closeLeadModal();
            invalidateLeadsCache();
            loadLeadsManager(); // Refresh table
            fetchScheduledLeads(); // Refresh calendar if changed
        } else {
            const err = await res.json();
            alert('Error al guardar: ' + (err.message || 'Error desconocido'));
        }
    } catch (err) {
        console.error('Error saving lead:', err);
        alert('Error de conexión al guardar el lead');
    } finally {
        saveBtn.innerText = 'Guardar Cambios';
        saveBtn.disabled = false;
    }
});

// Expose functions to global scope for button onclicks
window.openLeadEditor = openLeadEditor;
window.triggerManualCall = async function (phone, name) {
    if (!phone) return alert('No hay teléfono disponible');
    // Reuse existing logic from manual call modal
    document.getElementById('manual-phone').value = phone;
    document.getElementById('manual-lead-name').value = name;
    document.getElementById('call-feedback').textContent = '';
    document.getElementById('trigger-call-btn').textContent = '🚀 Lanzar Llamada';
    document.getElementById('manual-call-modal').style.display = 'flex';
};

async function loadData(skipEnrichment = false) {
    try {
        // Initialize UI components once
        if (!window.tabsInitialized) {
            initTabs();
            initBulkImport();
            initAutomationToggle();
            window.tabsInitialized = true;
        }

        // Pre-fetch confirmed data in parallel with call logs
        const [rawCalls] = await Promise.all([
            fetchData(CALL_LOGS_TABLE),
            fetchConfirmedData()
        ]);

        // Show all call logs (including those with vapi_call_id='unknown' — these are real calls
        // that were logged before the Vapi API returned the actual call ID)
        const calls = rawCalls;

        // Auto-evaluate confirmed calls that have no evaluation yet
        calls.forEach(call => {
            if (!call.evaluation && confirmedDataMap[call.vapi_call_id]) {
                call.evaluation = 'Confirmada ✓';
            }
        });

        // Retroactively classify disposition for calls that have an evaluation but no disposition
        calls.forEach(call => {
            if (!call.call_disposition && call.evaluation && call.evaluation !== 'Pendiente') {
                call.call_disposition = classifyCallDisposition(call, call.transcript || '');
            }
        });

        allCalls = calls;
        currentCalls = calls;

        // Separate test/manual calls from campaign calls
        // Test calls: is_test flag, Manual Trigger, known test names, or names without corporate suffix
        const TEST_NAMES = ['test manual', 'juan', 'sergio', 'talleres', 'astro', 'ramel',
            'talleres perez', 'tallerres perez', 'luis abogados', 'pamesa', 'spider ia',
            'grupo gavina azul celeste', 'tecnologia actual variable', 'gestoria way',
            'gatos felices 2', 'gatos felices 33', 'gatos felices 3', 'gatos felices 44', 'gatos felices',
            'covermanager', 'tracfutveri', 'golosinas sa', 'golosinas', 'golosinas sl 2', 'golosinas sl',
            'nenucos', 'nuevo', 'aaa', 'test', 'sans rober', 'mantecados 3', 'sergio test 3',
            'locutorios martinez', 'viviana s.l.', 'consultoria luis', 'gestoria luis', 'gestalia'];
        const isTestCall = (c) => {
            if (c.is_test === true || c.is_test === 1 || c.is_test === '1') return true;
            if ((c.ended_reason || '').includes('Manual Trigger')) return true;
            const name = (c.lead_name || '').toLowerCase().trim();
            if (TEST_NAMES.includes(name)) return true;
            // Only match names that look explicitly like test entries (contain 'test' keyword)
            if (name && /\btest\b/i.test(name)) return true;
            return false;
        };
        const testCalls = calls.filter(c => isTestCall(c));
        const campaignCalls = calls.filter(c => !isTestCall(c));

        // Calculate scores for all calls (before filters)
        calls.forEach(c => {
            const scoreResult = calculateCallScore(c);
            c._score = scoreResult.total;
            c._scoreBreakdown = scoreResult.breakdown;
        });

        // Enrich calls with missing data from Vapi (runs in background after render)
        if (!isEnriching && !skipEnrichment) {
            isEnriching = true;
            setTimeout(async () => {
                try {
                    const wasUpdated = await enrichCallsFromVapi(calls);
                    isEnriching = false;
                    if (wasUpdated) {
                        loadData(false); // Re-render and allow next batch
                    }
                } catch(e) { 
                    isEnriching = false;
                    console.warn('Enrich error:', e); 
                }
            }, 100);
        }

        const companyFilter = document.getElementById('filter-company').value.toLowerCase();
        const scoreFilter = document.getElementById('filter-score').value;
        const dateRange = document.getElementById('date-range').value;

        let filteredCalls = campaignCalls;

        // Apply Company Filter
        if (companyFilter) {
            filteredCalls = filteredCalls.filter(c =>
                (c.lead_name || '').toLowerCase().includes(companyFilter)
            );
        }

        // Apply Score Filter
        if (scoreFilter !== 'all') {
            const [minS, maxS] = scoreFilter.split('-').map(Number);
            filteredCalls = filteredCalls.filter(c => (c._score || 0) >= minS && (c._score || 0) <= maxS);
        }

        // Apply Disposition Filter
        const dispositionFilter = document.getElementById('filter-disposition')?.value || 'all';
        if (dispositionFilter !== 'all') {
            filteredCalls = filteredCalls.filter(c => c.call_disposition === dispositionFilter);
        }

        // Apply Date Filter
        if (dateRange && dateRange.includes(' a ')) {
            const [start, end] = dateRange.split(' a ').map(d => new Date(d));
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);

            filteredCalls = filteredCalls.filter(c => {
                const callDate = new Date(c.call_time || c.CreatedAt);
                return callDate >= start && callDate <= end;
            });
        }


        const totalCalls = campaignCalls.length;
        const confirmedCalls = campaignCalls.filter(c => isConfirmed(c)).length;
        const confirmationRate = totalCalls > 0 ? Math.round((confirmedCalls / totalCalls) * 100) : 0;

        // Interested = Interesado + Cita Agendada dispositions
        const interestedCalls = campaignCalls.filter(c => c.call_disposition === 'Interesado' || c.call_disposition === 'Cita Agendada').length;
        const interestedRate = totalCalls > 0 ? Math.round((interestedCalls / totalCalls) * 100) : 0;
        const totalDuration = campaignCalls.reduce((sum, c) => sum + (parseInt(c.duration_seconds) || 0), 0);
        const avgDuration = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;
        const avgScore = totalCalls > 0 ? Math.round(campaignCalls.reduce((sum, c) => sum + (c._score || 0), 0) / totalCalls) : 0;

        document.getElementById('total-calls').textContent = totalCalls;
        document.getElementById('interested-rate').textContent = interestedRate + '%';
        document.getElementById('avg-duration').textContent = formatDuration(avgDuration);
        document.getElementById('avg-score').textContent = avgScore;
        const avgScoreLabel = getScoreLabel(avgScore);
        document.getElementById('avg-score').style.color = getScoreColor(avgScore);
        document.getElementById('avg-score-label').textContent = avgScoreLabel.emoji + ' ' + avgScoreLabel.text;

        // New KPIs
        document.getElementById('confirmed-count').textContent = confirmedCalls;
        document.getElementById('confirmation-rate').textContent = confirmationRate + '%';

        const tbody = document.getElementById('call-table');
        const paginationContainer = document.getElementById('call-pagination');

        if (filteredCalls.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No hay llamadas registradas que coincidan con el filtro</td></tr>';
            if (paginationContainer) paginationContainer.innerHTML = '';
        } else {
            tbody.innerHTML = '';

            // Build a map of parent vapi_call_id → retry calls for grouping
            const retryMap = new Map(); // parentVapiId → [retryCall indexes]
            const retryChildIndexes = new Set(); // indexes that are retries (to skip in main loop)

            filteredCalls.forEach((call, index) => {
                const reason = call.ended_reason || '';
                const retryMatch = reason.match(/^Retry:?\s*([a-f0-9-]{8,})/i);
                if (retryMatch) {
                    const parentIdPrefix = retryMatch[1].replace(/\.+$/, '');
                    // Find the parent call in filteredCalls
                    const parentIdx = filteredCalls.findIndex(c => {
                        const cId = c.vapi_call_id || c.lead_id || '';
                        return cId.startsWith(parentIdPrefix);
                    });
                    if (parentIdx >= 0) {
                        if (!retryMap.has(parentIdx)) retryMap.set(parentIdx, []);
                        retryMap.get(parentIdx).push(index);
                        retryChildIndexes.add(index);
                        // Store the parent vapi_call_id on the retry call for reference
                        call._retryParentIdx = parentIdx;
                    }
                }
            });

            // Build display-order list (parents + their retries grouped together), excluding standalone retries
            const displayOrder = [];
            filteredCalls.forEach((call, index) => {
                if (retryChildIndexes.has(index)) return;
                displayOrder.push({ call, index, isRetry: false });
                if (retryMap.has(index)) {
                    retryMap.get(index).forEach(retryIdx => {
                        displayOrder.push({ call: filteredCalls[retryIdx], index: retryIdx, isRetry: true, parentCall: call });
                    });
                }
            });

            // ── Pagination: slice for current page ──
            const totalItems = displayOrder.length;
            const totalPages = Math.ceil(totalItems / paginationPageSize);
            if (paginationPage > totalPages) paginationPage = totalPages;
            if (paginationPage < 1) paginationPage = 1;
            const startIdx = (paginationPage - 1) * paginationPageSize;
            const endIdx = Math.min(startIdx + paginationPageSize, totalItems);
            const pageItems = displayOrder.slice(startIdx, endIdx);

            // Helper to render a single call row
            function renderCallRow(call, index, isRetry = false, parentCall = null) {
                const tr = document.createElement('tr');
                const vapiId = call.vapi_call_id || call.lead_id || call.id || call.Id || '-';
                const shortId = vapiId;

                const confirmed = isConfirmed(call);
                if (confirmed) tr.classList.add('confirmed-row');

                // Detect unenriched rows (data not yet fetched from Vapi)
                // Only show "loading" for calls that CAN be enriched (have a real Vapi ID)
                const hasRealVapiId = vapiId && vapiId !== 'unknown' && vapiId !== '-' && vapiId.length >= 36;
                const isUnenriched = hasRealVapiId && (
                    !call.evaluation || call.evaluation === 'Pendiente' ||
                    call.ended_reason === 'Call Initiated' || call.ended_reason === 'call_initiated' ||
                    call.ended_reason === 'Bulk Call Trigger' || call.ended_reason === 'Manual Trigger');
                if (isUnenriched) tr.classList.add('unenriched-row');

                // Add retry styling class
                if (isRetry) {
                    tr.classList.add('retry-subcall-row');
                }
                // Add parent class if it has retries
                if (retryMap.has(index)) {
                    tr.classList.add('retry-parent-row');
                }

                // Get confirmed data from pre-fetched map
                const confData = confirmedDataMap[call.vapi_call_id];
                let confirmedCell = '❌';
                if (confirmed && confData) {
                    const resolvedPhone = sanitizePhone(confData.rawPhone, call.phone_called);
                    const apptHtml = confData.appointmentDate ? `<div class="confirmed-detail-item"><span class="confirmed-label">🗓️</span> ${formatAppointmentDate(confData.appointmentDate)}</div>` : '';
                    confirmedCell = `
                        <div class="confirmed-inline">
                            <span class="confirmed-badge">✅ Confirmado</span>
                            <div class="confirmed-details">
                                <div class="confirmed-detail-item"><span class="confirmed-label">👤</span> ${confData.name}</div>
                                <div class="confirmed-detail-item"><span class="confirmed-label">📧</span> ${confData.email}</div>
                                <div class="confirmed-detail-item"><span class="confirmed-label">📞</span> ${resolvedPhone}</div>
                                ${apptHtml}
                            </div>
                        </div>`;
                } else if (confirmed) {
                    confirmedCell = '<span class="confirmed-badge">✅ Confirmado</span>';
                }

                const scoreVal = call._score || 0;
                const scoreLbl = getScoreLabel(scoreVal);
                const scoreClr = getScoreColor(scoreVal);

                // For retry calls, show a special "Resultado" with link badge
                let resultadoCell = call.ended_reason || '-';
                let empresaCell = `<strong>${call.lead_name || '-'}</strong>`;
                let idCell = `<code style="font-family: monospace; color: var(--accent); font-size: 11px;" title="${vapiId}">${shortId}</code> <button class="copy-id-btn" data-copy-id="${vapiId}" title="Copiar ID completo" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px 4px;opacity:0.6;transition:opacity 0.2s;vertical-align:middle;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">📋</button>`;

                if (isRetry) {
                    idCell = `<span class="retry-connector">↳</span> <code style="font-family: monospace; color: #22c55e; font-size: 11px;" title="${vapiId}">${shortId}</code> <button class="copy-id-btn" data-copy-id="${vapiId}" title="Copiar ID completo" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px 4px;opacity:0.6;transition:opacity 0.2s;vertical-align:middle;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">📋</button>`;
                    empresaCell = `<span class="retry-badge">🔄 Rellamada</span>`;
                    resultadoCell = call.ended_reason ? call.ended_reason.replace(/^Retry:?\s*[a-f0-9-]+\.{0,3}\s*/i, '').trim() || call.ended_reason : '-';
                }

                // For parent calls that have retries, add a subtle indicator
                if (retryMap.has(index)) {
                    const retryCount = retryMap.get(index).length;
                    empresaCell += ` <span class="retry-count-badge" title="${retryCount} rellamada(s)">🔄 ${retryCount}</span>`;
                }

                // Build cell content — grey placeholders for unenriched rows
                const placeholderSpan = '<span class="unenriched-placeholder">⏳</span>';

                tr.innerHTML = `
                    <td data-label="Acciones" class="actions-cell-calls">
                        <button class="action-btn" data-index="${index}">👁 Ver Detalle</button>
                        <button class="action-btn mark-test-btn" data-call-id="${call.id || call.Id}" title="Marcar como Test">🧪</button>
                        <button class="action-btn mark-contestador-btn" data-call-id="${call.id || call.Id}" data-phone="${call.phone_called || ''}" title="Marcar como Contestador">📞🤖</button>
                    </td>
                    <td data-label="Call ID">${idCell}</td>
                    <td data-label="Empresa">${empresaCell}</td>
                    <td data-label="Teléfono" class="phone">${call.phone_called || '-'}</td>
                    <td data-label="Fecha">${formatDate(call.call_time || call.CreatedAt)}</td>
                    <td data-label="Disposición">${isUnenriched ? '<span class="badge unenriched-badge">⏳ Cargando...</span>' : (() => { const dp = getDispositionProps(call.call_disposition); return call.call_disposition ? `<span class="badge disposition-badge ${dp.cls}">${dp.icon} ${call.call_disposition}</span>` : '<span class="badge disposition-badge disposition-unknown">❓ Pendiente</span>'; })()}</td>
                    <td data-label="Duración">${isUnenriched ? placeholderSpan : formatDuration(call.duration_seconds)}</td>
                    <td data-label="Score">${isUnenriched ? placeholderSpan : `<span class="score-badge ${scoreLbl.cls}" style="--score-color: ${scoreClr}">${scoreLbl.emoji} ${scoreVal}</span>`}</td>
                    <td data-label="Notas" class="table-notes">${call.Notes ? `<span class="note-indicator" data-index="${index}" title="${call.Notes}" style="cursor: pointer;">📝</span>` : '-'}</td>
                `;
                return tr;
            }

            // Render only the current page items
            pageItems.forEach(item => {
                const tr = renderCallRow(item.call, item.index, item.isRetry, item.parentCall || null);
                tbody.appendChild(tr);
            });

            // Render pagination controls
            renderPagination(totalItems, paginationPage, paginationPageSize, totalPages);

            // Update Chart
            renderChart(filteredCalls);
            currentCallsPage = filteredCalls;
        }

        // Start background sync for pending ones
        syncPendingCalls();

        // Render test calls section
        renderTestCalls(testCalls);
    } catch (err) {
        console.error('[loadData] Error completo:', err);
        const isNetwork = err.type === 'NETWORK_ERROR';
        const isHTTP = err.type === 'HTTP_ERROR';
        const errType = err.type || 'UNKNOWN';
        const errMsg = err.message || 'Error desconocido';
        const errDetail = err.detail || '';
        const errUrl = err.url || '';
        const timestamp = new Date().toLocaleString('es-ES');

        let causasHTML = '';
        if (isNetwork) {
            causasHTML = `
                <div style="margin-top:12px;text-align:left;font-size:13px;color:var(--text-secondary);line-height:1.6;">
                    <div style="font-weight:600;color:var(--text-primary);margin-bottom:6px;">🔍 Posibles causas:</div>
                    <div>• Tu conexión a internet puede estar inestable</div>
                    <div>• El servidor de datos (<code style="font-size:11px;background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;">${API_BASE}</code>) puede estar temporalmente caído</div>
                    <div>• Un firewall o proxy puede estar bloqueando la conexión</div>
                    <div>• Extensiones del navegador (ad blockers) pueden interferir</div>
                </div>`;
        } else if (isHTTP) {
            causasHTML = `
                <div style="margin-top:12px;text-align:left;font-size:13px;color:var(--text-secondary);line-height:1.6;">
                    <div style="font-weight:600;color:var(--text-primary);margin-bottom:6px;">🔍 Posibles causas:</div>
                    <div>• HTTP ${err.status || '?'}: ${err.status === 401 ? 'Token de acceso inválido o expirado' : err.status === 403 ? 'Acceso denegado al servidor' : err.status === 500 ? 'Error interno del servidor de datos' : err.status === 502 || err.status === 503 ? 'Servidor temporalmente no disponible' : 'Error del servidor'}</div>
                    ${errDetail ? `<div style="margin-top:6px;"><code style="font-size:11px;word-break:break-all;background:rgba(255,255,255,0.05);padding:4px 8px;border-radius:4px;display:block;max-height:80px;overflow:auto;">${errDetail}</code></div>` : ''}
                </div>`;
        } else {
            causasHTML = `
                <div style="margin-top:12px;text-align:left;font-size:13px;color:var(--text-secondary);line-height:1.6;">
                    <div style="font-weight:600;color:var(--text-primary);margin-bottom:6px;">🔍 Detalle técnico:</div>
                    <div><code style="font-size:11px;word-break:break-all;background:rgba(255,255,255,0.05);padding:4px 8px;border-radius:4px;display:block;max-height:80px;overflow:auto;">${errMsg}${errDetail ? '\n' + errDetail : ''}</code></div>
                    ${errUrl ? `<div style="margin-top:4px;font-size:11px;">URL: <code style="background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;">${errUrl}</code></div>` : ''}
                </div>`;
        }

        document.getElementById('call-table').innerHTML = `<tr><td colspan="9" style="padding:40px 20px;text-align:center;">
            <div style="max-width:500px;margin:0 auto;">
                <div style="font-size:40px;margin-bottom:12px;">⚠️</div>
                <div style="font-size:16px;font-weight:600;color:var(--danger);margin-bottom:8px;">Error al cargar datos</div>
                <div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px;">${errMsg}</div>
                <div style="font-size:11px;color:var(--text-secondary);opacity:0.7;">Tipo: ${errType} • ${timestamp}</div>
                ${causasHTML}
                <div style="margin-top:20px;display:flex;gap:10px;justify-content:center;">
                    <button onclick="loadData()" style="padding:10px 24px;background:var(--accent);color:white;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;">🔄 Reintentar</button>
                    <button onclick="navigator.clipboard.writeText('Error: ${errMsg.replace(/'/g, "\\'").replace(/\n/g, ' ')} | Tipo: ${errType} | Detalle: ${errDetail.replace(/'/g, "\\'").replace(/\n/g, ' ')} | URL: ${errUrl} | Hora: ${timestamp}').then(()=>this.textContent='✅ Copiado')" style="padding:10px 24px;background:rgba(255,255,255,0.1);color:var(--text-secondary);border:1px solid rgba(255,255,255,0.1);border-radius:8px;cursor:pointer;font-size:13px;">📋 Copiar error</button>
                </div>
            </div>
        </td></tr>`;
    }
}

// --- Test / Manual Calls Rendering ---
function renderTestCalls(testCalls) {
    const tbody = document.getElementById('test-call-table');
    if (!tbody) return;

    // Update test KPIs
    const total = testCalls.length;
    const success = testCalls.filter(c => getBadgeClass(c.evaluation) === 'success').length;
    const failed = testCalls.filter(c => getBadgeClass(c.evaluation) === 'fail').length;
    const voicemail = testCalls.filter(c => getBadgeClass(c.evaluation) === 'voicemail').length;

    document.getElementById('test-total').textContent = total;
    document.getElementById('test-success').textContent = success;
    document.getElementById('test-failed').textContent = failed;
    document.getElementById('test-voicemail').textContent = voicemail;

    if (total === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No hay llamadas de test registradas. Las llamadas manuales aparecerán aquí.</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    testCalls.forEach((call, idx) => {
        const tr = document.createElement('tr');
        const vapiId = call.vapi_call_id || call.lead_id || call.id || call.Id || '-';
        const shortId = vapiId;

        const confirmed = isConfirmed(call);
        if (confirmed) tr.classList.add('confirmed-row');

        const confData = confirmedDataMap[call.vapi_call_id];
        let confirmedCell = '❌';
        if (confirmed && confData) {
            const apptLabel = confData.appointmentDate ? ` 🗓️ ${formatAppointmentDate(confData.appointmentDate)}` : '';
            confirmedCell = `<span class="confirmed-badge">✅ Confirmado${apptLabel}</span>`;
        } else if (confirmed) {
            confirmedCell = '<span class="confirmed-badge">✅</span>';
        }

        const scoreVal = call._score || 0;
        const scoreLbl = getScoreLabel(scoreVal);
        const scoreClr = getScoreColor(scoreVal);

        tr.innerHTML = `
            <td class="actions-cell-calls">
                <button class="action-btn test-detail-btn" data-test-index="${idx}">👁 Ver Detalle</button>
                <button class="action-btn unmark-test-btn" data-call-id="${call.id || call.Id}" title="Quitar de Test">↩️</button>
            </td>
            <td data-label="Call ID"><code style="font-family: monospace; color: #a855f7; font-size: 11px;" title="${vapiId}">${shortId}</code> <button class="copy-id-btn" data-copy-id="${vapiId}" title="Copiar ID completo" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px 4px;opacity:0.6;transition:opacity 0.2s;vertical-align:middle;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">📋</button></td>
            <td data-label="Empresa"><strong>${call.lead_name || '-'}</strong></td>
            <td data-label="Teléfono" class="phone">${call.phone_called || '-'}</td>
            <td data-label="Fecha">${formatDate(call.call_time || call.CreatedAt)}</td>
            <td data-label="Disposición">${(() => { const dp = getDispositionProps(call.call_disposition); return call.call_disposition ? `<span class="badge disposition-badge ${dp.cls}">${dp.icon} ${call.call_disposition}</span>` : '<span class="badge disposition-badge disposition-unknown">❓ Pendiente</span>'; })()}</td>
            <td data-label="Duración">${formatDuration(call.duration_seconds)}</td>
            <td data-label="Score"><span class="score-badge ${scoreLbl.cls}" style="--score-color: ${scoreClr}">${scoreLbl.emoji} ${scoreVal}</span></td>
        `;
        tbody.appendChild(tr);
    });

    // Attach click handler for test detail buttons — use test call array directly
    tbody.querySelectorAll('.test-detail-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const testIdx = parseInt(btn.getAttribute('data-test-index'));
            const call = testCalls[testIdx];
            if (call) openDetailDirect(call);
        });
    });

    // Attach click handler for unmark-test buttons
    tbody.querySelectorAll('.unmark-test-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const callId = btn.getAttribute('data-call-id');
            await toggleTestStatus(callId, false);
        });
    });
}



async function saveNotes() {
    const btn = document.getElementById('save-notes-btn');
    const id = btn.getAttribute('data-id');
    const notes = document.getElementById('modal-notes').value;

    if (!id) return;
    btn.disabled = true;
    btn.textContent = '⌛ Guardando...';

    try {
        const res = await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
            method: 'PATCH',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify([{ Id: id, Notes: notes }])
        });

        if (res.ok) {
            btn.textContent = '✅ Guardado';
            setTimeout(() => {
                btn.textContent = '💾 Guardar Notas';
                btn.disabled = false;
                loadData();
            }, 1500);
        } else {
            throw new Error('Failed to save');
        }
    } catch (err) {
        console.error('Error saving notes:', err);
        btn.textContent = '❌ Error';
        btn.disabled = false;
    }
}

// --- Toggle Test Status ---
async function toggleTestStatus(callId, markAsTest) {
    if (!callId) return;
    const action = markAsTest ? 'marcar como test' : 'quitar de test';
    if (!confirm(`¿Seguro que quieres ${action} esta llamada?`)) return;

    try {
        const res = await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
            method: 'PATCH',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify([{ Id: parseInt(callId), is_test: markAsTest }])
        });

        if (res.ok) {
            // Update local data immediately
            const call = allCalls.find(c => (c.id || c.Id) == callId);
            if (call) call.is_test = markAsTest;
            loadData(true); // Re-render without re-enriching
        } else {
            throw new Error('Failed to update');
        }
    } catch (err) {
        console.error('Error toggling test status:', err);
        alert('Error al actualizar el estado de test');
    }
}
window.toggleTestStatus = toggleTestStatus;

// --- Toggle Contestador Status ---
async function toggleContestadorStatus(callId, phone) {
    if (!callId) return;
    if (!confirm('¿Marcar esta llamada como Contestador Automático? El lead se excluirá de futuras programaciones.')) return;

    try {
        // 1. Update call_logs evaluation
        const res = await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
            method: 'PATCH',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify([{ Id: parseInt(callId), evaluation: 'Contestador' }])
        });

        if (!res.ok) throw new Error('Error al actualizar call_logs');

        // 2. Update local data immediately
        const call = allCalls.find(c => (c.id || c.Id) == callId);
        if (call) call.evaluation = 'Contestador';

        // 3. Update lead status in Leads table by phone
        if (phone) {

            const cleanPhone = phone.replace(/^\+34/, '').replace(/\D/g, '');
            // Try both formats
            for (const searchPhone of [phone, cleanPhone]) {
                try {
                    const searchRes = await fetch(`${API_BASE}/${LEADS_TABLE}/records?where=(phone,like,%25${encodeURIComponent(searchPhone)}%25)&limit=5`, {
                        headers: { 'xc-token': XC_TOKEN }
                    });
                    const searchData = await searchRes.json();
                    if (searchData.list && searchData.list.length > 0) {
                        const lead = searchData.list[0];
                        const leadId = lead.unique_id;
                        await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                            method: 'PATCH',
                            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                            body: JSON.stringify([{ unique_id: leadId, status: 'Contestador' }])
                        });
                        console.log(`[Contestador] Lead ${leadId} marked as Contestador`);
                        break;
                    }
                } catch (e) {
                    console.warn('[Contestador] Error searching lead:', e);
                }
            }
        }

        loadData(true); // Re-render
    } catch (err) {
        console.error('Error toggling contestador status:', err);
        alert('Error al marcar como contestador');
    }
}
window.toggleContestadorStatus = toggleContestadorStatus;

// ── Pagination Controls ──
function renderPagination(totalItems, currentPage, pageSize, totalPages) {
    const container = document.getElementById('call-pagination');
    if (!container) return;
    if (totalItems <= 0) { container.innerHTML = ''; return; }

    const startItem = (currentPage - 1) * pageSize + 1;
    const endItem = Math.min(currentPage * pageSize, totalItems);

    // Build page buttons with ellipsis
    let pageButtons = '';
    const maxVisible = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);

    if (startPage > 1) {
        pageButtons += `<button class="pagination-btn pagination-page" data-page="1">1</button>`;
        if (startPage > 2) pageButtons += `<span class="pagination-ellipsis">…</span>`;
    }
    for (let i = startPage; i <= endPage; i++) {
        pageButtons += `<button class="pagination-btn pagination-page ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) pageButtons += `<span class="pagination-ellipsis">…</span>`;
        pageButtons += `<button class="pagination-btn pagination-page" data-page="${totalPages}">${totalPages}</button>`;
    }

    container.innerHTML = `
        <div class="pagination-bar">
            <div class="pagination-info">
                Mostrando <strong>${startItem}–${endItem}</strong> de <strong>${totalItems}</strong> llamadas
            </div>
            <div class="pagination-controls">
                <button class="pagination-btn pagination-nav" ${currentPage <= 1 ? 'disabled' : ''} data-page="${currentPage - 1}">← Anterior</button>
                ${pageButtons}
                <button class="pagination-btn pagination-nav" ${currentPage >= totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">Siguiente →</button>
            </div>
            <div class="pagination-size">
                <span class="pagination-size-label">Por página:</span>
                <select class="pagination-size-select" id="pagination-page-size">
                    <option value="20" ${pageSize === 20 ? 'selected' : ''}>20</option>
                    <option value="50" ${pageSize === 50 ? 'selected' : ''}>50</option>
                    <option value="100" ${pageSize === 100 ? 'selected' : ''}>100</option>
                </select>
            </div>
        </div>
    `;

    // Event: page buttons
    container.querySelectorAll('.pagination-page').forEach(btn => {
        btn.addEventListener('click', () => {
            paginationPage = parseInt(btn.getAttribute('data-page'));
            loadData(true);
            document.getElementById('call-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });

    // Event: prev/next
    container.querySelectorAll('.pagination-nav').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            paginationPage = parseInt(btn.getAttribute('data-page'));
            loadData(true);
            document.getElementById('call-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });

    // Event: page size selector
    const sizeSelect = container.querySelector('#pagination-page-size');
    if (sizeSelect) {
        sizeSelect.addEventListener('change', () => {
            paginationPageSize = parseInt(sizeSelect.value);
            paginationPage = 1;
            loadData(true);
        });
    }
}

// Event listeners
document.getElementById('refresh-btn').addEventListener('click', loadData);
document.getElementById('filter-company').addEventListener('input', () => { paginationPage = 1; loadData(); });
document.getElementById('filter-score').addEventListener('change', () => { paginationPage = 1; loadData(); });
if (document.getElementById('filter-disposition')) document.getElementById('filter-disposition').addEventListener('change', () => { paginationPage = 1; loadData(); });
document.getElementById('close-modal').addEventListener('click', closeModal);
document.getElementById('save-notes-btn').addEventListener('click', saveNotes);

// --- Copy Call ID to Clipboard (delegated handler for all tables) ---
document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy-id-btn');
    if (!copyBtn) return;
    e.stopPropagation();
    const callId = copyBtn.getAttribute('data-copy-id');
    if (!callId || callId === '-') return;
    navigator.clipboard.writeText(callId).then(() => {
        const original = copyBtn.textContent;
        copyBtn.textContent = '✅';
        copyBtn.style.opacity = '1';
        setTimeout(() => {
            copyBtn.textContent = original;
            copyBtn.style.opacity = '0.6';
        }, 1500);
    }).catch(() => {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = callId;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        const original = copyBtn.textContent;
        copyBtn.textContent = '✅';
        copyBtn.style.opacity = '1';
        setTimeout(() => {
            copyBtn.textContent = original;
            copyBtn.style.opacity = '0.6';
        }, 1500);
    });
});

document.getElementById('call-table').addEventListener('click', async (e) => {
    const target = e.target;
    if (target.closest('.copy-id-btn')) return; // Already handled by delegated handler
    const markTestBtn = target.closest('.mark-test-btn');
    if (markTestBtn) {
        e.stopPropagation();
        const callId = markTestBtn.getAttribute('data-call-id');
        await toggleTestStatus(callId, true);
        return;
    }
    const markContestadorBtn = target.closest('.mark-contestador-btn');
    if (markContestadorBtn) {
        e.stopPropagation();
        const callId = markContestadorBtn.getAttribute('data-call-id');
        const phone = markContestadorBtn.getAttribute('data-phone');
        await toggleContestadorStatus(callId, phone);
        return;
    }
    const actionBtn = target.closest('.action-btn');
    const noteIndicator = target.closest('.note-indicator');
    const clickedElement = actionBtn || noteIndicator;
    if (clickedElement) {
        const index = parseInt(clickedElement.getAttribute('data-index'));
        if (!isNaN(index) && index >= 0 && index < currentCallsPage.length) {
            openDetail(index);
        } else {
            console.warn('[Detail] Invalid index:', index, 'currentCallsPage length:', currentCallsPage.length);
        }
    }
});

document.getElementById('detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'detail-modal' || e.target.classList.contains('modal')) closeModal();
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email-input').value.trim();
    const password = document.getElementById('password-input').value;
    const remember = document.getElementById('remember-me').checked;
    const errorEl = document.getElementById('auth-error');
    const btn = document.getElementById('login-btn');

    errorEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = '⏳ Verificando...';

    try {
        const res = await fetch(AUTH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();

        if (data.success && data.config) {
            // Store session
            const storage = remember ? localStorage : sessionStorage;
            storage.setItem('setter_auth_token', data.token);
            storage.setItem('setter_auth_config', JSON.stringify(data.config));

            applyConfig(data.config);
            showDashboard();
        } else {
            errorEl.textContent = data.error || 'Error de autenticación';
            errorEl.style.display = 'block';
        }
    } catch (err) {
        console.error('Login error:', err);
        errorEl.textContent = 'Error de conexión. Inténtalo de nuevo.';
        errorEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Entrar';
    }
});

// Logout
document.getElementById('logout-btn')?.addEventListener('click', () => {
    localStorage.removeItem('setter_auth_token');
    localStorage.removeItem('setter_auth_config');
    sessionStorage.removeItem('setter_auth_token');
    sessionStorage.removeItem('setter_auth_config');
    location.reload();
});

function showDashboard() {
    document.body.classList.remove('auth-hidden');
    document.getElementById('login-gate').style.display = 'none';

    // Initialize Flatpickr
    dateFilter = flatpickr("#date-range", {
        mode: "range",
        dateFormat: "Y-m-d",
        locale: "es",
        maxDate: "today",
        onChange: function (selectedDates, dateStr) {
            if (selectedDates.length === 2) {
                paginationPage = 1;
                loadData();
            }
        }
    });

    // Initialize tabs and load only the active tab's data (lazy loading)
    if (!window.tabsInitialized) {
        initTabs();
        initBulkImport();
        initAutomationToggle();
        window.tabsInitialized = true;
    }

    const activeHash = location.hash.replace('#', '') || 'dashboard';
    switchToTab(activeHash);
}

async function checkAuth() {
    // Try to restore session from storage
    const token = localStorage.getItem('setter_auth_token') || sessionStorage.getItem('setter_auth_token');
    const cachedConfig = localStorage.getItem('setter_auth_config') || sessionStorage.getItem('setter_auth_config');

    if (!token) return; // No session, show login

    // Apply cached config immediately for instant load
    if (cachedConfig) {
        try {
            applyConfig(JSON.parse(cachedConfig));
            showDashboard();
        } catch (e) { /* ignore parse errors */ }
    }

    // Verify token in background (refresh config if needed)
    try {
        const res = await fetch(VERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        const data = await res.json();

        if (data.success && data.config) {
            applyConfig(data.config);
            // Update cached config
            const storage = localStorage.getItem('setter_auth_token') ? localStorage : sessionStorage;
            storage.setItem('setter_auth_config', JSON.stringify(data.config));
            if (!cachedConfig) showDashboard(); // Show if not already shown
        } else {
            // Token invalid — clear and show login
            localStorage.removeItem('setter_auth_token');
            localStorage.removeItem('setter_auth_config');
            sessionStorage.removeItem('setter_auth_token');
            sessionStorage.removeItem('setter_auth_config');
            if (cachedConfig) location.reload(); // Reload to show login
        }
    } catch (err) {
        console.warn('Token verify failed (offline?):', err);
        // If we have cached config, continue with it (offline mode)
    }
}

checkAuth();

// --- Timezone Helper ---
// Convert a datetime-local input value (local time) to UTC string for NocoDB
// Input: '2026-02-12T13:00' (local CET) → Output: '2026-02-12 12:00:00' (UTC)
function localDatetimeToUTC(datetimeLocalValue) {
    if (!datetimeLocalValue) return null;
    const localDate = new Date(datetimeLocalValue); // parses as local time
    const utcYear = localDate.getUTCFullYear();
    const utcMonth = String(localDate.getUTCMonth() + 1).padStart(2, '0');
    const utcDay = String(localDate.getUTCDate()).padStart(2, '0');
    const utcHours = String(localDate.getUTCHours()).padStart(2, '0');
    const utcMinutes = String(localDate.getUTCMinutes()).padStart(2, '0');
    return `${utcYear}-${utcMonth}-${utcDay} ${utcHours}:${utcMinutes}:00`;
}

// Convert a UTC date string from NocoDB to a datetime-local input value (local time)
// Input: '2026-02-12 12:00:00' (UTC) → Output: '2026-02-12T13:00' (local CET)
function utcToLocalDatetime(utcStr) {
    if (!utcStr) return '';
    // Parse as UTC — handle formats: '...Z', '...+00:00', '...+01:00', or bare '...'
    const normalized = utcStr.replace(' ', 'T');
    const hasTimezone = /[Zz]$/.test(normalized) || /[+-]\d{2}:\d{2}$/.test(normalized);
    const asUTC = hasTimezone ? normalized : normalized + 'Z';
    const d = new Date(asUTC);
    if (isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// Convert a UTC date string to a local Date object for display/comparison
function utcStringToLocalDate(utcStr) {
    if (!utcStr) return new Date(NaN);
    const normalized = utcStr.replace(' ', 'T');
    const hasTimezone = /[Zz]$/.test(normalized) || /[+-]\d{2}:\d{2}$/.test(normalized);
    const asUTC = hasTimezone ? normalized : normalized + 'Z';
    return new Date(asUTC);
}

// --- Manual Vapi Call Integration ---
// VAPI_ASSISTANT_ID and VAPI_PHONE_NUMBER_ID come from window.APP_CONFIG

function normalizePhone(phone) {
    let p = phone.toString().replace(/\D/g, '');
    if (!p) return '';
    // Vapi requires E.164 (+CCNUMBER)
    // Note: Zadarma routing fix is done via Zadarma Calling Rules (strip leading 34)
    return p.startsWith('34') ? '+' + p : '+34' + p;
}

async function triggerManualCall() {
    const name = document.getElementById('manual-lead-name').value;
    const phone = document.getElementById('manual-phone').value;
    const locality = document.getElementById('manual-locality').value;
    const assistantId = document.getElementById('manual-assistant').value;
    const isScheduled = document.getElementById('manual-schedule-toggle').checked;
    const scheduledTime = document.getElementById('manual-schedule-time').value;
    const feedback = document.getElementById('call-feedback');
    const btn = document.getElementById('trigger-call-btn');

    if (!name || !phone || !locality) {
        feedback.textContent = '❌ Por favor, rellena todos los campos (incluyendo localidad)';
        feedback.className = 'feedback-error';
        return;
    }

    if (isScheduled && !scheduledTime) {
        feedback.textContent = '❌ Por favor, elige una hora para programar';
        feedback.className = 'feedback-error';
        return;
    }

    const formattedPhone = normalizePhone(phone);
    btn.disabled = true;

    if (isScheduled) {
        // --- SCHEDULE FOR LATER ---
        btn.textContent = '⌛ Programando Llamada...';
        feedback.textContent = 'Guardando programación en NocoDB...';
        feedback.className = 'feedback-loading';

        try {

            const leadPayload = {
                unique_id: 'lead_' + Date.now(),
                name: name,
                phone: formattedPhone,
                email: '',
                sector: '',
                Localidad: locality,
                summary: '',
                address: '',
                status: 'Programado',
                assistant_id: assistantId,
                fecha_planificada: localDatetimeToUTC(scheduledTime)
            };

            console.log('Scheduling lead payload:', JSON.stringify(leadPayload));

            const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                method: 'POST',
                headers: {
                    'xc-token': XC_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(leadPayload)
            });

            if (res.ok) {
                feedback.textContent = '📅 ¡Llamada programada con éxito!';
                feedback.className = 'feedback-success';
                setTimeout(() => {
                    closeManualModal();
                    invalidateLeadsCache();
                    loadData();
                    fetchScheduledLeads();
                    renderScheduledCallsInScheduler();
                }, 2000);
            } else {
                const errBody = await res.json();
                console.error('NocoDB Schedule Error Response:', res.status, errBody);
                throw new Error(errBody.msg || errBody.message || `Error ${res.status} al guardar`);
            }
        } catch (err) {
            console.error('Schedule Error:', err);
            feedback.textContent = `❌ Error: ${err.message}`;
            feedback.className = 'feedback-error';
        } finally {
            btn.disabled = false;
            btn.textContent = '📅 Programar Llamada';
        }
        return;
    }

    // --- IMMEDIATE CALL ---
    btn.textContent = '⌛ Verificando disponibilidad...';
    feedback.textContent = 'Comprobando llamadas activas...';
    feedback.className = 'feedback-loading';

    // helper: append a log line to feedback
    const log = (icon, msg, cls = '') => {
        const line = document.createElement('div');
        line.style.cssText = 'font-size:12px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05);text-align:left;';
        if (cls) line.style.color = cls === 'ok' ? '#4ade80' : cls === 'err' ? '#f87171' : '#facc15';
        line.textContent = `${icon} ${msg}`;
        feedback.appendChild(line);
    };

    try {
        feedback.innerHTML = '';
        feedback.className = '';
        feedback.style.cssText = 'background:rgba(0,0,0,0.3);border-radius:8px;padding:10px 14px;margin-top:12px;max-height:260px;overflow-y:auto;font-family:monospace;';
        log('🔍', `Teléfono: ${formattedPhone}`);
        log('🤖', `Asistente: ${assistantId}`);
        log('📡', `Phone Number ID: ${VAPI_PHONE_NUMBER_ID}`);

        // ⚠️ CRITICAL: Check concurrency limit before launching
        log('⏳', 'Comprobando llamadas activas en Vapi...');
        try {
            const checkRes = await fetch(`${VAPI_API_BASE}/call?limit=100`, {
                headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
            });
            if (checkRes.ok) {
                const allCalls = await checkRes.json();
                const activeCalls = (Array.isArray(allCalls) ? allCalls : []).filter(c =>
                    ['queued', 'ringing', 'in-progress'].includes(c.status)
                );
                const MAX_CONCURRENT = 10;
                if (activeCalls.length >= MAX_CONCURRENT) {
                    log('🚫', `Límite alcanzado: ${activeCalls.length}/${MAX_CONCURRENT} activas`, 'err');
                    btn.disabled = false;
                    btn.textContent = '🚀 Lanzar Llamada';
                    return;
                }
                log('✅', `Concurrencia OK: ${activeCalls.length}/${MAX_CONCURRENT} activas`, 'ok');
            } else {
                log('⚠️', `No se pudo comprobar concurrencia (HTTP ${checkRes.status})`, 'warn');
            }
        } catch (checkErr) {
            log('⚠️', `Error comprobando concurrencia: ${checkErr.message}`, 'warn');
        }

        btn.textContent = '⌛ Iniciando Llamada...';

        // 1. Call Vapi AI with SIP retry logic
        const MAX_CALL_RETRIES = 3;
        const RETRY_BACKOFF_BASE = 5000;
        let vapiData = null;

        for (let attempt = 1; attempt <= MAX_CALL_RETRIES; attempt++) {
            if (attempt > 1) log('🔄', `Reintento ${attempt}/${MAX_CALL_RETRIES}...`, 'warn');

            // Vapi API STRICTLY requires E164 format (with the '+' prefix).
            // We cannot strip it here. The double '34' issue MUST be fixed inside Zadarma's SIP settings (Dial Prefix).
            const extPhone = formattedPhone;


            const vapiPayload = {
                customer: {
                    number: extPhone,
                },
                assistantId: assistantId,
                phoneNumberId: VAPI_PHONE_NUMBER_ID,
                assistantOverrides: {
                    variableValues: {
                        nombre: name,
                        tel_contacto: extPhone,
                        ciudad: locality,
                        leadId: 'manual_' + Date.now(),
                        fecha_hoy: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }),
                        dia_semana: new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long' })
                    }
                }
            };
            log('📤', 'POST /call payload:');
            const payloadPre = document.createElement('pre');
            payloadPre.style.cssText = 'font-size:10px;color:#93c5fd;background:rgba(0,0,0,0.5);padding:8px;border-radius:6px;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:4px 0;';
            payloadPre.textContent = JSON.stringify(vapiPayload, null, 2);
            feedback.appendChild(payloadPre);

            const vapiRes = await fetch(`${VAPI_API_BASE}/call`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VAPI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(vapiPayload)
            });

            vapiData = await vapiRes.json();
            // ── FULL RESPONSE LOG ──
            const fullJson = JSON.stringify(vapiData, null, 2);
            log(vapiRes.ok ? '✅' : '❌', `Vapi HTTP ${vapiRes.status}`, vapiRes.ok ? 'ok' : 'err');
            // Render full JSON in a pre block for readability
            const preBlock = document.createElement('pre');
            preBlock.style.cssText = 'font-size:10px;color:#e2e8f0;background:rgba(0,0,0,0.5);padding:8px;border-radius:6px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:4px 0;';
            preBlock.textContent = fullJson;
            feedback.appendChild(preBlock);

            if (!vapiRes.ok) {
                const rawMsg = vapiData.message || vapiData.error || vapiData;
                const errMsg = Array.isArray(rawMsg) ? rawMsg.join(', ') : String(rawMsg);
                const isSipError = errMsg.toLowerCase().includes('sip') ||
                    errMsg.includes('503') ||
                    errMsg.toLowerCase().includes('rate') ||
                    vapiRes.status === 429 || vapiRes.status === 503;

                if (isSipError && attempt < MAX_CALL_RETRIES) {
                    const waitMs = RETRY_BACKOFF_BASE * Math.pow(2, attempt - 1);
                    log('⚠️', `Error SIP — esperando ${waitMs / 1000}s antes de reintentar...`, 'warn');
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }
                throw new Error(errMsg);
            }
            log('🎉', `Llamada creada! Call ID: ${vapiData.id}`, 'ok');

            // ── CALL STATUS POLLING (30s, every 3s) ──
            log('📡', 'Monitorizando estado de la llamada en tiempo real...', 'warn');
            const callId = vapiData.id;
            const POLL_INTERVAL = 3000;
            const POLL_DURATION = 30000;
            const pollStart = Date.now();
            let lastStatus = '';
            while (Date.now() - pollStart < POLL_DURATION) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
                try {
                    const statusRes = await fetch(`${VAPI_API_BASE}/call/${callId}`, {
                        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
                    });
                    const statusData = await statusRes.json();
                    const status = statusData.status || 'unknown';
                    const endedReason = statusData.endedReason || '';
                    const sipCode = statusData.costs?.find(c => c.type === 'transport')?.sipCode || '';
                    const phoneNum = statusData.phoneNumber || {};
                    const transport = statusData.transport || {};

                    const statusLine = `Estado: ${status}` +
                        (endedReason ? ` | Razón: ${endedReason}` : '') +
                        (sipCode ? ` | SIP Code: ${sipCode}` : '');

                    if (status !== lastStatus) {
                        const color = status === 'ended' ? (endedReason.includes('error') ? 'err' : 'ok') :
                            status === 'in-progress' ? 'ok' :
                                status === 'ringing' ? 'ok' : 'warn';
                        log('📊', statusLine, color);

                        // On first status change, show transport/phone details once
                        if (!lastStatus) {
                            if (Object.keys(transport).length) {
                                log('🔌', `Transport: ${JSON.stringify(transport)}`, 'warn');
                            }
                            if (Object.keys(phoneNum).length) {
                                log('📞', `Phone Config: provider=${phoneNum.provider || 'N/A'}, number=${phoneNum.number || 'N/A'}, sipUri=${phoneNum.sipUri || 'N/A'}`, 'warn');
                            }
                        }
                        lastStatus = status;
                    }

                    // If call ended, show full final status
                    if (status === 'ended') {
                        log('🏁', 'Llamada finalizada. Respuesta completa:', endedReason.includes('error') ? 'err' : 'ok');
                        const finalPre = document.createElement('pre');
                        finalPre.style.cssText = 'font-size:10px;color:#fbbf24;background:rgba(0,0,0,0.5);padding:8px;border-radius:6px;max-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:4px 0;';
                        // Show key diagnostic fields
                        const diagnosticData = {
                            id: statusData.id,
                            status: statusData.status,
                            endedReason: statusData.endedReason,
                            startedAt: statusData.startedAt,
                            endedAt: statusData.endedAt,
                            type: statusData.type,
                            transport: statusData.transport,
                            phoneNumber: statusData.phoneNumber,
                            customer: statusData.customer,
                            costs: statusData.costs,
                            messages: statusData.messages?.slice(0, 5), // first 5 messages
                        };
                        finalPre.textContent = JSON.stringify(diagnosticData, null, 2);
                        feedback.appendChild(finalPre);
                        break;
                    }
                } catch (pollErr) {
                    log('⚠️', `Error polling: ${pollErr.message}`, 'warn');
                }
            }
            if (Date.now() - pollStart >= POLL_DURATION && lastStatus !== 'ended') {
                log('⏱️', `Polling terminado (30s). Último estado: ${lastStatus || 'sin respuesta'}`, 'warn');
            }

            break;
        }

        // 2. Log to NocoDB
        log('💾', `Registrando en NocoDB (table: ${CALL_LOGS_TABLE})...`);
        const logPayload = {
            vapi_call_id: vapiData.id,
            lead_name: name,
            phone_called: formattedPhone,
            call_time: new Date().toISOString(),
            ended_reason: 'Manual Trigger'
        };
        log('📤', `NocoDB payload: ${JSON.stringify(logPayload)}`);

        const logRes = await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
            method: 'POST',
            headers: {
                'xc-token': XC_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(logPayload)
        });
        const logBody = await logRes.json();
        log(logRes.ok ? '✅' : '❌', `NocoDB HTTP ${logRes.status}: ${JSON.stringify(logBody)}`, logRes.ok ? 'ok' : 'err');

        if (logRes.ok) {
            log('🚀', '¡LLAMADA LANZADA CON ÉXITO! El modal permanece abierto.', 'ok');
            btn.textContent = '✅ Llamada en curso';
            btn.style.background = 'var(--accent)';
            loadData(); // refresh dashboard in background

            // 3. Clear scheduled status
            try {
                const rawPhone = document.getElementById('manual-phone').value.trim();
                const normalizedPhone = normalizePhone(formattedPhone);
                log('🔍', `Buscando lead para limpiar fecha_planificada: ${rawPhone}`);

                let searchRes = await fetch(`${API_BASE}/${LEADS_TABLE}/records?where=(phone,eq,${encodeURIComponent(rawPhone)})`, {
                    headers: { 'xc-token': XC_TOKEN }
                });
                let searchData = await searchRes.json();
                let leadToClear = searchData.list && searchData.list[0];

                if (!leadToClear && normalizedPhone !== rawPhone) {
                    searchRes = await fetch(`${API_BASE}/${LEADS_TABLE}/records?where=(phone,eq,${encodeURIComponent(normalizedPhone)})`, {
                        headers: { 'xc-token': XC_TOKEN }
                    });
                    searchData = await searchRes.json();
                    leadToClear = searchData.list && searchData.list[0];
                }

                if (leadToClear && leadToClear.fecha_planificada) {
                    const leadId = leadToClear.unique_id;
                    await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                        method: 'PATCH',
                        headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                        body: JSON.stringify([{ unique_id: leadId, fecha_planificada: null }])
                    });
                    log('✅', `Lead ${leadId} — fecha_planificada limpiada`, 'ok');
                    setTimeout(fetchScheduledLeads, 500);
                } else {
                    log('ℹ️', 'No hay lead programado que limpiar para este teléfono');
                }
            } catch (e) {
                log('⚠️', `Error limpiando lead: ${e.message}`, 'warn');
            }
        } else {
            throw new Error(`NocoDB error ${logRes.status}: ${JSON.stringify(logBody)}`);
        }

    } catch (err) {
        console.error('Manual Call Error:', err);
        log('❌', `ERROR FATAL: ${err.message}`, 'err');
    } finally {
        btn.disabled = false;
        if (btn.textContent.includes('Iniciando') || btn.textContent.includes('Verificando')) {
            btn.textContent = '🚀 Lanzar Llamada';
        }
    }
}


function openManualModal() {
    document.getElementById('manual-call-modal').style.display = 'flex';
    document.getElementById('manual-lead-name').value = '';
    document.getElementById('manual-phone').value = '';
    document.getElementById('manual-locality').value = '';
    document.getElementById('manual-schedule-toggle').checked = false;
    document.getElementById('manual-schedule-fields').style.display = 'none';
    document.getElementById('trigger-call-btn').textContent = '🚀 Lanzar Llamada';
    document.getElementById('call-feedback').textContent = '';

    // Default time + 5 min
    const now = new Date();
    now.setMinutes(now.getMinutes() + 5);
    const tzOffset = now.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(now - tzOffset)).toISOString().slice(0, 16);
    document.getElementById('manual-schedule-time').value = localISOTime;
}

function closeManualModal() {
    document.getElementById('manual-call-modal').style.display = 'none';
}

document.getElementById('manual-call-fab').addEventListener('click', openManualModal);
document.getElementById('close-manual-modal').addEventListener('click', closeManualModal);
document.getElementById('trigger-call-btn').addEventListener('click', triggerManualCall);

// Toggle listeners
document.getElementById('manual-schedule-toggle').addEventListener('change', (e) => {
    const fields = document.getElementById('manual-schedule-fields');
    const btn = document.getElementById('trigger-call-btn');
    if (e.target.checked) {
        fields.style.display = 'block';
        btn.textContent = '📅 Programar Llamada';
        btn.style.background = 'var(--accent)';
    } else {
        fields.style.display = 'none';
        btn.textContent = '🚀 Lanzar Llamada';
        btn.style.background = 'var(--success)';
    }
});

document.getElementById('manual-call-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('manual-call-modal')) {
        closeManualModal();
    }
});

// --- Retry Call with Context ---
window._retryCall = async function () {
    if (!activeDetailCall) return;

    const vapiId = activeDetailCall.vapi_call_id || activeDetailCall.lead_id || '';
    const phone = activeDetailCall.phone_called;
    const retryBtn = document.getElementById('retry-call-btn');
    const retryFeedback = document.getElementById('retry-feedback');

    if (!vapiId.startsWith('019') || !phone) {
        retryFeedback.style.display = 'block';
        retryFeedback.textContent = '❌ No se puede rellamar: falta el ID de Vapi o el teléfono';
        retryFeedback.style.color = 'var(--danger)';
        return;
    }

    if (!confirm(`¿Lanzar rellamada con contexto a ${phone}?`)) return;

    retryBtn.disabled = true;
    retryFeedback.style.display = 'block';
    retryFeedback.textContent = '⏳ Obteniendo contexto de la llamada anterior...';
    retryFeedback.style.color = 'var(--accent)';

    try {
        // 1. Get previous call details from Vapi
        const vapiRes = await fetch(`${VAPI_API_BASE}/call/${vapiId}`, {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (!vapiRes.ok) throw new Error('No se pudo obtener la llamada anterior');
        const previousCall = await vapiRes.json();

        // 2. Extract context
        const transcript = previousCall.artifact?.transcript || previousCall.transcript || '';
        const analysis = previousCall.analysis?.summary || '';
        const duration = previousCall.endedAt && previousCall.startedAt
            ? Math.round((new Date(previousCall.endedAt) - new Date(previousCall.startedAt)) / 1000) : 0;
        const endedReason = previousCall.endedReason || 'unknown';

        // Parse user messages for interest signals
        const lines = transcript.split('\n').filter(l => l.trim());
        const userMsgs = lines.filter(l => l.startsWith('User:') || l.startsWith('user:'))
            .map(l => l.replace(/^(User|user):\s*/, ''));
        const interestSignals = ['interesa', 'sí', 'cuéntame', 'dime', 'vale', 'ok', 'de acuerdo', 'claro'];
        const customerInterested = userMsgs.some(msg =>
            interestSignals.some(signal => msg.toLowerCase().includes(signal))
        );

        // Extract customer name
        let customerName = '';
        for (const msg of userMsgs) {
            const m = msg.match(/(?:soy|me llamo)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){0,2})/i);
            if (m) { customerName = m[1].trim(); break; }
        }

        // Determine last topic
        let lastTopic = 'el programa de partners';
        const aiMsgs = lines.filter(l => l.startsWith('AI:') || l.startsWith('bot:'))
            .map(l => l.replace(/^(AI|bot):\s*/, ''));
        if (aiMsgs.some(m => m.toLowerCase().includes('servicio de seguridad'))) lastTopic = 'si ofrecéis servicios de seguridad';
        if (aiMsgs.some(m => m.toLowerCase().includes('cibersafe') || m.toLowerCase().includes('cibersteps'))) lastTopic = 'CiberSafe y CiberSteps';
        if (aiMsgs.some(m => m.toLowerCase().includes('email') || m.toLowerCase().includes('correo'))) lastTopic = 'el envío de información por email';

        // 3. Build retry first message
        const nameGreeting = customerName ? `${customerName}, ` : '';
        let retryFirstMessage;
        if (customerInterested) {
            retryFirstMessage = `Hola ${nameGreeting}soy Violeta de General Protec Ciberseguridad. Te llamé hace un momento y parece que se cortó la comunicación. Me habías dicho que te interesaba, ¿verdad? Retomo donde lo dejamos rapidísimo.`;
        } else if (duration < 15) {
            retryFirstMessage = `Hola, soy Violeta de General Protec Ciberseguridad. Intenté llamarte hace un momento pero parece que se cortó antes de poder explicarme bien. ¿Tienes un minuto? Es brevísimo.`;
        } else {
            retryFirstMessage = `Hola ${nameGreeting}soy Violeta de General Protec Ciberseguridad. Disculpa, parece que se cortó nuestra llamada. Te estaba comentando sobre ${lastTopic}. ¿Seguimos?`;
        }

        // 4. Build system prompt addition
        const endReason = endedReason === 'customer-ended-call' ? 'la llamada se cortó'
            : endedReason.includes('error') ? 'hubo un problema técnico' : 'la llamada terminó';

        const retryPromptAddition = `\n\n## CONTEXTO DE RELLAMADA (IMPORTANTE)
Esta es una RELLAMADA. Ya hablaste con este contacto hace unos minutos y la llamada se cortó.

### Lo que pasó en la llamada anterior:
${analysis || 'Se cortó la comunicación durante la conversación.'}

### Estado de la conversación anterior:
- Duración: ${duration} segundos
- El cliente mostró interés: ${customerInterested ? 'SÍ' : 'No determinado'}
- Último tema tratado: ${lastTopic}
- Motivo del corte: ${endReason}
${customerName ? `- Nombre del interlocutor: ${customerName}` : ''}

### Transcripción de la llamada anterior:
${transcript || 'No disponible'}

### INSTRUCCIONES PARA ESTA RELLAMADA:
1. NO repitas toda la presentación desde cero.
2. Haz referencia a que se cortó la llamada anterior.
3. Retoma donde lo dejaste. Si dijo "interesa", pasa directo a dar valor y recoger datos.
4. Si el cliente ya se identificó, usa su nombre.
5. Sé más conciso y directo que en una primera llamada.`;

        // 5. Check concurrency
        retryFeedback.textContent = '⏳ Verificando disponibilidad...';
        const checkRes = await fetch(`${VAPI_API_BASE}/call?limit=100`, {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (checkRes.ok) {
            const allVapiCalls = await checkRes.json();
            const activeCalls = (Array.isArray(allVapiCalls) ? allVapiCalls : [])
                .filter(c => ['queued', 'ringing', 'in-progress'].includes(c.status));
            if (activeCalls.length >= 10) {
                retryFeedback.textContent = `🚫 Límite de concurrencia alcanzado: ${activeCalls.length}/10`;
                retryFeedback.style.color = 'var(--danger)';
                retryBtn.disabled = false;
                return;
            }
        }

        // 6. Get current assistant config for the model override
        retryFeedback.textContent = '⏳ Preparando rellamada...';
        const assistantRes = await fetch(`${VAPI_API_BASE}/assistant/${VAPI_ASSISTANT_ID}`, {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        const assistant = await assistantRes.json();
        const currentPrompt = assistant.model?.messages?.[0]?.content || '';

        // 7. Launch the retry call
        retryFeedback.textContent = '🚀 Lanzando rellamada...';
        const formattedPhone = normalizePhone(phone);

        const callRes = await fetch(`${VAPI_API_BASE}/call`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${VAPI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                customer: { number: formattedPhone },
                assistantId: VAPI_ASSISTANT_ID,
                phoneNumberId: VAPI_PHONE_NUMBER_ID,
                assistantOverrides: {
                    firstMessage: retryFirstMessage,
                    model: {
                        ...assistant.model,
                        messages: [{
                            role: 'system',
                            content: currentPrompt + retryPromptAddition
                        }]
                    },
                    variableValues: {
                        nombre: customerName || activeDetailCall.lead_name || 'Cliente',
                        empresa: activeDetailCall.lead_name || '',
                        tel_contacto: formattedPhone,
                        ciudad: activeDetailCall.locality || activeDetailCall.address || 'tu zona',
                        fecha_hoy: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }),
                        dia_semana: new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long' })
                    }
                }
            })
        });

        const callData = await callRes.json();
        if (!callRes.ok) throw new Error(callData.message || 'Error de Vapi');

        // 8. Log to NocoDB
        await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
            method: 'POST',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vapi_call_id: callData.id,
                lead_name: activeDetailCall.lead_name || 'Rellamada',
                phone_called: formattedPhone,
                call_time: new Date().toISOString(),
                ended_reason: `Retry: ${vapiId.substring(0, 12)}...`,
                Notes: `Rellamada con contexto. Anterior: ${vapiId}. Interés: ${customerInterested ? 'Sí' : 'No'}. ${customerName ? 'Contacto: ' + customerName : ''}`
            })
        });

        retryFeedback.textContent = `✅ ¡Rellamada lanzada! ID: ${callData.id.substring(0, 12)}...`;
        retryFeedback.style.color = 'var(--success)';

        setTimeout(() => {
            closeModal();
            loadData();
        }, 3000);

    } catch (err) {
        console.error('Retry call error:', err);
        retryFeedback.textContent = `❌ Error: ${err.message}`;
        retryFeedback.style.color = 'var(--danger)';
    } finally {
        retryBtn.disabled = false;
    }
};

// --- Transcript Extraction Logic ---

function extractInfoFromTranscript(text) {
    if (!text) return { name: '', email: '', phone: '' };

    const lines = text.split('\n');
    let email = '', phone = '', name = '';

    // Standard Email Regex
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    // Spanish Phone Regex
    const phoneRegex = /(?:\+34|0034|34)?[ -]?(?:[6789]\d{8}|[6789]\d{2}[ -]\d{3}[ -]\d{3}|[6789]\d{2}[ -]\d{2}[ -]\d{2}[ -]\d{2})/;
    // Name Heuristics (Simplified and case-insensitive)
    const nameHeuristics = [
        /soy\s+([A-ZÁÉÍÓÚÑa-z]+(?:\s+[A-ZÁÉÍÓÚÑa-z]+){0,4})/i,
        /me llamo\s+([A-ZÁÉÍÓÚÑa-z]+(?:\s+[A-ZÁÉÍÓÚÑa-z]+){0,4})/i,
        /soy el\s+([A-ZÁÉÍÓÚÑa-z]+(?:\s+[A-ZÁÉÍÓÚÑa-z]+){0,4})/i,
        /soy la\s+([A-ZÁÉÍÓÚÑa-z]+(?:\s+[A-ZÁÉÍÓÚÑa-z]+){0,4})/i,
        /nombre es\s+([A-ZÁÉÍÓÚÑa-z]+(?:\s+[A-ZÁÉÍÓÚÑa-z]+){0,4})/i
    ];

    for (const line of lines) {
        const isUser = line.toLowerCase().includes('user:') || line.toLowerCase().includes('lead:');

        // Extract Email
        if (!email) {
            const m = line.match(emailRegex);
            if (m) email = m[0];
        }

        // Extract Phone
        if (!phone) {
            const m = line.match(phoneRegex);
            if (m) phone = m[0].trim();
        }

        // Extract Name (Prioritize User lines)
        if (!name || (isUser && name.toLowerCase().includes('violeta'))) {
            for (const regex of nameHeuristics) {
                const m = line.match(regex);
                if (m && m[1]) {
                    const detected = m[1].trim();
                    const lower = detected.toLowerCase();
                    if (!['violeta', 'marcos', 'asistente', 'compañera'].some(forbidden => lower.includes(forbidden))) {
                        name = detected;
                        break;
                    }
                }
            }
        }
    }

    return { email, phone, name };
}

document.getElementById('extract-transcript-btn').addEventListener('click', () => {
    const transcript = document.getElementById('modal-transcript').textContent;
    const notes = document.getElementById('modal-notes').value || '';
    // Combine transcript + notes for broader extraction
    const combined = transcript + '\n' + notes;
    const results = extractInfoFromTranscript(combined);
    const feedback = document.getElementById('extraction-feedback');

    // Pre-fill phone from the call's phone_called if not detected
    if (!results.phone && activeDetailCall) {
        results.phone = activeDetailCall.phone_called || '';
    }
    // Pre-fill name from lead_name if not detected
    if (!results.name && activeDetailCall) {
        results.name = activeDetailCall.lead_name || '';
    }

    document.getElementById('ext-name').value = results.name;
    document.getElementById('ext-email').value = results.email;
    document.getElementById('ext-phone').value = results.phone;

    document.getElementById('extraction-results').style.display = 'block';
    feedback.textContent = '✨ Analisis completado. Revisa los datos y pulsa Guardar como Validados.';
    feedback.style.color = 'var(--accent)';
});

document.getElementById('apply-extraction-btn').addEventListener('click', async () => {
    if (!activeDetailCall) return;

    const btn = document.getElementById('apply-extraction-btn');
    const feedback = document.getElementById('extraction-feedback');

    const name = document.getElementById('ext-name').value;
    const email = document.getElementById('ext-email').value;
    const phone = document.getElementById('ext-phone').value;

    if (!name && !email && !phone) {
        feedback.textContent = '⚠️ Introduce al menos un dato (nombre, email o telefono).';
        feedback.style.color = 'var(--warning)';
        return;
    }

    btn.disabled = true;
    btn.textContent = '⌛ Guardando datos validados...';
    feedback.textContent = '';

    try {
        const vapiCallId = activeDetailCall.vapi_call_id || activeDetailCall.lead_id || activeDetailCall.id || activeDetailCall.Id;
        const callRecordId = activeDetailCall.id || activeDetailCall.Id;
        const resolvedPhone = phone || activeDetailCall.phone_called || '';

        // 1. Save to Confirmed Data table (CONFIRMED_TABLE)
        const confirmedPayload = {
            'Vapi Call ID': vapiCallId,
            'Nombre Confirmado': name,
            'Telefono Confirmado': resolvedPhone,
            'Email Confirmado': email,
            'notas': `Validado manualmente desde dashboard. ${new Date().toLocaleString('es-ES')}`
        };

        const confRes = await fetch(`${API_BASE}/${CONFIRMED_TABLE}/records`, {
            method: 'POST',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify(confirmedPayload)
        });

        if (!confRes.ok) {
            const errData = await confRes.json().catch(() => ({}));
            throw new Error(`Error al guardar datos confirmados: ${errData.msg || confRes.status}`);
        }

        // 2. Mark the call as confirmed in the Call Logs table
        if (callRecordId) {
            await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
                method: 'PATCH',
                headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify([{
                    id: callRecordId,
                    'Data Confirmada': true,
                    evaluation: activeDetailCall.evaluation === 'Pendiente' || !activeDetailCall.evaluation ? 'Confirmada \u2713' : activeDetailCall.evaluation
                }])
            }).catch(err => console.warn('Non-critical: failed to update call log confirmation flag:', err));
        }

        // 3. Update local confirmedDataMap
        confirmedDataMap[vapiCallId] = {
            name: sanitizeName(name),
            rawPhone: resolvedPhone,
            email: sanitizeEmail(email)
        };

        // 4. Also update the Lead in the Leads table (best effort)
        try {

            const phoneCalled = activeDetailCall.phone_called;
            const normalizedSearch = normalizePhone(phoneCalled);
            const query = `(phone,eq,${encodeURIComponent(normalizedSearch)})`;
            const searchRes = await fetch(`${API_BASE}/${LEADS_TABLE}/records?where=${query}`, {
                headers: { 'xc-token': XC_TOKEN }
            });
            const searchData = await searchRes.json();
            const lead = searchData.list && searchData.list[0];

            if (lead) {
                const leadId = lead.id || lead.Id;
                await fetch(`${API_BASE}/${LEADS_TABLE}/records/${leadId}`, {
                    method: 'PATCH',
                    headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: name || lead.name,
                        email: email || lead.email,
                        status: 'Interesado'
                    })
                });
            }
        } catch (leadErr) {
            console.warn('Non-critical: failed to update lead:', leadErr);
        }

        feedback.textContent = '\u2705 Datos guardados como validados!';
        feedback.style.color = 'var(--success)';

        // Update the confirmed section in the modal immediately
        const confirmedSec = document.getElementById('confirmed-section');
        if (confirmedSec) {
            confirmedSec.style.display = 'block';
            document.getElementById('conf-name').textContent = name || '-';
            document.getElementById('conf-phone').textContent = resolvedPhone || '-';
            document.getElementById('conf-email').textContent = email || '-';
        }

        setTimeout(() => {
            document.getElementById('extraction-results').style.display = 'none';
            loadData();
        }, 2000);

    } catch (err) {
        console.error('Save Confirmed Data Error:', err);
        feedback.textContent = `\u274c ${err.message}`;
        feedback.style.color = 'var(--danger)';
    } finally {
        btn.disabled = false;
        btn.textContent = '\ud83d\udcbe Guardar como Datos Validados';
    }
});

// --- Live Clock & Timer Logic ---
function updatePlannedTimers() {
    const timers = document.querySelectorAll('.planned-card-timer, .planned-row-timer, .planned-next-timer');
    if (timers.length === 0) return;

    const now = new Date();

    timers.forEach(timer => {
        const scheduledStr = timer.getAttribute('data-scheduled');
        if (!scheduledStr) return;

        const scheduledAt = utcStringToLocalDate(scheduledStr);
        if (isNaN(scheduledAt.getTime())) return;
        const diff = scheduledAt - now;
        const span = timer.querySelector('span') || timer;

        if (diff <= 0) {
            const overdueMinutes = Math.abs(Math.floor(diff / 60000));
            if (overdueMinutes < 2) {
                span.textContent = '⏳ Lanzando...';
            } else {
                span.textContent = `⏰ -${overdueMinutes}min`;
            }
            span.className = 'timer-urgent';
            return;
        }

        const totalSeconds = Math.floor(diff / 1000);
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;

        const timeStr = `${h > 0 ? h + 'h ' : ''}${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
        span.textContent = timer.classList.contains('planned-next-timer') ? `⏱️ Próxima: ${timeStr}` : timeStr;

        if (totalSeconds < 300) {
            span.className = 'timer-urgent';
        } else if (totalSeconds < 3600) {
            span.className = 'timer-warning';
        } else {
            span.className = '';
        }
    });
}

function updateLiveClock() {
    const clockEl = document.getElementById('live-clock');
    if (!clockEl) return;

    const now = new Date();

    // Also update planned timers to stay in sync
    updatePlannedTimers();

    const options = {
        timeZone: 'Europe/Madrid',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };

    try {
        const timeStr = new Intl.DateTimeFormat('es-ES', options).format(now);
        clockEl.textContent = timeStr;
    } catch (err) {
        clockEl.textContent = now.toLocaleTimeString('es-ES');
    }
}

// Start the clock and update every second
setInterval(updateLiveClock, 1000);
document.addEventListener('DOMContentLoaded', updateLiveClock);
updateLiveClock();

// ═══════════════════════════════════════════════════
// ── REALTIME MONITORING SYSTEM ──
// ═══════════════════════════════════════════════════

let realtimePollingInterval = null;
let realtimeActiveCalls = []; // Currently tracked active calls
let realtimeCallTimers = {}; // callId -> start timestamp for duration tracking
let realtimeIsPolling = false;
let realtimeLastScan = null;

// Network error backoff state
let realtimeConsecutiveErrors = 0;
let realtimeBackoffCycles = 0; // cycles to skip before retrying
let realtimeCurrentSkip = 0;  // current skip counter

// Background polling — always runs to update the tab badge
let realtimeBgInterval = null;

function startRealtimeBgPolling() {
    if (realtimeBgInterval) return;
    // Do an initial scan
    fetchRealtimeCalls(true);
    // Then every 30 seconds (reduced from 10s to ease rate limits)
    realtimeBgInterval = setInterval(() => {
        // Only update badge if NOT on the realtime tab (if on realtime, the main polling handles it)
        const isOnRealtimeTab = document.getElementById('view-realtime')?.classList.contains('active');
        if (!isOnRealtimeTab) {
            fetchRealtimeCalls(true); // lightweight, badge-only
        }
    }, 30000);
}

function startRealtimePolling() {
    if (realtimePollingInterval) return;
    console.log('[Realtime] Starting polling...');
    realtimeIsPolling = true;
    fetchRealtimeCalls();
    realtimePollingInterval = setInterval(fetchRealtimeCalls, 5000);
}

function stopRealtimePolling() {
    if (realtimePollingInterval) {
        clearInterval(realtimePollingInterval);
        realtimePollingInterval = null;
    }
    realtimeIsPolling = false;
    console.log('[Realtime] Polling stopped.');
}

async function fetchRealtimeCalls(badgeOnly = false) {
    // Skip if browser is offline
    if (!navigator.onLine) {
        const statusText = document.getElementById('realtime-status-text');
        if (!badgeOnly && statusText) statusText.textContent = 'Sin conexión a internet';
        return;
    }

    // Backoff: skip this cycle if we're in backoff mode
    if (realtimeBackoffCycles > 0 && realtimeCurrentSkip < realtimeBackoffCycles) {
        realtimeCurrentSkip++;
        return;
    }
    realtimeCurrentSkip = 0;

    try {
        const statusText = document.getElementById('realtime-status-text');
        if (!badgeOnly && statusText) statusText.textContent = 'Escaneando...';

        // Fetch recent calls from Vapi
        const res = await fetch(`${VAPI_API_BASE}/call?limit=100`, {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });

        if (!res.ok) {
            console.warn('[Realtime] API error:', res.status);
            if (!badgeOnly && statusText) statusText.textContent = `Error API (${res.status})`;
            return;
        }

        const rawCalls = await res.json();
        // Vapi may return an array or an object wrapping the array
        const calls = Array.isArray(rawCalls) ? rawCalls : (rawCalls?.results || rawCalls?.data || rawCalls?.list || []);

        // ✅ Success — reset backoff
        if (realtimeConsecutiveErrors > 0) {
            console.log('[Realtime] Connection restored after', realtimeConsecutiveErrors, 'errors');
        }
        realtimeConsecutiveErrors = 0;
        realtimeBackoffCycles = 0;
        realtimeCurrentSkip = 0;

        // Categorize calls
        const activeCalls = calls.filter(c => c.status === 'in-progress');
        const queuedCalls = calls.filter(c => c.status === 'queued');
        const ringingCalls = calls.filter(c => c.status === 'ringing');
        const allLiveCalls = [...activeCalls, ...queuedCalls, ...ringingCalls];

        // Count total today
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayCalls = calls.filter(c => new Date(c.createdAt) >= todayStart);

        // Update tab text and badge (always)
        const tabEl = document.getElementById('nav-tab-realtime');
        const badge = document.getElementById('realtime-badge');
        if (tabEl) {
            if (allLiveCalls.length > 0) {
                tabEl.innerHTML = `🔴 En Vivo <span class="realtime-tab-count">(${allLiveCalls.length})</span> <span id="realtime-badge" class="realtime-badge" style="display:inline-flex;">${allLiveCalls.length}</span>`;
                tabEl.classList.add('has-live');
            } else {
                tabEl.innerHTML = `🔴 En Vivo <span id="realtime-badge" class="realtime-badge" style="display:none;">0</span>`;
                tabEl.classList.remove('has-live');
            }
        }

        if (badgeOnly) return; // Only update badge, don't render

        // Update stats
        document.getElementById('rt-active-count').textContent = activeCalls.length;
        document.getElementById('rt-queued-count').textContent = queuedCalls.length;
        document.getElementById('rt-ringing-count').textContent = ringingCalls.length;
        document.getElementById('rt-total-today').textContent = todayCalls.length;

        // Update status indicator
        if (allLiveCalls.length > 0) {
            statusText.textContent = `${allLiveCalls.length} llamada${allLiveCalls.length > 1 ? 's' : ''} en curso`;
            document.getElementById('realtime-status')?.classList.add('active');
        } else {
            statusText.textContent = 'Sin llamadas activas';
            document.getElementById('realtime-status')?.classList.remove('active');
        }

        realtimeLastScan = new Date();
        realtimeActiveCalls = allLiveCalls;

        // Render active calls
        renderRealtimeCalls(allLiveCalls, todayCalls);

    } catch (err) {
        realtimeConsecutiveErrors++;
        // Exponential backoff: skip 1, 2, 4, 8, 12, 12... polling cycles
        realtimeBackoffCycles = Math.min(12, Math.pow(2, realtimeConsecutiveErrors - 1));
        realtimeCurrentSkip = 0;

        // Only log the first error and then every 10th to avoid flooding
        if (realtimeConsecutiveErrors === 1 || realtimeConsecutiveErrors % 10 === 0) {
            console.warn(`[Realtime] Network error (x${realtimeConsecutiveErrors}), backing off ${realtimeBackoffCycles} cycles:`, err.message || err);
        }
        const statusText = document.getElementById('realtime-status-text');
        if (!badgeOnly && statusText) statusText.textContent = `Sin conexión (reintentando...)`;
    }
}

function renderRealtimeCalls(liveCalls, todayCalls) {
    const grid = document.getElementById('realtime-calls-grid');
    if (!grid) return;

    if (liveCalls.length === 0) {
        // Show empty state with recent ended calls
        const recentEnded = todayCalls
            .filter(c => c.status === 'ended')
            .sort((a, b) => new Date(b.endedAt || b.updatedAt) - new Date(a.endedAt || a.updatedAt))
            .slice(0, 6);

        let recentHtml = '';
        if (recentEnded.length > 0) {
            recentHtml = `
                <div class="realtime-recent-section">
                    <div class="section-title" style="margin-bottom: 16px; font-size: 14px; opacity: 0.7;">📋 Últimas llamadas completadas hoy</div>
                    <div class="realtime-recent-grid">
                        ${recentEnded.map(c => {
                const duration = c.startedAt && c.endedAt
                    ? Math.round((new Date(c.endedAt) - new Date(c.startedAt)) / 1000)
                    : 0;
                const name = c.customer?.number || 'Desconocido';
                return `
                                <div class="realtime-recent-card">
                                    <div class="realtime-recent-phone">📞 ${name}</div>
                                    <div class="realtime-recent-meta">
                                        <span>${formatDuration(duration)}</span>
                                        <span class="realtime-recent-status ${c.endedReason === 'customer-ended-call' ? 'success' : ''}">${getEndReasonLabel(c.endedReason)}</span>
                                    </div>
                                    <div class="realtime-recent-time">${new Date(c.createdAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div>
                                </div>
                            `;
            }).join('')}
                    </div>
                </div>
            `;
        }

        grid.innerHTML = `
            <div class="realtime-empty-state">
                <div class="realtime-empty-icon">📡</div>
                <h3>No hay llamadas activas en este momento</h3>
                <p>El sistema escanea automáticamente cada 5 segundos.</p>
                <div class="realtime-empty-timer">Último scan: <span id="rt-last-scan">ahora</span></div>
            </div>
            ${recentHtml}
        `;
        return;
    }

    // Render active call cards with live transcript
    let html = '';
    liveCalls.forEach((call, i) => {
        const callId = call.id;
        const phone = call.customer?.number || 'Desconocido';
        const status = call.status;
        const startTime = call.startedAt ? new Date(call.startedAt) : new Date(call.createdAt);
        const statusLabel = getCallStatusLabel(status);
        const statusClass = getCallStatusClass(status);

        // Track timers
        if (!realtimeCallTimers[callId]) {
            realtimeCallTimers[callId] = startTime.getTime();
        }

        html += `
            <div class="realtime-call-card ${statusClass}" id="rt-call-${callId}">
                <div class="realtime-call-header">
                    <div class="realtime-call-info">
                        <div class="realtime-call-phone">
                            <span class="live-pulse-dot small ${statusClass}"></span>
                            📞 ${phone}
                        </div>
                        <div class="realtime-call-status">
                            <span class="realtime-status-badge ${statusClass}">${statusLabel}</span>
                        </div>
                    </div>
                    <div class="realtime-call-timer" data-start="${startTime.toISOString()}">
                        <span class="timer-icon">⏱️</span>
                        <span class="timer-value">00:00</span>
                    </div>
                </div>
                <div class="realtime-call-transcript" id="rt-transcript-${callId}">
                    <div class="transcript-loading">
                        <span class="loading-pulse">⌛ Obteniendo transcripción en vivo...</span>
                    </div>
                </div>
                <div class="realtime-call-actions">
                    <button class="rt-action-btn" onclick="fetchCallTranscript('${callId}')" title="Actualizar transcripción">
                        🔄 Actualizar
                    </button>
                </div>
            </div>
        `;
    });

    grid.innerHTML = html;

    // Fetch transcripts for all active calls
    liveCalls.forEach(call => {
        fetchCallTranscript(call.id);
    });

    // Update timers
    updateRealtimeTimers();
}

async function fetchCallTranscript(callId) {
    try {
        const res = await fetch(`${VAPI_API_BASE}/call/${callId}`, {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });

        if (!res.ok) {
            console.warn('[Realtime] Error fetching transcript for', callId, res.status);
            return;
        }

        const callData = await res.json();
        const transcriptEl = document.getElementById(`rt-transcript-${callId}`);
        if (!transcriptEl) return;

        // Get messages from the artifact
        const messages = callData.artifact?.messages || callData.messages || [];
        const transcript = callData.artifact?.transcript || callData.transcript || '';

        if (messages.length > 0) {
            // Render message-by-message transcript (chat style)
            let msgHtml = '<div class="rt-messages">';
            messages.forEach(msg => {
                if (msg.role === 'system' || msg.role === 'tool') return; // Skip system/tool messages
                const role = msg.role;
                const isBot = role === 'bot' || role === 'assistant';
                const speaker = isBot ? '🤖 Violeta' : '👤 Cliente';
                const roleClass = isBot ? 'bot' : 'user';
                const content = msg.message || msg.content || '';
                if (!content.trim()) return;

                const timestamp = msg.secondsFromStart != null
                    ? formatDuration(Math.round(msg.secondsFromStart))
                    : '';

                msgHtml += `
                    <div class="rt-message ${roleClass}">
                        <div class="rt-message-header">
                            <span class="rt-message-speaker">${speaker}</span>
                            ${timestamp ? `<span class="rt-message-time">${timestamp}</span>` : ''}
                        </div>
                        <div class="rt-message-content">${escapeHtml(content)}</div>
                    </div>
                `;
            });
            msgHtml += '</div>';

            // Add typing indicator if call is still in progress
            if (callData.status === 'in-progress') {
                msgHtml += `
                    <div class="rt-typing-indicator">
                        <span class="rt-typing-dot"></span>
                        <span class="rt-typing-dot"></span>
                        <span class="rt-typing-dot"></span>
                    </div>
                `;
            }

            transcriptEl.innerHTML = msgHtml;
            // Scroll to bottom
            transcriptEl.scrollTop = transcriptEl.scrollHeight;

        } else if (transcript) {
            // Fallback: show raw transcript
            transcriptEl.innerHTML = `<div class="rt-raw-transcript">${escapeHtml(transcript)}</div>`;
        } else {
            const statusMsg = callData.status === 'queued' ? 'En cola, esperando conexión...'
                : callData.status === 'ringing' ? 'Llamando... esperando respuesta'
                    : 'Esperando inicio de conversación...';
            transcriptEl.innerHTML = `<div class="transcript-loading"><span class="loading-pulse">${statusMsg}</span></div>`;
        }

    } catch (err) {
        console.warn('[Realtime] Error fetching call data:', callId, err);
    }
}

// escapeHtml is defined at the top of the file (line 56)

function getCallStatusLabel(status) {
    switch (status) {
        case 'in-progress': return '🟢 En Curso';
        case 'queued': return '🟡 En Cola';
        case 'ringing': return '🔵 Sonando';
        case 'forwarding': return '📞 Transfiriendo';
        default: return status;
    }
}

function getCallStatusClass(status) {
    switch (status) {
        case 'in-progress': return 'status-active';
        case 'queued': return 'status-queued';
        case 'ringing': return 'status-ringing';
        default: return '';
    }
}

function getEndReasonLabel(reason) {
    if (!reason) return 'Desconocido';
    switch (reason) {
        case 'customer-ended-call': return '✅ Cliente colgó';
        case 'assistant-ended-call': return '🤖 Asistente colgó';
        case 'voicemail': return '📫 Contestador';
        case 'machine_detected': return '🤖 Máquina detectada';
        case 'silence-timed-out': return '🔇 Silencio';
        case 'customer-did-not-answer': return '📵 No contestó';
        default: return reason.replace(/-/g, ' ');
    }
}

function updateRealtimeTimers() {
    const timers = document.querySelectorAll('.realtime-call-timer');
    timers.forEach(timer => {
        const startStr = timer.getAttribute('data-start');
        if (!startStr) return;
        const startMs = new Date(startStr).getTime();
        const elapsed = Math.floor((Date.now() - startMs) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const valueEl = timer.querySelector('.timer-value');
        if (valueEl) {
            valueEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }
    });
}

// Update realtime timers every second
setInterval(updateRealtimeTimers, 1000);

// Make fetchCallTranscript available globally for onclick
window.fetchCallTranscript = fetchCallTranscript;

// Wire up the refresh button
document.getElementById('realtime-refresh-btn')?.addEventListener('click', () => {
    fetchRealtimeCalls();
});

// Start background polling from page load (lightweight, for badge updates)
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(startRealtimeBgPolling, 3000); // Start 3s after page load
});
// Also start it immediately in case DOMContentLoaded already fired
setTimeout(startRealtimeBgPolling, 3000);

// Reset backoff instantly when browser regains connectivity
window.addEventListener('online', () => {
    console.log('[Realtime] Browser is back online, resetting backoff');
    realtimeConsecutiveErrors = 0;
    realtimeBackoffCycles = 0;
    realtimeCurrentSkip = 0;
    fetchRealtimeCalls(true);
});

// ══════════════════════════════════════════════════════════════
// ── REPORTS / INFORMES DIARIOS ──
// ══════════════════════════════════════════════════════════════

const REPORTS_TABLE = 'matif11dcltlmn6';
let reportsLoaded = false;

async function loadReports() {
    const container = document.getElementById('reports-timeline');
    if (!container) return;

    if (!reportsLoaded) {
        container.innerHTML = '<div class="loading" style="text-align:center;padding:60px;color:var(--text-secondary)">Cargando informes...</div>';
    }

    try {
        const res = await fetch(`${API_BASE}/${REPORTS_TABLE}/records?limit=50&sort=-report_date`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        const data = await res.json();
        const reports = data.list || [];

        if (reports.length === 0) {
            container.innerHTML = `
                <div class="reports-empty">
                    <div style="font-size: 48px; margin-bottom: 16px;">📊</div>
                    <h3>No hay informes todavía</h3>
                    <p>Ejecuta el primer análisis con el botón "🤖 Ejecutar Análisis Hoy" o espera al cron nocturno.</p>
                </div>`;
            reportsLoaded = true;
            return;
        }

        container.innerHTML = reports.map(r => renderReportCard(r)).join('');
        reportsLoaded = true;
    } catch (err) {
        console.error('Error loading reports:', err);
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--danger)">❌ Error al cargar informes</div>';
    }
}

function renderReportCard(report) {
    const score = report.ai_score || 0;
    const scoreColor = score >= 75 ? 'var(--success)' : score >= 50 ? 'var(--warning)' : 'var(--danger)';
    const scoreEmoji = score >= 75 ? '🟢' : score >= 50 ? '🟡' : '🔴';

    // Format date nicely
    const dateStr = report.report_date || '—';
    const dateParts = dateStr.split('-');
    const formattedDate = dateParts.length === 3
        ? new Date(dateStr + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
        : dateStr;

    const successRate = report.total_calls > 0 ? Math.round((report.successful / report.total_calls) * 100) : 0;
    const contestadorRate = report.total_calls > 0 ? Math.round((report.contestador / report.total_calls) * 100) : 0;

    // Format analysis text with basic markdown-like rendering
    const analysisHtml = (report.ai_analysis || 'Sin análisis disponible.')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');

    const recommendationsHtml = (report.ai_recommendations || '')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');

    return `
    <div class="report-card">
        <div class="report-card-header">
            <div class="report-date-section">
                <div class="report-date">${formattedDate}</div>
                <div class="report-date-raw">${dateStr}</div>
            </div>
            <div class="report-score-gauge">
                <div class="report-score-circle" style="--score-color: ${scoreColor}">
                    <span class="report-score-value">${score}</span>
                    <span class="report-score-label">/ 100</span>
                </div>
                <div class="report-score-emoji">${scoreEmoji}</div>
            </div>
        </div>

        <div class="report-kpis">
            <div class="report-kpi">
                <div class="report-kpi-value">${report.total_calls || 0}</div>
                <div class="report-kpi-label">Llamadas</div>
            </div>
            <div class="report-kpi success">
                <div class="report-kpi-value">${report.successful || 0}</div>
                <div class="report-kpi-label">Exitosas (${successRate}%)</div>
            </div>
            <div class="report-kpi danger">
                <div class="report-kpi-value">${report.failed || 0}</div>
                <div class="report-kpi-label">Fallidas</div>
            </div>
            <div class="report-kpi warning">
                <div class="report-kpi-value">${report.contestador || 0}</div>
                <div class="report-kpi-label">Contestador (${contestadorRate}%)</div>
            </div>
            <div class="report-kpi">
                <div class="report-kpi-value">${report.avg_duration || 0}s</div>
                <div class="report-kpi-label">Dur. Media</div>
            </div>
            <div class="report-kpi">
                <div class="report-kpi-value">$${(report.total_cost || 0).toFixed(2)}</div>
                <div class="report-kpi-label">Coste</div>
            </div>
            <div class="report-kpi">
                <div class="report-kpi-value">${report.confirmation_rate || 0}%</div>
                <div class="report-kpi-label">Confirmados</div>
            </div>
        </div>

        <div class="report-section">
            <div class="report-section-title" onclick="this.parentElement.classList.toggle('expanded')">
                🤖 Análisis IA <span class="report-toggle-icon">▶</span>
            </div>
            <div class="report-section-body">
                ${analysisHtml}
            </div>
        </div>

        ${recommendationsHtml ? `
        <div class="report-section">
            <div class="report-section-title" onclick="this.parentElement.classList.toggle('expanded')">
                💡 Recomendaciones <span class="report-toggle-icon">▶</span>
            </div>
            <div class="report-section-body">
                ${recommendationsHtml}
            </div>
        </div>` : ''}
    </div>`;
}

// Wire up reports buttons
document.getElementById('reports-refresh-btn')?.addEventListener('click', () => {
    reportsLoaded = false;
    loadReports();
});

document.getElementById('refresh-appointments-btn')?.addEventListener('click', () => {
    loadAppointments();
});

// Calendar navigation
document.getElementById('appt-cal-prev')?.addEventListener('click', () => {
    calendarWeekOffset--;
    loadAppointments();
});
document.getElementById('appt-cal-next')?.addEventListener('click', () => {
    calendarWeekOffset++;
    loadAppointments();
});

// New appointment modal
document.getElementById('btn-new-appointment')?.addEventListener('click', () => {
    document.getElementById('new-appointment-modal').style.display = 'flex';
    // Pre-fill with tomorrow 10:00
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    const dtStr = tomorrow.getFullYear() + '-' +
        String(tomorrow.getMonth() + 1).padStart(2, '0') + '-' +
        String(tomorrow.getDate()).padStart(2, '0') + 'T10:00';
    document.getElementById('new-appt-datetime').value = dtStr;
});

document.getElementById('close-appointment-modal')?.addEventListener('click', () => {
    document.getElementById('new-appointment-modal').style.display = 'none';
});

document.getElementById('save-new-appointment-btn')?.addEventListener('click', () => {
    saveManualAppointment();
});

document.getElementById('reports-run-btn')?.addEventListener('click', () => {
    alert('Para ejecutar el análisis de hoy, usa el comando:\\n\\nOPENAI_API_KEY=sk-... node daily_analysis.mjs\\n\\nDesde la carpeta call-dashboard-app/');
});

// ── Agent Prompt Editor ──
let currentAgentConfig = null; // cache the full assistant object for the selected agent

async function loadAgentPrompt() {
    const assistantId = document.getElementById('agent-select').value;
    const feedback = document.getElementById('agent-feedback');
    const textarea = document.getElementById('agent-prompt-textarea');
    const infoBar = document.getElementById('prompt-info-bar');
    const editorWrapper = document.getElementById('prompt-editor-wrapper');
    const actionsBar = document.getElementById('prompt-actions');
    const loadBtn = document.getElementById('agent-load-btn');

    loadBtn.disabled = true;
    loadBtn.textContent = '⏳ Cargando...';
    feedback.textContent = '';
    feedback.className = '';

    try {
        const res = await fetch(`${VAPI_API_BASE}/assistant/${assistantId}`, {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (!res.ok) throw new Error(`Error ${res.status}: ${await res.text()}`);
        const assistant = await res.json();
        currentAgentConfig = assistant;

        // Extract prompt
        const prompt = assistant.model?.messages?.[0]?.content || assistant.instructions || '';
        textarea.value = prompt;

        // Populate info bar
        document.getElementById('agent-info-name').textContent = assistant.name || 'Sin nombre';
        document.getElementById('agent-info-model').textContent =
            `${assistant.model?.provider || '?'} / ${assistant.model?.model || '?'}`;
        document.getElementById('agent-info-chars').textContent = prompt.length.toLocaleString();

        // Update character count
        document.getElementById('prompt-char-count').textContent = `${prompt.length.toLocaleString()} caracteres`;

        // Show editor sections
        infoBar.style.display = 'flex';
        editorWrapper.style.display = 'block';
        actionsBar.style.display = 'flex';

        feedback.textContent = `✅ Prompt cargado: ${assistant.name}`;
        feedback.style.color = 'var(--success)';
    } catch (err) {
        console.error('[Agent Editor] Error loading assistant:', err);
        feedback.textContent = `❌ Error: ${err.message}`;
        feedback.style.color = 'var(--danger)';
    } finally {
        loadBtn.disabled = false;
        loadBtn.textContent = '📥 Cargar Prompt';
    }
}

async function saveAgentPrompt() {
    const assistantId = document.getElementById('agent-select').value;
    const textarea = document.getElementById('agent-prompt-textarea');
    const feedback = document.getElementById('agent-feedback');
    const saveBtn = document.getElementById('agent-save-btn');
    const newPrompt = textarea.value;

    if (!currentAgentConfig) {
        feedback.textContent = '⚠️ Primero carga un agente antes de guardar.';
        feedback.style.color = 'var(--warning)';
        return;
    }

    if (!newPrompt.trim()) {
        feedback.textContent = '⚠️ El prompt no puede estar vacío.';
        feedback.style.color = 'var(--warning)';
        return;
    }

    if (!confirm('¿Guardar los cambios en el prompt del agente? Esto se aplicará inmediatamente en producción.')) {
        return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = '⏳ Guardando...';
    feedback.textContent = '';

    try {
        // Build update payload preserving the existing model config
        const updates = {};
        if (currentAgentConfig.model?.messages) {
            updates.model = {
                ...currentAgentConfig.model,
                messages: currentAgentConfig.model.messages.map((msg, i) =>
                    i === 0 ? { ...msg, content: newPrompt } : msg
                )
            };
        } else {
            updates.instructions = newPrompt;
        }

        const res = await fetch(`${VAPI_API_BASE}/assistant/${assistantId}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${VAPI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updates)
        });

        if (!res.ok) throw new Error(`Error ${res.status}: ${await res.text()}`);
        const updatedAssistant = await res.json();
        currentAgentConfig = updatedAssistant;

        // Update info
        document.getElementById('agent-info-chars').textContent = newPrompt.length.toLocaleString();
        document.getElementById('prompt-char-count').textContent = `${newPrompt.length.toLocaleString()} caracteres`;

        feedback.textContent = `✅ Prompt guardado con éxito para ${updatedAssistant.name}`;
        feedback.style.color = 'var(--success)';
    } catch (err) {
        console.error('[Agent Editor] Error saving prompt:', err);
        feedback.textContent = `❌ Error al guardar: ${err.message}`;
        feedback.style.color = 'var(--danger)';
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Guardar Prompt';
    }
}

// Agent editor event listeners
document.getElementById('agent-load-btn')?.addEventListener('click', loadAgentPrompt);
document.getElementById('agent-save-btn')?.addEventListener('click', saveAgentPrompt);
document.getElementById('agent-select')?.addEventListener('change', loadAgentPrompt);

// Update character count on input
document.getElementById('agent-prompt-textarea')?.addEventListener('input', () => {
    const len = document.getElementById('agent-prompt-textarea').value.length;
    document.getElementById('prompt-char-count').textContent = `${len.toLocaleString()} caracteres`;
});

// Ctrl+S shortcut to save prompt when textarea is focused
document.getElementById('agent-prompt-textarea')?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveAgentPrompt();
    }
});

// ── Error Logs View ──
let _errorLogsData = [];

async function loadErrorLogs() {
    const tbody = document.getElementById('errorlogs-table');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="loading">Cargando errores del servidor...</td></tr>';

    try {
        _errorLogsData = await getApiErrorsFromServer(200);
        renderErrorLogs(_errorLogsData);
        updateErrorLogKPIs(_errorLogsData);
    } catch (e) {
        console.error('[ErrorLogs] Error loading:', e);
        tbody.innerHTML = '<tr><td colspan="6" class="loading">Error al cargar logs</td></tr>';
    }
}

function updateErrorLogKPIs(logs) {
    const total = logs.length;
    const count404 = logs.filter(l => l.status === 404).length;
    const count5xx = logs.filter(l => l.status >= 500 && l.status < 600).length;
    const countOther = total - count404 - count5xx;

    animateKPIValue('errorlogs-kpi-total', total);
    animateKPIValue('errorlogs-kpi-404', count404);
    animateKPIValue('errorlogs-kpi-500', count5xx);
    animateKPIValue('errorlogs-kpi-network', countOther);
}

function renderErrorLogs(logs) {
    const tbody = document.getElementById('errorlogs-table');
    if (!tbody) return;

    if (!logs || logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-secondary);">✅ Sin errores registrados</td></tr>';
        return;
    }

    let html = '';
    logs.forEach(log => {
        const ts = log.timestamp || log.CreatedAt || '';
        const dateStr = ts ? new Date(ts).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
        const status = log.status || 0;
        const method = escapeHtml(log.method || 'GET');
        const context = escapeHtml(log.context || '');
        const url = escapeHtml((log.url || '').replace(/https:\/\/[^/]+/, '...'));
        const detail = escapeHtml((log.detail || log.status_text || '').substring(0, 120));

        let statusBadge = '';
        if (status === 0) {
            statusBadge = '<span style="background: rgba(148,163,184,0.15); color: #94a3b8; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;">NETWORK</span>';
        } else if (status >= 500) {
            statusBadge = `<span style="background: rgba(239,68,68,0.15); color: #f87171; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;">${status}</span>`;
        } else if (status === 404) {
            statusBadge = `<span style="background: rgba(245,158,11,0.15); color: #fbbf24; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;">${status}</span>`;
        } else if (status >= 400) {
            statusBadge = `<span style="background: rgba(251,146,60,0.15); color: #fb923c; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;">${status}</span>`;
        } else {
            statusBadge = `<span style="background: rgba(59,130,246,0.15); color: #60a5fa; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;">${status}</span>`;
        }

        const methodColors = { GET: '#60a5fa', POST: '#4ade80', PATCH: '#fbbf24', DELETE: '#f87171' };
        const mColor = methodColors[method] || '#94a3b8';
        const methodBadge = `<span style="background: ${mColor}22; color: ${mColor}; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;">${method}</span>`;

        html += `<tr>
            <td style="white-space: nowrap; font-size: 12px; color: var(--text-secondary);">${dateStr}</td>
            <td>${methodBadge}</td>
            <td>${statusBadge}</td>
            <td style="font-size: 12px; max-width: 160px; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(log.context || '')}">${context}</td>
            <td style="font-size: 11px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; color: var(--text-secondary);" title="${escapeHtml(log.url || '')}">${url}</td>
            <td style="font-size: 11px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; color: var(--text-secondary);" title="${escapeHtml(log.detail || log.status_text || '')}">${detail}</td>
        </tr>`;
    });

    tbody.innerHTML = html;
}

// Error Logs event listeners
document.getElementById('errorlogs-refresh-btn')?.addEventListener('click', loadErrorLogs);

document.getElementById('errorlogs-download-btn')?.addEventListener('click', async () => {
    try {
        const logs = await getApiErrorsFromServer(500);
        const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `error_logs_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
    } catch (e) {
        alert('Error al descargar: ' + e.message);
    }
});

document.getElementById('errorlogs-clear-btn')?.addEventListener('click', async () => {
    if (!confirm('¿Borrar TODOS los logs de errores del servidor?')) return;
    const btn = document.getElementById('errorlogs-clear-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Borrando...';
    try {
        await clearServerErrors();
        clearApiErrors();
        loadErrorLogs();
    } catch (e) {
        alert('Error: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '🗑️ Borrar Todo';
    }
});
const CHANGELOG_DATA = [
    {
        date: '2026-03-03',
        entries: [
            { type: 'feature', title: 'Sistema de Agendamiento de Citas', hours: 3, desc: 'Adaptación completa del sistema para gestión de visitas técnicas: nueva pestaña "Citas" con historial detallado, visualización de fechas de cita confirmadas, y refinamiento del prompt de Carolina para optimizar el cierre de agendamientos mediante el uso directo de bookAppointment.' },
            { type: 'improvement', title: 'Visualización de datos confirmados en Citas', hours: 1, desc: 'Sincronización automática de campos "Fecha Cita" de NocoDB para mostrar la planificación real confirmada por la asistente virtual en el dashboard.' },
        ]
    },
    {
        date: '2026-02-26',
        entries: [
            { type: 'improvement', title: 'Bump de versión a v0.0.4', hours: 0.5, desc: 'Actualización de versión del dashboard con changelog actualizado y deploy a producción.' },
        ]
    },
    {
        date: '2026-02-25',
        entries: [
            { type: 'feature', title: 'Diagnóstico IA individual por llamada', hours: 2, desc: 'Nuevo botón \"🔍 Diagnóstico IA\" en el modal de detalle que analiza la llamada con GPT-4o-mini: genera resumen, detecta problemas, recomendaciones, nivel de interés del lead, calidad de la IA y siguiente paso sugerido. Resultados visuales con badges de colores.' },
            { type: 'fix', title: 'Error reporting detallado en carga de datos', hours: 1.5, desc: 'Reescritura completa del manejo de errores en loadData: mensajes descriptivos por tipo de error (red, HTTP, JSON), botones de reintento y copia de detalles técnicos para diagnóstico rápido. Elimina el genérico \"Error loading data\".' },
            { type: 'improvement', title: 'Población automática de datos originales del lead', hours: 1, desc: 'El modal de detalle ahora consulta la tabla de Leads por teléfono para mostrar datos originales completos (empresa, email, sector) incluso cuando el registro de llamada solo tiene datos parciales.' },
        ]
    },
    {
        date: '2026-02-24',
        entries: [
            { type: 'feature', title: 'Separación Datos Originales vs Datos Extraídos', hours: 1.5, desc: 'El modal de detalle ahora distingue claramente los datos originales del lead (empresa, teléfono, email, sector) de los datos extraídos de la conversación para el gerente (nombre, teléfono y email confirmados). Sección azul para originales, naranja para extraídos.' },
            { type: 'improvement', title: 'Transcripción formateada con colores IA/Cliente', hours: 0.5, desc: 'La transcripción ahora muestra líneas de IA con borde violeta y líneas del cliente con borde verde, facilitando la lectura y el seguimiento de la conversación.' },
            { type: 'improvement', title: 'Workflow automático de deploy a producción', hours: 1, desc: 'Creación de workflow /deploy que automatiza el bump de versión, actualización del changelog, build y deploy a Vercel en un solo paso, sin intervención manual.' },
        ]
    },
    {
        date: '2026-02-23',
        entries: [
            { type: 'fix', title: 'Modal "Ver Detalle" en pestaña Test', hours: 1.5, desc: 'Corrección del bug donde el modal de detalle no se abría correctamente desde la pestaña Test. Se implementó función openTestDetail() dedicada que muestra el modal con display:flex, renderiza score, transcripción, grabación y datos confirmados.' },
            { type: 'improvement', title: 'Mejora de visibilidad y legibilidad del dashboard', hours: 1.5, desc: 'Aumento de tamaños de fuente en estadísticas, KPIs, tablas y navegación para mejorar la legibilidad sin necesidad de zoom. Ajuste del ancho máximo del contenedor a 1700px.' },
            { type: 'improvement', title: 'Tablas responsive sin scroll horizontal', hours: 1, desc: 'Rediseño de las tablas para que se adapten a pantallas más pequeñas: reducción de padding, font-size compacto, eliminación del min-width fijo y overflow-x:auto como fallback.' },
            { type: 'feature', title: 'Sistema de paginación en historial de llamadas', hours: 1.5, desc: 'Implementación de paginación completa con 20 registros por página, barra de navegación con botones de página, indicador de registros mostrados y navegación primera/última página.' },
        ]
    },
    {
        date: '2026-02-21',
        entries: [
            { type: 'improvement', title: 'Paginación de fetchData para +500 registros', hours: 1, desc: 'Reescritura de la función fetchData con paginación automática de NocoDB API: carga por lotes de 200 registros hasta obtener todos los datos, con safety limit de 5000 registros.' },
            { type: 'fix', title: 'Corrección de carga de datos en dashboard principal', hours: 0.5, desc: 'Fix del flujo de carga de datos para asegurar que las estadísticas y gráficos se alimentan de todos los registros disponibles en la base de datos, no solo del primer lote.' },
        ]
    },
    {
        date: '2026-02-20',
        entries: [
            { type: 'fix', title: 'Diagnóstico de llamadas programadas vencidas', hours: 1, desc: 'Investigación de 9 llamadas programadas a las 13:00-13:16 que no se ejecutaron: análisis de la sección de planificación, revisión del workflow de n8n y del trigger automático para identificar la causa raíz.' },
            { type: 'fix', title: 'Reprogramación de 9 llamadas vencidas', hours: 0.5, desc: 'Ejecución del script reschedule_overdue.mjs para redistribuir las 9 llamadas vencidas de forma escalonada cada 3 minutos, empezando 5 minutos después de la hora actual, evitando avalancha de llamadas simultáneas.' },
            { type: 'improvement', title: 'Verificación de estado del workflow n8n', hours: 0.5, desc: 'Consulta directa a la API de n8n para confirmar que el workflow "General Protect" (Schedule Trigger cada 1 minuto) está activo y operativo, asegurando que las llamadas reprogramadas se ejecuten automáticamente.' },
        ]
    },
    {
        date: '2026-02-19',
        entries: [
            { type: 'feature', title: 'Sección "Changelog" — Registro de Cambios', hours: 2, desc: 'Diseño e implementación de nueva pestaña "📝 Changelog" con timeline visual día a día, badges por tipo de cambio (feature, fix, mejora, prompt), barra de resumen con KPIs y diseño responsive.' },
            { type: 'fix', title: 'Score de contestador automático a 0', hours: 1, desc: 'Modificación del sistema de scoring para que las llamadas que terminan en contestador automático reciban automáticamente un score de 0, evitando inflar las métricas de calidad del agente.' },
            { type: 'fix', title: 'Investigación de llamada cortada (019c757d)', hours: 1.5, desc: 'Análisis detallado de una llamada que se cortó inesperadamente: revisión de logs de Vapi, transcripción, motivo de finalización y ajuste de parámetros para prevenir reincidencias.' },
            { type: 'improvement', title: 'Estimación de horas en changelog', hours: 1, desc: 'Añadidas estimaciones de tiempo por tarea al registro de cambios para justificar la inversión de horas en el proyecto y dar visibilidad al cliente del trabajo realizado.' },
        ]
    },
    {
        date: '2026-02-18',
        entries: [
            { type: 'feature', title: 'Editor de Prompts de Agentes', hours: 3.5, desc: 'Diseño e implementación completa de la sección "🤖 Agentes" del dashboard: selector de asistentes, carga del prompt actual desde Vapi API, editor de texto con contador de caracteres, guardado en producción con feedback visual, y atajo Ctrl+S.' },
            { type: 'improvement', title: 'Barra de info del agente seleccionado', hours: 1, desc: 'Se muestra automáticamente el nombre, modelo de IA y longitud del prompt del agente seleccionado al cargarlo, dando contexto inmediato al usuario.' },
            { type: 'fix', title: 'Reviews duplicadas por persona/marca', hours: 1.5, desc: 'Investigación y corrección del sistema de reviews: se implementó filtrado para mostrar solo una review por persona por marca, aumentando la credibilidad y seriedad de las reseñas públicas.' },
            { type: 'improvement', title: 'Validación de prompt antes de guardar', hours: 0.5, desc: 'Se añadió validación para evitar guardar prompts vacíos o demasiado cortos, protegiendo contra errores accidentales.' },
        ]
    },
    {
        date: '2026-02-17',
        entries: [
            { type: 'prompt', title: 'Prompt de Violeta v2 — conversación interactiva', hours: 3, desc: 'Reescritura completa del prompt del agente Violeta: enfoque en preguntas cortas y relevantes, eliminación de monólogos iniciales largos, revelación de identidad IA solo si preguntan directamente. Objetivo: reducir drásticamente la tasa de cuelgue en los primeros 15 segundos.' },
            { type: 'improvement', title: 'Análisis de tasa de abandono', hours: 2, desc: 'Análisis detallado de las llamadas con alta tasa de abandono: identificación de patrones (monólogos >20s, revelación prematura de IA, falta de interactividad) y propuesta de mejoras para el flujo conversacional.' },
            { type: 'fix', title: 'Detección de contestador automático mejorada', hours: 1.5, desc: 'Mejora del algoritmo de detección de buzón de voz: ahora se identifican correctamente los contestadores automáticos por la duración del tono, respuesta estándar y falta de interacción humana.' },
            { type: 'fix', title: 'Bug llamada bloqueada 10 minutos', hours: 1, desc: 'Investigación y resolución de un caso donde una llamada a contestador duró 10 minutos sin finalizar: se ajustaron los timeouts y condiciones de corte para evitar costes innecesarios.' },
            { type: 'fix', title: 'Validación de contraseñas en autenticación', hours: 1, desc: 'Corrección del sistema de validación de passwords en Convex Auth que rechazaba contraseñas válidas durante el inicio de sesión.' },
        ]
    },
    {
        date: '2026-02-16',
        entries: [
            { type: 'improvement', title: 'Loading states con skeletons en todo el dashboard', hours: 2, desc: 'Implementación de indicadores visuales de carga (skeleton loading) en todas las cards de estadísticas, KPIs y tablas del dashboard. Los valores ahora muestran una animación pulsante en lugar de "0" o "—" mientras se cargan, eliminando la confusión del usuario.' },
            { type: 'fix', title: 'Lógica de horario comercial', hours: 2, desc: 'Las llamadas ahora respetan estrictamente el horario comercial español: mañanas 9:00-13:00 y tardes 15:30-17:30. Se implementó lógica de reprogramación automática para llamadas fuera de horario: si es antes de las 15:30, se mueve a la tarde; si es después de las 17:30, se mueve al día siguiente a las 9:00.' },
            { type: 'fix', title: 'Filtrado y separación de llamadas de test', hours: 1.5, desc: 'Las llamadas de prueba/test ya no aparecen mezcladas con las de producción. Se implementó detección automática por "Manual Trigger" en el motivo de finalización y nombre "test manual".' },
            { type: 'feature', title: 'Sección de llamadas de Test', hours: 2, desc: 'Nueva pestaña "🧪 Test" con estadísticas independientes (total, exitosas, fallidas, contestador) y tabla dedicada para visualizar y gestionar las llamadas de prueba sin contaminar los datos de producción.' },
            { type: 'fix', title: 'Limpieza de registros duplicados', hours: 1, desc: 'Script de limpieza para eliminar registros duplicados y erróneos en los logs de llamadas de NocoDB, evitando que aparezcan en el dashboard y distorsionen las estadísticas.' },
            { type: 'fix', title: 'Reprogramación de llamadas fuera de horario', hours: 1, desc: 'Script para detectar y reprogramar automáticamente todas las llamadas que se habían programado incorrectamente fuera del horario comercial al siguiente slot disponible.' },
        ]
    },
    {
        date: '2026-02-15',
        entries: [
            { type: 'feature', title: 'Sección de llamadas programadas con countdown', hours: 3, desc: 'Implementación completa de la sección de planificación: banner resumen con total programadas/vencidas/pendientes, lista compacta con temporizador en tiempo real por cada llamada, indicador de "PRÓXIMA" llamada, y click para editar cada lead.' },
            { type: 'fix', title: 'Bug crítico de timezone UTC vs local', hours: 2, desc: 'Descubierto y corregido un bug donde las fechas planificadas se almacenaban en UTC pero se parseaban como hora local, causando que las llamadas no aparecieran en el dashboard o aparecieran con horas incorrectas. Se implementaron funciones de conversión UTC↔Local.' },
            { type: 'improvement', title: 'Display compacto para +200 llamadas', hours: 1.5, desc: 'Optimización del renderizado de la sección de planificación: se limita a 50 llamadas visibles inicialmente con botón "mostrar más", evitando lag en el navegador con volúmenes grandes de datos.' },
            { type: 'feature', title: 'Trigger automático de llamadas en n8n', hours: 2.5, desc: 'Implementación del disparador automático en n8n: Schedule Trigger cada minuto que busca leads con estado "Programado" y fecha_planificada <= ahora, los llama vía Vapi API respetando concurrencia máxima (evitando sobrepasar el límite de llamadas simultáneas).' },
            { type: 'improvement', title: 'Paginación de datos para +500 leads', hours: 1, desc: 'Implementación de carga paginada en la API de NocoDB para soportar bases de datos con más de 200 leads sin perder registros, con safety limit de 2000.' },
        ]
    },
    {
        date: '2026-02-14',
        entries: [
            { type: 'feature', title: 'Configuración de Live Reload con Capacitor', hours: 2.5, desc: 'Configuración completa del entorno de desarrollo móvil: Vite como servidor de desarrollo, exposición en red local con --host, actualización de capacitor.config.ts para apuntar al servidor Vite, y scripts npm para arrancar fácilmente el entorno de live reload.' },
            { type: 'improvement', title: 'Scripts de desarrollo en package.json', hours: 0.5, desc: 'Añadidos scripts npm de conveniencia (dev, dev:ios, dev:android, sync) para simplificar el workflow de desarrollo sin tener que recordar comandos largos de Capacitor.' },
            { type: 'feature', title: 'Sistema de importación de llamadas Vapi', hours: 2, desc: 'Desarrollo de script de importación (import_vapi_calls.mjs) para sincronizar las llamadas de Vapi con la base de datos NocoDB, incluyendo deduplicación y mapeo de campos.' },
        ]
    },
    {
        date: '2026-02-13',
        entries: [
            { type: 'feature', title: 'Dashboard de llamadas v0.0.1 — versión inicial', hours: 4, desc: 'Diseño y desarrollo completo de la primera versión del dashboard: arquitectura SPA con HTML/CSS/JS vanilla, integración con NocoDB API, tabla de historial de llamadas con paginación, y sistema de autenticación con contraseña.' },
            { type: 'feature', title: 'Integración con Vapi API — transcripciones y grabaciones', hours: 2, desc: 'Conexión directa con la API de Vapi para obtener transcripciones en tiempo real y URLs de grabación de audio de cada llamada, mostradas en el modal de detalle.' },
            { type: 'feature', title: 'Gráfico de rendimiento con Chart.js', hours: 1.5, desc: 'Implementación del gráfico de barras de rendimiento de llamadas por día con Chart.js, mostrando distribución de resultados (éxito, fallida, contestador, no contesta).' },
            { type: 'feature', title: 'Modal de detalle de llamada', hours: 2, desc: 'Diseño e implementación del modal de detalle: transcripción completa, reproductor de audio, sección de datos confirmados, notas del agente con guardado, toggle test/producción, y sistema de scoring de calidad con gauge visual.' },
            { type: 'feature', title: 'Sistema de scoring de calidad', hours: 1.5, desc: 'Diseño del algoritmo de scoring multi-dimensional: duración (25pts), evaluación IA (30pts), datos confirmados (20pts), motivo de fin (15pts), transcripción (10pts). Gauge visual con colores por rango y breakdown detallado.' },
        ]
    }
];

const CHANGELOG_TYPE_CONFIG = {
    feature: { icon: '🚀', label: 'Nueva Funcionalidad', color: '#22c55e', bg: 'rgba(34, 197, 94, 0.12)', border: 'rgba(34, 197, 94, 0.3)' },
    fix: { icon: '🔧', label: 'Corrección', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)', border: 'rgba(245, 158, 11, 0.3)' },
    improvement: { icon: '⚡', label: 'Mejora', color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.12)', border: 'rgba(59, 130, 246, 0.3)' },
    prompt: { icon: '🧠', label: 'Cambio de Prompt', color: '#a855f7', bg: 'rgba(168, 85, 247, 0.12)', border: 'rgba(168, 85, 247, 0.3)' },
};

function renderChangelog() {
    const container = document.getElementById('changelog-timeline');
    if (!container) return;

    const dateOpts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    let totalEntries = 0;
    let totalHours = 0;
    CHANGELOG_DATA.forEach(day => {
        totalEntries += day.entries.length;
        day.entries.forEach(e => totalHours += (e.hours || 0));
    });

    let html = `
        <div class="changelog-summary-bar">
            <div class="changelog-summary-stat">
                <span class="changelog-summary-value">${CHANGELOG_DATA.length}</span>
                <span class="changelog-summary-label">Días de trabajo</span>
            </div>
            <div class="changelog-summary-stat">
                <span class="changelog-summary-value">${totalEntries}</span>
                <span class="changelog-summary-label">Cambios realizados</span>
            </div>
            <div class="changelog-summary-stat">
                <span class="changelog-summary-value">${totalHours.toFixed(1)}h</span>
                <span class="changelog-summary-label">Horas invertidas</span>
            </div>
            <div class="changelog-summary-stat">
                <span class="changelog-summary-value">${CHANGELOG_DATA.reduce((acc, d) => acc + d.entries.filter(e => e.type === 'feature').length, 0)}</span>
                <span class="changelog-summary-label">Nuevas funcionalidades</span>
            </div>
            <div class="changelog-summary-stat">
                <span class="changelog-summary-value">${CHANGELOG_DATA.reduce((acc, d) => acc + d.entries.filter(e => e.type === 'fix').length, 0)}</span>
                <span class="changelog-summary-label">Correcciones</span>
            </div>
        </div>
    `;

    CHANGELOG_DATA.forEach((day, dayIdx) => {
        const dateObj = new Date(day.date + 'T12:00:00');
        const dateStr = dateObj.toLocaleDateString('es-ES', dateOpts);

        // Check if this day is today
        const today = new Date();
        const isToday = day.date === today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

        // Calculate hours for this day
        const dayHours = day.entries.reduce((acc, e) => acc + (e.hours || 0), 0);

        html += `
            <div class="changelog-day ${dayIdx === 0 ? 'changelog-day-latest' : ''}">
                <div class="changelog-day-header">
                    <div class="changelog-day-dot"></div>
                    <div class="changelog-day-date">
                        ${isToday ? '<span class="changelog-today-badge">HOY</span>' : ''}
                        ${dateStr.charAt(0).toUpperCase() + dateStr.slice(1)}
                    </div>
                    <div class="changelog-day-count">${day.entries.length} ${day.entries.length === 1 ? 'cambio' : 'cambios'}</div>
                    <div class="changelog-day-hours">🕐 ${dayHours.toFixed(1)}h</div>
                </div>
                <div class="changelog-entries">
        `;

        day.entries.forEach(entry => {
            const cfg = CHANGELOG_TYPE_CONFIG[entry.type] || CHANGELOG_TYPE_CONFIG.improvement;
            html += `
                <div class="changelog-entry" style="--entry-color: ${cfg.color}; --entry-bg: ${cfg.bg}; --entry-border: ${cfg.border};">
                    <div class="changelog-entry-header">
                        <div class="changelog-entry-badge" style="background: ${cfg.bg}; border-color: ${cfg.border}; color: ${cfg.color};">
                            ${cfg.icon} ${cfg.label}
                        </div>
                        ${entry.hours ? `<div class="changelog-entry-hours">🕐 ${entry.hours}h</div>` : ''}
                    </div>
                    <div class="changelog-entry-title">${entry.title}</div>
                    <div class="changelog-entry-desc">${entry.desc}</div>
                </div>
            `;
        });

        html += `
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}


// ═══════════════════════════════════════════════════════════════
// ══  ADMIN PANEL — User Management CRUD
// ═══════════════════════════════════════════════════════════════

const ADMIN_USERS_TABLE = 'mkb040wimke95sl';
const ADMIN_NOCODB_BASE = `${NOCODB_PROXY_BASE}/api/v2/tables`;
const ADMIN_XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

let _adminUsers = [];

async function loadAdminUsers() {
    try {
        const res = await fetch(`${ADMIN_NOCODB_BASE}/${ADMIN_USERS_TABLE}/records?limit=200`, {
            headers: { 'xc-token': ADMIN_XC_TOKEN }
        });
        const data = await res.json();
        _adminUsers = data.list || [];
        renderAdminKPI();
        renderAdminUsersGrid();
    } catch (err) {
        console.error('Admin: Error loading users:', err);
    }
}

function renderAdminKPI() {
    const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    el('admin-kpi-total', _adminUsers.length);
    el('admin-kpi-active', _adminUsers.filter(u => u['Is Active']).length);
    el('admin-kpi-admins', _adminUsers.filter(u => u['Is Admin']).length);
}

function renderAdminUsersGrid() {
    const grid = document.getElementById('admin-users-grid');
    if (!grid) return;

    if (_adminUsers.length === 0) {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-secondary);">No hay usuarios registrados</div>';
        return;
    }

    grid.innerHTML = _adminUsers.map(u => {
        const active = u['Is Active'];
        const admin = u['Is Admin'];
        const company = u['Company Name'] || '—';
        const email = u['Email'] || '—';
        const hasVapi = !!u['Vapi API Key'];
        const hasZadarma = !!u['Zadarma Key'];
        const hasNocoDB = !!u['XC Token'];
        const statusColor = active ? '#22c55e' : '#ef4444';
        const statusText = active ? 'Activo' : 'Inactivo';

        return `
            <div class="glass-effect" style="padding: 20px; border-radius: 14px; border-left: 4px solid ${statusColor}; position: relative;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                    <div>
                        <div style="font-weight: 700; font-size: 16px; display: flex; align-items: center; gap: 8px;">
                            ${company}
                            ${admin ? '<span style="background: rgba(251,191,36,0.15); color: #fbbf24; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;">👑 Admin</span>' : ''}
                        </div>
                        <div style="color: var(--text-secondary); font-size: 13px; margin-top: 4px;">${email}</div>
                    </div>
                    <span style="background: rgba(${active ? '34,197,94' : '239,68,68'},0.15); color: ${statusColor}; padding: 4px 10px; border-radius: 8px; font-size: 12px; font-weight: 600;">${statusText}</span>
                </div>
                <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px;">
                    <span style="background: ${hasNocoDB ? 'rgba(96,165,250,0.15)' : 'rgba(148,163,184,0.1)'}; color: ${hasNocoDB ? '#60a5fa' : '#64748b'}; padding: 3px 10px; border-radius: 6px; font-size: 11px;">🗄️ NocoDB</span>
                    <span style="background: ${hasVapi ? 'rgba(167,139,250,0.15)' : 'rgba(148,163,184,0.1)'}; color: ${hasVapi ? '#a78bfa' : '#64748b'}; padding: 3px 10px; border-radius: 6px; font-size: 11px;">📞 Vapi</span>
                    <span style="background: ${hasZadarma ? 'rgba(52,211,153,0.15)' : 'rgba(148,163,184,0.1)'}; color: ${hasZadarma ? '#34d399' : '#64748b'}; padding: 3px 10px; border-radius: 6px; font-size: 11px;">📱 Zadarma</span>
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="refresh-btn" style="flex:1; padding: 8px;" onclick="openUserModal('${email.replace(/'/g, "\\'")}')">✏️ Editar</button>
                    <button class="refresh-btn" style="padding: 8px; background: rgba(${active ? '239,68,68' : '34,197,94'},0.1); color: ${active ? '#ef4444' : '#22c55e'}; border-color: rgba(${active ? '239,68,68' : '34,197,94'},0.2);" onclick="toggleUserActive('${email.replace(/'/g, "\\'")}')">⏻ ${active ? 'Desactivar' : 'Activar'}</button>
                </div>
            </div>
        `;
    }).join('');
}

function openUserModal(email = '') {
    const modal = document.getElementById('user-edit-modal');
    const title = document.getElementById('user-modal-title');
    const feedback = document.getElementById('user-form-feedback');
    feedback.textContent = '';

    if (email) {
        // Edit mode
        const u = _adminUsers.find(usr => usr['Email'] === email);
        if (!u) return;
        title.textContent = '✏️ Editar Usuario';
        document.getElementById('user-edit-email-original').value = email;
        document.getElementById('user-email').value = u['Email'] || '';
        document.getElementById('user-email').readOnly = true;
        document.getElementById('user-password').value = u['Password Hash'] || '';
        document.getElementById('user-company').value = u['Company Name'] || '';
        document.getElementById('user-logo').value = u['Logo URL'] || '';
        document.getElementById('user-is-active').checked = !!u['Is Active'];
        document.getElementById('user-is-admin').checked = !!u['Is Admin'];
        document.getElementById('user-api-base').value = u['API Base'] || '';
        document.getElementById('user-xc-token').value = u['XC Token'] || '';
        document.getElementById('user-leads-table').value = u['Leads Table'] || '';
        document.getElementById('user-calllogs-table').value = u['Call Logs Table'] || '';
        document.getElementById('user-confirmed-table').value = u['Confirmed Table'] || '';
        document.getElementById('user-errorlogs-table').value = u['Error Logs Table'] || '';
        document.getElementById('user-vapi-key').value = u['Vapi API Key'] || '';
        document.getElementById('user-vapi-public').value = u['Vapi Public Key'] || '';
        document.getElementById('user-vapi-assistant').value = u['Vapi Assistant ID'] || '';
        document.getElementById('user-vapi-phone').value = u['Vapi Phone Number ID'] || '';
        document.getElementById('user-zadarma-key').value = u['Zadarma Key'] || '';
        document.getElementById('user-zadarma-secret').value = u['Zadarma Secret'] || '';
        document.getElementById('user-zadarma-number').value = u['Zadarma From Number'] || '';
        document.getElementById('user-openai-key').value = u['OpenAI API Key'] || '';
        document.getElementById('user-n8n-base').value = u['N8N Webhook Base'] || '';
    } else {
        // Create mode
        title.textContent = '➕ Nuevo Usuario';
        document.getElementById('user-edit-email-original').value = '';
        document.getElementById('user-email').readOnly = false;
        ['user-email','user-password','user-company','user-logo','user-api-base','user-xc-token',
         'user-leads-table','user-calllogs-table','user-confirmed-table','user-errorlogs-table',
         'user-vapi-key','user-vapi-public','user-vapi-assistant','user-vapi-phone',
         'user-zadarma-key','user-zadarma-secret','user-zadarma-number',
         'user-openai-key','user-n8n-base'].forEach(id => document.getElementById(id).value = '');
        document.getElementById('user-is-active').checked = true;
        document.getElementById('user-is-admin').checked = false;
    }

    modal.style.display = 'flex';
}
window.openUserModal = openUserModal;

async function saveUser() {
    const feedback = document.getElementById('user-form-feedback');
    const email = document.getElementById('user-email').value.trim();
    const originalEmail = document.getElementById('user-edit-email-original').value;
    const isEdit = !!originalEmail;

    if (!email) { feedback.textContent = '⚠️ Email requerido'; return; }

    const record = {
        'Email': email,
        'Password Hash': document.getElementById('user-password').value,
        'Company Name': document.getElementById('user-company').value,
        'Logo URL': document.getElementById('user-logo').value,
        'Is Active': document.getElementById('user-is-active').checked,
        'Is Admin': document.getElementById('user-is-admin').checked,
        'API Base': document.getElementById('user-api-base').value,
        'XC Token': document.getElementById('user-xc-token').value,
        'Leads Table': document.getElementById('user-leads-table').value,
        'Call Logs Table': document.getElementById('user-calllogs-table').value,
        'Confirmed Table': document.getElementById('user-confirmed-table').value,
        'Error Logs Table': document.getElementById('user-errorlogs-table').value,
        'Vapi API Key': document.getElementById('user-vapi-key').value,
        'Vapi Public Key': document.getElementById('user-vapi-public').value,
        'Vapi Assistant ID': document.getElementById('user-vapi-assistant').value,
        'Vapi Phone Number ID': document.getElementById('user-vapi-phone').value,
        'Zadarma Key': document.getElementById('user-zadarma-key').value,
        'Zadarma Secret': document.getElementById('user-zadarma-secret').value,
        'Zadarma From Number': document.getElementById('user-zadarma-number').value,
        'OpenAI API Key': document.getElementById('user-openai-key').value,
        'N8N Webhook Base': document.getElementById('user-n8n-base').value
    };

    feedback.textContent = '⏳ Guardando...';

    try {
        if (isEdit) {
            await fetch(`${ADMIN_NOCODB_BASE}/${ADMIN_USERS_TABLE}/records`, {
                method: 'PATCH',
                headers: { 'xc-token': ADMIN_XC_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify(record)
            });
        } else {
            await fetch(`${ADMIN_NOCODB_BASE}/${ADMIN_USERS_TABLE}/records`, {
                method: 'POST',
                headers: { 'xc-token': ADMIN_XC_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify(record)
            });
        }

        feedback.textContent = '✅ Usuario guardado correctamente';
        setTimeout(() => {
            document.getElementById('user-edit-modal').style.display = 'none';
            loadAdminUsers();
        }, 800);
    } catch (err) {
        console.error('Admin: Error saving user:', err);
        feedback.textContent = '❌ Error al guardar: ' + err.message;
    }
}

async function toggleUserActive(email) {
    const u = _adminUsers.find(usr => usr['Email'] === email);
    if (!u) return;
    const newState = !u['Is Active'];
    const action = newState ? 'activar' : 'desactivar';
    if (!confirm(`¿Seguro que quieres ${action} a ${u['Company Name'] || email}?`)) return;

    try {
        await fetch(`${ADMIN_NOCODB_BASE}/${ADMIN_USERS_TABLE}/records`, {
            method: 'PATCH',
            headers: { 'xc-token': ADMIN_XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ 'Email': email, 'Is Active': newState })
        });
        await loadAdminUsers();
    } catch (err) {
        console.error('Admin: Error toggling user:', err);
    }
}
window.toggleUserActive = toggleUserActive;

// Admin event listeners
(function initAdminPanel() {
    document.getElementById('btn-add-user')?.addEventListener('click', () => openUserModal());
    document.getElementById('admin-refresh-btn')?.addEventListener('click', () => loadAdminUsers());
    document.getElementById('save-user-btn')?.addEventListener('click', () => saveUser());
    document.getElementById('close-user-modal')?.addEventListener('click', () => {
        document.getElementById('user-edit-modal').style.display = 'none';
    });
    document.getElementById('user-edit-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'user-edit-modal') document.getElementById('user-edit-modal').style.display = 'none';
    });
})();

#!/usr/bin/env node
/**
 * Bulk Call Script — Llama a todos los leads con teléfono válido
 * que NO tienen fecha_planificada y NO están completados.
 * 
 * ⚠️ HARD LIMIT: Maximum 10 concurrent calls at ANY time (Vapi limit).
 *    Before each call, we verify active calls via the Vapi API.
 *    If at the limit, we wait until a slot opens up.
 * 
 * Usage: node bulk_call_all.mjs [--dry-run] [--assistant marcos|violeta]
 */

const API_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const LEADS_TABLE = 'mf0wzufqcpi3bd1';
const CALL_LOGS_TABLE = 'm73w58ba47ifkrx';
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

const VAPI_API_KEY = '0594f41c-e836-425d-aaa2-1c5b7d9e506e';
const VAPI_PHONE_NUMBER_ID = 'ee153e9d-ece6-4469-a634-70eaa6e083c4';

const ASSISTANTS = {
    carolina: 'f3359bb0-7bc4-45c7-9a02-ca4793cc5d48',
    marcos: 'f34469b5-334e-4fbf-b5ad-b2b05e8d76ee'
};

const MAX_CONCURRENT_CALLS = 3;  // ⚠️ SIP trunk limit is ~10, but 3 is safe to avoid errors
const DELAY_BETWEEN_CALLS_MS = 15000; // 15 seconds between calls — prevents SIP 503 errors
const CONCURRENCY_CHECK_INTERVAL_MS = 15000; // 15 seconds wait when at max concurrency
const MAX_CONCURRENCY_RETRIES = 40; // 40 * 15s = 10 minutes max wait
const RECENT_CALL_WINDOW_MS = 30 * 60 * 1000; // 30 minutes — skip numbers called recently
const MAX_SIP_FAILURES_PER_NUMBER = 2; // Skip numbers that failed 2+ times today

// Parse args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const assistantArg = args.find(a => a.startsWith('--assistant'));
const assistantName = assistantArg ? args[args.indexOf(assistantArg) + 1] : 'carolina';
const ASSISTANT_ID = ASSISTANTS[assistantName] || ASSISTANTS.carolina;

function normalizePhone(phone) {
    let p = phone.toString().replace(/\D/g, '');
    if (!p) return '';
    return p.startsWith('34') ? '+' + p : '+34' + p;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Query Vapi API for the number of currently active calls.
 * Active = queued, ringing, or in-progress.
 * Also returns the set of phone numbers currently in active calls.
 */
async function getActiveCallInfo() {
    try {
        const res = await fetch('https://api.vapi.ai/call?limit=100', {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (!res.ok) {
            console.warn(`   ⚠️ Error checking active calls: HTTP ${res.status}`);
            return { count: -1, activePhones: new Set() };
        }
        const calls = await res.json();
        const activeCalls = (Array.isArray(calls) ? calls : []).filter(c =>
            ['queued', 'ringing', 'in-progress'].includes(c.status)
        );
        const activePhones = new Set(activeCalls.map(c => c.customer?.number).filter(Boolean));
        return { count: activeCalls.length, activePhones };
    } catch (err) {
        console.warn(`   ⚠️ Error checking active calls: ${err.message}`);
        return { count: -1, activePhones: new Set() };
    }
}

async function getActiveCallCount() {
    const info = await getActiveCallInfo();
    return info.count;
}

/**
 * Fetch phones called in the last RECENT_CALL_WINDOW_MS from Vapi.
 * Returns a Set of normalized phone numbers.
 * This provides cross-session dedup (n8n + script + manual).
 */
async function fetchRecentCallPhonesFromVapi() {
    try {
        const res = await fetch('https://api.vapi.ai/call?limit=100', {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (!res.ok) {
            console.warn('   ⚠️ Could not fetch recent calls for dedup.');
            return new Set();
        }
        const calls = await res.json();
        const cutoff = Date.now() - RECENT_CALL_WINDOW_MS;
        const recentPhones = new Set();
        for (const c of (Array.isArray(calls) ? calls : [])) {
            const created = new Date(c.createdAt).getTime();
            if (created >= cutoff && c.customer?.number) {
                recentPhones.add(c.customer.number);
            }
        }
        return recentPhones;
    } catch (err) {
        console.warn(`   ⚠️ Error fetching recent calls for dedup: ${err.message}`);
        return new Set();
    }
}

/**
 * Fetch phones that have failed with SIP errors 2+ times today.
 * Returns a Set of normalized phone numbers to skip.
 */
async function fetchTodayFailedPhones() {
    try {
        const res = await fetch('https://api.vapi.ai/call?limit=100', {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (!res.ok) return new Set();
        const calls = await res.json();

        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
        const failCounts = {};

        for (const c of (Array.isArray(calls) ? calls : [])) {
            const callDate = c.createdAt?.substring(0, 10);
            if (callDate !== today) continue;
            const reason = c.endedReason || '';
            if (reason.includes('error-sip') || reason.includes('error-providerfault')) {
                const phone = c.customer?.number;
                if (phone) {
                    failCounts[phone] = (failCounts[phone] || 0) + 1;
                }
            }
        }

        const blockedPhones = new Set();
        for (const [phone, count] of Object.entries(failCounts)) {
            if (count >= MAX_SIP_FAILURES_PER_NUMBER) {
                blockedPhones.add(phone);
            }
        }
        return blockedPhones;
    } catch (err) {
        console.warn(`   ⚠️ Error fetching failed phones: ${err.message}`);
        return new Set();
    }
}

/**
 * Update lead status in NocoDB when a call fails with SIP error.
 * Resets "Llamando..." → "Fallida - SIP" so the dashboard is accurate.
 */
async function updateLeadStatusOnFailure(lead, sipReason) {
    try {
        await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
            method: 'PATCH',
            headers: {
                'xc-token': XC_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify([{
                unique_id: lead.unique_id,
                status: `Fallida - ${sipReason || 'SIP'}`,
                fecha_planificada: null
            }])
        });
    } catch (err) {
        console.warn(`   ⚠️ Error updating lead status after SIP failure: ${err.message}`);
    }
}

/**
 * Wait until there's a free slot (active calls < MAX_CONCURRENT_CALLS).
 * Also checks that the target phone is not already in an active call.
 * Returns { available: true/false, activePhones: Set }
 */
async function waitForAvailableSlot(targetPhone) {
    for (let attempt = 0; attempt < MAX_CONCURRENCY_RETRIES; attempt++) {
        const info = await getActiveCallInfo();

        if (info.count === -1) {
            console.log(`   ⚠️ Could not verify concurrency. Waiting ${CONCURRENCY_CHECK_INTERVAL_MS / 1000}s to retry...`);
            await sleep(CONCURRENCY_CHECK_INTERVAL_MS);
            continue;
        }

        // Check if target phone is already in an active call
        if (targetPhone && info.activePhones.has(targetPhone)) {
            console.log(`   🚫 Phone ${targetPhone} already has an active call. Skipping.`);
            return { available: false, reason: 'phone_active' };
        }

        if (info.count < MAX_CONCURRENT_CALLS) {
            if (attempt > 0) {
                console.log(`   ✅ Slot available! Active calls: ${info.count}/${MAX_CONCURRENT_CALLS}`);
            }
            return { available: true };
        }

        const now = new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        console.log(`   🚫 [${now}] Concurrency limit: ${info.count}/${MAX_CONCURRENT_CALLS} active. Waiting ${CONCURRENCY_CHECK_INTERVAL_MS / 1000}s... (${attempt + 1}/${MAX_CONCURRENCY_RETRIES})`);
        await sleep(CONCURRENCY_CHECK_INTERVAL_MS);
    }

    console.error(`   ❌ Timed out waiting for a free slot after ${MAX_CONCURRENCY_RETRIES} attempts.`);
    return { available: false, reason: 'timeout' };
}

async function fetchAllLeads() {
    const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records?limit=200`, {
        headers: { 'xc-token': XC_TOKEN }
    });
    const data = await res.json();
    return data.list || [];
}

async function callLead(lead) {
    const phone = normalizePhone(lead.phone);
    let name = (lead.name || '').trim();
    const validName = name.length >= 2 && name.toLowerCase() !== 'empresa';
    
    // Si no hay nombre válido, usamos un nombre genérico para referirnos a él, pero no lo pronunciamos
    const nombreVariables = validName ? name : 'el titular de la vivienda';
    const firstGreeting = validName ? `¡Hola! ¿Hablo con ${name}?` : '¡Hola! Buenas tardes. Soy Carolina de Setter Solar.';

    console.log(`  📞 Llamando a ${validName ? name : phone} (${phone})...`);

    if (DRY_RUN) {
        console.log(`  ✅ [DRY RUN] Se llamaría a ${name} (${phone})`);
        return { success: true, dry: true, lead };
    }

    const MAX_CALL_RETRIES = 3;
    const RETRY_BACKOFF_BASE_MS = 15000; // 15s, 30s, 60s

    for (let attempt = 1; attempt <= MAX_CALL_RETRIES; attempt++) {
        try {
            // 1. Initiate call via Vapi
            const vapiRes = await fetch('https://api.vapi.ai/call', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VAPI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    customer: { number: phone },
                    assistantId: ASSISTANT_ID,
                    phoneNumberId: VAPI_PHONE_NUMBER_ID,
                    assistantOverrides: {
                        firstMessage: firstGreeting,
                        variableValues: {
                            nombre: nombreVariables,
                            empresa: name || '',
                            tel_contacto: phone,
                            ciudad: lead.Localidad || lead.address || 'tu zona',
                            leadId: lead.unique_id || '',
                            fecha_hoy: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }),
                            dia_semana: new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long' })
                        }
                    }
                })
            });

            const vapiData = await vapiRes.json();

            if (!vapiRes.ok) {
                const errMsg = vapiData.message || JSON.stringify(vapiData);
                const isSipError = errMsg.toLowerCase().includes('sip') ||
                    errMsg.includes('503') ||
                    errMsg.toLowerCase().includes('rate') ||
                    errMsg.toLowerCase().includes('capacity') ||
                    errMsg.toLowerCase().includes('busy') ||
                    vapiRes.status === 429 || vapiRes.status === 503;

                if (isSipError && attempt < MAX_CALL_RETRIES) {
                    const waitMs = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
                    console.log(`  ⚠️ SIP/Rate error (attempt ${attempt}/${MAX_CALL_RETRIES}): ${errMsg}`);
                    console.log(`  ⏳ Retrying in ${waitMs / 1000}s...`);
                    await sleep(waitMs);
                    continue; // Retry
                }

                // ⚠️ AUTO-RECOVERY: Reset lead status from "Llamando..." to "Fallida - SIP"
                console.log(`  ❌ Error Vapi para ${name}: ${errMsg}`);
                await updateLeadStatusOnFailure(lead, isSipError ? 'SIP' : 'API');
                return { success: false, error: errMsg, lead };
            }

            console.log(`  ✅ Llamada iniciada para ${name} — Vapi ID: ${vapiData.id}${attempt > 1 ? ` (retry ${attempt})` : ''}`);

            // 2. Log to NocoDB call_logs
            try {
                await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
                    method: 'POST',
                    headers: {
                        'xc-token': XC_TOKEN,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        vapi_call_id: vapiData.id,
                        lead_name: name,
                        phone_called: phone,
                        call_time: new Date().toISOString(),
                        ended_reason: 'Bulk Call Trigger'
                    })
                });
            } catch (logErr) {
                console.log(`  ⚠️ Log a NocoDB falló para ${name}: ${logErr.message}`);
            }

            // 3. Update lead status + clear fecha_planificada
            try {
                await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                    method: 'PATCH',
                    headers: {
                        'xc-token': XC_TOKEN,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify([{
                        unique_id: lead.unique_id,
                        status: 'Llamando...',
                        fecha_planificada: null
                    }])
                });
            } catch (updateErr) {
                console.log(`  ⚠️ Update lead falló para ${name}: ${updateErr.message}`);
            }

            return { success: true, vapiId: vapiData.id, lead };
        } catch (err) {
            if (attempt < MAX_CALL_RETRIES) {
                const waitMs = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
                console.log(`  ⚠️ Error (attempt ${attempt}/${MAX_CALL_RETRIES}): ${err.message}`);
                console.log(`  ⏳ Retrying in ${waitMs / 1000}s...`);
                await sleep(waitMs);
                continue;
            }
            console.log(`  ❌ Error general para ${name} tras ${MAX_CALL_RETRIES} intentos: ${err.message}`);
            return { success: false, error: err.message, lead };
        }
    }
}

async function main() {
    console.log('═'.repeat(60));
    console.log('🚀 BULK CALL SCRIPT — Llamando a todos los leads');
    console.log(`   Asistente: ${assistantName.toUpperCase()} (${ASSISTANT_ID.substring(0, 8)}...)`);
    console.log(`   🔒 Max concurrent calls: ${MAX_CONCURRENT_CALLS}`);
    if (DRY_RUN) console.log('   ⚠️  MODO DRY RUN — No se harán llamadas reales');
    console.log('═'.repeat(60));

    // 🛡️ SECURITY: Run preflight checks (business hours, concurrency, max daily calls)
    const { runPreflightChecks } = await import('./preflight_check.mjs');
    const preflight = await runPreflightChecks();
    if (!preflight.allowed) {
        console.error('\n🛑 SCRIPT BLOQUEADO POR PREFLIGHT CHECKS.');
        process.exit(1);
    }

    // Check current concurrency
    const initialActive = await getActiveCallCount();
    if (initialActive >= 0) {
        console.log(`📊 Current active calls: ${initialActive}/${MAX_CONCURRENT_CALLS}`);
        if (initialActive >= MAX_CONCURRENT_CALLS) {
            console.log(`⚠️  Already at max concurrency! Will wait for slots to open...\n`);
        }
    }

    // 1. Fetch all leads
    const allLeads = await fetchAllLeads();
    console.log(`📋 Total leads en DB: ${allLeads.length}`);

    // 2. Filter eligible leads — include scheduled ones (we're overriding the scheduler)
    const eligible = allLeads.filter(lead => {
        const phone = lead.phone;
        if (!phone || phone === '0' || phone === 'N/A') return false;
        // Exclude test leads (Sergio entries)
        if ((lead.name || '').toLowerCase() === 'sergio') return false;
        const status = (lead.status || '').toLowerCase();
        if (status.includes('completado') || status.includes('llamando') || status.includes('contestador')) return false;
        return true;
    });

    console.log(`✅ Leads elegibles para llamar: ${eligible.length}`);

    if (eligible.length === 0) {
        console.log('ℹ️ No hay leads pendientes de llamar.');
        return;
    }

    console.log(`📦 Processing ${eligible.length} calls sequentially with concurrency check\n`);

    // ⚠️ GLOBAL DEDUP: Fetch recently-called phones from Vapi API (cross-session dedup)
    console.log('🔍 Checking recently called numbers (cross-session dedup)...');
    const recentlyCalledPhones = await fetchRecentCallPhonesFromVapi();
    if (recentlyCalledPhones.size > 0) {
        console.log(`   Found ${recentlyCalledPhones.size} numbers called in the last ${RECENT_CALL_WINDOW_MS / 60000} min.`);
    }

    // ⚠️ BLACKLIST: Fetch phones with 2+ SIP failures today
    console.log('🔍 Checking numbers with repeated SIP failures today...');
    const sipBlacklist = await fetchTodayFailedPhones();
    if (sipBlacklist.size > 0) {
        console.log(`   🚫 ${sipBlacklist.size} numbers blacklisted (${MAX_SIP_FAILURES_PER_NUMBER}+ SIP failures today).`);
    }

    // 3. Process each call sequentially, checking concurrency before each one
    const allResults = [];
    let skipped = 0;
    const calledPhones = new Set(); // Track phones called in this session to avoid duplicates

    for (let i = 0; i < eligible.length; i++) {
        const lead = eligible[i];
        const name = lead.name || 'Empresa';
        const phone = normalizePhone(lead.phone);
        const now = new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' });

        console.log(`\n[${i + 1}/${eligible.length}] ${now} — ${name}`);
        console.log('─'.repeat(50));

        // ⚠️ RULE: Never call the same number twice in one session
        if (calledPhones.has(phone)) {
            console.log(`  ⏭️  Skipping ${name} (${phone}) — same number already called in this session.`);
            allResults.push({ success: false, error: 'Duplicate phone in session', lead });
            skipped++;
            continue;
        }

        // ⚠️ GLOBAL DEDUP: Skip if called recently by any source (n8n, another script, etc.)
        if (recentlyCalledPhones.has(phone)) {
            console.log(`  ⏭️  Skipping ${name} (${phone}) — already called in last ${RECENT_CALL_WINDOW_MS / 60000} min (cross-session dedup).`);
            allResults.push({ success: false, error: 'Recently called (cross-session dedup)', lead });
            skipped++;
            continue;
        }

        // ⚠️ BLACKLIST: Skip numbers with repeated SIP failures today
        if (sipBlacklist.has(phone)) {
            console.log(`  ⏭️  Skipping ${name} (${phone}) — ${MAX_SIP_FAILURES_PER_NUMBER}+ SIP failures today. Will retry tomorrow.`);
            allResults.push({ success: false, error: `SIP blacklisted (${MAX_SIP_FAILURES_PER_NUMBER}+ failures today)`, lead });
            skipped++;
            continue;
        }

        // ⚠️ CRITICAL: Check concurrency + active phone before EVERY call
        if (!DRY_RUN) {
            const slot = await waitForAvailableSlot(phone);
            if (!slot.available) {
                const reason = slot.reason === 'phone_active'
                    ? `Phone ${phone} already in active call`
                    : 'Concurrency timeout';
                console.log(`  ⏭️  Skipping ${name} — ${reason}`);
                allResults.push({ success: false, error: reason, lead });
                skipped++;
                continue;
            }
        }

        calledPhones.add(phone);
        const result = await callLead(lead);
        allResults.push(result);

        // Small delay between calls to avoid hammering the API
        if (i < eligible.length - 1) {
            await sleep(DELAY_BETWEEN_CALLS_MS);
        }
    }

    // 4. Summary
    const totalSuccess = allResults.filter(r => r.success).length;
    const totalFail = allResults.filter(r => !r.success).length;

    console.log('\n' + '═'.repeat(60));
    console.log('📊 RESUMEN FINAL');
    console.log('═'.repeat(60));
    console.log(`   Total llamadas: ${allResults.length}`);
    console.log(`   ✅ Éxitos: ${totalSuccess}`);
    console.log(`   ❌ Fallos: ${totalFail}`);
    console.log(`   ⏭️  Skipped (concurrency): ${skipped}`);

    if (totalFail > 0) {
        console.log('\n   Leads con error:');
        allResults.filter(r => !r.success).forEach(r => {
            console.log(`     - ${r.lead.name}: ${r.error}`);
        });
    }

    console.log('\n✨ Script completado.');
}

main().catch(err => {
    console.error('💥 Error fatal:', err);
    process.exit(1);
});


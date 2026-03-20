#!/usr/bin/env node
/**
 * Daily Batch Calls — Llamadas automáticas diarias
 * 
 * Llama a un lote de N leads cada ejecución (por defecto 10).
 * Diseñado para ejecutarse con un cron a las 9:00 AM todos los días.
 * 
 * Reutiliza toda la lógica de protección de bulk_call_all.mjs:
 *   ✅ Preflight checks (horario comercial, límite diario, concurrencia)
 *   ✅ Dedup cross-session (no repetir números llamados recientemente)
 *   ✅ Blacklist SIP (saltar números con 2+ fallos SIP hoy)
 *   ✅ Control de concurrencia (máx 3 simultáneas)
 *   ✅ Reintentos con backoff exponencial ante errores SIP
 *   ✅ Recuperación automática de estado del lead tras fallo
 * 
 * Usage:
 *   node daily_batch_calls.mjs                    # 10 llamadas con Carolina
 *   node daily_batch_calls.mjs --limit 5          # 5 llamadas
 *   node daily_batch_calls.mjs --assistant marcos  # Usar asistente Marcos
 *   node daily_batch_calls.mjs --dry-run           # Simular sin llamar
 * 
 * Cron (9:00 AM todos los días):
 *   0 9 * * * cd /ruta/a/setter-solar && /usr/bin/node daily_batch_calls.mjs >> logs/daily_calls.log 2>&1
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

// ── Configuración del lote diario ──
const DEFAULT_BATCH_SIZE = 10;
const MAX_CONCURRENT_CALLS = 3;
const DELAY_BETWEEN_CALLS_MS = 15000;       // 15s entre llamadas
const CONCURRENCY_CHECK_INTERVAL_MS = 15000;
const MAX_CONCURRENCY_RETRIES = 40;
const RECENT_CALL_WINDOW_MS = 30 * 60 * 1000; // 30 min dedup
const MAX_SIP_FAILURES_PER_NUMBER = 2;

// ── Parse args ──
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const BATCH_SIZE = limitIdx !== -1 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : DEFAULT_BATCH_SIZE;
const assistantArg = args.indexOf('--assistant');
const assistantName = assistantArg !== -1 && args[assistantArg + 1] ? args[assistantArg + 1] : 'carolina';
const ASSISTANT_ID = ASSISTANTS[assistantName] || ASSISTANTS.carolina;

function normalizePhone(phone) {
    let p = phone.toString().replace(/\D/g, '');
    if (!p) return '';
    return p.startsWith('34') ? '+' + p : '+34' + p;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
    return new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Funciones de seguridad (reutilizadas de bulk_call_all.mjs) ──

async function getActiveCallInfo() {
    try {
        const res = await fetch('https://api.vapi.ai/call?limit=100', {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (!res.ok) return { count: -1, activePhones: new Set() };
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

async function fetchRecentCallPhonesFromVapi() {
    try {
        const res = await fetch('https://api.vapi.ai/call?limit=100', {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (!res.ok) return new Set();
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
        return new Set();
    }
}

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
            if (c.createdAt?.substring(0, 10) !== today) continue;
            const reason = c.endedReason || '';
            if (reason.includes('error-sip') || reason.includes('error-providerfault')) {
                const phone = c.customer?.number;
                if (phone) failCounts[phone] = (failCounts[phone] || 0) + 1;
            }
        }
        const blocked = new Set();
        for (const [phone, count] of Object.entries(failCounts)) {
            if (count >= MAX_SIP_FAILURES_PER_NUMBER) blocked.add(phone);
        }
        return blocked;
    } catch (err) {
        return new Set();
    }
}

async function updateLeadStatusOnFailure(lead, sipReason) {
    try {
        await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
            method: 'PATCH',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify([{
                unique_id: lead.unique_id,
                status: `Fallida - ${sipReason || 'SIP'}`,
                fecha_planificada: null
            }])
        });
    } catch (err) {
        console.warn(`   ⚠️ Error updating lead status: ${err.message}`);
    }
}

async function waitForAvailableSlot(targetPhone) {
    for (let attempt = 0; attempt < MAX_CONCURRENCY_RETRIES; attempt++) {
        const info = await getActiveCallInfo();
        if (info.count === -1) {
            await sleep(CONCURRENCY_CHECK_INTERVAL_MS);
            continue;
        }
        if (targetPhone && info.activePhones.has(targetPhone)) {
            return { available: false, reason: 'phone_active' };
        }
        if (info.count < MAX_CONCURRENT_CALLS) {
            if (attempt > 0) console.log(`   ✅ Slot libre. Activas: ${info.count}/${MAX_CONCURRENT_CALLS}`);
            return { available: true };
        }
        console.log(`   🚫 [${timestamp()}] Concurrencia: ${info.count}/${MAX_CONCURRENT_CALLS}. Esperando... (${attempt + 1}/${MAX_CONCURRENCY_RETRIES})`);
        await sleep(CONCURRENCY_CHECK_INTERVAL_MS);
    }
    return { available: false, reason: 'timeout' };
}

// ── Fetch de leads ──

async function fetchEligibleLeads(limit) {
    // Traemos más de los que necesitamos para poder filtrar
    const fetchLimit = Math.max(limit * 3, 200);
    const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records?limit=${fetchLimit}`, {
        headers: { 'xc-token': XC_TOKEN }
    });
    const data = await res.json();
    const allLeads = data.list || [];

    // Filtrar elegibles (misma lógica que bulk_call_all.mjs)
    const eligible = allLeads.filter(lead => {
        const phone = lead.phone;
        if (!phone || phone === '0' || phone === 'N/A') return false;
        if ((lead.name || '').toLowerCase() === 'sergio') return false;
        const status = (lead.status || '').toLowerCase();
        if (status.includes('completado') || status.includes('llamando') || status.includes('contestador')) return false;
        return true;
    });

    // Devolver solo los primeros N
    return eligible.slice(0, limit);
}

// ── Llamada individual ──

async function callLead(lead) {
    const phone = normalizePhone(lead.phone);
    const name = lead.name || 'Empresa';

    console.log(`  📞 Llamando a ${name} (${phone})...`);

    if (DRY_RUN) {
        console.log(`  ✅ [DRY RUN] Se llamaría a ${name} (${phone})`);
        return { success: true, dry: true, lead };
    }

    const MAX_CALL_RETRIES = 3;
    const RETRY_BACKOFF_BASE_MS = 15000;

    for (let attempt = 1; attempt <= MAX_CALL_RETRIES; attempt++) {
        try {
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
                        variableValues: {
                            nombre: name,
                            empresa: lead.name || '',
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
                    console.log(`  ⚠️ SIP/Rate error (intento ${attempt}/${MAX_CALL_RETRIES}): ${errMsg}`);
                    console.log(`  ⏳ Reintentando en ${waitMs / 1000}s...`);
                    await sleep(waitMs);
                    continue;
                }

                console.log(`  ❌ Error Vapi para ${name}: ${errMsg}`);
                await updateLeadStatusOnFailure(lead, isSipError ? 'SIP' : 'API');
                return { success: false, error: errMsg, lead };
            }

            console.log(`  ✅ Llamada iniciada — ${name} — Vapi ID: ${vapiData.id}`);

            // Log a NocoDB
            try {
                await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
                    method: 'POST',
                    headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        vapi_call_id: vapiData.id,
                        lead_name: name,
                        phone_called: phone,
                        call_time: new Date().toISOString(),
                        ended_reason: 'Daily Batch Call'
                    })
                });
            } catch (logErr) {
                console.log(`  ⚠️ Log NocoDB falló: ${logErr.message}`);
            }

            // Actualizar estado del lead
            try {
                await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                    method: 'PATCH',
                    headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                    body: JSON.stringify([{
                        unique_id: lead.unique_id,
                        status: 'Llamando...',
                        fecha_planificada: null
                    }])
                });
            } catch (updateErr) {
                console.log(`  ⚠️ Update lead falló: ${updateErr.message}`);
            }

            return { success: true, vapiId: vapiData.id, lead };
        } catch (err) {
            if (attempt < MAX_CALL_RETRIES) {
                const waitMs = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
                console.log(`  ⚠️ Error (intento ${attempt}/${MAX_CALL_RETRIES}): ${err.message}`);
                await sleep(waitMs);
                continue;
            }
            console.log(`  ❌ Error general para ${name} tras ${MAX_CALL_RETRIES} intentos: ${err.message}`);
            return { success: false, error: err.message, lead };
        }
    }
}

// ── Main ──

async function main() {
    const startTime = new Date();
    console.log('═'.repeat(60));
    console.log('🌅 DAILY BATCH CALLS — Lote automático de la mañana');
    console.log(`   📅 ${startTime.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`);
    console.log(`   🕘 ${startTime.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' })}`);
    console.log(`   🤖 Asistente: ${assistantName.toUpperCase()} (${ASSISTANT_ID.substring(0, 8)}...)`);
    console.log(`   📞 Lote: ${BATCH_SIZE} llamadas`);
    console.log(`   🔒 Max concurrencia: ${MAX_CONCURRENT_CALLS}`);
    if (DRY_RUN) console.log('   ⚠️  MODO DRY RUN — No se harán llamadas reales');
    console.log('═'.repeat(60));

    // 🛡️ Preflight checks
    const { runPreflightChecks } = await import('./preflight_check.mjs');
    const preflight = await runPreflightChecks();
    if (!preflight.allowed) {
        console.error('\n🛑 BLOQUEADO POR PREFLIGHT CHECKS. No se realizarán llamadas.');
        process.exit(1);
    }

    // Obtener leads elegibles (solo BATCH_SIZE)
    console.log(`\n📋 Obteniendo ${BATCH_SIZE} leads elegibles...`);
    const leads = await fetchEligibleLeads(BATCH_SIZE);
    console.log(`   Encontrados: ${leads.length} leads`);

    if (leads.length === 0) {
        console.log('ℹ️ No hay leads pendientes de llamar. Nada que hacer.');
        return;
    }

    // Dedup y blacklist
    console.log('\n🔍 Aplicando filtros de seguridad...');
    const recentlyCalledPhones = await fetchRecentCallPhonesFromVapi();
    if (recentlyCalledPhones.size > 0) {
        console.log(`   📵 ${recentlyCalledPhones.size} números llamados recientemente (dedup).`);
    }

    const sipBlacklist = await fetchTodayFailedPhones();
    if (sipBlacklist.size > 0) {
        console.log(`   🚫 ${sipBlacklist.size} números en blacklist SIP.`);
    }

    // Procesar llamadas
    const results = [];
    let skipped = 0;
    const calledPhones = new Set();

    for (let i = 0; i < leads.length; i++) {
        const lead = leads[i];
        const name = lead.name || 'Empresa';
        const phone = normalizePhone(lead.phone);

        console.log(`\n[${i + 1}/${leads.length}] ${timestamp()} — ${name}`);
        console.log('─'.repeat(50));

        // Dedup en sesión
        if (calledPhones.has(phone)) {
            console.log(`  ⏭️ Duplicado en sesión, saltando.`);
            skipped++;
            continue;
        }

        // Dedup cross-session
        if (recentlyCalledPhones.has(phone)) {
            console.log(`  ⏭️ Llamado recientemente, saltando.`);
            skipped++;
            continue;
        }

        // Blacklist SIP
        if (sipBlacklist.has(phone)) {
            console.log(`  ⏭️ Blacklist SIP (${MAX_SIP_FAILURES_PER_NUMBER}+ fallos), saltando.`);
            skipped++;
            continue;
        }

        // Control de concurrencia
        if (!DRY_RUN) {
            const slot = await waitForAvailableSlot(phone);
            if (!slot.available) {
                console.log(`  ⏭️ Sin slot disponible (${slot.reason}), saltando.`);
                skipped++;
                continue;
            }
        }

        calledPhones.add(phone);
        const result = await callLead(lead);
        results.push(result);

        // Delay entre llamadas
        if (i < leads.length - 1) {
            await sleep(DELAY_BETWEEN_CALLS_MS);
        }
    }

    // Resumen
    const totalSuccess = results.filter(r => r.success).length;
    const totalFail = results.filter(r => !r.success).length;
    const elapsed = ((Date.now() - startTime.getTime()) / 1000).toFixed(0);

    console.log('\n' + '═'.repeat(60));
    console.log('📊 RESUMEN — DAILY BATCH');
    console.log('═'.repeat(60));
    console.log(`   📞 Llamadas realizadas: ${results.length}`);
    console.log(`   ✅ Éxitos: ${totalSuccess}`);
    console.log(`   ❌ Fallos: ${totalFail}`);
    console.log(`   ⏭️  Saltados: ${skipped}`);
    console.log(`   ⏱️  Duración: ${elapsed}s`);

    if (totalFail > 0) {
        console.log('\n   Leads con error:');
        results.filter(r => !r.success).forEach(r => {
            console.log(`     - ${r.lead.name}: ${r.error}`);
        });
    }

    console.log('\n✨ Lote diario completado.');
}

main().catch(err => {
    console.error('💥 Error fatal:', err);
    process.exit(1);
});

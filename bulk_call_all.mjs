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
const VAPI_PHONE_NUMBER_ID = 'b3b47ab7-b74b-46b9-bf72-0f82d6731f56';

const ASSISTANTS = {
    carolina: 'f3359bb0-7bc4-45c7-9a02-ca4793cc5d48',
    marcos: 'f34469b5-334e-4fbf-b5ad-b2b05e8d76ee'
};

const MAX_CONCURRENT_CALLS = 10;
const DELAY_BETWEEN_CALLS_MS = 10000; // 10 seconds between calls — prevents SIP 503 errors
const CONCURRENCY_CHECK_INTERVAL_MS = 15000; // 15 seconds wait when at max concurrency
const MAX_CONCURRENCY_RETRIES = 40; // 40 * 15s = 10 minutes max wait

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
 */
async function getActiveCallCount() {
    try {
        const res = await fetch('https://api.vapi.ai/call?limit=100', {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (!res.ok) {
            console.warn(`   ⚠️ Error checking active calls: HTTP ${res.status}`);
            return -1;
        }
        const calls = await res.json();
        const activeCalls = (Array.isArray(calls) ? calls : []).filter(c =>
            ['queued', 'ringing', 'in-progress'].includes(c.status)
        );
        return activeCalls.length;
    } catch (err) {
        console.warn(`   ⚠️ Error checking active calls: ${err.message}`);
        return -1;
    }
}

/**
 * Wait until there's a free slot (active calls < MAX_CONCURRENT_CALLS).
 * Returns true if a slot is available, false if we timed out.
 */
async function waitForAvailableSlot() {
    for (let attempt = 0; attempt < MAX_CONCURRENCY_RETRIES; attempt++) {
        const activeCount = await getActiveCallCount();

        if (activeCount === -1) {
            console.log(`   ⚠️ Could not verify concurrency. Waiting ${CONCURRENCY_CHECK_INTERVAL_MS / 1000}s to retry...`);
            await sleep(CONCURRENCY_CHECK_INTERVAL_MS);
            continue;
        }

        if (activeCount < MAX_CONCURRENT_CALLS) {
            if (attempt > 0) {
                console.log(`   ✅ Slot available! Active calls: ${activeCount}/${MAX_CONCURRENT_CALLS}`);
            }
            return true;
        }

        const now = new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        console.log(`   🚫 [${now}] Concurrency limit: ${activeCount}/${MAX_CONCURRENT_CALLS} active. Waiting ${CONCURRENCY_CHECK_INTERVAL_MS / 1000}s... (${attempt + 1}/${MAX_CONCURRENCY_RETRIES})`);
        await sleep(CONCURRENCY_CHECK_INTERVAL_MS);
    }

    console.error(`   ❌ Timed out waiting for a free slot after ${MAX_CONCURRENCY_RETRIES} attempts.`);
    return false;
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
    const name = lead.name || 'Empresa';

    console.log(`  📞 Llamando a ${name} (${phone})...`);

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
                        variableValues: {
                            nombre: name,
                            empresa: lead.name || '',
                            tel_contacto: phone,
                            localidad: lead.Localidad || 'tu zona',
                            leadId: lead.unique_id || ''
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

                console.log(`  ❌ Error Vapi para ${name}: ${errMsg}`);
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

    // 3. Process each call sequentially, checking concurrency before each one
    const allResults = [];
    let skipped = 0;

    for (let i = 0; i < eligible.length; i++) {
        const lead = eligible[i];
        const name = lead.name || 'Empresa';
        const now = new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' });

        console.log(`\n[${i + 1}/${eligible.length}] ${now} — ${name}`);
        console.log('─'.repeat(50));

        // ⚠️ CRITICAL: Check concurrency before EVERY call
        if (!DRY_RUN) {
            const slotAvailable = await waitForAvailableSlot();
            if (!slotAvailable) {
                console.log(`  ⏭️  Skipping ${name} — could not get a free slot.`);
                allResults.push({ success: false, error: 'Concurrency timeout', lead });
                skipped++;
                continue;
            }
        }

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


#!/usr/bin/env node
/**
 * Direct bulk call launcher — bypasses n8n, calls Vapi directly.
 * Fetches leads with status=Programado and launches calls immediately.
 * 
 * ⚠️ HARD LIMIT: Maximum 10 concurrent calls at any time.
 *    Before each call, we check Vapi for active calls and wait if at limit.
 */

const NOCODB_BASE = 'https://nocodb.srv889387.hstgr.cloud/api/v2/tables';
const LEADS_TABLE = 'mgot1kl4sglenym';
const CALL_LOGS_TABLE = 'm013en5u2cyu30j';
const XC_TOKEN = 'jx3uoKeVaidZLF7M0skVb9pV6yvNsam0Hu-Vfeww';
const VAPI_API_KEY = '852080ba-ce7c-4778-b218-bf718613a2b6';
const ASSISTANT_ID = '49e56db1-1f20-4cf1-b031-9cea9fba73cb';
const PHONE_NUMBER_ID = '611c8c8e-ab43-4af0-8df0-f2f8fac8115b';

const MAX_CONCURRENT_CALLS = 10;
const DELAY_BETWEEN_CALLS = 10; // seconds between calls
const CONCURRENCY_CHECK_INTERVAL = 15; // seconds to wait when at max concurrency
const MAX_CONCURRENCY_RETRIES = 40; // max retries waiting for a slot (40 * 15s = 10min max)

function formatPhone(phone) {
    let p = String(phone || '').replace(/\D/g, '');
    if (!p || p.length < 6) return null;
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
            return -1; // Unknown — treat cautiously
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
            // Could not check — wait a bit and try again, but don't skip the limit
            console.log(`   ⚠️ Could not verify concurrency. Waiting ${CONCURRENCY_CHECK_INTERVAL}s to retry...`);
            await sleep(CONCURRENCY_CHECK_INTERVAL * 1000);
            continue;
        }

        if (activeCount < MAX_CONCURRENT_CALLS) {
            if (attempt > 0) {
                console.log(`   ✅ Slot available! Active calls: ${activeCount}/${MAX_CONCURRENT_CALLS}`);
            }
            return true;
        }

        const now = new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        console.log(`   🚫 [${now}] Concurrency limit reached: ${activeCount}/${MAX_CONCURRENT_CALLS} active calls. Waiting ${CONCURRENCY_CHECK_INTERVAL}s... (attempt ${attempt + 1}/${MAX_CONCURRENCY_RETRIES})`);
        await sleep(CONCURRENCY_CHECK_INTERVAL * 1000);
    }

    console.error(`   ❌ Timed out waiting for a free slot after ${MAX_CONCURRENCY_RETRIES} attempts.`);
    return false;
}

async function main() {
    console.log('🚀 BULK CALL LAUNCHER');
    console.log(`⏰ Current time: ${new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' })}`);
    console.log(`⏱️  Delay between calls: ${DELAY_BETWEEN_CALLS}s`);
    console.log(`🔒 Max concurrent calls: ${MAX_CONCURRENT_CALLS}\n`);

    // Check current concurrency before starting
    const initialActive = await getActiveCallCount();
    if (initialActive >= 0) {
        console.log(`📊 Current active calls: ${initialActive}/${MAX_CONCURRENT_CALLS}`);
        if (initialActive >= MAX_CONCURRENT_CALLS) {
            console.log(`⚠️  Already at max concurrency! Will wait for slots to open...\n`);
        }
    }

    // 1. Fetch leads with status=Programado
    console.log('📡 Fetching leads with status=Programado...');
    let allLeads = [];
    let offset = 0;

    while (true) {
        const res = await fetch(`${NOCODB_BASE}/${LEADS_TABLE}/records?limit=200&offset=${offset}&where=(status,eq,Programado)`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        const data = await res.json();
        const records = data.list || [];
        allLeads = allLeads.concat(records);
        if (records.length < 200 || data.pageInfo?.isLastPage !== false) break;
        offset += 200;
    }

    // Filter for valid phones
    const eligible = allLeads.filter(l => formatPhone(l.phone));
    console.log(`   Found ${allLeads.length} Programado leads, ${eligible.length} with valid phone\n`);

    if (eligible.length === 0) {
        console.log('❌ No eligible leads found. Make sure to schedule calls first from the dashboard.');
        process.exit(1);
    }

    // Calculate estimated finish time
    const totalTime = eligible.length * DELAY_BETWEEN_CALLS;
    const endTime = new Date(Date.now() + totalTime * 1000);
    console.log(`📊 Plan: ${eligible.length} calls, ~${Math.ceil(totalTime / 60)} minutes`);
    console.log(`🏁 Estimated finish: ${endTime.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' })}\n`);

    // 2. Launch calls
    let success = 0;
    let errors = 0;
    let skipped = 0;

    for (let i = 0; i < eligible.length; i++) {
        const lead = eligible[i];
        const phone = formatPhone(lead.phone);
        const name = lead.name || 'Cliente';
        const address = lead.address || 'su localidad';
        const email = lead.email || '';

        // ⚠️ CRITICAL: Wait for available concurrency slot before launching
        const slotAvailable = await waitForAvailableSlot();
        if (!slotAvailable) {
            console.log(`⏭️  Skipping ${name} — could not get a free slot.`);
            skipped++;
            continue;
        }

        const now = new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        process.stdout.write(`[${i + 1}/${eligible.length}] ${now} ${name.substring(0, 35).padEnd(35)} ${phone} → `);

        try {
            // SIP retry with exponential backoff
            const MAX_CALL_RETRIES = 3;
            const RETRY_BACKOFF_BASE_MS = 15000;
            let callSuccess = false;

            for (let attempt = 1; attempt <= MAX_CALL_RETRIES; attempt++) {
                try {
                    // Call Vapi
                    const vapiRes = await fetch('https://api.vapi.ai/call', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${VAPI_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            customer: { number: phone },
                            assistantId: ASSISTANT_ID,
                            phoneNumberId: PHONE_NUMBER_ID,
                            assistantOverrides: {
                                variableValues: {
                                    nombre: name,
                                    empresa: name,
                                    ciudad: address,
                                    tel_contacto: phone,
                                    correo_cliente: email
                                }
                            }
                        })
                    });

                    const vapiData = await vapiRes.json();

                    if (!vapiRes.ok) {
                        const errMsg = vapiData.message || vapiData.error || `HTTP ${vapiRes.status}`;
                        const isSipError = errMsg.toLowerCase().includes('sip') ||
                            errMsg.includes('503') ||
                            errMsg.toLowerCase().includes('rate') ||
                            errMsg.toLowerCase().includes('capacity') ||
                            errMsg.toLowerCase().includes('busy') ||
                            vapiRes.status === 429 || vapiRes.status === 503;

                        if (isSipError && attempt < MAX_CALL_RETRIES) {
                            const waitMs = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
                            console.log(`⚠️ SIP error (attempt ${attempt}/${MAX_CALL_RETRIES}), retrying in ${waitMs / 1000}s...`);
                            await sleep(waitMs / 1000);
                            continue;
                        }
                        throw new Error(errMsg);
                    }

                    console.log(`✅ Call ID: ${vapiData.id?.substring(0, 12)}...${attempt > 1 ? ` (retry ${attempt})` : ''}`);

                    // Log to NocoDB
                    await fetch(`${NOCODB_BASE}/${CALL_LOGS_TABLE}/records`, {
                        method: 'POST',
                        headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            vapi_call_id: vapiData.id,
                            lead_name: name,
                            phone_called: phone,
                            call_time: new Date().toISOString(),
                            ended_reason: 'Call Initiated'
                        })
                    });

                    // Update lead status
                    await fetch(`${NOCODB_BASE}/${LEADS_TABLE}/records`, {
                        method: 'PATCH',
                        headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                        body: JSON.stringify([{
                            unique_id: lead.unique_id,
                            status: 'Completado',
                            fecha_planificada: null
                        }])
                    });

                    callSuccess = true;
                    success++;
                    break; // Success, exit retry loop
                } catch (retryErr) {
                    if (attempt < MAX_CALL_RETRIES && (retryErr.message.toLowerCase().includes('sip') || retryErr.message.includes('503'))) {
                        const waitMs = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
                        console.log(`⚠️ Retry ${attempt}/${MAX_CALL_RETRIES} in ${waitMs / 1000}s...`);
                        await sleep(waitMs / 1000);
                        continue;
                    }
                    throw retryErr; // Rethrow if not retryable or last attempt
                }
            }
        } catch (err) {
            console.log(`❌ ${err.message}`);
            errors++;

            // Still update lead to avoid retry
            try {
                await fetch(`${NOCODB_BASE}/${LEADS_TABLE}/records`, {
                    method: 'PATCH',
                    headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                    body: JSON.stringify([{
                        unique_id: lead.unique_id,
                        status: 'Fallido',
                        fecha_planificada: null
                    }])
                });
            } catch (_) { /* ignore */ }
        }

        // Wait between calls (except last one)
        if (i < eligible.length - 1) {
            await sleep(DELAY_BETWEEN_CALLS * 1000);
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🏁 DONE at ${new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' })}`);
    console.log(`✅ Success: ${success}`);
    console.log(`❌ Errors: ${errors}`);
    console.log(`⏭️  Skipped: ${skipped}`);
    console.log(`📊 Total: ${eligible.length}`);
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});

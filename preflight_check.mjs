#!/usr/bin/env node
/**
 * 🚀 PREFLIGHT CHECK — Run before launching bulk calls
 * 
 * Verifies:
 *  1. Vapi API is reachable and key is valid
 *  2. NocoDB API is reachable and token works
 *  3. Phone number is configured correctly in Vapi
 *  4. Assistant ID is valid
 *  5. Current concurrency status (active calls)
 *  6. Lead readiness (how many are eligible)
 *  7. Scheduled leads status
 * 
 * Usage: node preflight_check.mjs
 */

const VAPI_API_KEY = '852080ba-ce7c-4778-b218-bf718613a2b6';
const VAPI_PHONE_NUMBER_ID = '611c8c8e-ab43-4af0-8df0-f2f8fac8115b';

const ASSISTANTS = {
    violeta: '49e56db1-1f20-4cf1-b031-9cea9fba73cb',
    marcos: 'f34469b5-334e-4fbf-b5ad-b2b05e8d76ee'
};

const API_BASE = 'https://nocodb.srv889387.hstgr.cloud/api/v2/tables';
const LEADS_TABLE = 'mgot1kl4sglenym';
const CALL_LOGS_TABLE = 'm013en5u2cyu30j';
const XC_TOKEN = 'jx3uoKeVaidZLF7M0skVb9pV6yvNsam0Hu-Vfeww';

const MAX_CONCURRENT = 10;

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(msg) {
    console.log(`  ✅ ${msg}`);
    passed++;
}

function fail(msg) {
    console.log(`  ❌ ${msg}`);
    failed++;
}

function warn(msg) {
    console.log(`  ⚠️  ${msg}`);
    warnings++;
}

function section(title) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🔍 ${title}`);
    console.log('─'.repeat(50));
}

async function checkVapiAPI() {
    section('1. VAPI API');

    try {
        const res = await fetch('https://api.vapi.ai/call?limit=1', {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });

        if (res.ok) {
            pass('Vapi API reachable and API key valid');
        } else if (res.status === 401) {
            fail(`Vapi API key INVALID (401 Unauthorized)`);
        } else {
            warn(`Vapi API returned status ${res.status}`);
        }
    } catch (err) {
        fail(`Vapi API unreachable: ${err.message}`);
    }
}

async function checkVapiPhoneNumber() {
    section('2. VAPI PHONE NUMBER');

    try {
        const res = await fetch(`https://api.vapi.ai/phone-number/${VAPI_PHONE_NUMBER_ID}`, {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });

        if (res.ok) {
            const data = await res.json();
            pass(`Phone number configured: ${data.number || data.name || VAPI_PHONE_NUMBER_ID}`);
            if (data.provider) pass(`Provider: ${data.provider}`);
            if (data.sipTrunkId) pass(`SIP Trunk ID: ${data.sipTrunkId}`);
        } else {
            fail(`Phone number not found or invalid (HTTP ${res.status})`);
        }
    } catch (err) {
        fail(`Could not verify phone number: ${err.message}`);
    }
}

async function checkAssistants() {
    section('3. VAPI ASSISTANTS');

    for (const [name, id] of Object.entries(ASSISTANTS)) {
        try {
            const res = await fetch(`https://api.vapi.ai/assistant/${id}`, {
                headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
            });

            if (res.ok) {
                const data = await res.json();
                pass(`Assistant "${name}" (${id.substring(0, 8)}...) — ${data.name || 'OK'}`);
            } else {
                fail(`Assistant "${name}" (${id.substring(0, 8)}...) NOT FOUND (HTTP ${res.status})`);
            }
        } catch (err) {
            fail(`Could not verify assistant "${name}": ${err.message}`);
        }
    }
}

async function checkConcurrency() {
    section('4. CONCURRENCY STATUS');

    try {
        const res = await fetch('https://api.vapi.ai/call?limit=100', {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });

        if (res.ok) {
            const calls = await res.json();
            const active = (Array.isArray(calls) ? calls : []).filter(c =>
                ['queued', 'ringing', 'in-progress'].includes(c.status)
            );

            if (active.length === 0) {
                pass(`No active calls — ${MAX_CONCURRENT} slots available`);
            } else if (active.length < MAX_CONCURRENT) {
                warn(`${active.length}/${MAX_CONCURRENT} active calls — ${MAX_CONCURRENT - active.length} slots available`);
            } else {
                fail(`AT MAX CONCURRENCY: ${active.length}/${MAX_CONCURRENT} active calls — NO slots available!`);
            }

            // Show recent call history
            const recent = (Array.isArray(calls) ? calls : []).slice(0, 5);
            if (recent.length > 0) {
                console.log('\n   Recent calls:');
                recent.forEach(c => {
                    const status = c.status || 'unknown';
                    const reason = c.endedReason || '';
                    const emoji = status === 'ended' ? (reason.includes('Error') ? '❌' : '✔️') : '🔄';
                    console.log(`   ${emoji} ${c.id?.substring(0, 12)}... | ${status} | ${reason}`);
                });
            }
        } else {
            warn(`Could not check concurrency (HTTP ${res.status})`);
        }
    } catch (err) {
        fail(`Concurrency check failed: ${err.message}`);
    }
}

async function checkNocoDB() {
    section('5. NOCODB API');

    try {
        const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records?limit=1`, {
            headers: { 'xc-token': XC_TOKEN }
        });

        if (res.ok) {
            const data = await res.json();
            pass(`NocoDB reachable — Leads table accessible (${data.pageInfo?.totalRows || '?'} total records)`);
        } else if (res.status === 401 || res.status === 403) {
            fail(`NocoDB token INVALID (HTTP ${res.status})`);
        } else {
            fail(`NocoDB error: HTTP ${res.status}`);
        }
    } catch (err) {
        fail(`NocoDB unreachable: ${err.message}`);
    }

    // Check Call Logs table
    try {
        const res = await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records?limit=1`, {
            headers: { 'xc-token': XC_TOKEN }
        });

        if (res.ok) {
            pass('Call Logs table accessible');
        } else {
            fail(`Call Logs table error: HTTP ${res.status}`);
        }
    } catch (err) {
        fail(`Call Logs table unreachable: ${err.message}`);
    }
}

async function checkLeadReadiness() {
    section('6. LEAD READINESS');

    try {
        // Fetch all leads to analyze
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
            if (allRecords.length >= 5000) break;
        }

        const total = allRecords.length;
        const withPhone = allRecords.filter(l => {
            const p = String(l.phone || '').trim();
            return p && p !== '0' && p !== 'null' && p.length >= 6;
        });
        const noPhone = total - withPhone.length;

        // Status breakdown
        const statusCounts = {};
        allRecords.forEach(l => {
            const s = (l.status || 'Nuevo').toLowerCase();
            statusCounts[s] = (statusCounts[s] || 0) + 1;
        });

        const programados = statusCounts['programado'] || 0;
        const enProceso = statusCounts['en proceso'] || 0;
        const llamando = statusCounts['llamando...'] || 0;
        const nuevos = (statusCounts['nuevo'] || 0) + (statusCounts[''] || 0);
        const completados = statusCounts['completado'] || 0;
        const fallidos = statusCounts['fallido'] || 0;

        // Scheduled leads
        const scheduled = allRecords.filter(l => l.fecha_planificada);
        const now = new Date();
        const overdue = scheduled.filter(l => {
            const d = new Date(l.fecha_planificada.replace(' ', 'T') + 'Z');
            return d <= now;
        });

        console.log(`\n   📊 Lead Status Overview:`);
        console.log(`   ─────────────────────────────`);
        console.log(`   Total leads:       ${total}`);
        console.log(`   Con teléfono:      ${withPhone.length}`);
        console.log(`   Sin teléfono:      ${noPhone}`);
        console.log(`   ─────────────────────────────`);
        console.log(`   Nuevos:            ${nuevos}`);
        console.log(`   Programados:       ${programados}`);
        console.log(`   En Proceso:        ${enProceso}`);
        console.log(`   Llamando...:       ${llamando}`);
        console.log(`   Completados:       ${completados}`);
        console.log(`   Fallidos:          ${fallidos}`);
        console.log(`   ─────────────────────────────`);
        console.log(`   Con fecha_plan:    ${scheduled.length}`);
        console.log(`   Vencidas:          ${overdue.length}`);

        // Eligible for new calls
        const calledStatuses = ['completado', 'contestador', 'voicemail', 'no contesta', 'fallido', 'interesado', 'reintentar', 'programado', 'en proceso', 'llamando...'];
        const eligible = withPhone.filter(l => {
            const s = (l.status || '').toLowerCase();
            return !calledStatuses.some(cs => s.includes(cs)) && !l.fecha_planificada;
        });

        console.log(`\n   🟢 Eligible for new bulk call: ${eligible.length}`);

        if (eligible.length >= 200) {
            pass(`${eligible.length} leads ready — sufficient for 200-call batch`);
        } else if (eligible.length > 0) {
            warn(`Only ${eligible.length} eligible leads — less than 200`);
        } else {
            warn('No eligible leads found for new bulk call');
        }

        if (overdue.length > 0) {
            warn(`${overdue.length} scheduled leads are OVERDUE (past their planned time)`);
        }

        if (programados > 0) {
            pass(`${programados} leads are scheduled (Programado status)`);
        }

    } catch (err) {
        fail(`Could not analyze leads: ${err.message}`);
    }
}

async function checkSIPHealth() {
    section('7. SIP HEALTH (Recent Error Analysis)');

    try {
        const res = await fetch('https://api.vapi.ai/call?limit=50', {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });

        if (res.ok) {
            const calls = await res.json();
            const recentCalls = Array.isArray(calls) ? calls : [];

            const sipErrors = recentCalls.filter(c =>
                (c.endedReason || '').toLowerCase().includes('sip') ||
                (c.endedReason || '').includes('503')
            );

            const otherErrors = recentCalls.filter(c =>
                (c.endedReason || '').toLowerCase().includes('error') &&
                !(c.endedReason || '').toLowerCase().includes('sip')
            );

            const successful = recentCalls.filter(c =>
                c.endedReason === 'customer-ended-call' ||
                c.endedReason === 'assistant-ended-call' ||
                c.endedReason === 'silence-timed-out'
            );

            if (sipErrors.length === 0) {
                pass('No SIP errors in last 50 calls');
            } else {
                fail(`${sipErrors.length} SIP errors found in last 50 calls!`);
                sipErrors.slice(0, 3).forEach(c => {
                    console.log(`     → ${c.id?.substring(0, 12)}... | ${c.endedReason}`);
                });
            }

            if (otherErrors.length > 0) {
                warn(`${otherErrors.length} other errors in last 50 calls`);
            }

            const successRate = recentCalls.length > 0
                ? Math.round((successful.length / recentCalls.length) * 100)
                : 0;
            console.log(`\n   📈 Success rate (last 50): ${successRate}% (${successful.length}/${recentCalls.length})`);

        } else {
            warn(`Could not analyze SIP health (HTTP ${res.status})`);
        }
    } catch (err) {
        warn(`SIP health check failed: ${err.message}`);
    }
}

// --- MAIN ---
async function main() {
    console.log('═'.repeat(60));
    console.log('🚀 PREFLIGHT CHECK — Sistema de Llamadas Masivas');
    console.log(`   ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}`);
    console.log('═'.repeat(60));

    await checkVapiAPI();
    await checkVapiPhoneNumber();
    await checkAssistants();
    await checkConcurrency();
    await checkNocoDB();
    await checkLeadReadiness();
    await checkSIPHealth();

    // Final Report
    console.log('\n' + '═'.repeat(60));
    console.log('📋 PREFLIGHT REPORT');
    console.log('═'.repeat(60));
    console.log(`   ✅ Passed:   ${passed}`);
    console.log(`   ⚠️  Warnings: ${warnings}`);
    console.log(`   ❌ Failed:   ${failed}`);
    console.log('─'.repeat(60));

    if (failed > 0) {
        console.log('\n🔴 PREFLIGHT FAILED — Fix the errors above before launching!');
        process.exit(1);
    } else if (warnings > 0) {
        console.log('\n🟡 PREFLIGHT PASSED WITH WARNINGS — Review the warnings above.');
        process.exit(0);
    } else {
        console.log('\n🟢 ALL SYSTEMS GO — Ready to launch!');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('💥 Preflight fatal error:', err);
    process.exit(1);
});

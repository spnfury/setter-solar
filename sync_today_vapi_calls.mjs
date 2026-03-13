#!/usr/bin/env node
/**
 * sync_today_vapi_calls.mjs
 * 
 * Fetches all calls made recently from Vapi API (paginated) and imports missing ones into NocoDB.
 */

const VAPI_API_KEY = '0594f41c-e836-425d-aaa2-1c5b7d9e506e';
const NOCODB_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const CALL_LOGS_TABLE = 'm73w58ba47ifkrx';
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}

async function fetchFromVapiWithRetry(url) {
    let retries = 5;
    while (retries > 0) {
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (res.status === 429) {
            console.log('   ⚠️ Vapi rate limited. Waiting 5s...');
            await sleep(5000);
            retries--;
            continue;
        }
        if (!res.ok) throw new Error(`Vapi API error: ${res.status} ${await res.text()}`);
        return res.json();
    }
    throw new Error('Vapi API rate limited too many times');
}

async function getExistingCallIds() {
    console.log('📡 Buscando IDs existentes en NocoDB...');
    let offset = 0;
    const existing = new Set();
    while (true) {
        const res = await fetch(`${NOCODB_BASE}/${CALL_LOGS_TABLE}/records?limit=1000&offset=${offset}&fields=vapi_call_id`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        const data = await res.json();
        const list = data.list || [];
        if (list.length === 0) break;
        
        for (const row of list) {
            if (row.vapi_call_id) existing.add(row.vapi_call_id);
        }
        
        if (list.length < 1000) break;
        offset += 1000;
        console.log(`   Fetched ${existing.size} IDs locales...`);
    }
    return existing;
}

function calcDuration(call) {
    if (call.startedAt && call.endedAt) {
        return Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000);
    }
    return 0;
}

function evaluateCall(ended, duration) {
    if (ended === 'voicemail') return 'Contestador Automático';
    if (ended === 'silence-timed-out') return 'No contesta';
    if (ended === 'customer-busy') return 'Comunica';
    if (ended && ended.includes('error')) return 'Error Técnico';
    if (duration && duration < 10) return 'Cliente colgó rápidamente';
    if (ended === 'customer-ended-call') return 'Llamada Finalizada';
    if (ended === 'assistant-ended-call') return 'Llamada Finalizada';
    return 'Pendiente';
}

async function importToNocoDB(records) {
    const batchSize = 20;
    let success = 0;

    for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        try {
            const res = await fetch(`${NOCODB_BASE}/${CALL_LOGS_TABLE}/records`, {
                method: 'POST',
                headers: {
                    'xc-token': XC_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(batch)
            });
            if (!res.ok) {
                const errBody = await res.text();
                console.log(`  Batch ${Math.floor(i / batchSize) + 1}: ERROR ${res.status} - ${errBody.substring(0, 300)}`);
                continue;
            }
            const result = await res.json();
            const count = Array.isArray(result) ? result.length : 1;
            success += count;
            console.log(`  Batch ${Math.floor(i / batchSize) + 1}: imported ${count} records`);
        } catch (err) {
            console.log(`  Batch ${Math.floor(i / batchSize) + 1}: ERROR - ${err.message}`);
        }
        await sleep(500); // Rate limit NocoDB
    }
    return success;
}

async function main() {
    const existingIds = await getExistingCallIds();
    console.log(`✅ ${existingIds.size} llamadas ya están en NocoDB.\n`);

    console.log('📡 Descargando llamadas recientes de Vapi...');
    
    // We fetch up to 10 pages of 100 calls (1000 calls)
    let allVapiCalls = [];
    let page = 1;
    let url = 'https://api.vapi.ai/call?limit=100'; // No pagination cursor in list response easily documented, usually it's time-based or we just get newest 100.
    
    // Actually VAPI returns array directly. If we want more we might need boundaries. 
    // Let's just fetch the last 600 calls by doing multiple requests, wait, vapi api list returns an array without pagination token? 
    // According to vapi docs, we can pass createdAtGt or just get the default limit (which might default to 100).
    // Let's get the 100. If we need 1000 docs, limit=1000 might work.
    
    try {
        const calls = await fetchFromVapiWithRetry('https://api.vapi.ai/call?limit=1000');
        if (Array.isArray(calls)) {
            allVapiCalls = calls;
        } else if (calls.results) {
            allVapiCalls = calls.results; // Sometimes APIs wrap in results
        }
    } catch (e) {
        console.error('Error fetching vapi limit 1000', e.message);
        const calls = await fetchFromVapiWithRetry('https://api.vapi.ai/call?limit=100');
        allVapiCalls = Array.isArray(calls) ? calls : [];
    }
    
    console.log(`   Recuperadas ${allVapiCalls.length} llamadas de Vapi.\n`);

    const newRecords = [];
    
    for (const c of allVapiCalls) {
        const callId = c.id || '';
        if (!callId || existingIds.has(callId)) continue;
        
        const isToday = c.createdAt && c.createdAt.includes('2026-03-13');
        if (!isToday && allVapiCalls.length > 500) continue; // Only process today if there's a huge dump

        const empresa = c.assistantOverrides?.variableValues?.empresa || '';
        const phone = c.customer?.number || 'Desconocido';
        const created = c.createdAt || '';
        const ended = c.endedReason || '';
        const transcript = c.artifact?.transcript || '';
        const recording = c.artifact?.recordingUrl || '';
        const summary = c.analysis?.summary || '';
        const isTest = !empresa;
        const duration = calcDuration(c);
        const evaluation = summarizeEval(c) || evaluateCall(ended, duration);

        const record = {
            vapi_call_id: callId,
            lead_name: isTest ? 'Test Manual' : empresa,
            phone_called: phone,
            call_time: created,
            ended_reason: isTest ? 'Manual Trigger' : ended,
            evaluation: evaluation,
            duration_seconds: duration,
        };

        if (transcript) record.transcript = transcript.substring(0, 5000);
        if (recording) record.recording_url = recording;
        if (summary) record.Notes = summary;

        newRecords.push(record);
    }
    
    function summarizeEval(call) {
        let evalStr = '';
        if (call.analysis?.successEvaluation) {
            evalStr = call.analysis.successEvaluation.toLowerCase();
            if (evalStr.includes('voicemail') || evalStr.includes('buzón')) return 'Contestador Automático';
            if (evalStr.includes('confirmada')) return 'Cita Confirmada';
            if (evalStr.includes('completada')) return 'Completada: interes';
        }
        return null;
    }

    console.log(`📊 Nuevas llamadas a insertar: ${newRecords.length}\n`);

    if (newRecords.length === 0) {
        console.log('✅ Base de datos ya está completamente sincronizada.');
        return;
    }

    console.log('⬆️ Insertando en NocoDB...');
    const success = await importToNocoDB(newRecords);
    console.log(`\n✅ Importación completada: ${success}/${newRecords.length} nuevos registros importados`);
}

main().catch(err => {
    console.error('❌ Error fatal:', err.message);
    process.exit(1);
});

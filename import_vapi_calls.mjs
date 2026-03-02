#!/usr/bin/env node
/**
 * import_vapi_calls.mjs
 * 
 * Fetches all calls from Vapi API and imports them into NocoDB call_logs table.
 * Test/manual calls (without empresa) are tagged as 'Manual Trigger'.
 */

const VAPI_API_KEY = '852080ba-ce7c-4778-b218-bf718613a2b6';
const NOCODB_BASE = 'https://nocodb.srv889387.hstgr.cloud/api/v2/tables';
const CALL_LOGS_TABLE = 'm013en5u2cyu30j';
const XC_TOKEN = 'jx3uoKeVaidZLF7M0skVb9pV6yvNsam0Hu-Vfeww';

async function fetchVapiCalls() {
    const res = await fetch('https://api.vapi.ai/call?limit=100', {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });
    if (!res.ok) throw new Error(`Vapi API error: ${res.status} ${await res.text()}`);
    return res.json();
}

function calcDuration(call) {
    if (call.startedAt && call.endedAt) {
        return Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000);
    }
    return 0;
}

function evaluateCall(ended, duration) {
    if (ended === 'voicemail') return 'Contestador';
    if (ended === 'silence-timed-out') return 'No contesta';
    if (ended === 'customer-busy') return 'No contesta';
    if (ended && ended.includes('error')) return 'Error';
    if (duration && duration < 10) return 'No contesta';
    if (ended === 'customer-ended-call' && duration > 30) return 'Completada';
    if (ended === 'assistant-ended-call' && duration > 20) return 'Completada';
    return 'Sin datos';
}

async function importToNocoDB(records) {
    const batchSize = 10;
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
    }
    return success;
}

async function main() {
    console.log('📡 Fetching calls from Vapi API...');
    const calls = await fetchVapiCalls();
    console.log(`   Found ${calls.length} calls in Vapi\n`);

    const records = [];
    let testCount = 0;
    let campaignCount = 0;

    for (const c of calls) {
        const empresa = c.assistantOverrides?.variableValues?.empresa || '';
        const phone = c.customer?.number || 'Desconocido';
        const created = c.createdAt || '';
        const ended = c.endedReason || '';
        const callId = c.id || '';
        const transcript = c.artifact?.transcript || '';
        const recording = c.artifact?.recordingUrl || '';
        const isTest = !empresa;
        const duration = calcDuration(c);
        const evaluation = evaluateCall(ended, duration);

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

        records.push(record);
        if (isTest) testCount++;
        else campaignCount++;
    }

    console.log('📊 Records prepared:');
    console.log(`   🧪 Test (manual): ${testCount}`);
    console.log(`   📞 Campaign: ${campaignCount}`);
    console.log(`   📦 Total: ${records.length}\n`);

    console.log('⬆️  Importing to NocoDB...');
    const success = await importToNocoDB(records);
    console.log(`\n✅ Import complete: ${success}/${records.length} records imported`);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});

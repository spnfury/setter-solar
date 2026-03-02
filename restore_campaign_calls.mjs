#!/usr/bin/env node
/**
 * Restore campaign calls that were accidentally marked as 'Manual Trigger'.
 * Fetches the real endedReason from Vapi API and updates NocoDB.
 */

const VAPI_API_KEY = '852080ba-ce7c-4778-b218-bf718613a2b6';
const NOCODB_BASE = 'https://nocodb.srv889387.hstgr.cloud/api/v2/tables';
const CALL_LOGS_TABLE = 'm013en5u2cyu30j';
const XC_TOKEN = 'jx3uoKeVaidZLF7M0skVb9pV6yvNsam0Hu-Vfeww';

const TEST_NAMES = new Set([
    'test manual', 'sergio', 'test', 'aaa', 'nuevo', 'nenucos',
    'golosinas', 'golosinas sa', 'golosinas sl', 'golosinas sl 2',
    'mantecados 3', 'gatos felices', 'gatos felices 2', 'gatos felices 3',
    'gatos felices 33', 'gatos felices 44', 'sans rober', 'gestalia',
    'pamesa', 'spider ia', 'viviana s.l.', 'covermanager', 'tracfutveri',
    'gestoria luis', 'consultoria luis', 'gestoria way',
    'tecnologia actual variable', 'grupo gavina azul celeste',
    'locutorios martinez', 'sergio test 3'
]);

async function main() {
    // 1. Fetch all call logs
    console.log('📡 Fetching call logs from NocoDB...');
    const res = await fetch(`${NOCODB_BASE}/${CALL_LOGS_TABLE}/records?limit=200`, {
        headers: { 'xc-token': XC_TOKEN }
    });
    const data = await res.json();
    const calls = data.list || [];
    console.log(`   Found ${calls.length} call records\n`);

    // 2. Identify campaign calls (real companies, not test names)
    const campaignCalls = calls.filter(c => {
        const ln = (c.lead_name || '').trim().toLowerCase();
        return ln && !TEST_NAMES.has(ln);
    });

    console.log(`📞 Campaign calls to restore: ${campaignCalls.length}`);
    console.log(`🧪 Test calls (keeping as Manual Trigger): ${calls.length - campaignCalls.length}\n`);

    // 3. For each campaign call, fetch the real endedReason from Vapi
    const updates = [];
    for (const call of campaignCalls) {
        const vapiId = call.vapi_call_id;
        if (!vapiId) {
            console.log(`  ⏭  id=${call.id} - No vapi_call_id, skipping`);
            continue;
        }

        try {
            const vapiRes = await fetch(`https://api.vapi.ai/call/${vapiId}`, {
                headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
            });

            if (vapiRes.status === 429) {
                console.log('  ⚠️  Rate limited, waiting 2s...');
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            if (!vapiRes.ok) {
                console.log(`  ⏭  id=${call.id} (${vapiId.substring(0, 8)}...): HTTP ${vapiRes.status}`);
                continue;
            }

            const vapiData = await vapiRes.json();
            const endedReason = vapiData.endedReason || 'unknown';
            updates.push({ id: call.id, ended_reason: endedReason });
            const name = (call.lead_name || '').substring(0, 35);
            console.log(`  ✅ id=${call.id} => ${endedReason}  (${name})`);

            // Small delay to avoid rate limits
            await new Promise(r => setTimeout(r, 250));
        } catch (err) {
            console.log(`  ❌ Error for id=${call.id}: ${err.message}`);
        }
    }

    // 4. Batch update in NocoDB
    console.log(`\n⬆️  Updating ${updates.length} records in NocoDB...`);
    let success = 0;
    for (let i = 0; i < updates.length; i += 10) {
        const batch = updates.slice(i, i + 10);
        try {
            const patchRes = await fetch(`${NOCODB_BASE}/${CALL_LOGS_TABLE}/records`, {
                method: 'PATCH',
                headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify(batch)
            });
            if (patchRes.ok) {
                success += batch.length;
                console.log(`  Batch ${Math.floor(i / 10) + 1}: ✅ OK (${batch.length} records)`);
            } else {
                console.log(`  Batch ${Math.floor(i / 10) + 1}: ❌ ERROR ${patchRes.status}`);
            }
        } catch (err) {
            console.log(`  Batch ${Math.floor(i / 10) + 1}: ❌ ${err.message}`);
        }
    }

    console.log(`\n🏁 Done! ${success}/${updates.length} campaign calls restored.`);
}

main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});

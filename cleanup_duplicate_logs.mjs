#!/usr/bin/env node
/**
 * cleanup_duplicate_logs.mjs
 * 
 * Removes duplicate 'Call Initiated' logs from NocoDB based on phone number.
 * Keeps only 1 record per phone number.
 */

const NOCODB_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const CALL_LOGS_TABLE = 'm73w58ba47ifkrx';
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

async function main() {
    console.log('🧹 Limpiando base de datos de llamadas duplicadas temporales...');
    let offset = 0;
    let allRecords = [];
    
    // Fetch all Call Initiated
    while (true) {
        const res = await fetch(`${NOCODB_BASE}/${CALL_LOGS_TABLE}/records?limit=1000&offset=${offset}&where=(ended_reason,eq,Call%20Initiated)`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        const data = await res.json();
        const list = data.list || [];
        if (list.length === 0) break;
        allRecords = allRecords.concat(list);
        if (allRecords.length >= (data.pageInfo?.totalRows || 0)) break;
        offset += 1000;
        console.log(`   Fetched ${allRecords.length} records...`);
    }
    
    // Group by phone
    const phoneMap = new Map();
    const toDelete = [];

    // Reverse sort by ID to keep the oldest or newest (doesn't matter, just keep ONE)
    allRecords.sort((a, b) => a.Id - b.Id);

    for (const r of allRecords) {
        const phone = r.phone_called;
        if (!phone) {
            toDelete.push(r); // invalid row?
            continue;
        }

        if (phoneMap.has(phone)) {
            // Already have a record for this phone in the 'Initiated' state
            toDelete.push(r);
        } else {
            // Keep the first one we see
            phoneMap.set(phone, r);
        }
    }
    
    console.log(`🗑️ Se encontraron ${toDelete.length} registros duplicados para eliminar.`);
    if (toDelete.length === 0) return;
    
    const batchSize = 100;
    let deletedCount = 0;
    
    for (let i = 0; i < toDelete.length; i += batchSize) {
        const batch = toDelete.slice(i, i + batchSize).map(r => ({ Id: r.Id }));
        
        try {
            const res = await fetch(`${NOCODB_BASE}/${CALL_LOGS_TABLE}/records`, {
                method: 'DELETE',
                headers: { 
                    'xc-token': XC_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(batch)
            });
            
            if (res.ok) {
                deletedCount += batch.length;
                console.log(`   Borrados ${deletedCount}/${toDelete.length}...`);
            } else {
                console.error(`   ❌ Error borrando batch: ${await res.text()}`);
            }
        } catch (err) {
            console.error(`   ❌ Error de red: ${err.message}`);
        }
    }
    
    console.log(`✨ Limpieza completada. Borrados ${deletedCount} registros.`);
}

main().catch(console.error);

#!/usr/bin/env node
/**
 * cleanup_call_logs.mjs
 * 
 * Removes all call logs from NocoDB where vapi_call_id is 'unknown' 
 * or where ended_reason contains 'call.start.error'
 */

const NOCODB_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const CALL_LOGS_TABLE = 'm73w58ba47ifkrx';
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

async function main() {
    console.log('🧹 Limpiando base de datos de llamadas corruptas...');
    let offset = 0;
    let allRecords = [];
    
    // Fetch all records
    while (true) {
        const res = await fetch(`${NOCODB_BASE}/${CALL_LOGS_TABLE}/records?limit=1000&offset=${offset}`, {
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
    
    // Find bad records
    const toDelete = allRecords.filter(r => 
        r.vapi_call_id === 'unknown' || 
        r.vapi_call_id === 'undefined' ||
        (r.ended_reason && r.ended_reason.includes('error')) ||
        (r.ended_reason && r.ended_reason.includes('call.start'))
    );
    
    console.log(`🗑️ Se encontraron ${toDelete.length} registros corruptos para eliminar.`);
    if (toDelete.length === 0) return;

    // We can only delete by passing an array of objects with the primary key `Id`
    // Wait, NocoDB bulk delete endpoint format:
    // DELETE /api/v2/tables/:table/records
    // body: [ { Id: 123 }, { Id: 124 } ]
    
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

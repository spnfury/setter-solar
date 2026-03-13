#!/usr/bin/env node
/**
 * wipe_noise_calls.mjs
 * 
 * Deletes *all* calls from today (March 13) from NocoDB.
 * Since all calls today were either a 400 Bad Request batch or the 600-call infinite loop bug,
 * the user considers them "noise" and wants a completely clean slate on the dashboard.
 */

const NOCODB_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const CALL_LOGS_TABLE = 'm73w58ba47ifkrx';
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

async function main() {
    console.log('🧹 Buscando todas las llamadas "ruido" de hoy en NocoDB...');
    
    let offset = 0;
    const toDelete = [];
    
    // Fetch all calls from today
    while (true) {
        const res = await fetch(`${NOCODB_BASE}/${CALL_LOGS_TABLE}/records?limit=1000&offset=${offset}&sort=-call_time`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        
        if (!res.ok) {
            console.error('Error fetching logs:', await res.text());
            break;
        }
        
        const data = await res.json();
        const list = data.list || [];
        if (list.length === 0) break;
        
        // Filter locally
        list.forEach(row => {
            if (row.call_time && row.call_time.includes('2026-03-13')) {
                toDelete.push(row);
            }
        });
        
        if (list.length < 1000 || offset >= 1000) break; // We only need the most recent ones
        offset += 1000;
    }
    
    console.log(`🗑️ Se encontraron ${toDelete.length} llamadas de hoy para eliminar.`);
    
    if (toDelete.length === 0) {
        console.log('✅ No hay ruido que borrar.');
        return;
    }
    
    // Batch delete
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
    
    console.log(`✨ Limpieza de ruido completada. Borrados ${deletedCount} registros. El dashboard debería estar a 0 para hoy.`);
}

main().catch(console.error);

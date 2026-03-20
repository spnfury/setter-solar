#!/usr/bin/env node
/**
 * relaunch_failed_calls.mjs
 * 
 * Extracts the leads that failed with SIP 503 (estado "Fallida" in call_logs)
 * resets their status in the leads table to "No contactado"
 * and then executes the bulk_call_all.mjs script to retry them sequentially and safely.
 */

import { execSync } from 'child_process';

const NOCODB_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const LEADS_TABLE = 'mf0wzufqcpi3bd1';
const CALL_LOGS_TABLE = 'm73w58ba47ifkrx';
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

async function main() {
    console.log('🔄 Buscando llamadas fallidas (SIP 503) para relanzar...\n');
    
    // 1. Fetch Failed Calls — ONLY "Fallida" (SIP 503 trunk errors), NOT "No disponible" (SIP 480 phone unreachable)
    const url = `${NOCODB_BASE}/${CALL_LOGS_TABLE}/records?limit=1000&where=(evaluation,eq,Fallida)&sort=-CreatedAt`;
    const res = await fetch(url, { headers: { 'xc-token': XC_TOKEN } });
    const data = await res.json();
    const failedCalls = data.list || [];
    
    // Extra safety: filter out any "No disponible" that might have been marked as Fallida in older data
    const retryableCalls = failedCalls.filter(c => {
        const reason = (c.ended_reason || '').toLowerCase();
        // Skip SIP 480 / phone unreachable — not a system error, phone was just off
        if (reason.includes('no disponible') || reason.includes('apagado') || reason.includes('480')) {
            return false;
        }
        return true;
    });
    
    console.log(`📊 Encontradas ${failedCalls.length} llamadas fallidas total.`);
    console.log(`   └─ ${retryableCalls.length} retryable (SIP 503), ${failedCalls.length - retryableCalls.length} skipped (phone unreachable).`);
    
    if (retryableCalls.length === 0) {
        console.log('✅ No hay llamadas retryable que relanzar.');
        return;
    }

    // Extract unique phones
    const phonesToRetry = [...new Set(retryableCalls.map(c => c.phone_called).filter(p => p))];
    console.log(`📞 Teléfonos únicos a relanzar: ${phonesToRetry.length}\n`);

    // 2. We need the unique_ids from the leads table to modify them
    console.log('🔍 Buscando los IDs de los leads en la tabla principal...');
    let allLeads = [];
    let offset = 0;
    while (true) {
        const leadRes = await fetch(`${NOCODB_BASE}/${LEADS_TABLE}/records?limit=200&offset=${offset}`, { headers: { 'xc-token': XC_TOKEN } });
        const leadData = await leadRes.json();
        const records = leadData.list || [];
        if (records.length === 0) break;
        allLeads = allLeads.concat(records);
        if (allLeads.length >= (leadData.pageInfo?.totalRows || 0)) break;
        offset += 200;
    }

    // Match leads by phone
    const leadsToReset = allLeads.filter(l => {
        if (!l.phone) return false;
        // Normalize phones for comparison
        const normDb = l.phone.replace(/\D/g, '');
        return phonesToRetry.some(p => {
            const normP = p.replace(/\D/g, '');
            return normDb.includes(normP) || normP.includes(normDb);
        });
    });

    console.log(`✅ Leads identificados para resetear: ${leadsToReset.length}`);

    // 3. Reset status directly in NocoDB to 'No contactado' so bulk_call_all.mjs picks them up
    if (leadsToReset.length > 0) {
        console.log('🔄 Reseteando estado a "No contactado"...');
        const updates = leadsToReset.map(l => ({
            unique_id: l.unique_id,
            status: 'No contactado',
            fecha_planificada: null
        }));

        // Patch in batches
        for (let i = 0; i < updates.length; i += 100) {
            const batch = updates.slice(i, i + 100);
            await fetch(`${NOCODB_BASE}/${LEADS_TABLE}/records`, {
                method: 'PATCH',
                headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify(batch)
            });
            console.log(`   Reset batch ${Math.floor(i/100) + 1} done.`);
        }
    }

    // 4. Trigger bulk_call_all.mjs
    console.log('\n🚀 Iniciando relanzamiento secuencial controlado...');
    console.log('   (Esto usará bulk_call_all.mjs que respeta el límite de 10 concurrencias y pausas de 10s)\n');
    
    try {
        // Execute the script, inheriting stdio to see progress
        execSync('node bulk_call_all.mjs', { stdio: 'inherit' });
    } catch (err) {
        console.error('❌ Error ejecutando bulk_call_all.mjs:', err.message);
    }
}

main().catch(err => {
    console.error('💥 Error fatal:', err);
    process.exit(1);
});

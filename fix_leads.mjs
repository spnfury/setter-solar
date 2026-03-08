#!/usr/bin/env node
/**
 * 🔧 FIX LEADS — Repair corrupted unique_ids and statuses
 * 
 * Problem: All 5953 leads share the same unique_id "test_1772641136740_55fiw"
 * and were mass-updated to status "Completado" with notes "Asistenta agendó cita para el undefined".
 * 
 * This script:
 * 1. Fetches all leads in batches
 * 2. Assigns each lead a unique unique_id based on phone + row index
 * 3. Resets status to "Nuevo" for leads that have no real call history (no last_call_id)
 * 4. Clears corrupted notes
 * 
 * Uses NocoDB row-level PATCH endpoint: /api/v2/tables/{tableId}/records/{rowId}
 */

const API_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const LEADS_TABLE = 'mf0wzufqcpi3bd1';
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

const BATCH_SIZE = 200;
const CORRUPTED_UID = 'test_1772641136740_55fiw';
const CORRUPTED_NOTES = 'Asistenta agendó cita para el undefined';

async function fetchAllLeads() {
    let allRecords = [];
    let offset = 0;
    while (true) {
        const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records?limit=${BATCH_SIZE}&offset=${offset}&sort=CreatedAt`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        const data = await res.json();
        const records = data.list || [];
        allRecords = allRecords.concat(records);
        console.log(`  Fetched ${allRecords.length} / ${data.pageInfo?.totalRows || '?'} records...`);
        if (records.length < BATCH_SIZE || data.pageInfo?.isLastPage !== false) break;
        offset += BATCH_SIZE;
        if (allRecords.length >= 10000) break;
    }
    return allRecords;
}

async function updateLeadByRowId(rowId, updates) {
    const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records/${rowId}`, {
        method: 'PATCH',
        headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return await res.json();
}

function generateUniqueId(phone, index) {
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    const timestamp = Date.now();
    const rand = Math.random().toString(36).substr(2, 5);
    return `lead_${cleanPhone || 'nophone'}_${index}_${rand}`;
}

async function main() {
    console.log('🔧 FIX LEADS — Reparando leads con unique_id y status corrupto');
    console.log('');

    // Step 1: Fetch all leads
    console.log('📥 Paso 1: Descargando todos los leads...');
    const allLeads = await fetchAllLeads();
    console.log(`   Total: ${allLeads.length} leads`);
    console.log('');

    // Step 2: Analyze corruption
    const corrupted = allLeads.filter(l => l.unique_id === CORRUPTED_UID);
    const withBadNotes = allLeads.filter(l => (l.notes || '').includes('undefined'));
    const completadoNoCall = allLeads.filter(l =>
        (l.status || '').toLowerCase() === 'completado' && !l.last_call_id
    );
    const programadoNoFecha = allLeads.filter(l =>
        (l.status || '').toLowerCase() === 'programado' && !l.fecha_planificada
    );

    console.log('📊 Paso 2: Análisis de corrupción:');
    console.log(`   Leads con unique_id corrupto: ${corrupted.length}`);
    console.log(`   Leads con notes corruptas: ${withBadNotes.length}`);
    console.log(`   Leads "Completado" sin last_call_id: ${completadoNoCall.length}`);
    console.log(`   Leads "Programado" sin fecha_planificada: ${programadoNoFecha.length}`);
    console.log('');

    // Step 3: Fix each lead - use row IDs (1-indexed, sequential)
    console.log('🔄 Paso 3: Reparando leads...');
    let fixed = 0;
    let errors = 0;
    let skipped = 0;

    for (let i = 0; i < allLeads.length; i++) {
        const lead = allLeads[i];
        const rowId = i + 1; // NocoDB row IDs are 1-indexed
        const updates = {};
        let needsUpdate = false;

        // Fix unique_id
        if (lead.unique_id === CORRUPTED_UID || !lead.unique_id) {
            updates.unique_id = generateUniqueId(lead.phone, i);
            needsUpdate = true;
        }

        // Fix status: if "Completado" but never actually called, reset to "Nuevo"
        const status = (lead.status || '').toLowerCase();
        if (status === 'completado' && !lead.last_call_id) {
            updates.status = 'Nuevo';
            needsUpdate = true;
        }

        // Fix status: if "Programado" but no fecha_planificada, reset to "Nuevo"
        if (status === 'programado' && !lead.fecha_planificada) {
            updates.status = 'Nuevo';
            needsUpdate = true;
        }

        // Fix corrupted notes
        if (lead.notes === CORRUPTED_NOTES) {
            updates.notes = '';
            needsUpdate = true;
        }

        if (!needsUpdate) {
            skipped++;
            continue;
        }

        try {
            await updateLeadByRowId(rowId, updates);
            fixed++;
            if (fixed % 50 === 0 || fixed === 1) {
                console.log(`   ✅ ${fixed} leads reparados (${i + 1}/${allLeads.length})... [${lead.name || lead.phone}]`);
            }
        } catch (err) {
            errors++;
            if (errors <= 5) {
                console.error(`   ❌ Error en lead ${i + 1} (row ${rowId}): ${err.message}`);
            }
            if (errors === 5) {
                console.error('   ... suprimiendo errores adicionales');
            }
        }

        // Small delay to avoid rate limiting
        if (i % 20 === 0 && i > 0) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    console.log('');
    console.log('✅ Reparación completada:');
    console.log(`   Reparados: ${fixed}`);
    console.log(`   Errores: ${errors}`);
    console.log(`   Sin cambios: ${skipped}`);
}

main().catch(err => {
    console.error('❌ Error fatal:', err);
    process.exit(1);
});

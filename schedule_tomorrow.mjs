#!/usr/bin/env node
/**
 * 📅 SCHEDULE 200 CALLS — Tomorrow 2026-02-16 starting at 09:00 CET
 * 
 * Fetches eligible leads from NocoDB and schedules them with status=Programado
 * and fecha_planificada staggered every 2 minutes starting at 09:00.
 * 
 * The n8n scheduled trigger workflow will pick them up automatically.
 * 
 * Usage: node schedule_tomorrow.mjs [--dry-run] [--count 200] [--spacing 2]
 */

const API_BASE = 'https://nocodb.srv889387.hstgr.cloud/api/v2/tables';
const LEADS_TABLE = 'mgot1kl4sglenym';
const XC_TOKEN = 'jx3uoKeVaidZLF7M0skVb9pV6yvNsam0Hu-Vfeww';

// Parse args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const countIdx = args.indexOf('--count');
const CALL_COUNT = countIdx >= 0 ? parseInt(args[countIdx + 1]) : 200;
const spacingIdx = args.indexOf('--spacing');
const SPACING_MINUTES = spacingIdx >= 0 ? parseInt(args[spacingIdx + 1]) : 2;

// Tomorrow 09:00 CET = 08:00 UTC (CET = UTC+1, February = no DST)
const START_UTC = new Date('2026-02-16T08:00:00Z');

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function utcDateToString(d) {
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    return `${y}-${mo}-${day} ${h}:${mi}:00`;
}

function utcToCET(d) {
    return new Date(d.getTime() + 3600000); // +1h for CET
}

async function fetchAllLeads() {
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

    return allRecords;
}

async function main() {
    console.log('═'.repeat(60));
    console.log('📅 PROGRAMAR LLAMADAS — Mañana 16 Feb 2026');
    console.log(`   Inicio: 09:00 CET (${utcDateToString(START_UTC)} UTC)`);
    console.log(`   Cantidad: ${CALL_COUNT} llamadas`);
    console.log(`   Spacing: ${SPACING_MINUTES} minutos entre cada una`);
    if (DRY_RUN) console.log('   ⚠️  MODO DRY RUN — No se guardarán cambios');
    console.log('═'.repeat(60));

    // 1. Fetch all leads
    console.log('\n📋 Obteniendo leads de NocoDB...');
    const allLeads = await fetchAllLeads();
    console.log(`   Total leads en DB: ${allLeads.length}`);

    // 2. Filter eligible leads
    const calledStatuses = ['completado', 'contestador', 'voicemail', 'no contesta', 'fallido', 'interesado', 'reintentar', 'programado', 'en proceso', 'llamando...'];

    const eligible = allLeads.filter(lead => {
        const phone = String(lead.phone || '').trim();
        if (!phone || phone === '0' || phone === 'null' || phone === 'N/A' || phone.length < 6) return false;
        const status = (lead.status || '').toLowerCase();
        if (calledStatuses.some(s => status.includes(s))) return false;
        if (lead.fecha_planificada) return false;
        return true;
    });

    console.log(`   Leads elegibles: ${eligible.length}`);

    if (eligible.length === 0) {
        console.log('\n❌ No hay leads elegibles para programar.');
        return;
    }

    // Sort by CreatedAt (oldest first for more variety)
    eligible.sort((a, b) => new Date(a.CreatedAt) - new Date(b.CreatedAt));

    const toSchedule = eligible.slice(0, CALL_COUNT);
    const totalDuration = (toSchedule.length - 1) * SPACING_MINUTES;
    const endTimeUTC = new Date(START_UTC.getTime() + totalDuration * 60000);
    const endTimeCET = utcToCET(endTimeUTC);

    const hours = Math.floor(totalDuration / 60);
    const mins = totalDuration % 60;

    console.log(`\n📊 Plan de programación:`);
    console.log(`   ──────────────────────────────`);
    console.log(`   Leads a programar: ${toSchedule.length}`);
    console.log(`   Inicio:   09:00 CET`);
    console.log(`   Fin est:  ${endTimeCET.getUTCHours().toString().padStart(2, '0')}:${endTimeCET.getUTCMinutes().toString().padStart(2, '0')} CET`);
    console.log(`   Duración: ${hours}h ${mins}m`);
    console.log(`   ──────────────────────────────`);

    // Show first 10 and last 5
    console.log('\n   Primeras 10 llamadas:');
    for (let i = 0; i < Math.min(10, toSchedule.length); i++) {
        const callTimeUTC = new Date(START_UTC.getTime() + i * SPACING_MINUTES * 60000);
        const callTimeCET = utcToCET(callTimeUTC);
        const timeStr = `${callTimeCET.getUTCHours().toString().padStart(2, '0')}:${callTimeCET.getUTCMinutes().toString().padStart(2, '0')}`;
        console.log(`   ${(i + 1).toString().padStart(3)}. ${timeStr} — ${(toSchedule[i].name || 'Sin nombre').substring(0, 40)} | ${toSchedule[i].phone}`);
    }
    if (toSchedule.length > 15) {
        console.log(`   ...`);
        console.log(`   Últimas 5 llamadas:`);
        for (let i = toSchedule.length - 5; i < toSchedule.length; i++) {
            const callTimeUTC = new Date(START_UTC.getTime() + i * SPACING_MINUTES * 60000);
            const callTimeCET = utcToCET(callTimeUTC);
            const timeStr = `${callTimeCET.getUTCHours().toString().padStart(2, '0')}:${callTimeCET.getUTCMinutes().toString().padStart(2, '0')}`;
            console.log(`   ${(i + 1).toString().padStart(3)}. ${timeStr} — ${(toSchedule[i].name || 'Sin nombre').substring(0, 40)} | ${toSchedule[i].phone}`);
        }
    }

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN — No se han guardado cambios.');
        return;
    }

    // 3. Schedule all leads in batches of 10 (NocoDB PATCH)
    console.log('\n🚀 Programando leads...\n');

    let success = 0;
    let errors = 0;
    const BATCH_SIZE = 10;

    for (let i = 0; i < toSchedule.length; i += BATCH_SIZE) {
        const batch = toSchedule.slice(i, i + BATCH_SIZE);
        const patchData = batch.map((lead, j) => {
            const idx = i + j;
            const callTimeUTC = new Date(START_UTC.getTime() + idx * SPACING_MINUTES * 60000);
            return {
                unique_id: lead.unique_id || lead.Id || lead.id,
                status: 'Programado',
                fecha_planificada: utcDateToString(callTimeUTC)
            };
        });

        try {
            const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                method: 'PATCH',
                headers: {
                    'xc-token': XC_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(patchData)
            });

            if (!res.ok) {
                const errBody = await res.json().catch(() => ({}));
                throw new Error(`HTTP ${res.status}: ${errBody.msg || errBody.message || 'Unknown error'}`);
            }

            success += batch.length;
            const lastIdx = Math.min(i + BATCH_SIZE, toSchedule.length);
            const pct = Math.round((lastIdx / toSchedule.length) * 100);
            process.stdout.write(`\r   [${'█'.repeat(Math.floor(pct / 2))}${'░'.repeat(50 - Math.floor(pct / 2))}] ${pct}% — ${success} programados`);
        } catch (err) {
            errors += batch.length;
            console.log(`\n   ❌ Error en batch ${Math.floor(i / BATCH_SIZE) + 1}: ${err.message}`);
        }

        // Small delay between API calls
        if (i + BATCH_SIZE < toSchedule.length) {
            await sleep(200);
        }
    }

    console.log('\n');
    console.log('═'.repeat(60));
    console.log('📋 RESUMEN');
    console.log('═'.repeat(60));
    console.log(`   ✅ Programados: ${success}`);
    if (errors > 0) console.log(`   ❌ Errores: ${errors}`);
    console.log(`   ⏰ Primera llamada: 09:00 CET`);
    console.log(`   🏁 Última llamada:  ${endTimeCET.getUTCHours().toString().padStart(2, '0')}:${endTimeCET.getUTCMinutes().toString().padStart(2, '0')} CET`);
    console.log('─'.repeat(60));
    console.log('\n💡 Recuerda: El workflow n8n "Scheduled Call Trigger" debe estar');
    console.log('   ACTIVO para que las llamadas se ejecuten automáticamente.');
    console.log('   Usa: node preflight_check.mjs  antes de las 9:00 para verificar.\n');
}

main().catch(err => {
    console.error('💥 Fatal error:', err);
    process.exit(1);
});

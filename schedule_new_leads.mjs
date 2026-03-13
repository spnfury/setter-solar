#!/usr/bin/env node
/**
 * schedule_new_leads.mjs
 * 
 * Fetches leads in "Nuevo" state and marks them as "Programado" for today.
 * Assigns a sequence of times starting from now + 5 minutes.
 * N8N will pick them up and call them 1 by 1 securely.
 */

const API_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const LEADS_TABLE = 'mf0wzufqcpi3bd1'; 
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

async function main() {
    console.log('📅 Preparando el agendamiento de leads "Nuevos"...');

    // 1. Fetch all 'Nuevo' leads
    let allNewLeads = [];
    let offset = 0;
    const batchSize = 200;

    while (true) {
        const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records?limit=${batchSize}&offset=${offset}&where=(status,eq,Nuevo)`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        const data = await res.json();
        const records = data.list || [];
        allNewLeads = allNewLeads.concat(records);
        
        console.log(`   Fetched ${allNewLeads.length} leads...`);
        if (records.length < batchSize) break;
        offset += batchSize;
    }

    console.log(`\n📊 Encontrados ${allNewLeads.length} leads en estado 'Nuevo'.`);

    if (allNewLeads.length === 0) {
        console.log('✅ No hay leads nuevos para programar.');
        return;
    }

    // 2. Schedule them
    // We start 5 minutes from now to give N8N a short buffer
    let scheduleTime = new Date();
    scheduleTime.setMinutes(scheduleTime.getMinutes() + 5);

    const updateBatch = [];
    
    // N8N executes 1 per minute. If we schedule them 1 minute apart, N8N's "Every 1 min" trigger
    // will see them as `fecha_planificada <= now` and pick them up instantly 1 by 1.
    for (const lead of allNewLeads) {
        updateBatch.push({
            Id: lead.Id,
            status: 'Programado',
            fecha_planificada: scheduleTime.toISOString()
        });
        
        // Add 1 minute for the next lead
        scheduleTime.setMinutes(scheduleTime.getMinutes() + 1);
    }

    console.log(`\n🚀 Agendando ${updateBatch.length} leads...`);

    // 3. Push updates in chunks
    const chunkSize = 100;
    let successCount = 0;

    for (let i = 0; i < updateBatch.length; i += chunkSize) {
        const chunk = updateBatch.slice(i, i + chunkSize);
        
        try {
            const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                method: 'PATCH',
                headers: { 
                    'xc-token': XC_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(chunk)
            });

            if (res.ok) {
                successCount += chunk.length;
                console.log(`   ✅ Lote ${Math.floor(i/chunkSize) + 1} actualizado (${successCount}/${updateBatch.length})`);
            } else {
                console.error(`   ❌ Error en lote ${Math.floor(i/chunkSize) + 1}: ${await res.text()}`);
            }
        } catch (err) {
            console.error(`   ❌ Error de red en lote ${Math.floor(i/chunkSize) + 1}:`, err.message);
        }
    }

    console.log(`\n✨ ¡Completado! ${successCount} leads han sido programados correctamente.`);
    console.log('N8N comenzará a procesarlos automáticamente dentro de 5 minutos, a un ritmo de 1 por minuto.');
    console.log('Los scripts de seguridad (preflight_check) prevendrán automáticamente excesos y llamadas fuera de horario.');
}

main().catch(console.error);

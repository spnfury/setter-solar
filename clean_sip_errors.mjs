#!/usr/bin/env node
import fs from 'fs';

const API_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const CALL_LOGS_TABLE = 'm73w58ba47ifkrx';
const LEADS_TABLE = 'mf0wzufqcpi3bd1';
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function fetchSipErrors() {
    let allRecords = [];
    let offset = 0;
    const batchSize = 100;

    console.log('🔍 Buscando llamadas con error SIP recientes...');
    while (true) {
        const res = await fetch(
            `${API_BASE}/${CALL_LOGS_TABLE}/records?limit=${batchSize}&offset=${offset}&sort=-CreatedAt`,
            { headers: { 'xc-token': XC_TOKEN } }
        );
        const data = await res.json();
        const records = data.list || [];
        allRecords = allRecords.concat(records);
        
        if (records.length < batchSize || data.pageInfo?.isLastPage !== false) break;
        offset += batchSize;
        if (allRecords.length >= 500) break; // limit to last 500 calls
    }

    const sipErrors = allRecords.filter(c => 
        (c.ended_reason || '').includes('sip-outbound-call-failed-to-connect')
    );

    console.log(`❌ Encontrados ${sipErrors.length} errores SIP en el registro de llamadas.`);
    return sipErrors;
}

async function markLeadAsInvalid(phone) {
    // 1. Find the lead
    // Note: phone in call_logs might have $+34, but in leads it might just be the national number.
    // Let's normalize by taking the last 9 digits.
    const cleanPhone = phone.replace(/\D/g, '').slice(-9);

    const res = await fetch(
        `${API_BASE}/${LEADS_TABLE}/records?where=(phone,like,%${cleanPhone}%)&limit=1`,
        { headers: { 'xc-token': XC_TOKEN } }
    );
    const data = await res.json();
    
    if (data.list && data.list.length > 0) {
        const lead = data.list[0];
        if (lead.status === 'Error SIP' || lead.status === 'Invalido') {
            return false; // already marked
        }

        // 2. Update the lead
        const updateRes = await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
            method: 'PATCH',
            headers: { 
                'xc-token': XC_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify([{
                Id: lead.Id,
                status: 'Error SIP',
                notes: ((lead.notes || '') + ' [Sistema: Marcado como número inválido por error SIP]').trim()
            }])
        });
        
        if (updateRes.ok) {
            console.log(`✅ Lead actualizado: ${lead.name} (${phone}) -> Error SIP`);
            return true;
        } else {
            console.error(`❌ Error actualizando lead ${lead.name}:`, await updateRes.text());
        }
    } else {
        console.log(`⚠️  No se encontró el lead asociado al teléfono: ${phone}`);
    }
    return false;
}

async function main() {
    const sipErrors = await fetchSipErrors();
    const phones = [...new Set(sipErrors.map(c => c.phone_called).filter(Boolean))];
    
    console.log(`\n🧹 Limpiando ${phones.length} teléfonos con error SIP conocidos...`);
    let updatedCount = 0;

    for (const phone of phones) {
        const changed = await markLeadAsInvalid(phone);
        if (changed) updatedCount++;
        await sleep(300); // Rate limiting
    }

    console.log(`\n🎉 Limpieza completada. Leads actualizados: ${updatedCount}`);
}

main().catch(console.error);

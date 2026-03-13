#!/usr/bin/env node
import fs from 'fs';

const N8N_URL = 'https://n8n.srv889387.hstgr.cloud/api/v1/workflows/T7hbLpMglK1Hwjk9';
const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlMDIyMDljMS1mMWEzLTRhN2ItYjQ3MC0wYWM3MmJiMzljZWYiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzcxMjM3ODEwLCJleHAiOjE3NzM3ODg0MDB9.ZNAmgm1OPjq8WRA0gPgdmU3CjsNYoyE2Z-arrWfA0LU';

async function updateWorkflow() {
    try {
        console.log('🔄 Extrayendo datos del workflow corregido (n8n_master_workflow.json)...');
        const raw = fs.readFileSync('n8n_master_workflow.json', 'utf8');
        const data = JSON.parse(raw);
        
        console.log('⬆️ Subiendo actualización a N8N...');
        const res = await fetch(N8N_URL, {
            method: 'PUT',
            headers: {
                'X-N8N-API-KEY': API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: data.name,
                nodes: data.nodes,
                connections: data.connections,
                settings: data.settings
            })
        });
        
        if (!res.ok) {
            const err = await res.text();
            console.error('❌ Error actualizando N8N:', res.status, err);
            process.exit(1);
        }
        
        console.log('✅ Workflow "Setter Solar Master Workflow" actualizado y activado exitosamente en N8N.');
    } catch(err) {
        console.error('💥 Fallo catastrófico:', err);
    }
}

updateWorkflow();

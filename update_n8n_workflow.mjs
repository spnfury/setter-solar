#!/usr/bin/env node
import fs from 'fs';

const N8N_URL = 'https://optima-n8n.vhsxer.easypanel.host/api/v1/workflows/T7hbLpMglK1Hwjk9';
const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI4YjU0YmU1Mi03Njg3LTQwNGYtYWVjYy03MzM4MmQxZDhiMjUiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzczNzcyMzY4fQ.nPl-aaEo8SLZ3t4HODOiGP1D7FsWzu-rz9hrUZFOWtA';

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

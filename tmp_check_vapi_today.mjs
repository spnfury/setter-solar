const fetch = require('node-fetch');
const VAPI_KEY = '0594f41c-e836-425d-aaa2-1c5b7d9e506e';

async function main() {
    const res = await fetch('https://api.vapi.ai/call?limit=15', {
        headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
    });
    const calls = await res.json();
    const data = Array.isArray(calls) ? calls : (calls.results || []);
    console.log(`Verificando las últimas ${data.length} llamadas en Vapi...`);
    
    let todayCount = 0;
    data.forEach((c, i) => {
        const date = c.createdAt;
        const phone = c.customer?.number || '?';
        const status = c.status || c.endedReason || '?';
        const duration = (new Date(c.endedAt) - new Date(c.startedAt))/1000 || 0;
        
        console.log(`[${i+1}] Date: ${date} | Phone: ${phone} | Status: ${status} | Dur: ${duration}s`);
        if (date && date.includes('2026-03-20')) {
            todayCount++;
            console.log("   --- transcript ---");
            console.log("   " + (c.artifact?.transcript || c.transcript || '').substring(0, 150).replace(/\n/g, ' '));
        }
    });
    console.log(`\nLlamadas encontradas de HOY (2026-03-20): ${todayCount}`);
}
main().catch(console.error);

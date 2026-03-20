// Native fetch used in Node 22
const VAPI_KEY = '0594f41c-e836-425d-aaa2-1c5b7d9e506e';

async function main() {
    const res = await fetch('https://api.vapi.ai/call?limit=10', {
        headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
    });
    const calls = await res.json();
    const data = Array.isArray(calls) ? calls : (calls.results || []);
    
    let summary = '';
    data.forEach((c, i) => {
        const date = c.createdAt;
        const phone = c.customer?.number || '?';
        const endedReason = c.endedReason || '?';
        const evalRes = c.analysis?.successEvaluation || 'N/A';
        const dur = c.endedAt && c.startedAt ? (new Date(c.endedAt) - new Date(c.startedAt))/1000 : 0;
        const s = c.analysis?.summary || 'Sin resumen';
        
        summary += `\n[${i+1}] ${phone} — ${dur.toFixed(0)}s | ${endedReason} | Eval: ${evalRes}\n`;
        summary += `   Resumen: ${s}\n`;
        
        if (c.artifact?.transcript) {
            const lines = c.artifact.transcript.split('\n');
            const endLines = lines.slice(-3).join(' | ');
            summary += `   Extracto final: ${endLines}\n`;
        }
    });

    console.log(summary);
}
main().catch(console.error);

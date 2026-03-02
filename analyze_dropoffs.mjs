#!/usr/bin/env node
// Analyze mid-length calls (5-30s) to find AI drop-off pattern
const XC_TOKEN = 'jx3uoKeVaidZLF7M0skVb9pV6yvNsam0Hu-Vfeww';
const VAPI_KEY = '852080ba-ce7c-4778-b218-bf718613a2b6';
const API_BASE = 'https://nocodb.srv889387.hstgr.cloud/api/v2/tables';
const CALL_LOGS = 'm013en5u2cyu30j';

async function main() {
    // Fetch more records
    let all = [];
    for (let offset = 0; offset < 600; offset += 200) {
        const res = await fetch(`${API_BASE}/${CALL_LOGS}/records?limit=200&offset=${offset}&sort=-CreatedAt`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        const data = await res.json();
        all = all.concat(data.list || []);
        if ((data.list || []).length < 200) break;
    }

    // Get calls from last 7 days with duration 3-60s (the interesting drop-off range)
    const cutoff = new Date('2026-02-10');
    const calls = all.filter(c => {
        const d = new Date(c.call_time || c.CreatedAt);
        if (d < cutoff) return false;
        if (c.is_test) return false;
        const dur = parseInt(c.duration_seconds) || 0;
        return dur >= 3 && dur <= 60 && c.vapi_call_id;
    }).sort((a, b) => (parseInt(a.duration_seconds) || 0) - (parseInt(b.duration_seconds) || 0));

    console.log(`Mid-length calls (3-60s) in last 7 days: ${calls.length}\n`);

    // Get transcripts for up to 20 of these
    const toFetch = calls.slice(0, 20);
    for (const call of toFetch) {
        const dur = call.duration_seconds || '?';
        const eval_ = call.evaluation || 'Pendiente';
        const name = call.lead_name || '?';
        const reason = call.ended_reason || '?';
        const date = new Date(call.call_time || call.CreatedAt).toLocaleDateString('es-ES');

        let transcript = '(no vapi data)';
        let summary = '';
        try {
            const vRes = await fetch(`https://api.vapi.ai/call/${call.vapi_call_id}`, {
                headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
            });
            if (vRes.ok) {
                const v = await vRes.json();
                transcript = (v.artifact?.transcript || v.transcript || '(empty)').substring(0, 800);
                summary = v.analysis?.summary || v.summary || '';
            }
        } catch (e) { transcript = '(error)'; }

        console.log(`=== ${dur}s | ${eval_} | ${date} | ${name} | ${reason}`);
        if (summary) console.log(`   📝 ${summary.substring(0, 200)}`);
        console.log(transcript);
        console.log('');
        await new Promise(r => setTimeout(r, 250));
    }
}

main().catch(console.error);

#!/usr/bin/env node
/**
 * 🔄 BATCH & ANALYZE PIPELINE
 *
 * Runs a batch of N calls, waits until all calls are finished, 
 * then immediately generates an AI analysis of that specific batch.
 *
 * Usage:
 *   node batch_and_analyze.mjs                     # 10 calls, then analyze
 *   node batch_and_analyze.mjs --limit 25          # 25 calls, then analyze
 *   node batch_and_analyze.mjs --dry-run           # Simulate without calling
 *   node batch_and_analyze.mjs --skip-analysis     # Calls only, no analysis
 *
 * The script will:
 *   1. ✅ Run preflight safety checks
 *   2. 📞 Call N leads from the "Nuevo" pool
 *   3. ⏳ Wait for all Vapi calls to finish (polling)
 *   4. 📊 Pull transcripts & summaries from Vapi
 *   5. 🤖 Generate AI analysis with Groq
 *   6. 💾 Store results in NocoDB
 */

// ── CONFIG ──────────────────────────────────────────────────
const API_BASE        = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const LEADS_TABLE     = 'mf0wzufqcpi3bd1';
const CALL_LOGS_TABLE = 'm73w58ba47ifkrx';
const REPORTS_TABLE   = 'matif11dcltlmn6';
const XC_TOKEN        = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

const VAPI_API_KEY        = '0594f41c-e836-425d-aaa2-1c5b7d9e506e';
const VAPI_PHONE_NUMBER_ID = 'ee153e9d-ece6-4469-a634-70eaa6e083c4';
const ASSISTANT_ID        = 'f3359bb0-7bc4-45c7-9a02-ca4793cc5d48';

const GROQ_API_KEY  = process.env.GROQ_API_KEY || '';
const GROQ_MODEL    = 'llama-3.3-70b-versatile';

const MAX_CONCURRENT_CALLS        = 3;
const DELAY_BETWEEN_CALLS_MS      = 15000; // 15s
const CONCURRENCY_CHECK_INTERVAL  = 15000;
const MAX_CONCURRENCY_RETRIES     = 40;
const POLL_INTERVAL_MS            = 10000; // 10s poll to check if calls finished
const MAX_POLL_WAIT_MS            = 10 * 60 * 1000; // 10 min max wait

// ── CLI ARGS ─────────────────────────────────────────────────
const args          = process.argv.slice(2);
const DRY_RUN       = args.includes('--dry-run');
const SKIP_ANALYSIS = args.includes('--skip-analysis');
const limitIdx      = args.indexOf('--limit');
const BATCH_SIZE    = limitIdx !== -1 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : 10;

// ── HELPERS ───────────────────────────────────────────────────
function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }
function ts()         { return new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function normalizePhone(p) {
    p = String(p || '').replace(/\D/g, '');
    if (!p) return '';
    if (p.length === 9 && /^[6789]/.test(p)) p = '34' + p;
    if (p.startsWith('34') && p.length === 11 && /^[6789]/.test(p.substring(2))) {
        return '+' + p;
    }
    return 'INVALID';
}

// ── 1. DATA FETCH ─────────────────────────────────────────────

async function fetchLeads(limit) {
    // Fetch extra to allow for filtering/dedup
    const fetch_limit = Math.max(limit * 3, 60);
    const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records?limit=${fetch_limit}&where=(status,eq,Nuevo)`, {
        headers: { 'xc-token': XC_TOKEN }
    });
    const data = await res.json();
    const leadsObj = data.list || [];
    const validLeads = [];
    
    for (const l of leadsObj) {
        if ((l.name || '').toLowerCase().includes('sergi')) continue;
        const phone = normalizePhone(l.phone);
        
        if (phone === 'INVALID' || !phone) {
            if (phone === 'INVALID' && !DRY_RUN) {
                console.log(`   🚫 Descartando número malformado: ${l.phone} (${l.name})`);
                await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                    method: 'PATCH',
                    headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                    body: JSON.stringify([{ unique_id: l.unique_id, status: 'Invalido - Formato', fecha_planificada: null }])
                }).catch(() => {});
            }
            continue;
        }
        l.normalizedPhone = phone;
        validLeads.push(l);
        if (validLeads.length >= limit) break;
    }
    return validLeads;
}

async function getActiveCallCount() {
    try {
        const res = await fetch('https://api.vapi.ai/call?limit=100', {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        const calls = await res.json();
        return (Array.isArray(calls) ? calls : []).filter(c =>
            ['queued', 'ringing', 'in-progress'].includes(c.status)
        );
    } catch { return []; }
}

async function waitForSlot(phone) {
    for (let i = 0; i < MAX_CONCURRENCY_RETRIES; i++) {
        const active = await getActiveCallCount();
        const activePhones = new Set(active.map(c => c.customer?.number).filter(Boolean));
        if (phone && activePhones.has(phone)) return { available: false, reason: 'phone_active' };
        if (active.length < MAX_CONCURRENT_CALLS) return { available: true };
        process.stdout.write(`\r   ⏳ [${ts()}] Concurrencia: ${active.length}/${MAX_CONCURRENT_CALLS}. Esperando...`);
        await sleep(CONCURRENCY_CHECK_INTERVAL);
    }
    return { available: false, reason: 'timeout' };
}

// ── 2. CALL LAUNCHER ─────────────────────────────────────────

async function callLead(lead) {
    const phone = lead.normalizedPhone || normalizePhone(lead.phone);
    const name  = lead.name || 'Cliente';

    if (DRY_RUN) {
        console.log(`  [DRY RUN] → ${name} (${phone})`);
        return { success: true, dry: true, phone, name, vapiId: `dry-${Date.now()}` };
    }

    const slot = await waitForSlot(phone);
    if (!slot.available) {
        console.log(`  ⏭️  Skip ${name} — ${slot.reason}`);
        return { success: false, skip: true, phone, name };
    }

    process.stdout.write(`  📞 → ${name} (${phone}) … `);
    try {
        const vapiRes = await fetch('https://api.vapi.ai/call', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customer: { number: phone },
                assistantId: ASSISTANT_ID,
                phoneNumberId: VAPI_PHONE_NUMBER_ID,
                assistantOverrides: {
                    variableValues: {
                        nombre: name,
                        empresa: name,
                        tel_contacto: phone,
                        ciudad: lead.Localidad || lead.address || 'tu zona',
                        leadId: lead.unique_id || '',
                        fecha_hoy: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }),
                        dia_semana: new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long' })
                    }
                }
            })
        });

        const vapiData = await vapiRes.json();
        if (!vapiRes.ok) throw new Error(vapiData.message || `HTTP ${vapiRes.status}`);

        console.log(`✅ ${vapiData.id?.substring(0, 12)}...`);

        // Log inicial en NocoDB
        await fetch(`${API_BASE}/${CALL_LOGS_TABLE}/records`, {
            method: 'POST',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ vapi_call_id: vapiData.id, lead_name: name, phone_called: phone, call_time: new Date().toISOString(), ended_reason: 'Batch Iniciado' })
        }).catch(() => {});

        // Actualizar lead a "Llamando"
        await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
            method: 'PATCH',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify([{ unique_id: lead.unique_id, status: 'Llamando...', fecha_planificada: null }])
        }).catch(() => {});

        return { success: true, phone, name, unique_id: lead.unique_id, vapiId: vapiData.id };
    } catch (err) {
        console.log(`❌ ${err.message}`);
        return { success: false, phone, name, unique_id: lead.unique_id, error: err.message };
    }
}

// ── 3. WAIT FOR COMPLETION ────────────────────────────────────

async function waitForBatchToFinish(vapiIds) {
    if (DRY_RUN) return [];

    console.log(`\n⏳ Esperando a que terminen ${vapiIds.length} llamadas...`);
    const start = Date.now();
    let remaining = new Set(vapiIds);

    while (remaining.size > 0 && (Date.now() - start) < MAX_POLL_WAIT_MS) {
        await sleep(POLL_INTERVAL_MS);

        // Check which ones are still active
        const active = await getActiveCallCount();
        const activeIds = new Set(active.map(c => c.id));
        
        for (const id of [...remaining]) {
            if (!activeIds.has(id)) remaining.delete(id);
        }

        const elapsed = Math.round((Date.now() - start) / 1000);
        process.stdout.write(`\r   📡 Activas aún: ${remaining.size}/${vapiIds.length} | Tiempo: ${elapsed}s    `);
    }

    console.log(`\n   ✅ Todas las llamadas han terminado.\n`);

    // Now fetch full call data from Vapi
    const callData = [];
    for (const id of vapiIds) {
        try {
            const res = await fetch(`https://api.vapi.ai/call/${id}`, {
                headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
            });
            if (res.ok) callData.push(await res.json());
        } catch {}
        await sleep(200);
    }
    return callData;
}

// ── 4. ANALYZE BATCH ──────────────────────────────────────────

function calcDuration(c) {
    return c.endedAt && c.startedAt ? Math.round((new Date(c.endedAt) - new Date(c.startedAt)) / 1000) : 0;
}

function buildMetrics(calls) {
    const total = calls.length;
    const evalCounts = {};
    let totalDur = 0, totalCost = 0, successCount = 0, busyCount = 0, voicemailCount = 0, sipErrors = 0;
    const summaries = [];

    for (const c of calls) {
        const dur = calcDuration(c);
        const reason = c.endedReason || '';
        const evalRaw = (c.analysis?.successEvaluation || '').toLowerCase();
        const evalKey = evalRaw || reason.substring(0, 30);
        evalCounts[evalKey] = (evalCounts[evalKey] || 0) + 1;

        totalDur += dur;
        totalCost += c.cost || 0;

        if (evalRaw === 'true') successCount++;
        if (reason.includes('busy')) busyCount++;
        if (reason.includes('voicemail') || reason.includes('assistant-ended') && dur < 20) voicemailCount++;
        if (reason.includes('sip')) sipErrors++;

        if (c.analysis?.summary) {
            summaries.push({
                lead: c.assistantOverrides?.variableValues?.nombre || c.customer?.number,
                dur,
                eval: evalRaw,
                summary: c.analysis.summary.substring(0, 200),
                success: evalRaw === 'true'
            });
        }
    }

    const contactRate = total > 0 ? Math.round(((total - busyCount - sipErrors) / total) * 100) : 0;

    return { total, successCount, busyCount, voicemailCount, sipErrors, totalDur, totalCost: Math.round(totalCost * 100) / 100, avgDur: Math.round(totalDur / (total || 1)), contactRate, evalCounts, summaries };
}

async function analyzeBatchWithGroq(batchNum, metrics, startedAt) {
    const dateStr = startedAt.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

    console.log(`\n🤖 Generando análisis del lote con IA...`);

    if (!GROQ_API_KEY) {
        console.warn('⚠️  GROQ_API_KEY no configurada. Solo métricas básicas.');
        return {
            analysis: `Lote ${batchNum} del ${dateStr}: ${metrics.total} llamadas. Contactados: ${metrics.contactRate}%. Éxito: ${metrics.successCount}. Coste: $${metrics.totalCost}.`,
            recommendations: 'Configura GROQ_API_KEY para análisis IA.',
            score: metrics.successCount > 0 ? 60 : 30
        };
    }

    const prompt = `Eres un analista de campañas de llamadas IA para Setter Solar (empresa de paneles solares).
Analiza este lote de llamadas automatizadas y responde en JSON puro (sin markdown).

## LOTE ${batchNum} — ${dateStr}

Métricas:
- Total llamadas: ${metrics.total}
- Tasa de contacto: ${metrics.contactRate}%
- Citas conseguidas: ${metrics.successCount}
- Comunican/ocupado: ${metrics.busyCount}
- Buzones detectados: ${metrics.voicemailCount}
- Errores SIP: ${metrics.sipErrors}
- Duración media conversación: ${metrics.avgDur}s
- Coste total: $${metrics.totalCost}

Desglose evaluaciones:
${Object.entries(metrics.evalCounts).map(([k, v]) => `  ${k}: ${v}`).join('\n')}

Conversaciones reales (resumen):
${metrics.summaries.map((s, i) => `${i + 1}. ${s.lead} | ${s.dur}s | ${s.summary}`).join('\n')}

Responde EXACTAMENTE en este JSON:
{
  "analysis": "Análisis del lote en 150-250 palabras",
  "patterns": "Patrones clave observados",
  "recommendations": "2-3 acciones concretas para el próximo lote",
  "score": <0-100>
}`;

    try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [
                    { role: 'system', content: 'Analista de datos de llamadas. Responde solo JSON válido sin bloques de código.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.6,
                max_tokens: 800
            })
        });

        const data = await res.json();
        let content = data.choices?.[0]?.message?.content?.trim() || '';
        content = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        
        try {
            const parsed = JSON.parse(content);
            return {
                analysis: `${parsed.analysis}\n\n**Patrones:** ${parsed.patterns}`,
                recommendations: parsed.recommendations,
                score: parsed.score || 50
            };
        } catch {
            return { analysis: content.substring(0, 500), recommendations: '–', score: 50 };
        }
    } catch (err) {
        console.error('❌ Groq error:', err.message);
        return { analysis: `Lote ${batchNum}: ${metrics.total} llamadas. ${metrics.successCount} éxitos. Score estimado.`, recommendations: '–', score: metrics.successCount > 0 ? 60 : 30 };
    }
}

async function saveBatchReport(batchNum, metrics, aiResult) {
    const reportData = {
        report_date: new Date().toISOString().split('T')[0],
        total_calls: metrics.total,
        successful: metrics.successCount,
        failed: metrics.sipErrors,
        contestador: metrics.voicemailCount,
        avg_duration: metrics.avgDur,
        total_cost: metrics.totalCost,
        ai_analysis: `[LOTE ${batchNum}] ${aiResult.analysis}`,
        ai_recommendations: aiResult.recommendations,
        ai_score: aiResult.score,
        metrics_json: JSON.stringify({ batchNum, ...metrics })
    };

    const res = await fetch(`${API_BASE}/${REPORTS_TABLE}/records`, {
        method: 'POST',
        headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(reportData)
    });

    if (!res.ok) {
        console.error('⚠️  Error guardando informe en NocoDB:', await res.text());
    } else {
        const saved = await res.json();
        console.log(`   💾 Informe guardado (ID: ${saved.Id || saved.id})`);
    }
}

// ── 5. MAIN ───────────────────────────────────────────────────

async function main() {
    const BATCH_NUM = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
    const startedAt = new Date();

    console.log('═'.repeat(62));
    console.log(`🔄 BATCH & ANALYZE — Lote ${BATCH_NUM}`);
    console.log(`   📅 ${startedAt.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}`);
    console.log(`   📞 Tamaño del lote: ${BATCH_SIZE}`);
    if (DRY_RUN)       console.log('   ⚠️  MODO DRY RUN');
    if (SKIP_ANALYSIS) console.log('   ⚠️  ANÁLISIS OMITIDO');
    console.log('═'.repeat(62) + '\n');

    // Preflight
    const { runPreflightChecks } = await import('./preflight_check.mjs');
    const pre = await runPreflightChecks();
    if (!pre.allowed) {
        console.error('🛑 Bloqueado por preflight. Abortando.');
        process.exit(1);
    }

    // Fetch leads
    console.log(`📋 Obteniendo ${BATCH_SIZE} leads...`);
    const leads = await fetchLeads(BATCH_SIZE);
    if (leads.length === 0) {
        console.log('ℹ️  No hay leads disponibles. Termina.');
        return;
    }
    console.log(`   ✅ ${leads.length} leads listos.\n`);

    // Launch calls
    const results = [];
    for (let i = 0; i < leads.length; i++) {
        const lead = leads[i];
        console.log(`[${i + 1}/${leads.length}] ${ts()} — ${lead.name}`);
        const result = await callLead(lead);
        results.push(result);
        if (i < leads.length - 1) await sleep(DELAY_BETWEEN_CALLS_MS);
    }

    const launched = results.filter(r => r.success && r.vapiId && !r.dry);
    const vapiIds  = launched.map(r => r.vapiId);

    console.log(`\n📊 Lote lanzado: ${launched.length} llamadas iniciadas, ${results.filter(r => !r.success).length} fallidas.\n`);

    // Wait for completion + get full call data
    let callData = [];
    if (!SKIP_ANALYSIS && vapiIds.length > 0) {
        callData = await waitForBatchToFinish(vapiIds);

        // Post-batch cleanup for SIP errors
        if (!DRY_RUN) {
            const vapiIdToLead = {};
            launched.forEach(r => { vapiIdToLead[r.vapiId] = r.unique_id; });
            
            for (const c of callData) {
                const reason = (c.endedReason || '').toLowerCase();
                if (reason.includes('sip') || reason.includes('failed-to-connect') || reason.includes('providerfault')) {
                    const unique_id = vapiIdToLead[c.id];
                    if (unique_id) {
                        await fetch(`${API_BASE}/${LEADS_TABLE}/records`, {
                            method: 'PATCH',
                            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
                            body: JSON.stringify([{ unique_id, status: 'Error SIP', fecha_planificada: null }])
                        }).catch(() => {});
                        console.log(`   🚫 Lead actualizado a 'Error SIP' permanentemente: ${c.customer?.number}`);
                    }
                }
            }
        }
    }

    // Analysis
    if (!SKIP_ANALYSIS) {
        const metrics = DRY_RUN
            ? buildMetrics([])
            : buildMetrics(callData.length > 0 ? callData : []);

        // Print table  
        console.log('┌─────────────────────────────────────────┐');
        console.log(`│  📊 RESULTADOS — LOTE ${BATCH_NUM.padEnd(18)}│`);
        console.log('├─────────────────────────────────────────┤');
        console.log(`│  Llamadas lanzadas:  ${String(launched.length).padStart(6)}             │`);
        console.log(`│  Tasa de contacto:   ${String(metrics.contactRate + '%').padStart(6)}             │`);
        console.log(`│  Citas conseguidas:  ${String(metrics.successCount).padStart(6)}             │`);
        console.log(`│  Buzones:            ${String(metrics.voicemailCount).padStart(6)}             │`);
        console.log(`│  Errores SIP:        ${String(metrics.sipErrors).padStart(6)}             │`);
        console.log(`│  Duración media:     ${String(metrics.avgDur + 's').padStart(6)}             │`);
        console.log(`│  Coste total:       $${String(metrics.totalCost).padStart(6)}             │`);
        console.log('└─────────────────────────────────────────┘\n');

        const aiResult = await analyzeBatchWithGroq(BATCH_NUM, metrics, startedAt);

        console.log('\n📝 ANÁLISIS IA:');
        console.log('─'.repeat(50));
        console.log(aiResult.analysis);
        console.log('\n💡 RECOMENDACIONES:');
        console.log('─'.repeat(50));
        console.log(aiResult.recommendations);
        console.log(`\n⭐ SCORE DEL LOTE: ${aiResult.score}/100`);

        if (!DRY_RUN) {
            console.log('\n💾 Guardando informe...');
            await saveBatchReport(BATCH_NUM, metrics, aiResult);
        }
    }

    const totalTime = Math.round((Date.now() - startedAt.getTime()) / 1000);
    console.log(`\n${'═'.repeat(62)}`);
    console.log(`✅ Lote ${BATCH_NUM} completado en ${totalTime}s`);
    console.log('═'.repeat(62));
}

main().catch(err => {
    console.error('💥 Error fatal:', err);
    process.exit(1);
});

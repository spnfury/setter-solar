#!/usr/bin/env node
/**
 * 📊 DAILY CALL ANALYSIS — Automated AI-powered call analysis
 * 
 * Fetches all calls from a given day, calculates metrics,
 * sends to OpenAI for qualitative analysis, and stores the report in NocoDB.
 * 
 * Usage:
 *   node daily_analysis.mjs                    # Analyze today
 *   node daily_analysis.mjs --date 2026-02-17  # Analyze specific date
 *   node daily_analysis.mjs --dry-run          # Preview without saving
 * 
 * Environment:
 *   OPENAI_API_KEY=sk-...  (required)
 * 
 * Cron (every day at 23:00 CET):
 *   0 22 * * * cd /path/to/call-dashboard-app && node daily_analysis.mjs
 */

const API_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const CALL_LOGS_TABLE = 'm73w58ba47ifkrx';
const CONFIRMED_TABLE = 'mh4cvunsnskuu4b';
const LEADS_TABLE = 'mf0wzufqcpi3bd1';
const REPORTS_TABLE = 'matif11dcltlmn6'; // Asumiendo que esta es igual o debes validarla; si no hay tabla nueva de informes, déjala como matif11dcltlmn6 o coméntalo.
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

const VAPI_API_KEY = '0594f41c-e836-425d-aaa2-1c5b7d9e506e';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// Parse args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dateIdx = args.indexOf('--date');
const TARGET_DATE = dateIdx >= 0 ? args[dateIdx + 1] : new Date().toISOString().split('T')[0];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════
// 1. DATA FETCHING
// ═══════════════════════════════════════════════════════════

async function fetchCallsForDate(date) {
    // Fetch all call_logs, then filter by date (NocoDB date filtering is tricky)
    let allRecords = [];
    let offset = 0;
    const batchSize = 200;

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
        if (allRecords.length >= 2000) break;
    }

    // Filter by target date (comparing in CET timezone)
    return allRecords.filter(c => {
        const callDate = new Date(c.call_time || c.CreatedAt);
        // Convert to CET string
        const cetDate = callDate.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
        return cetDate === date;
    }).filter(c => {
        // Exclude test calls
        if (c.is_test === true || c.is_test === 1) return false;
        if ((c.ended_reason || '').includes('Manual Trigger')) return false;
        if ((c.lead_name || '').toLowerCase() === 'test manual') return false;
        return true;
    });
}

async function fetchConfirmedData() {
    const res = await fetch(`${API_BASE}/${CONFIRMED_TABLE}/records?limit=500`, {
        headers: { 'xc-token': XC_TOKEN }
    });
    const data = await res.json();
    const map = {};
    (data.list || []).forEach(row => {
        const callId = row['Vapi Call ID'] || row.vapi_call_id || '';
        if (callId) map[callId] = row;
    });
    return map;
}

async function enrichCallFromVapi(call) {
    if (!call.vapi_call_id || !call.vapi_call_id.startsWith('019')) return call;
    try {
        const res = await fetch(`https://api.vapi.ai/call/${call.vapi_call_id}`, {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (!res.ok) return call;
        const vapiData = await res.json();
        return {
            ...call,
            _vapi: {
                summary: vapiData.analysis?.summary || vapiData.summary || '',
                successEvaluation: vapiData.analysis?.successEvaluation || '',
                endedReason: vapiData.endedReason || '',
                cost: vapiData.cost || 0,
                transcript: (vapiData.artifact?.transcript || vapiData.transcript || '').substring(0, 1000),
                duration: vapiData.endedAt && vapiData.startedAt
                    ? Math.round((new Date(vapiData.endedAt) - new Date(vapiData.startedAt)) / 1000)
                    : parseInt(call.duration_seconds) || 0
            }
        };
    } catch (err) {
        return call;
    }
}

// ═══════════════════════════════════════════════════════════
// 2. METRICS CALCULATION
// ═══════════════════════════════════════════════════════════

function calculateMetrics(calls, confirmedMap) {
    const total = calls.length;
    if (total === 0) return null;

    const evaluations = {};
    let totalDuration = 0;
    let totalCost = 0;
    let confirmedCount = 0;
    const companiesContacted = new Set();
    const hourDistribution = {};
    const summaries = [];

    for (const call of calls) {
        // Evaluation breakdown
        const eval_ = (call.evaluation || 'Pendiente').toLowerCase();
        evaluations[eval_] = (evaluations[eval_] || 0) + 1;

        // Duration
        const dur = call._vapi?.duration || parseInt(call.duration_seconds) || 0;
        totalDuration += dur;

        // Cost
        totalCost += call._vapi?.cost || 0;

        // Confirmed
        if (confirmedMap[call.vapi_call_id]) confirmedCount++;

        // Companies
        if (call.lead_name) companiesContacted.add(call.lead_name);

        // Hour distribution
        const callTime = new Date(call.call_time || call.CreatedAt);
        const hour = callTime.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit' });
        hourDistribution[hour] = (hourDistribution[hour] || 0) + 1;

        // Summaries for AI context
        if (call._vapi?.summary) {
            summaries.push({
                empresa: call.lead_name || 'Desconocida',
                evaluacion: call.evaluation || 'Pendiente',
                duracion: dur,
                resumen: call._vapi.summary.substring(0, 200),
                notas: (call.Notes || '').substring(0, 100)
            });
        }
    }

    const successful = (evaluations['completada'] || 0) + (evaluations['confirmada ✓'] || 0);
    const failed = (evaluations['fallida'] || 0) + (evaluations['no contesta'] || 0) +
        (evaluations['error'] || 0) + (evaluations['ocupado'] || 0);
    const contestador = evaluations['contestador'] || 0;
    const avgDuration = Math.round(totalDuration / total);
    const confirmationRate = total > 0 ? Math.round((confirmedCount / total) * 100) : 0;
    const successRate = total > 0 ? Math.round((successful / total) * 100) : 0;

    return {
        total,
        successful,
        failed,
        contestador,
        avgDuration,
        totalDuration,
        totalCost: Math.round(totalCost * 100) / 100,
        confirmedCount,
        confirmationRate,
        successRate,
        evaluations,
        companiesContacted: companiesContacted.size,
        hourDistribution,
        summaries: summaries.slice(0, 30), // Limit for OpenAI context
        // Derived
        colgadoRapido: evaluations['colgó rápido'] || 0,
        sinDatos: evaluations['sin datos'] || 0,
        sinRespuesta: evaluations['sin respuesta'] || 0,
        pendiente: evaluations['pendiente'] || 0
    };
}

// ═══════════════════════════════════════════════════════════
// 3. OPENAI ANALYSIS
// ═══════════════════════════════════════════════════════════

async function generateAIAnalysis(metrics, date) {
    if (!GROQ_API_KEY) {
        console.warn('⚠️  No GROQ_API_KEY set. Generating basic analysis without AI.');
        return {
            analysis: generateBasicAnalysis(metrics, date),
            recommendations: generateBasicRecommendations(metrics),
            score: calculateBasicScore(metrics)
        };
    }

    const prompt = `Eres un analista experto en campañas de llamadas telefónicas automatizadas con IA para una empresa de energía solar (Setter Solar). 
Analiza los resultados del día ${date} y proporciona un informe profesional en español.

## DATOS DEL DÍA ${date}

### Métricas generales:
- Total llamadas: ${metrics.total}
- Exitosas (completadas/confirmadas): ${metrics.successful} (${metrics.successRate}%)
- Fallidas (no contesta/error/ocupado): ${metrics.failed}
- Contestadores automáticos: ${metrics.contestador}
- Colgaron rápido: ${metrics.colgadoRapido}
- Sin datos/pendientes: ${metrics.sinDatos + metrics.pendiente}
- Duración media: ${metrics.avgDuration}s
- Coste total: $${metrics.totalCost}
- Empresas/Leads contactados: ${metrics.companiesContacted}
- Datos confirmados: ${metrics.confirmedCount} (${metrics.confirmationRate}%)

### Distribución horaria:
${Object.entries(metrics.hourDistribution).sort().map(([h, c]) => `${h}:00 → ${c} llamadas`).join('\n')}

### Desglose por evaluación:
${Object.entries(metrics.evaluations).map(([e, c]) => `${e}: ${c}`).join('\n')}

### Resúmenes de llamadas relevantes:
${metrics.summaries.map((s, i) => `${i + 1}. ${s.empresa} | ${s.evaluacion} | ${s.duracion}s | ${s.resumen}${s.notas ? ' | Notas: ' + s.notas : ''}`).join('\n')}

## INSTRUCCIONES
Responde EXACTAMENTE en este formato JSON (sin markdown, solo JSON puro):
{
  "analysis": "Párrafo de análisis general del día (200-400 palabras). Incluye contexto, qué fue bien y qué fue mal.",
  "patterns": "Patrones detectados: mejores horarios, receptividad, problemas recurrentes.",
  "recommendations": "3-5 recomendaciones concretas y accionables para mejorar los resultados.",
  "highlights": "2-3 puntos destacados positivos del día.",
  "concerns": "2-3 problemas o áreas de preocupación.",
  "score": <número del 0 al 100 evaluando el rendimiento general>
}`;

    try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [
                    { role: 'system', content: 'Eres un analista de datos especializado en campañas de llamadas. Responde siempre en JSON válido, sin bloques de código markdown ni backticks.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 2000
            })
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Groq API error ${res.status}: ${err.error?.message || 'Unknown'}`);
        }

        const data = await res.json();
        const content = data.choices[0]?.message?.content || '';

        // Parse JSON from response (handle possible markdown wrapping)
        let jsonStr = content.trim();
        if (jsonStr.startsWith('\`\`\`')) {
            jsonStr = jsonStr.replace(/^\`\`\`(?:json)?\n?/, '').replace(/\n?\`\`\`$/, '');
        }
        
        let parsed;
        try {
            parsed = JSON.parse(jsonStr);
        } catch (e) {
            console.warn('⚠️  Groq returned invalid JSON, attempting fallback parsing.', jsonStr.substring(0, 100));
            parsed = { analysis: jsonStr.substring(0, 500) + '...', patterns: '', recommendations: 'Revisar output manualmente', highlights: '', concerns: '', score: 50 };
        }

        return {
            analysis: `${parsed.analysis || ''}\n\n**Patrones detectados:**\n${parsed.patterns || ''}\n\n**Puntos destacados:**\n${parsed.highlights || ''}\n\n**Áreas de preocupación:**\n${parsed.concerns || ''}`,
            recommendations: parsed.recommendations || 'Sin recomendaciones.',
            score: parsed.score || 50
        };
    } catch (err) {
        console.error('❌ Groq error:', err.message);
        return {
            analysis: generateBasicAnalysis(metrics, date),
            recommendations: generateBasicRecommendations(metrics),
            score: calculateBasicScore(metrics)
        };
    }
}

// Fallback analysis when no OpenAI key
function generateBasicAnalysis(m, date) {
    const lines = [];
    lines.push(`📊 Informe automático del ${date}`);
    lines.push(`\nSe realizaron ${m.total} llamadas con una tasa de éxito del ${m.successRate}%.`);
    if (m.contestador > 0) lines.push(`Se detectaron ${m.contestador} contestadores automáticos (${Math.round(m.contestador / m.total * 100)}%).`);
    if (m.confirmedCount > 0) lines.push(`Se confirmaron datos de ${m.confirmedCount} contactos (${m.confirmationRate}%).`);
    lines.push(`Duración media: ${m.avgDuration}s. Coste total: $${m.totalCost}.`);
    if (m.colgadoRapido > 0) lines.push(`⚠️ ${m.colgadoRapido} llamadas cortadas rápidamente.`);
    return lines.join('\n');
}

function generateBasicRecommendations(m) {
    const recs = [];
    if (m.contestador / m.total > 0.15) recs.push('Alto porcentaje de contestadores. Considerar filtrar leads con IVR antes de programar.');
    if (m.avgDuration < 20) recs.push('Duración media muy baja. Revisar el script de apertura para captar más atención.');
    if (m.colgadoRapido / m.total > 0.2) recs.push('Muchas llamadas cortadas rápido. Mejorar el saludo inicial.');
    if (m.confirmationRate < 5) recs.push('Tasa de confirmación baja. Revisar el flujo de recogida de datos.');
    if (recs.length === 0) recs.push('Los resultados están dentro de los parámetros normales. Seguir monitorizando.');
    return recs.join('\n');
}

function calculateBasicScore(m) {
    let score = 50;
    score += m.successRate * 0.3; // Up to +30
    score += m.confirmationRate * 0.2; // Up to +20
    if (m.avgDuration > 60) score += 10;
    else if (m.avgDuration > 30) score += 5;
    if (m.contestador / m.total > 0.2) score -= 10;
    if (m.colgadoRapido / m.total > 0.2) score -= 10;
    return Math.max(0, Math.min(100, Math.round(score)));
}

// ═══════════════════════════════════════════════════════════
// 4. SAVE REPORT
// ═══════════════════════════════════════════════════════════

async function saveReport(date, metrics, aiResult) {
    // Check if report already exists for this date
    const checkRes = await fetch(
        `${API_BASE}/${REPORTS_TABLE}/records?where=(report_date,eq,${date})&limit=1`,
        { headers: { 'xc-token': XC_TOKEN } }
    );
    const checkData = await checkRes.json();
    const existingReport = checkData.list && checkData.list[0];

    const reportData = {
        report_date: date,
        total_calls: metrics.total,
        successful: metrics.successful,
        failed: metrics.failed,
        contestador: metrics.contestador,
        avg_duration: metrics.avgDuration,
        confirmation_rate: metrics.confirmationRate,
        total_cost: metrics.totalCost,
        metrics_json: JSON.stringify(metrics),
        ai_analysis: aiResult.analysis,
        ai_recommendations: aiResult.recommendations,
        ai_score: aiResult.score
    };

    if (existingReport) {
        // Update existing report
        reportData.id = existingReport.id || existingReport.Id;
        const res = await fetch(`${API_BASE}/${REPORTS_TABLE}/records`, {
            method: 'PATCH',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify([reportData])
        });
        if (!res.ok) throw new Error(`Failed to update report: ${res.status}`);
        console.log(`   ✏️  Informe actualizado (ID: ${reportData.id})`);
    } else {
        // Create new report
        const res = await fetch(`${API_BASE}/${REPORTS_TABLE}/records`, {
            method: 'POST',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify(reportData)
        });
        if (!res.ok) throw new Error(`Failed to create report: ${res.status}`);
        const result = await res.json();
        console.log(`   ✅ Informe creado (ID: ${result.id || result.Id})`);
    }
}

// ═══════════════════════════════════════════════════════════
// 5. MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
    console.log('═'.repeat(60));
    console.log(`📊 ANÁLISIS DIARIO DE LLAMADAS — ${TARGET_DATE}`);
    console.log('═'.repeat(60));
    if (!GROQ_API_KEY) console.log('⚠️  GROQ_API_KEY no configurada — se usará análisis básico');
    if (DRY_RUN) console.log('⚠️  MODO DRY RUN — No se guardará en NocoDB');
    console.log('');

    // 1. Fetch calls
    console.log('📥 Obteniendo llamadas del día...');
    const calls = await fetchCallsForDate(TARGET_DATE);
    console.log(`   Encontradas: ${calls.length} llamadas (excluyendo test)`);

    if (calls.length === 0) {
        console.log('\n❌ No hay llamadas para analizar en esta fecha.');
        return;
    }

    // 2. Fetch confirmed data
    console.log('📥 Obteniendo datos confirmados...');
    const confirmedMap = await fetchConfirmedData();
    console.log(`   Registros confirmados: ${Object.keys(confirmedMap).length}`);

    // 3. Enrich calls with Vapi data (up to 30 for context)
    console.log('🔍 Enriqueciendo llamadas con datos de Vapi...');
    const enrichLimit = Math.min(calls.length, 10);
    for (let i = 0; i < enrichLimit; i++) {
        calls[i] = await enrichCallFromVapi(calls[i]);
        if (i % 5 === 0) process.stdout.write(`\r   ${i + 1}/${enrichLimit} llamadas procesadas...`);
        await sleep(200); // Rate limiting
    }
    console.log(`\r   ✅ ${enrichLimit} llamadas enriquecidas                `);

    // 4. Calculate metrics
    console.log('📈 Calculando métricas...');
    const metrics = calculateMetrics(calls, confirmedMap);
    if (!metrics) {
        console.log('❌ No se pudieron calcular métricas.');
        return;
    }

    console.log(`\n   ┌─────────────────────────────────────┐`);
    console.log(`   │  📊 MÉTRICAS DEL DÍA ${TARGET_DATE}    │`);
    console.log(`   ├─────────────────────────────────────┤`);
    console.log(`   │  Total llamadas:    ${String(metrics.total).padStart(6)}          │`);
    console.log(`   │  Exitosas:          ${String(metrics.successful).padStart(6)} (${metrics.successRate}%)     │`);
    console.log(`   │  Fallidas:          ${String(metrics.failed).padStart(6)}          │`);
    console.log(`   │  Contestadores:     ${String(metrics.contestador).padStart(6)}          │`);
    console.log(`   │  Colgaron rápido:   ${String(metrics.colgadoRapido).padStart(6)}          │`);
    console.log(`   │  Duración media:    ${String(metrics.avgDuration + 's').padStart(6)}          │`);
    console.log(`   │  Coste total:     $${String(metrics.totalCost).padStart(7)}          │`);
    console.log(`   │  Confirmadas:       ${String(metrics.confirmedCount).padStart(6)} (${metrics.confirmationRate}%)     │`);
    console.log(`   │  Empresas:          ${String(metrics.companiesContacted).padStart(6)}          │`);
    console.log(`   └─────────────────────────────────────┘\n`);

    // 5. AI Analysis
    console.log('🤖 Generando análisis con IA...');
    const aiResult = await generateAIAnalysis(metrics, TARGET_DATE);
    console.log(`   Score del día: ${aiResult.score}/100`);

    console.log('\n📝 ANÁLISIS:');
    console.log('─'.repeat(50));
    console.log(aiResult.analysis);
    console.log('\n💡 RECOMENDACIONES:');
    console.log('─'.repeat(50));
    console.log(aiResult.recommendations);

    // 6. Save report
    if (!DRY_RUN) {
        console.log('\n💾 Guardando informe en NocoDB...');
        await saveReport(TARGET_DATE, metrics, aiResult);
    } else {
        console.log('\n⚠️  DRY RUN — No se guardó el informe.');
    }

    console.log('\n' + '═'.repeat(60));
    console.log('✅ Análisis completado.');
    console.log('═'.repeat(60));
}

main().catch(err => {
    console.error('💥 Error fatal:', err);
    process.exit(1);
});

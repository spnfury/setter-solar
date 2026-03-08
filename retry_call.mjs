#!/usr/bin/env node
/**
 * retry_call.mjs
 * 
 * Rellamar a un lead retomando la conversación anterior.
 * Busca la llamada anterior en Vapi, extrae la transcripción y el contexto,
 * y lanza una nueva llamada con un firstMessage adaptado que retoma
 * donde se quedó.
 * 
 * Usage:
 *   node retry_call.mjs <vapi_call_id>
 *   node retry_call.mjs <phone_number>
 * 
 * Examples:
 *   node retry_call.mjs 019c56f5-9ce2-7996-875e-1738f308c58f
 *   node retry_call.mjs +34968630135
 */

const VAPI_API_KEY = '0594f41c-e836-425d-aaa2-1c5b7d9e506e';
const ASSISTANT_ID = 'f3359bb0-7bc4-45c7-9a02-ca4793cc5d48';
const PHONE_NUMBER_ID = 'e774df77-8fd0-4a17-a815-2acf8b6e3c2b';

const NOCODB_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const LEADS_TABLE = 'mf0wzufqcpi3bd1';
const CALL_LOGS_TABLE = 'm73w58ba47ifkrx';
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';

const MAX_CONCURRENT_CALLS = 10;

function formatPhone(phone) {
    let p = String(phone || '').replace(/\D/g, '');
    if (!p || p.length < 6) return null;
    return p.startsWith('34') ? '+' + p : '+34' + p;
}

/**
 * Fetch the full call details from Vapi
 */
async function getCallDetails(callId) {
    const res = await fetch(`https://api.vapi.ai/call/${callId}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });
    if (!res.ok) throw new Error(`Failed to fetch call ${callId}: ${res.status}`);
    return res.json();
}

/**
 * Find the most recent call to a phone number
 */
async function findLastCallToPhone(phone) {
    const normalizedPhone = formatPhone(phone);
    const res = await fetch('https://api.vapi.ai/call?limit=50', {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });
    if (!res.ok) throw new Error(`Failed to fetch calls: ${res.status}`);
    const calls = await res.json();

    // Find the most recent call to this phone number
    const matching = (Array.isArray(calls) ? calls : [])
        .filter(c => c.customer?.number === normalizedPhone && c.status === 'ended')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (matching.length === 0) return null;
    return getCallDetails(matching[0].id);
}

/**
 * Extract a summary of what happened in the previous call
 * to use as context in the retry call
 */
function buildRetryContext(previousCall) {
    const transcript = previousCall.artifact?.transcript || previousCall.transcript || '';
    const endedReason = previousCall.endedReason || 'unknown';
    const analysis = previousCall.analysis?.summary || '';
    const duration = previousCall.endedAt && previousCall.startedAt
        ? Math.round((new Date(previousCall.endedAt) - new Date(previousCall.startedAt)) / 1000)
        : 0;

    // Parse transcript to extract key conversation points
    const lines = transcript.split('\n').filter(l => l.trim());
    const userMessages = lines.filter(l => l.startsWith('User:') || l.startsWith('user:'))
        .map(l => l.replace(/^(User|user):\s*/, '').trim());
    const aiMessages = lines.filter(l => l.startsWith('AI:') || l.startsWith('bot:'))
        .map(l => l.replace(/^(AI|bot):\s*/, '').trim());

    // Determine if the customer showed interest
    const interestSignals = ['interesa', 'sí', 'cuéntame', 'dime', 'vale', 'ok', 'de acuerdo', 'claro'];
    const customerInterested = userMessages.some(msg =>
        interestSignals.some(signal => msg.toLowerCase().includes(signal))
    );

    // Determine the last topic discussed
    let lastTopic = 'la presentación del programa de partners';
    if (aiMessages.some(m => m.toLowerCase().includes('servicio de seguridad'))) {
        lastTopic = 'si actualmente ofrecéis servicios de seguridad';
    }
    if (aiMessages.some(m => m.toLowerCase().includes('cibersafe') || m.toLowerCase().includes('cibersteps'))) {
        lastTopic = 'los servicios CiberSafe y CiberSteps';
    }
    if (aiMessages.some(m => m.toLowerCase().includes('comisión') || m.toLowerCase().includes('partner'))) {
        lastTopic = 'el modelo de colaboración como partner';
    }
    if (aiMessages.some(m => m.toLowerCase().includes('email') || m.toLowerCase().includes('correo'))) {
        lastTopic = 'el envío de más información por email';
    }

    // Determine why it ended
    let endReason = 'la llamada se cortó';
    if (endedReason === 'customer-ended-call') {
        endReason = duration < 30 ? 'la llamada se cortó muy rápido' : 'la llamada se cortó';
    } else if (endedReason === 'assistant-ended-call') {
        endReason = 'terminaste la llamada (quizá por error)';
    } else if (endedReason.includes('error') || endedReason.includes('sip')) {
        endReason = 'hubo un problema técnico con la línea';
    }

    // Extract customer name if mentioned
    let customerName = '';
    for (const msg of userMessages) {
        const nameMatch = msg.match(/(?:soy|me llamo|soy el|soy la)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){0,2})/i);
        if (nameMatch) {
            customerName = nameMatch[1].trim();
            break;
        }
    }

    return {
        transcript,
        customerInterested,
        lastTopic,
        endReason,
        customerName,
        duration,
        endedReason,
        analysis,
        userMessages,
        aiMessages
    };
}

/**
 * Build the firstMessage for the retry call
 */
function buildRetryFirstMessage(context) {
    const nameGreeting = context.customerName
        ? `${context.customerName}, `
        : '';

    if (context.customerInterested) {
        // Customer showed interest — emphasis on continuing
        return `Hola ${nameGreeting}soy Violeta de General Protec Ciberseguridad. Te llamé hace un momento y parece que se cortó la comunicación. Me habías dicho que te interesaba, ¿verdad? Retomo donde lo dejamos rapidísimo.`;
    } else if (context.duration < 15) {
        // Very short call — probably couldn't even present
        return `Hola, soy Violeta de General Protec Ciberseguridad. Intenté llamarte hace un momento pero parece que se cortó antes de poder explicarme bien. ¿Tienes un minuto? Es brevísimo.`;
    } else {
        // General retry
        return `Hola ${nameGreeting}soy Violeta de General Protec Ciberseguridad. Disculpa, parece que se cortó nuestra llamada. Te estaba comentando sobre ${context.lastTopic}. ¿Seguimos?`;
    }
}

/**
 * Build system prompt additions for the retry call
 */
function buildRetrySystemPromptAddition(context) {
    let addition = `\n\n## CONTEXTO DE RELLAMADA (IMPORTANTE)
Esta es una RELLAMADA. Ya hablaste con este contacto hace unos minutos y la llamada se cortó.

### Lo que pasó en la llamada anterior:
${context.analysis || 'Se cortó la comunicación durante la conversación.'}

### Estado de la conversación anterior:
- Duración: ${context.duration} segundos
- El cliente mostró interés: ${context.customerInterested ? 'SÍ' : 'No determinado'}
- Último tema tratado: ${context.lastTopic}
- Motivo del corte: ${context.endReason}
${context.customerName ? `- Nombre del interlocutor: ${context.customerName}` : ''}

### Transcripción de la llamada anterior:
${context.transcript || 'No disponible'}

### INSTRUCCIONES PARA ESTA RELLAMADA:
1. NO repitas toda la presentación desde cero. El cliente ya sabe quién eres.
2. Haz referencia a que se cortó la llamada anterior de forma natural.
3. Retoma EXACTAMENTE donde lo dejaste. Si el cliente dijo "interesa", pasa directo a dar valor y recoger datos.
4. Si el cliente ya se había identificado, usa su nombre.
5. Sé más conciso y directo que en una primera llamada.
6. Si el cliente pregunta por qué llamas de nuevo, di que se cortó la comunicación y quieres asegurarte de darle toda la información.`;

    return addition;
}

/**
 * Check active call count
 */
async function getActiveCallCount() {
    try {
        const res = await fetch('https://api.vapi.ai/call?limit=100', {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (!res.ok) return -1;
        const calls = await res.json();
        return (Array.isArray(calls) ? calls : [])
            .filter(c => ['queued', 'ringing', 'in-progress'].includes(c.status)).length;
    } catch { return -1; }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.log('Usage:');
        console.log('  node retry_call.mjs <vapi_call_id>');
        console.log('  node retry_call.mjs <phone_number>');
        console.log('');
        console.log('Example:');
        console.log('  node retry_call.mjs 019c56f5-9ce2-7996-875e-1738f308c58f');
        console.log('  node retry_call.mjs +34968630135');
        process.exit(1);
    }

    const input = args[0];
    let previousCall;
    let customerPhone;

    console.log('🔄 RETRY CALL — Rellamada con contexto');
    console.log('═'.repeat(60));

    // Determine if input is a call ID or phone number
    if (input.startsWith('+') || /^\d{6,}$/.test(input)) {
        // It's a phone number
        customerPhone = formatPhone(input);
        console.log(`📞 Buscando última llamada al teléfono ${customerPhone}...`);
        previousCall = await findLastCallToPhone(input);
        if (!previousCall) {
            console.error(`❌ No se encontró ninguna llamada al teléfono ${customerPhone}`);
            process.exit(1);
        }
        console.log(`   Encontrada llamada ${previousCall.id}`);
    } else {
        // It's a call ID
        console.log(`📡 Obteniendo detalles de la llamada ${input}...`);
        previousCall = await getCallDetails(input);
        customerPhone = previousCall.customer?.number;
    }

    if (!customerPhone) {
        console.error('❌ No se encontró número de teléfono del cliente');
        process.exit(1);
    }

    // Build context
    const context = buildRetryContext(previousCall);

    console.log(`\n📋 Resumen de la llamada anterior:`);
    console.log(`   Teléfono: ${customerPhone}`);
    console.log(`   Duración: ${context.duration}s`);
    console.log(`   Motivo fin: ${context.endedReason}`);
    console.log(`   Interés detectado: ${context.customerInterested ? '✅ SÍ' : '❓ No claro'}`);
    console.log(`   Nombre del cliente: ${context.customerName || 'No identificado'}`);
    console.log(`   Último tema: ${context.lastTopic}`);
    console.log(`   Análisis: ${context.analysis || 'N/A'}`);

    // Build retry messages
    const retryFirstMessage = buildRetryFirstMessage(context);
    const retryPromptAddition = buildRetrySystemPromptAddition(context);

    console.log(`\n💬 Primer mensaje de la rellamada:`);
    console.log(`   "${retryFirstMessage}"`);

    // Check concurrency
    const activeCount = await getActiveCallCount();
    if (activeCount >= MAX_CONCURRENT_CALLS) {
        console.error(`\n🚫 Límite de concurrencia alcanzado: ${activeCount}/${MAX_CONCURRENT_CALLS}`);
        process.exit(1);
    }
    if (activeCount >= 0) {
        console.log(`\n📊 Llamadas activas: ${activeCount}/${MAX_CONCURRENT_CALLS}`);
    }

    // Get current assistant to build overrides
    console.log(`\n🚀 Lanzando rellamada a ${customerPhone}...`);

    const assistantRes = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });
    const assistant = await assistantRes.json();
    const currentPrompt = assistant.model?.messages?.[0]?.content || '';

    // Launch the call with context overrides
    const vapiRes = await fetch('https://api.vapi.ai/call', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            customer: { number: customerPhone },
            assistantId: ASSISTANT_ID,
            phoneNumberId: PHONE_NUMBER_ID,
            assistantOverrides: {
                firstMessage: retryFirstMessage,
                model: {
                    ...assistant.model,
                    messages: [
                        {
                            role: 'system',
                            content: currentPrompt + retryPromptAddition
                        }
                    ]
                },
                variableValues: {
                    nombre: context.customerName || 'Cliente',
                    empresa: previousCall.customer?.name || '',
                    tel_contacto: customerPhone
                }
            }
        })
    });

    const vapiData = await vapiRes.json();

    if (!vapiRes.ok) {
        console.error(`❌ Error de Vapi: ${vapiData.message || JSON.stringify(vapiData)}`);
        process.exit(1);
    }

    console.log(`\n✅ ¡Rellamada lanzada con éxito!`);
    console.log(`   Call ID: ${vapiData.id}`);
    console.log(`   Status: ${vapiData.status}`);

    // Log to NocoDB
    try {
        await fetch(`${NOCODB_BASE}/${CALL_LOGS_TABLE}/records`, {
            method: 'POST',
            headers: { 'xc-token': XC_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vapi_call_id: vapiData.id,
                lead_name: previousCall.customer?.name || context.customerName || 'Rellamada',
                phone_called: customerPhone,
                call_time: new Date().toISOString(),
                ended_reason: `Retry of ${previousCall.id.substring(0, 12)}...`,
                Notes: `Rellamada automática. Llamada anterior: ${previousCall.id}. Motivo corte: ${context.endedReason}. Interés previo: ${context.customerInterested ? 'Sí' : 'No determinado'}.`
            })
        });
        console.log(`   📝 Registrado en NocoDB`);
    } catch (err) {
        console.warn(`   ⚠️ Error al registrar en NocoDB: ${err.message}`);
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('🏁 Proceso completado. La rellamada está en curso.');
}

main().catch(err => {
    console.error('❌ Error fatal:', err.message);
    process.exit(1);
});

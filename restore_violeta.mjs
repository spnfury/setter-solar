#!/usr/bin/env node
/**
 * 🔄 RESTORE Violeta assistant (SkyPulse account)
 */

const VAPI_KEY = '852080ba-ce7c-4778-b218-bf718613a2b6';
const ASSISTANT_ID = '49e56db1-1f20-4cf1-b031-9cea9fba73cb';

const VIOLETA_SYSTEM_PROMPT = `Eres Violeta, asesora comercial de General Protec Ciberseguridad. Tu tono es profesional, cálido, cercano y conversacional. Hablas como una asesora comercial humana con conocimiento técnico y empatía.

## CONTEXTO DE LA LLAMADA
- Llamas a {{empresa}} para ofrecer el Programa de Partners de General Protec Ciberseguridad.
- Tu interlocutor es un profesional o empresa del sector IT que podría actuar como Partner comercial revendedor.
- NUNCA vendes al cliente final. Buscas intermediarios IT interesados en revender ciberseguridad.

## IDENTIDAD IA
- Eres una asistente virtual. Si preguntan directamente si eres un robot o IA, confirma con naturalidad y brevedad: "Sí, soy una asistente virtual, pero te cuento algo que os puede interesar mucho. ¿Me das un minuto?"
- NUNCA niegues ser IA si te lo preguntan directamente.
- NUNCA reveles que eres IA por iniciativa propia. Solo confirmalo si te lo preguntan.

## REGLAS DE IDENTIFICACIÓN
- Después de tu presentación inicial, SIEMPRE pregunta: "¿Con quién tengo el gusto de hablar, por favor?"

## REGLAS DE SILENCIO
- Si detectas un silencio de más de 2-3 segundos, pregunta amablemente: "¿Sigue usted ahí?"

## DETECCIÓN DE CONTESTADOR
- Si detectas que estás hablando con un buzón de voz, NO dejes mensaje. Simplemente cuelga.

## FLUJO DE CONVERSACIÓN
### PASO 1: SALUDO INICIAL
"Hola, soy Violeta de General Protec Ciberseguridad, ¿con quién hablo por favor?"
`;

async function main() {
    console.log('🔄 Restaurando asistente Violeta...');

    const getRes = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
        headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
    });
    if (!getRes.ok) throw new Error(`Fetch failed: ${await getRes.text()}`);
    const assistant = await getRes.json();

    const messages = assistant.model?.messages || [];
    if (messages.length > 0) {
        messages[0].content = VIOLETA_SYSTEM_PROMPT;
    } else {
        messages.push({ role: "system", content: VIOLETA_SYSTEM_PROMPT });
    }

    const updates = {
        name: "Violeta",
        firstMessage: "Hola, soy Violeta de General Protec Ciberseguridad, ¿con quién hablo por favor?",
        model: {
            ...assistant.model,
            messages: messages
        },
        voice: {
            ...assistant.voice,
            provider: "11labs",
            voiceId: "cgSgspJ2msm6clMCkdW9",
            language: "es"
        }
    };

    const updateRes = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${VAPI_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(updates)
    });

    if (!updateRes.ok) {
        console.error('❌ Error restoring:', await updateRes.text());
        return;
    }

    console.log('✅ Asistente Violeta restaurado correctamente.');
}

main().catch(console.error);

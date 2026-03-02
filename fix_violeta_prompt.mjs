#!/usr/bin/env node
/**
 * fix_violeta_prompt.mjs
 * 
 * Fixes Violeta's prompt based on analysis of call 019c56f5-9ce2-7996-875e-1738f308c58f:
 * 
 * 1. ✅ Fix "¿Diga?" handling — don't repeat full pitch when customer says "diga"
 * 2. ✅ Improve interest capture — when customer says "interesa", go straight to value
 * 3. ✅ Keep responses short to avoid being cut off
 * 4. ✅ Fix identification rules (conflict between old and new sections)
 * 5. ✅ Update firstMessage to be cleaner
 * 6. ✅ Fix company name: "General Protec Ciberseguridad" (consistent)
 */

const VAPI_API_KEY = '852080ba-ce7c-4778-b218-bf718613a2b6';
const ASSISTANT_ID = '49e56db1-1f20-4cf1-b031-9cea9fba73cb';

async function getAssistant() {
    const res = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });
    if (!res.ok) throw new Error(`Failed to get assistant: ${res.status} ${await res.text()}`);
    return res.json();
}

async function updateAssistant(updates) {
    const res = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(updates)
    });
    if (!res.ok) throw new Error(`Failed to update: ${res.status} ${await res.text()}`);
    return res.json();
}

async function main() {
    console.log('📡 Obteniendo configuración actual de Violeta...\n');
    const assistant = await getAssistant();

    const currentPrompt = assistant.model?.messages?.[0]?.content || '';
    const currentFirstMessage = assistant.firstMessage || '';

    console.log('📝 firstMessage actual:');
    console.log(`   "${currentFirstMessage}"`);
    console.log(`\n📝 Prompt actual: ${currentPrompt.length} caracteres`);
    console.log('─'.repeat(60));

    // === 1. Fix the base prompt — remove duplicated/conflicting sections ===

    // Remove the old appended sections (added by update_vapi_assistant.mjs)
    // They conflict with the existing rules in the prompt
    let newPrompt = currentPrompt;

    // Remove the old appended "REGLAS DE IDENTIFICACIÓN" section and everything after it
    // since they were appended and conflict with existing rules
    const oldAppendedIdx = newPrompt.indexOf('\n\n## REGLAS DE IDENTIFICACIÓN');
    if (oldAppendedIdx > 0) {
        newPrompt = newPrompt.substring(0, oldAppendedIdx);
        console.log('🔧 Eliminada sección duplicada de REGLAS DE IDENTIFICACIÓN');
    }

    // === 2. Add improved rules integrated into the prompt ===

    const improvedRules = `

## RESPUESTA AL "¿DIGA?" O "¿SÍ?" INICIAL (MUY IMPORTANTE)
- Si el cliente contesta con "¿Diga?", "¿Sí?", "¿Quién es?", "Dígame", etc., significa que está al teléfono pero NO escuchó tu presentación, o es su forma de contestar.
- En ese caso, NO repitas el speech completo. Da una versión ULTRA CORTA:
  "Hola, soy Violeta de General Protec Ciberseguridad. Te llamo para presentarte nuestro programa de partners. ¿Tienes un minuto?"
- Si el cliente contesta con un "Hola", "Sí, dime", o similar que indica que SÍ escuchó todo, continúa con la conversación normalmente.

## CAPTURA RÁPIDA DE INTERÉS (MUY IMPORTANTE)
- Si el cliente dice "Interesa", "Me interesa", "Suena bien", "Cuéntame más", o cualquier señal de interés POSITIVA:
  1. NO hagas preguntas genéricas. Pasa DIRECTO a dar valor concreto.
  2. Responde algo como: "¡Perfecto! Básicamente tú presentas ciberseguridad a tus clientes, nosotros lo gestionamos todo, y tú cobras una comisión recurrente. ¿Quieres que te envíe toda la información por email?"
  3. Si dicen sí, recoge el email inmediata y concisamente.
- El objetivo es NO perder la ventana de interés con preguntas que alargan la conversación innecesariamente.

## REGLAS DE IDENTIFICACIÓN
- Tras presentarte y confirmar que tienen un minuto, pregunta: "¿Con quién tengo el gusto de hablar?"
- Si no se identifica, insiste UNA vez: "Perdone, ¿me podría indicar su nombre?"
- Si no se identifica, continúa la conversación con "usted".

## REGLAS DE SILENCIO
- Si detectas un silencio REAL de más de 5 segundos, pregunta: "¿Sigue usted ahí?"
- Si tras tu pregunta hay otro silencio de 5 segundos, despídete: "Parece que hemos perdido la comunicación. Le llamaremos en otro momento. ¡Hasta luego!" y cuelga.
- IMPORTANTE: NO preguntes "¿Sigues ahí?" si el usuario acaba de hablar o estar interactuando. Solo en silencio REAL.

## DETECCIÓN DE CONTESTADOR
- Si detectas buzón de voz, contestador automático, o mensaje grabado, cuelga inmediatamente sin decir nada.

## LONGITUD DE MENSAJES (CRÍTICO)
- Mantén TODOS tus mensajes en máximo 2 frases cortas.
- Si necesitas dar más información, divídela en turnos de conversación.
- El cliente puede interrumpirte si tus mensajes son demasiado largos. Mejor ser breve y que pregunte más.`;

    newPrompt = newPrompt + improvedRules;

    // === 3. Fix the firstMessage to be cleaner ===
    const newFirstMessage = 'Hola, soy Violeta de General Protec Ciberseguridad. Te contacto porque tenemos un programa de partners para empresas IT que quieran añadir ciberseguridad a su catálogo y generar ingresos recurrentes. ¿Tienes un minuto?';

    console.log('\n🔧 Cambios a aplicar:');
    console.log(`   ✅ Prompt: ${currentPrompt.length} → ${newPrompt.length} caracteres`);
    console.log(`   ✅ firstMessage actualizado (más limpio);`);
    console.log(`   ✅ Regla "¿Diga?" añadida`);
    console.log(`   ✅ Captura rápida de interés añadida`);
    console.log(`   ✅ Reglas de silencio mejoradas (5s en vez de 2-3s)`);
    console.log(`   ✅ Límite de longitud de mensajes reforzado`);

    // Build update
    const updates = {
        firstMessage: newFirstMessage,
        model: {
            ...assistant.model,
            messages: assistant.model.messages.map((msg, i) =>
                i === 0 ? { ...msg, content: newPrompt } : msg
            )
        },
        // Increase waitSeconds slightly so we don't start talking before customer picks up
        startSpeakingPlan: {
            waitSeconds: 1.5,
            smartEndpointingPlan: { provider: "vapi" }
        }
    };

    console.log('\n🚀 Aplicando cambios...');
    const result = await updateAssistant(updates);

    console.log('\n✅ ¡Violeta actualizada con éxito!');
    console.log(`   firstMessage: "${result.firstMessage}"`);
    console.log(`   startSpeakingPlan.waitSeconds: ${result.startSpeakingPlan?.waitSeconds}`);

    console.log('\n📝 Prompt completo actualizado:');
    console.log('─'.repeat(80));
    const updatedPrompt = result.model?.messages?.[0]?.content || '';
    console.log(updatedPrompt);
    console.log('─'.repeat(80));
    console.log(`\nTotal: ${updatedPrompt.length} caracteres`);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});

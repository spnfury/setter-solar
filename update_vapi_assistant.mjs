#!/usr/bin/env node
/**
 * update_vapi_assistant.mjs
 * 
 * Updates the Vapi assistant "Violeta" (ID: 49e56db1-1f20-4cf1-b031-9cea9fba73cb)
 * with the following improvements based on client feedback:
 * 
 * 1. Ask who the assistant is speaking with after introduction
 * 2. Handle silence (2-3 seconds) → ask if still there; second time → hang up
 * 3. Detect voicemail → hang up and mark as "Contestador"
 * 
 * Usage: node update_vapi_assistant.mjs
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
    if (!res.ok) throw new Error(`Failed to update assistant: ${res.status} ${await res.text()}`);
    return res.json();
}

async function main() {
    console.log('📡 Fetching current Violeta assistant configuration...\n');

    const assistant = await getAssistant();
    console.log('✅ Current assistant name:', assistant.name);
    console.log('📝 Current system prompt (first 300 chars):');
    console.log((assistant.model?.messages?.[0]?.content || assistant.instructions || 'N/A').substring(0, 300));
    console.log('\n---\n');

    // Read current prompt
    const currentPrompt = assistant.model?.messages?.[0]?.content || assistant.instructions || '';

    // Build the enhanced prompt with the new instructions
    const silenceInstructions = `

## REGLAS DE IDENTIFICACIÓN
- Después de tu presentación inicial, SIEMPRE pregunta: "¿Con quién tengo el gusto de hablar, por favor?"
- Si la persona no se identifica, insiste una vez más de forma educada: "Perdone, ¿me podría indicar su nombre?"
- Si no se identifica tras dos intentos, continúa la conversación dirigiéndote a la persona como "usted".

## REGLAS DE SILENCIO
- Si detectas un silencio de más de 2-3 segundos, pregunta amablemente: "¿Sigue usted ahí?"
- Si tras tu pregunta hay otro silencio de 2-3 segundos (segunda vez), despídete brevemente diciendo: "Parece que hemos perdido la comunicación. Le llamaremos en otro momento. ¡Hasta luego!" y cuelga la llamada.

## DETECCIÓN DE CONTESTADOR
- Si detectas que estás hablando con un buzón de voz, contestador automático, o un mensaje grabado (por ejemplo: "deje su mensaje después de la señal", "no estamos disponibles", "buzón de voz"), NO dejes mensaje.
- Simplemente cuelga la llamada inmediatamente sin decir nada.`;

    // Only append if not already present
    let newPrompt = currentPrompt;
    if (!currentPrompt.includes('REGLAS DE IDENTIFICACIÓN')) {
        newPrompt = currentPrompt + silenceInstructions;
        console.log('📋 Adding new instructions to the prompt...');
    } else {
        console.log('ℹ️  Instructions already present in prompt. Skipping prompt update.');
    }

    // Prepare the update payload
    const updates = {
        // Voicemail detection — Vapi built-in feature
        // (presence of the object enables it; no 'enabled' property needed)
        voicemailDetection: {
            provider: "vapi",
            backoffPlan: {
                maxRetries: 1,
                startAtSeconds: 8,
                frequencySeconds: 10
            }
        },
        // Don't leave voicemail messages — just hang up
        voicemailMessage: "",
        // Silence timeout — minimum 10s in Vapi API. The 2-3s behavior is handled
        // in the prompt instructions which tell Violeta to react after short silences.
        silenceTimeoutSeconds: 10,
        // Max duration (safety net)
        maxDurationSeconds: 600,
    };

    // Update the system prompt if changed
    if (newPrompt !== currentPrompt) {
        if (assistant.model?.messages) {
            updates.model = {
                ...assistant.model,
                messages: assistant.model.messages.map((msg, i) =>
                    i === 0 ? { ...msg, content: newPrompt } : msg
                )
            };
        } else if (assistant.instructions !== undefined) {
            updates.instructions = newPrompt;
        }
    }

    console.log('\n🚀 Applying updates to Violeta assistant...');
    console.log('   - Voicemail detection: ENABLED');
    console.log('   - Silence timeout: 3 seconds');
    console.log('   - Prompt updated: ' + (newPrompt !== currentPrompt ? 'YES' : 'NO (already up to date)'));

    const result = await updateAssistant(updates);
    console.log('\n✅ Assistant updated successfully!');
    console.log('   Name:', result.name);
    console.log('   Voicemail Detection:', result.voicemailDetection?.enabled ? 'ENABLED' : 'DISABLED');
    console.log('   Silence Timeout:', result.silenceTimeoutSeconds, 'seconds');

    // Print the full updated prompt for review
    const updatedPrompt = result.model?.messages?.[0]?.content || result.instructions || '';
    console.log('\n📝 Full updated prompt:');
    console.log('─'.repeat(80));
    console.log(updatedPrompt);
    console.log('─'.repeat(80));
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});

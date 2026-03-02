#!/usr/bin/env node
/**
 * fix_general_protec_name.mjs
 * 
 * Updates ALL mentions of "GeneralProtec" in the Vapi assistant "Violeta"
 * to "General Protec Ciberseguridad" — both in the firstMessage and the system prompt.
 */

const VAPI_API_KEY = '852080ba-ce7c-4778-b218-bf718613a2b6';
const ASSISTANT_ID = '49e56db1-1f20-4cf1-b031-9cea9fba73cb';

async function main() {
    console.log('📡 Fetching current Violeta assistant configuration...\n');

    // 1. Fetch current assistant
    const res = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });
    if (!res.ok) throw new Error(`Failed to get assistant: ${res.status} ${await res.text()}`);
    const assistant = await res.json();

    const currentPrompt = assistant.model?.messages?.[0]?.content || '';
    const currentFirstMessage = assistant.firstMessage || '';

    // 2. Fix firstMessage
    const newFirstMessage = currentFirstMessage
        .replace(/GeneralProtec Ciberseguridad/g, '<<KEEP>>')
        .replace(/GeneralProtec/g, 'General Protec Ciberseguridad')
        .replace(/<<KEEP>>/g, 'General Protec Ciberseguridad');

    // 3. Fix system prompt — replace all "GeneralProtec" with "General Protec Ciberseguridad"
    //    while keeping already-correct instances intact
    const newPrompt = currentPrompt
        .replace(/GeneralProtec Ciberseguridad/g, '<<KEEP>>')
        .replace(/GeneralProtec/g, 'General Protec Ciberseguridad')
        .replace(/<<KEEP>>/g, 'General Protec Ciberseguridad');

    // Show changes
    console.log('=== FIRST MESSAGE ===');
    console.log('BEFORE:', currentFirstMessage);
    console.log('AFTER: ', newFirstMessage);
    console.log('');

    const promptBefore = (currentPrompt.match(/GeneralProtec/g) || []).length;
    const alreadyCorrect = (currentPrompt.match(/GeneralProtec Ciberseguridad/g) || []).length;
    console.log('=== PROMPT STATS ===');
    console.log(`Total "GeneralProtec" in prompt: ${promptBefore}`);
    console.log(`Already "GeneralProtec Ciberseguridad": ${alreadyCorrect}`);
    console.log(`To be fixed: ${promptBefore - alreadyCorrect}`);

    // 4. Build update payload
    const updates = {
        firstMessage: newFirstMessage,
    };

    if (assistant.model?.messages) {
        updates.model = {
            ...assistant.model,
            messages: assistant.model.messages.map((msg, i) =>
                i === 0 ? { ...msg, content: newPrompt } : msg
            )
        };
    }

    // 5. Apply update
    console.log('\n🚀 Applying updates...');
    const res2 = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(updates)
    });

    if (!res2.ok) {
        throw new Error(`Failed to update: ${res2.status} ${await res2.text()}`);
    }

    const result = await res2.json();
    console.log('\n✅ Assistant updated successfully!');
    console.log('Updated firstMessage:', result.firstMessage);

    // 6. Verify
    const updatedPrompt = result.model?.messages?.[0]?.content || '';
    const correctCount = (updatedPrompt.match(/General Protec Ciberseguridad/g) || []).length;
    const badRemaining = updatedPrompt.match(/GeneralProtec(?! Ciberseguridad)/g) || [];

    console.log(`\n📊 Verification:`);
    console.log(`   "General Protec Ciberseguridad" occurrences: ${correctCount}`);
    console.log(`   Uncorrected remaining: ${badRemaining.length}`);

    if (badRemaining.length > 0) {
        console.log('   ⚠️  Some occurrences were not fixed!');
    } else {
        console.log('   ✅ All occurrences are correct!');
    }
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});

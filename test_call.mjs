#!/usr/bin/env node
const VAPI_API_KEY = '852080ba-ce7c-4778-b218-bf718613a2b6';
const ASSISTANT_ID = '49e56db1-1f20-4cf1-b031-9cea9fba73cb';
const PHONE_NUMBER_ID = '611c8c8e-ab43-4af0-8df0-f2f8fac8115b';

const phone = process.argv[2] || '+34666532143';

async function main() {
    console.log(`📞 Lanzando llamada de prueba a ${phone}...`);
    const res = await fetch('https://api.vapi.ai/call', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            assistantId: ASSISTANT_ID,
            phoneNumberId: PHONE_NUMBER_ID,
            customer: { number: phone }
        })
    });
    const data = await res.json();
    if (!res.ok) {
        console.error('❌ Error:', data.message || JSON.stringify(data));
    } else {
        console.log('✅ Llamada lanzada!');
        console.log('   Call ID:', data.id);
        console.log('   Status:', data.status);
    }
}
main().catch(e => console.error('❌', e.message));

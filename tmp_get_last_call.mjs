const VAPI_KEY = '0594f41c-e836-425d-aaa2-1c5b7d9e506e';
const ASSISTANT_ID = 'f3359bb0-7bc4-45c7-9a02-ca4793cc5d48';

async function main() {
    const res = await fetch(`https://api.vapi.ai/call?assistantId=${ASSISTANT_ID}&limit=1`, {
        headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
    });
    const calls = await res.json();
    if (calls.length > 0) {
        const call = calls[0];
        console.log("Call ID:", call.id);
        console.log("Status:", call.status);
        console.log("Started At:", call.createdAt);
        console.log("Transcript:");
        console.log(call.transcript || "No transcript");
        console.log("Messages:");
        if (call.messages) {
             call.messages.filter(m => m.type === 'transcript').forEach(m => console.log(m.role + ": " + m.transcript));
        }
    } else {
        console.log("No calls found");
    }
}
main();

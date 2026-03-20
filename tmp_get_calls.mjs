

const VAPI_KEY = '0594f41c-e836-425d-aaa2-1c5b7d9e506e';
const ASSISTANT_ID = 'f3359bb0-7bc4-45c7-9a02-ca4793cc5d48';

async function main() {
    const res = await fetch(`https://api.vapi.ai/call?assistantId=${ASSISTANT_ID}&limit=5`, {
        headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
    });
    const data = await res.json();
    for (const call of data) {
        console.log("--------------------------------------------------");
        console.log(`Call ID: ${call.id}`);
        console.log(`Status: ${call.status}`);
        console.log(`Transcript:`);
        console.log(call.transcript);
        if (call.analysis && call.analysis.summary) {
            console.log(`Summary: ${call.analysis.summary}`);
        }
    }
}
main().catch(console.error);

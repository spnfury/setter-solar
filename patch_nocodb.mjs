// patch_nocodb.mjs — Update Vapi Phone Number ID in NocoDB users table

const API_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const USERS_TABLE_ID = 'mkb040wimke95sl';
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';
const OLD_ID = '55e3868d-ab44-435e-a864-4dcd5b52636d';
const NEW_ID = 'ee153e9d-ece6-4469-a634-70eaa6e083c4';

async function patchUsers() {
    console.log('Fetching users from NocoDB...');
    const url = `${API_BASE}/${USERS_TABLE_ID}/records`;
    
    const res = await fetch(url, {
        headers: { 'xc-token': XC_TOKEN }
    });
    
    if (!res.ok) {
        console.error('Failed to fetch:', res.status, await res.text());
        return;
    }
    
    const data = await res.json();
    const users = data.list || [];
    console.log(`Found ${users.length} users.`);
    
    for (const u of users) {
        if (u['Vapi Phone Number ID'] === OLD_ID) {
            console.log(`Patching user ${u['Email']}...`);
            const patchRes = await fetch(url, {
                method: 'PATCH',
                headers: {
                    'xc-token': XC_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    Id: u.Id,
                    'Vapi Phone Number ID': NEW_ID
                })
            });
            
            if (patchRes.ok) {
                console.log(`Successfully patched user ${u['Email']}.`);
            } else {
                console.error(`Failed to patch user ${u['Email']}:`, await patchRes.text());
            }
        } else {
             console.log(`Skipping user ${u['Email']}, already matches or different.`);
        }
    }
}

patchUsers();

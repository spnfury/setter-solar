/**
 * preflight_check.mjs
 * 
 * Safety mechanism for AI calls. Verifies that calls:
 * 1. Are placed within business hours (09:00 - 20:00 Madrid time)
 * 2. Do not exceed the maximum daily limit to protect balance
 * 3. Do not exceed maximum concurrency on Vapi
 */


const NOCODB_BASE = 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables';
const CALL_LOGS_TABLE = 'm73w58ba47ifkrx';
const XC_TOKEN = 'vodwktZQ77mth3XeK290Fw8V9Axloe1LiOxsWn5d';
const VAPI_API_KEY = '0594f41c-e836-425d-aaa2-1c5b7d9e506e';

const CONFIG = {
    MAX_DAILY_CALLS: 200,      // Kill-switch: maximum calls per day allowed
    MAX_CONCURRENCY: 10,       // Max simultaneous calls on Vapi trunk
    BUSINESS_HOURS: {
        START: 9,              // 09:00
        END: 20                // 20:59 is the last allowed minute before 21:00
    }
};

/**
 * Validates business hours in Europe/Madrid timezone
 */
function checkBusinessHours() {
    const nowMadrid = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const currentHour = nowMadrid.getHours();
    
    if (currentHour < CONFIG.BUSINESS_HOURS.START || currentHour > CONFIG.BUSINESS_HOURS.END) {
        return {
            passed: false,
            reason: `Fuera de horario comercial. Hora actual: ${currentHour}:00 (Permitido: ${CONFIG.BUSINESS_HOURS.START}:00 - ${CONFIG.BUSINESS_HOURS.END}:59)`
        };
    }
    return { passed: true };
}

/**
 * Checks how many calls have been placed today against NocoDB
 */
async function checkDailyLimit() {
    try {
        // Get today's date boundary in UTC
        const nowMadrid = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
        const todayStr = `${nowMadrid.getFullYear()}-${String(nowMadrid.getMonth() + 1).padStart(2, '0')}-${String(nowMadrid.getDate()).padStart(2, '0')}`;
        
        // This regex/where clause fetches calls created today
        const url = `${NOCODB_BASE}/${CALL_LOGS_TABLE}/records?limit=1&where=(CreatedAt,like,${todayStr}%)`;
        
        const res = await fetch(url, { headers: { 'xc-token': XC_TOKEN } });
        if (!res.ok) {
            console.error('⚠️ Warning: No se pudo verificar el límite diario en NocoDB.');
            return { passed: true }; // Allow if DB is down transiently, but warn
        }
        
        const data = await res.json();
        const callsToday = data.pageInfo?.totalRows || 0;
        
        if (callsToday >= CONFIG.MAX_DAILY_CALLS) {
            return {
                passed: false,
                reason: `Límite diario superado. Se han realizado ${callsToday} llamadas hoy (Máximo: ${CONFIG.MAX_DAILY_CALLS}).`
            };
        }
        
        return { passed: true, currentCalls: callsToday };
    } catch (err) {
        console.error(`⚠️ Warning: Error verificando límite diario: ${err.message}`);
        return { passed: true };
    }
}

/**
 * Checks Vapi for currently active calls to respect concurrency limits
 */
async function checkConcurrency() {
    try {
        const res = await fetch('https://api.vapi.ai/call?limit=100', {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        
        if (!res.ok) {
             console.error('⚠️ Warning: No se pudo verificar la concurrencia en Vapi.');
             return { passed: true }; 
        }
        
        const calls = await res.json();
        const activeCalls = (Array.isArray(calls) ? calls : []).filter(c => 
            ['queued', 'ringing', 'in-progress'].includes(c.status)
        );
        
        if (activeCalls.length >= CONFIG.MAX_CONCURRENCY) {
            return {
                passed: false,
                reason: `Límite de concurrencia alcanzado. Hay ${activeCalls.length} llamadas activas (Máximo: ${CONFIG.MAX_CONCURRENCY}).`
            };
        }
        
        return { passed: true, activeCalls: activeCalls.length };
    } catch (err) {
        console.error(`⚠️ Warning: Error verificando concurrencia: ${err.message}`);
        return { passed: true };
    }
}

/**
 * Runs all protection checks. 
 * Use this before dispatching any call in automation scripts.
 */
export async function runPreflightChecks(options = { requireAll: true }) {
    console.log('🛡️  Ejecutando comprobaciones de seguridad automáticas (Preflight)...');
    
    // 1. Business Hours Check
    const timeCheck = checkBusinessHours();
    if (!timeCheck.passed) {
        console.error(`❌ BLOQUEO DE SEGURIDAD: ${timeCheck.reason}`);
        return { allowed: false, reason: timeCheck.reason };
    }
    console.log('   ✅ Horario comercial permitido.');

    // 2. Daily Limit Check
    const limitCheck = await checkDailyLimit();
    if (!limitCheck.passed) {
        console.error(`❌ BLOQUEO DE SEGURIDAD: ${limitCheck.reason}`);
        return { allowed: false, reason: limitCheck.reason };
    }
    console.log(`   ✅ Límite diario seguro (${limitCheck.currentCalls || 0}/${CONFIG.MAX_DAILY_CALLS} llamadas hoy).`);

    // 3. Concurrency Check (Optional if the caller handles its own concurrency queue)
    if (options.requireAll) {
        const concurrencyCheck = await checkConcurrency();
        if (!concurrencyCheck.passed) {
            console.error(`❌ BLOQUEO DE SEGURIDAD: ${concurrencyCheck.reason}`);
            return { allowed: false, reason: concurrencyCheck.reason };
        }
        console.log(`   ✅ Concurrencia segura (${concurrencyCheck.activeCalls || 0}/${CONFIG.MAX_CONCURRENCY} activas).`);
    }

    console.log('   🟢 Todo en verde. Llamadas autorizadas.\n');
    return { allowed: true };
}

// Allow running as a standalone script for testing
if (import.meta.url === `file://${process.argv[1]}`) {
    runPreflightChecks().then(res => {
        if (!res.allowed) process.exit(1);
    });
}

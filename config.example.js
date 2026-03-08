// ── Setter Solar — App Configuration Template ──
// Copy this file to config.js and fill in your actual API keys.
// config.js is gitignored and will NOT be committed.
//
// ⚠️ SECURITY NOTE: These keys are loaded in the browser.
// For production, consider moving API calls to a backend/serverless function.
window.APP_CONFIG = {
    // NocoDB: base URL de tu instancia
    API_BASE: 'https://YOUR_NOCODB_INSTANCE/api/v2/tables',
    // IDs de las tablas en NocoDB (Solar)
    LEADS_TABLE: 'YOUR_LEADS_TABLE_ID',        // Tabla principal de leads solares
    CALL_LOGS_TABLE: 'YOUR_CALL_LOGS_TABLE_ID',   // Historial de llamadas
    CONFIRMED_TABLE: 'YOUR_CONFIRMED_TABLE_ID',   // Leads con cita confirmada
    XC_TOKEN: 'YOUR_NOCODB_TOKEN_HERE',
    // Vapi: asistente IA para placas solares
    VAPI_API_KEY: 'YOUR_VAPI_API_KEY_HERE',       // private key
    VAPI_PUBLIC_KEY: 'YOUR_VAPI_PUBLIC_KEY_HERE',  // public key
    VAPI_ASSISTANT_ID: 'YOUR_SOLAR_ASSISTANT_ID',  // Asistente creado para solar
    VAPI_PHONE_NUMBER_ID: 'YOUR_PHONE_NUMBER_ID',
    // Zadarma: SIP trunk para llamadas salientes via callback API
    ZADARMA_KEY: 'YOUR_ZADARMA_KEY_HERE',
    ZADARMA_SECRET: 'YOUR_ZADARMA_SECRET_HERE',
    ZADARMA_FROM_NUMBER: 'YOUR_ZADARMA_FROM_NUMBER',
    // OpenAI (para informes diarios y diagnóstico IA)
    OPENAI_API_KEY: 'YOUR_OPENAI_API_KEY_HERE',
    // Contraseña de acceso al dashboard
    DASHBOARD_PASSWORD: 'your_password_here',
};

// ── Setter Solar — App Configuration Template ──
// Copy this file to config.js and fill in your actual API keys.
// config.js is gitignored and will NOT be committed.
window.APP_CONFIG = {
    // NocoDB: base URL de tu instancia
    API_BASE: 'https://YOUR_NOCODB_INSTANCE/api/v2/tables',
    // IDs de las tablas en NocoDB (Solar)
    LEADS_TABLE: 'YOUR_LEADS_TABLE_ID',        // Tabla principal de leads solares
    CALL_LOGS_TABLE: 'YOUR_CALL_LOGS_TABLE_ID',   // Historial de llamadas
    CONFIRMED_TABLE: 'YOUR_CONFIRMED_TABLE_ID',   // Leads con cita confirmada
    XC_TOKEN: 'YOUR_NOCODB_TOKEN_HERE',
    // Vapi: asistente IA para placas solares
    VAPI_API_KEY: 'YOUR_VAPI_API_KEY_HERE',
    VAPI_ASSISTANT_ID: 'YOUR_SOLAR_ASSISTANT_ID', // ← Asistente creado para solar
    // OpenAI (para informes diarios y diagnóstico IA)
    OPENAI_API_KEY: 'YOUR_OPENAI_API_KEY_HERE',
    // Contraseña de acceso al dashboard
    DASHBOARD_PASSWORD: 'solar2025',
};

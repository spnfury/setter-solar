#!/usr/bin/env node
// ── Generate config.js at build time from environment variables ──
// Used by Vercel during deployment. Locally, config.js is used directly.
import { writeFileSync, existsSync, mkdirSync } from 'fs';

const distDir = 'dist';
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

const env = (key, fallback = '') => (process.env[key] || fallback).trim();

const config = {
    API_BASE: env('API_BASE', 'https://optima-nocodb.vhsxer.easypanel.host/api/v2/tables'),
    LEADS_TABLE: env('LEADS_TABLE', 'mf0wzufqcpi3bd1'),
    CALL_LOGS_TABLE: env('CALL_LOGS_TABLE', 'm73w58ba47ifkrx'),
    CONFIRMED_TABLE: env('CONFIRMED_TABLE', 'mh4cvunsnskuu4b'),
    ERROR_LOGS_TABLE: env('ERROR_LOGS_TABLE', 'myfvnvb1zo7b6rh'),
    XC_TOKEN: env('XC_TOKEN'),
    VAPI_API_KEY: env('VAPI_API_KEY'),
    VAPI_PUBLIC_KEY: env('VAPI_PUBLIC_KEY'),
    VAPI_ASSISTANT_ID: env('VAPI_ASSISTANT_ID', 'f3359bb0-7bc4-45c7-9a02-ca4793cc5d48'),
    VAPI_PHONE_NUMBER_ID: env('VAPI_PHONE_NUMBER_ID', 'b3b47ab7-b74b-46b9-bf72-0f82d6731f56'),
    ZADARMA_KEY: env('ZADARMA_KEY'),
    ZADARMA_SECRET: env('ZADARMA_SECRET'),
    ZADARMA_FROM_NUMBER: env('ZADARMA_FROM_NUMBER', '34953977139'),
    OPENAI_API_KEY: env('OPENAI_API_KEY'),
    DASHBOARD_PASSWORD: env('DASHBOARD_PASSWORD', 'solar2025'),
};

const content = `// Auto-generated at build time — do NOT edit
window.APP_CONFIG = ${JSON.stringify(config, null, 4)};
`;

writeFileSync(`${distDir}/config.js`, content, 'utf-8');
console.log('✅ config.js generated in dist/ with', Object.keys(config).length, 'keys');

// Verify critical keys
const missing = ['XC_TOKEN', 'VAPI_API_KEY'].filter(k => !config[k]);
if (missing.length > 0) {
    console.warn('⚠️  WARNING: Missing critical env vars:', missing.join(', '));
    console.warn('   The dashboard will NOT work without these. Set them in Vercel Environment Variables.');
}

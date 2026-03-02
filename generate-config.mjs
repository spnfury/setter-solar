#!/usr/bin/env node
// ── Generate config.js at build time from environment variables ──
// Used by Vercel during deployment. Locally, config.js is used directly.
import { writeFileSync, existsSync, mkdirSync } from 'fs';

const distDir = 'dist';
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

const env = (key, fallback = '') => (process.env[key] || fallback).trim();

const config = {
    API_BASE: env('API_BASE', 'https://nocodb.srv889387.hstgr.cloud/api/v2/tables'),
    CALL_LOGS_TABLE: env('CALL_LOGS_TABLE', 'm013en5u2cyu30j'),
    CONFIRMED_TABLE: env('CONFIRMED_TABLE', 'mtoilizta888pej'),
    XC_TOKEN: env('XC_TOKEN'),
    VAPI_API_KEY: env('VAPI_API_KEY'),
    OPENAI_API_KEY: env('OPENAI_API_KEY'),
};

const content = `// Auto-generated at build time — do NOT edit
window.APP_CONFIG = ${JSON.stringify(config, null, 4)};
`;

writeFileSync(`${distDir}/config.js`, content, 'utf-8');
console.log('✅ config.js generated in dist/');

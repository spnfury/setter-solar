import { defineConfig } from 'vite'
import crypto from 'crypto'

// Zadarma API signing (Node.js side — avoids CORS and browser crypto issues)
function zadarmaSign(method, params, secret) {
    const paramStr = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const md5 = crypto.createHash('md5').update(paramStr).digest('hex');
    const sha1hex = crypto.createHmac('sha1', secret).update(method + paramStr + md5).digest('hex');
    return { paramStr, sign: Buffer.from(sha1hex).toString('base64') };
}

// Vite plugin: add /api/zadarma-callback server-side endpoint
const zadarmaPlugin = {
    name: 'zadarma-proxy',
    configureServer(server) {
        server.middlewares.use('/api/zadarma-callback', async (req, res) => {
            const url = new URL(req.url, 'http://localhost');
            const from = url.searchParams.get('from');
            const to = url.searchParams.get('to');
            const key = url.searchParams.get('key');
            const secret = url.searchParams.get('secret');

            if (!from || !to || !key || !secret) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: 'error', message: 'Missing params: from, to, key, secret' }));
            }

            const method = '/v1/request/callback/';
            const params = { from, to };
            const { paramStr, sign } = zadarmaSign(method, params, secret);

            const zadarmaUrl = `https://api.zadarma.com${method}?${paramStr}`;
            try {
                const zadarmaRes = await fetch(zadarmaUrl, {
                    headers: { 'Authorization': `${key}:${sign}` }
                });
                const data = await zadarmaRes.json();
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(data));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: e.message }));
            }
        });
    }
};

export default defineConfig({
    plugins: [zadarmaPlugin],
    server: {
        proxy: {
            '/vapi-api': {
                target: 'https://api.vapi.ai',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/vapi-api/, '')
            },
            '/nocodb-api': {
                target: 'https://optima-nocodb.vhsxer.easypanel.host',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/nocodb-api/, '')
            }
        }
    }
})


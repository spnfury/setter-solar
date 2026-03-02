import { defineConfig } from 'vite'

export default defineConfig({
    server: {
        proxy: {
            '/vapi-api': {
                target: 'https://api.vapi.ai',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/vapi-api/, '')
            }
        }
    }
})

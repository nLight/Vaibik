import { defineConfig } from 'vite';

export default defineConfig({
    root: 'ui',
    clearScreen: false,
    server: {
        port: 5173,
        strictPort: true,
        host: '127.0.0.1'
    },
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        target: 'safari16',
        assetsInlineLimit: 0
    },
    envPrefix: ['VITE_', 'TAURI_ENV_']
});
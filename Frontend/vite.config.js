import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    envPrefix: "VITE_", 
    server: {
        host: "localhost",
        port: 5173, // Set the port to 5173
        strictPort: false,
        
        proxy: {
            '/api': {
                target: 'http://localhost:3001', // Your backend URL
                changeOrigin: true,
                secure: false,
            },
        },
    },
    css: {
        preprocessorOptions: {
            scss: {
                api: 'modern-compiler',
                silenceDeprecations: ['mixed-decls', 'color-functions', 'global-builtin', 'import'],
            },
        },
    },
});
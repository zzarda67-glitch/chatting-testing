import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        port: 5173,
        strictPort: false,
        // Use the same origin as the chat app: /admin and /api are served by Express (port 3000).
        proxy: {
            '/api': { target: 'http://localhost:3000', changeOrigin: true },
            '/admin': { target: 'http://localhost:3000', changeOrigin: true },
            '/uploads': { target: 'http://localhost:3000', changeOrigin: true },
            '/login': { target: 'http://localhost:3000', changeOrigin: true },
            '/register': { target: 'http://localhost:3000', changeOrigin: true },
            '/socket.io': { target: 'http://localhost:3000', changeOrigin: true, ws: true }
        }
    }
});

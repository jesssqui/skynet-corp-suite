import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite on :5173 proxies /api to the suite server on :3100.
// Build: static files in dist/, served by the server in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // changeOrigin off: the server checks that a request's Origin matches the Host it was sent to
      // (cross-site request protection), so the Host must stay localhost:5173 like the page.
      '/api': { target: 'http://127.0.0.1:3100', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    // Older iPhones on the home screen: keep the output conservative.
    target: ['es2020', 'safari14'],
    cssTarget: 'safari14',
  },
});

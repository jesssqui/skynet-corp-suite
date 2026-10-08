import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Writes dist/sw.js (the service worker, src/sw/service-worker.js) with the list of every file
 * this build produced and a version hashed from their contents, so the home-screen app can
 * open offline and a new build is noticed as an update. Build only: there is no service
 * worker in development (Vite's dev server would fight it).
 */
function serviceWorker() {
  let outDir;
  let root;
  return {
    name: 'suite-service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!fs.existsSync(path.join(outDir, 'index.html'))) return; // the build failed
      const files = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name !== 'sw.js' && entry.name !== '.DS_Store') files.push(full);
        }
      };
      walk(outDir);
      const source = fs.readFileSync(path.join(root, 'src', 'sw', 'service-worker.js'), 'utf8');
      const hash = crypto.createHash('sha256');
      hash.update(source); // a change to the worker alone is a new version too
      const urls = files
        .map((full) => ({ full, url: `/${path.relative(outDir, full).split(path.sep).join('/')}` }))
        .sort((a, b) => (a.url < b.url ? -1 : 1));
      for (const { full, url } of urls) {
        hash.update(url);
        hash.update('\0');
        hash.update(fs.readFileSync(full));
      }
      const manifest = { version: hash.digest('hex').slice(0, 16), files: urls.map((u) => u.url) };
      const marker = 'const MANIFEST = self.__SUITE_PRECACHE__;';
      if (source.split(marker).length !== 2) throw new Error(`service-worker.js must contain "${marker}" exactly once`);
      fs.writeFileSync(path.join(outDir, 'sw.js'), source.replace(marker, `const MANIFEST = ${JSON.stringify(manifest)};`));
    },
  };
}

// Dev: Vite on :5173 proxies /api to the suite server on :3100.
// Build: static files in dist/, served by the server in production.
export default defineConfig({
  plugins: [react(), serviceWorker()],
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
    rollupOptions: {
      // React and the router in a file of their own (D1 took the app's own file past Vite's 500 kB
      // warning); they change only with an upgrade, so that file stays cached across app updates.
      output: { manualChunks: { react: ['react', 'react-dom', 'react-router-dom'] } },
    },
  },
});

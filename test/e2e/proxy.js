// A pass-through HTTP proxy in front of the test server that can be switched off. Playwright's
// setOffline() only covers the page: a service worker's own fetches still reach the server, so
// "the app opens with no signal" is only proven when the server really is unreachable.
// down(): every connection is cut and new ones are dropped (like a phone with no route to the Mac).
import http from 'node:http';

export function startProxy(target) {
  const state = { down: false };
  const sockets = new Set();
  const { hostname, port } = new URL(target);
  const server = http.createServer((req, res) => {
    if (state.down) {
      req.socket.destroy();
      return;
    }
    const upstream = http.request({ host: hostname, port, method: req.method, path: req.url, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('connection', (s) => {
    if (state.down) {
      s.destroy();
      return;
    }
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      // localhost (not 127.0.0.1): its own origin, so its cookies and service worker are separate.
      base: `http://localhost:${server.address().port}`,
      down() {
        state.down = true;
        for (const s of sockets) s.destroy();
      },
      up() {
        state.down = false;
      },
      close: () => new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
    }));
  });
}

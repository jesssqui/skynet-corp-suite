# suite

A private business and life management suite for two people: one place for clients, follow-ups, tasks and the day's
plan across every business. Runs at home on the Mac mini, reachable only over Tailscale.

Status: skeleton (package C0) — app shell, `health` module, Docker, nightly off-machine backups.

```bash
npm ci
npm test              # shared + server tests and a client build
npm run dev:server    # http://127.0.0.1:3100
npm run dev:client    # http://localhost:5173
```

- How it's built and the conventions to follow: [CLAUDE.md](CLAUDE.md)
- Running it on the Mac mini, Tailscale Serve, backups and the restore drill: [DEPLOY.md](DEPLOY.md)

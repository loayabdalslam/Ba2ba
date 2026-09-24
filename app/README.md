# CoitHub web app

React 18 + TypeScript + Vite + Tailwind v4. Talks only to the Bee2Bee gateway (`/api`, `/v1`);
it never connects to nodes directly.

```bash
npm install
cp .env.example .env        # optional: Supabase public keys, gateway URL
npm run dev                 # http://localhost:3000, proxies /api to the gateway on :3001
npm run lint && npm run typecheck && npm test
npm run build               # static files in dist/
npm run test:e2e            # Playwright: Python echo node + gateway + browser
```

Pages: `/` landing with live mesh stats, `/chat`, `/register?link=…` (node onboarding),
`/account` (sign in, API keys, usage), `/docs`, `/privacy`, `/terms`.

Deploy `dist/` anywhere static (Vercel config included: it rewrites `/api` and `/v1` to the
gateway), or let the gateway serve it with `STATIC_DIR` (see the root Dockerfile).

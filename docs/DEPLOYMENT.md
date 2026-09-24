# Deployment

## Topology

| Component | Where | Why |
|---|---|---|
| Desktop app | Users' computers (installers from GitHub releases) | Chat, explore, deploy |
| Directory server | Vercel + Neon | Lists online nodes for the desktop app |
| Gateway | A long-running container (Fly.io, Railway, a VM, Kubernetes) | Holds WebSocket connections to nodes; **not** serverless |
| Nodes | Wherever the GPUs are | Must be reachable on their P2P port (directly or via a TLS proxy/tunnel) |
| Database | Supabase | Registry, accounts, keys, usage, history |

## 0. Directory server (Vercel + Neon)

1. Create a Neon project; copy the **pooled** connection string.
2. `cd server && npm ci && DATABASE_URL=... npm run migrate`
3. In Vercel, import the repository with **Root Directory = `server`** and add `DATABASE_URL`.
4. Set the repository variable `DIRECTORY_URL` (Settings → Variables) to the Vercel URL so desktop
   builds default to it, and start nodes with `BEE2BEE_DIRECTORY_URL=<that URL>`.

## 1. Database (gateway accounts and API keys)

```bash
supabase link --project-ref <ref>
supabase db push            # applies supabase/migrations
```

Or paste `supabase/migrations/*.sql` into the SQL editor. Enable the `pg_cron` extension to prune stale
nodes automatically. Configure Auth (email magic links, optionally GitHub) and set the site URL.

## 2. Gateway (OpenAI-compatible API)

```bash
docker build -f gateway/Dockerfile -t bee2bee-gateway .
docker run -d --name gateway -p 3001:3001 -v gateway-data:/data \
  -e SUPABASE_URL=https://<ref>.supabase.co -e SUPABASE_ANON_KEY=<anon> \
  -e SUPABASE_SERVICE_ROLE_KEY=<service role> \
  -e BEE2BEE_SEEDS=wss://mesh.example.com -e TRUST_PROXY=true -e METRICS_TOKEN=<random> \
  bee2bee-gateway
```

Put it behind TLS (see `deploy/Caddyfile`). On Fly.io use `deploy/fly.gateway.toml`
(`auto_stop_machines = "off"` because the gateway keeps node connections open). The identity key lives
in the `/data` volume; keep it so nodes can keep trusting the same peer id.

API keys for the gateway are created through `POST /api/keys` with a Supabase user session, or
configured statically with `STATIC_API_KEYS` for self-hosted setups.

## 3. Nodes

```bash
docker run -d --name node --gpus all -p 4003:4003 -v node-data:/data \
  -e BEE2BEE_ANNOUNCE_ADDR=wss://mesh.example.com \
  -e BEE2BEE_REGISTRY_URL=https://coithub.example.com \
  -e BEE2BEE_TRUSTED_PEERS=<gateway peer id from GET /readyz> \
  -e OLLAMA_HOST=http://host.docker.internal:11434 \
  ghcr.io/<org>/bee2bee/node serve-ollama --model llama3.2
```

Keep the node's HTTP API (4002) private unless you need it; it is protected by an API key either way.

## 4. Verify

- `curl https://coithub.example.com/readyz` shows `nodes > 0`.
- `curl https://coithub.example.com/api/p2p/status` lists the node.
- Open the desktop app → Explore network: your node is listed as online and reachable.
- Run `loadtest/quick.mjs` against the gateway with an API key.

## Releases

All components share one version (`scripts/check-versions.sh` checks `bee2bee/_version.py`,
`desktop/package.json`, the two desktop `Cargo.toml` files, `gateway/package.json` and
`server/package.json`). To release:

1. Bump the version everywhere and add a `## [X.Y.Z]` section to `CHANGELOG.md`.
2. Commit and push a tag `vX.Y.Z` — or, without git, open **Actions → Release → Run workflow**,
   pick the branch and enter `vX.Y.Z`; the workflow creates the tag on that branch itself.
3. `.github/workflows/release.yml` creates a draft release, attaches the Python wheel and sdist,
   builds desktop installers for Linux (.deb, .rpm, .AppImage), Windows (.msi, .exe) and macOS
   (.dmg, Apple Silicon and Intel), pushes `node` and `gateway` images to GHCR, then publishes the release.

Optional: set the repository variable `PUBLISH_PYPI=true` (and add the repo as a trusted publisher on
PyPI with an environment named `pypi`) to also publish to PyPI; set `DIRECTORY_URL` so desktop builds
default to your directory; add the `APPLE_*` secrets to sign and notarize macOS builds.



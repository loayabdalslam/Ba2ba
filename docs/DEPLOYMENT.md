# Deployment

## Topology

| Component | Where | Why |
|---|---|---|
| Web app | Any static host (Vercel config included) or served by the gateway | Static files |
| Gateway | A long-running container (Fly.io, Railway, a VM, Kubernetes) | Holds WebSocket connections to nodes; **not** serverless |
| Nodes | Wherever the GPUs are | Must be reachable on their P2P port (directly or via a TLS proxy/tunnel) |
| Database | Supabase | Registry, accounts, keys, usage, history |

## 1. Database

```bash
supabase link --project-ref <ref>
supabase db push            # applies supabase/migrations
```

Or paste `supabase/migrations/*.sql` into the SQL editor. Enable the `pg_cron` extension to prune stale
nodes automatically. Configure Auth (email magic links, optionally GitHub) and set the site URL.

## 2. Gateway (+ web app)

```bash
docker build -f gateway/Dockerfile -t bee2bee-gateway \
  --build-arg VITE_SUPABASE_URL=https://<ref>.supabase.co \
  --build-arg VITE_SUPABASE_ANON_KEY=<anon key> .
docker run -d --name gateway -p 3001:3001 -v gateway-data:/data \
  -e SUPABASE_URL=https://<ref>.supabase.co -e SUPABASE_ANON_KEY=<anon> \
  -e SUPABASE_SERVICE_ROLE_KEY=<service role> \
  -e BEE2BEE_SEEDS=wss://mesh.example.com -e TRUST_PROXY=true -e METRICS_TOKEN=<random> \
  bee2bee-gateway
```

Put it behind TLS (see `deploy/Caddyfile`). On Fly.io use `deploy/fly.gateway.toml`
(`auto_stop_machines = "off"` because the gateway keeps node connections open). The identity key lives
in the `/data` volume; keep it so nodes can keep trusting the same peer id.

If the web app is hosted separately (e.g. Vercel), edit the rewrite destinations in `app/vercel.json`
to point at your gateway, or set `VITE_API_BASE_URL` and `CORS_ORIGINS`.

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
- Create an API key in the web app and run `loadtest/quick.mjs` briefly.

## Releases

Tag `vX.Y.Z` (matching `bee2bee/_version.py`) to publish the package to PyPI (trusted publishing: add the
repository as a trusted publisher on PyPI and create a `pypi` environment), push Docker images to GHCR
and create a GitHub release from `CHANGELOG.md`.

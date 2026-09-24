# Bee2Bee directory server

Central, read-mostly directory of the Bee2Bee mesh for the desktop app: which nodes are online, their
names, regions, models, providers, speed (tokens/s), latency and uptime, with search and filters.
Runs as Vercel Functions backed by Neon Postgres. It does not relay chat traffic: the desktop app
connects to nodes directly over the P2P protocol.

## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | Database connectivity |
| `GET /api/stats` | Online/reachable/total nodes, total tokens/s, average latency, regions, top models, providers |
| `GET /api/nodes` | Search nodes. Query: `q`, `model`, `provider`, `region`, `online` (`true`\|`false`\|`any`, default `true`), `reachable`, `min_tps`, `max_latency`, `sort` (`tps`\|`latency`\|`uptime`\|`name`\|`last_seen`), `order`, `limit` (≤100), `offset` |
| `GET /api/nodes/:peerId` | Node details plus 30-day uptime history |
| `GET /api/models` | Models online, with provider names, node counts and best speed |
| `GET /api/providers` | Providers (ollama, hf, hf_remote, …) with node and model counts |
| `POST /api/nodes/heartbeat` | Signed heartbeat from a node (see below) |

Read endpoints are CDN-cached for a few seconds.

## Heartbeats and trust

Nodes started with `BEE2BEE_DIRECTORY_URL=https://<your-deployment>` send a heartbeat every 30 s,
signed with their Ed25519 key (same scheme as the P2P protocol, see `docs/PROTOCOL.md`). The server
checks the signature, that the peer id matches the key, the timestamp (±5 min), replays (nonce table)
and the rate (≥10 s apart). When the address is new, changed or was last verified over an hour ago,
the server connects to it and runs the P2P handshake; only if the node proves the same peer id is it
marked `reachable`. Private addresses are never probed in production (SSRF protection).

Performance numbers (tokens/s, CPU, memory) are **self-reported** by nodes; latency and reachability
are measured by the server; uptime is computed from heartbeats.

## Deploy

1. Create a Neon project and copy the pooled connection string.
2. `DATABASE_URL=... npm run migrate`
3. Import the repository in Vercel with **Root Directory = `server`** and set `DATABASE_URL`
   (optionally `ONLINE_WINDOW_SECONDS`, `CORS_ORIGINS`).

## Develop

```bash
npm ci
DATABASE_URL=postgres://localhost/bee2bee npm run migrate
DATABASE_URL=postgres://localhost/bee2bee npx tsx scripts/dev-server.ts   # http://localhost:3002
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test
npm run lint && npm run typecheck
```

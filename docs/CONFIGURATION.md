# Configuration

## Node (`bee2bee`)

All variables are optional. CLI flags override them where both exist.

| Variable | Default | Description |
|---|---|---|
| `BEE2BEE_HOST` / `BEE2BEE_PORT` | `0.0.0.0` / `4003` | P2P WebSocket bind address |
| `BEE2BEE_API_HOST` / `BEE2BEE_API_PORT` | `0.0.0.0` / `4002` | HTTP API bind address (`--api-port 0` disables it) |
| `BEE2BEE_ANNOUNCE_ADDR` | | Full public URL (`wss://mesh.example.com`) when TLS is terminated by a proxy or tunnel |
| `BEE2BEE_ANNOUNCE_HOST` / `BEE2BEE_ANNOUNCE_PORT` | auto | Public host/port if not using `ANNOUNCE_ADDR` |
| `BEE2BEE_UPNP` | `true` | Try UPnP/NAT-PMP/PCP port mapping when binding `0.0.0.0` without an announce host |
| `BEE2BEE_BOOTSTRAP` | | Comma-separated bootstrap peers or a join link |
| `BEE2BEE_REGION` | `Auto` | Region label shown on the dashboard |
| `BEE2BEE_REGISTRY_URL` | | Gateway that accepts signed registrations (e.g. `https://coithub.org`) |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | | Operator-only direct registry mode |
| `BEE2BEE_TLS_CERT` / `BEE2BEE_TLS_KEY` | | Serve `wss://` and HTTPS directly |
| `BEE2BEE_REQUIRE_TLS` | `false` | Refuse `ws://` peers |
| `BEE2BEE_ALLOW_PRIVATE_PEERS` | `true` | Allow private/loopback peer addresses (LAN meshes) |
| `BEE2BEE_API_KEY` | generated | HTTP API key; generated into `~/.bee2bee/api_key` if unset |
| `BEE2BEE_API_AUTH` | `on` | `off` disables API authentication (local development only) |
| `BEE2BEE_CORS_ORIGINS` | none | Comma-separated allowed browser origins |
| `BEE2BEE_RATE_LIMIT_PER_MINUTE` | `60` | HTTP API requests per client IP |
| `BEE2BEE_TRUST_PROXY` | `false` | Use `X-Forwarded-For` for client IPs (behind your own proxy only) |
| `BEE2BEE_METRICS_PUBLIC` | `false` | Serve `/metrics` without the API key |
| `BEE2BEE_ALLOWED_PEERS` | open | Only accept these peer ids (private mesh) |
| `BEE2BEE_TRUSTED_PEERS` | | Peer ids exempt from the per-peer rate limit (your gateway) |
| `BEE2BEE_MAX_PEERS` / `BEE2BEE_TARGET_PEERS` | `50` / `8` | Connection cap / peers to keep dialed |
| `BEE2BEE_MAX_CONCURRENT_GENERATIONS` | `4` | Local generations at once; extra requests get `busy` and fail over |
| `BEE2BEE_PEER_RATE_LIMIT_PER_MINUTE` | `120` | Generation requests per peer |
| `BEE2BEE_MAX_PROMPT_CHARS` / `BEE2BEE_MAX_NEW_TOKENS` | `32000` / `4096` | Request limits |
| `BEE2BEE_MAX_MESSAGE_BYTES` | `1048576` | WebSocket frame and HTTP body limit |
| `BEE2BEE_MAX_HOPS` | `3` | Relay hop limit |
| `BEE2BEE_REQUEST_TIMEOUT` | `300` | Seconds without progress before a remote request times out |
| `BEE2BEE_PING_INTERVAL` / `BEE2BEE_REGISTRY_INTERVAL` | `15` / `30` | Seconds |
| `BEE2BEE_HOME` | `~/.bee2bee` | Identity key, API key, config |
| `BEE2BEE_LOG_LEVEL` / `BEE2BEE_LOG_JSON` / `BEE2BEE_LOG_FILE` | `INFO` / `false` / | Logging |
| `BEE2BEE_SENTRY_DSN` | | Error reporting (`pip install "bee2bee[sentry]"`) |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint |
| `HF_TOKEN` | | Hugging Face token for `serve-hf-remote` |

## Gateway

| Variable | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `3001` / `0.0.0.0` | Listen address |
| `BEE2BEE_SEEDS` | | Comma-separated node addresses to connect to |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | | Enables registry, accounts, API keys, usage |
| `GATEWAY_KEY_FILE` / `GATEWAY_PRIVATE_KEY` | ephemeral | Stable Ed25519 identity (set one in production so nodes can trust it) |
| `CORS_ORIGINS` | none | Allowed browser origins for browser-based API clients |
| `TRUST_PROXY` | `false` | Trust one proxy hop for client IPs |
| `ALLOW_PRIVATE_NODES` | `false` | Allow private node addresses (Compose/LAN only) |
| `REQUIRE_TLS_NODES` | `false` | Only connect to `wss://` nodes |
| `RATE_LIMIT_PER_MINUTE` / `ANON_RATE_LIMIT_PER_MINUTE` | `60` / `20` | Per IP; anonymous chat is stricter |
| `MAX_PROMPT_CHARS` / `MAX_NEW_TOKENS` | `32000` / `4096` | Request limits |
| `REQUEST_TIMEOUT_MS` | `120000` | Idle timeout per generation |
| `MAX_NODE_CONNECTIONS` | `20` | Node connection pool size |
| `DEFAULT_MONTHLY_TOKEN_QUOTA` | `1000000` | Quota for new API keys |
| `STATIC_API_KEYS` | | Comma-separated keys for self-hosted API access without Supabase |
| `OPEN_API` | `false` | Allow `/v1` without a key (development only) |
| `PROBE_NODE_REGISTRATIONS` | `true` | Connect back to verify self-registrations |
| `METRICS_TOKEN` | | Bearer token required for `/metrics` |
| `STATIC_DIR` | | Optionally serve a static web front end from this directory |
| `LOG_LEVEL` / `SENTRY_DSN` | `info` / | Logging / error reporting (`@sentry/node` optional) |

## Directory server (`server/`)

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | | Neon (pooled) connection string |
| `ONLINE_WINDOW_SECONDS` | `90` | A node is online if its last heartbeat is newer than this |
| `ALLOW_PRIVATE_NODES` | `false` | Allow probing private addresses (local testing only) |
| `CORS_ORIGINS` | | Extra browser origins; the Tauri app origins are always allowed |

Nodes: `BEE2BEE_DIRECTORY_URL` (directory to announce to), `BEE2BEE_DIRECTORY_INTERVAL` (default 30 s),
`BEE2BEE_NODE_NAME` (display name, default hostname).

## Desktop app

Settings are edited in the app (directory URL, bee2bee/Python commands, Ollama address, theme, chat
defaults). `VITE_DIRECTORY_URL` sets the default directory URL at build time (the release workflow reads
the `DIRECTORY_URL` repository variable).

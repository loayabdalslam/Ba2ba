# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/).

## [4.1.0] - 2026-09-24

### Added
- **Desktop app** (`desktop/`, Tauri 2 + React): ChatGPT-style chat with any node over the P2P protocol,
  network explorer with filters, control center, local node deployments with logs, Ollama model
  management. Rust core crate with tests, including interop with a real Python node.
- **Directory server** (`server/`, Vercel + Neon): online nodes, search and filters by model, provider,
  region, speed and latency, uptime, statistics. Nodes announce themselves with signed heartbeats and
  are probed before being marked reachable.
- Node options `--name` / `BEE2BEE_NODE_NAME`, `BEE2BEE_DIRECTORY_URL`.
- `Desktop app` workflow: verify, build installers for Windows/macOS/Linux, release on `desktop-v*` tags.

### Removed
- The React web app (`app/`), replaced by the desktop app. The gateway image no longer bundles a UI.

## [4.0.0] - 2026-09-24

Production-readiness release. **Breaking:** the wire protocol is now version 2 and does not interoperate
with 3.x nodes; upgrade every node.

### Added
- Ed25519 node identities, mutual challenge/response handshake, signed registrations.
- Standalone gateway service (`gateway/`) with connection pool, failover, cancellation, accounts,
  API keys, monthly quotas, usage tracking and an OpenAI-compatible API.
- OpenAI-compatible `/v1/chat/completions` and `/v1/models` on nodes and on the gateway.
- `/healthz`, `/readyz`, Prometheus `/metrics`, JSON logs, optional Sentry.
- `serve-echo`, `relay`, `api-key`, `identity` and `config` CLI commands; `BEE2BEE_ANNOUNCE_ADDR`,
  `BEE2BEE_TRUSTED_PEERS` and many other settings (see docs/CONFIGURATION.md).
- Supabase migrations with strict RLS and automated policy tests.
- TypeScript web app with chat history, account page, honest privacy policy and terms.
- Docker images, docker-compose, Caddy and Fly.io configs, CI and release workflows, load tests.

### Fixed
- Node-to-node generation never returned (response type mismatch).
- Streaming through the mesh dropped Ollama output.
- Inference blocked the event loop; `requests` was a missing dependency.
- Dockerfile and GitHub workflow referenced modules and folders that no longer existed.
- The web app called endpoints that did not exist and displayed randomly generated metrics.

### Security
- Removed anonymous write access to the node registry, SSRF vectors (`/connect`, `?target=`),
  wildcard CORS with credentials, automatic TLS downgrade and the default-open API.

### Removed
- Legacy distributed-training modules (`node.py`, `model.py`, `dht.py`, `pieces.py`, `datasets.py`),
  the Vercel serverless API, outdated guides and notebooks.

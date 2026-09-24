# 🐝 Bee2Bee

[![PyPI version](https://badge.fury.io/py/bee2bee.svg)](https://pypi.org/project/bee2bee/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Bee2Bee is a peer-to-peer network for serving open AI models. Anyone can run a **node** that serves a
model (Ollama, a local Hugging Face model, or the Hugging Face Inference API). Users reach the mesh
through the **gateway**: a web chat at [coithub.org](https://coithub.org) and an OpenAI-compatible API.

```
browser / OpenAI SDK ──HTTPS──▶ gateway ──wss (signed handshake)──▶ node ──▶ Ollama / transformers / HF API
                                   │                                  ▲
                                   └── Supabase (registry, keys, usage) └── relays to other nodes
```

- **Verified identities**: every node and gateway has an Ed25519 key; its `peer_id` is derived from the
  public key and proven on every connection (mutual challenge/response).
- **Resilient routing**: provider ranking by reputation and latency, failover before the first token,
  cancellation, hop-limited relays, reconnect with backoff.
- **Secure defaults**: API keys required, rate limits, input limits, CORS allowlists, SSRF protection,
  strict Supabase row-level security.
- **Operable**: `/healthz`, `/readyz`, Prometheus `/metrics`, JSON logs, Docker images, CI/CD.

## Quick start

### Run a node

```bash
pip install bee2bee
ollama pull llama3.2
bee2bee serve-ollama --model llama3.2 --region egypt --public-host node.example.com
```

Other backends:

```bash
pip install "bee2bee[hf,torch]" && bee2bee serve-hf --model Qwen/Qwen2.5-0.5B-Instruct
HF_TOKEN=hf_... bee2bee serve-hf-remote --model HuggingFaceH4/zephyr-7b-beta
bee2bee serve-echo            # test backend, no model needed
bee2bee relay                 # route requests without serving a model
```

The node listens for peers on **4003** (WebSocket) and serves an HTTP API on **4002**. To join the public
mesh set `BEE2BEE_REGISTRY_URL=https://coithub.org` and a bootstrap peer (`BEE2BEE_BOOTSTRAP`).

### Use the local node API

```bash
KEY=$(bee2bee api-key)
curl -s localhost:4002/v1/chat/completions -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"llama3.2","messages":[{"role":"user","content":"Hello"}]}'
```

### Run the whole stack locally

```bash
docker compose up --build     # demo node + gateway + web app on http://localhost:3001
```

## CLI

| Command | Purpose |
|---|---|
| `bee2bee serve-ollama/serve-hf/serve-hf-remote/serve-echo` | Serve a model (`--model --region --public-host --port --api-port --bootstrap --price`) |
| `bee2bee relay` | Node without a model |
| `bee2bee api-key [--rotate]` | Show or rotate the local API key |
| `bee2bee identity` | Show the node's peer id and public key |
| `bee2bee config bootstrap_url wss://host:4003` | Persist a bootstrap peer |
| `bee2bee register` | Register once with the registry (normally automatic) |

All settings are environment variables; see [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Repository layout

| Path | What |
|---|---|
| `bee2bee/` | Python package: node, protocol, backends, HTTP API, CLI |
| `gateway/` | Node.js gateway: mesh bridge, web/OpenAI API, accounts, registry |
| `app/` | React/TypeScript web app (CoitHub) |
| `supabase/` | Database migrations and RLS tests |
| `deploy/`, `Dockerfile`, `docker-compose.yml` | Deployment |
| `loadtest/` | k6 and dependency-free load tests |
| `docs/` | Architecture, protocol, deployment, runbook |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) · [Wire protocol](docs/PROTOCOL.md) · [Configuration](docs/CONFIGURATION.md)
- [Deployment](docs/DEPLOYMENT.md) · [Operations runbook](docs/RUNBOOK.md) · [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md) · [Production readiness plan](PRODUCTION_READINESS_PLAN.md)

## Development

```bash
pip install -e ".[dev]" && ruff check bee2bee tests && mypy && pytest
(cd gateway && npm ci && npm run lint && npm test)
(cd app && npm ci && npm run lint && npm run typecheck && npm test && npm run test:e2e)
PGHOST=... PGUSER=postgres supabase/tests/run.sh
```

Built by **Loay Abdelsalam** and the **ConnectIT team**. MIT licensed.

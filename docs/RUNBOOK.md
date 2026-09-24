# Operations runbook

## Health signals

| Check | Healthy |
|---|---|
| `GET /healthz` (gateway, node API, node P2P port) | `200` |
| `GET /readyz` (gateway) | `nodes > 0` |
| `gateway_connected_nodes` | > 0, stable |
| `rate(gateway_generations_total{outcome!="ok"}[5m])` | low relative to `outcome="ok"` |
| `histogram_quantile(0.95, rate(gateway_http_request_seconds_bucket[5m]))` | within your SLO |
| `bee2bee_peers`, `bee2bee_active_local_generations` (per node) | peers > 0; generations below the cap |

Suggested alerts: no connected nodes for 5 minutes; error ratio above 10 % for 10 minutes; p95 latency
above target; gateway restarts; Supabase errors in logs (`"registry sync failed"`, `"usage recording failed"`).

## Common incidents

**Chat says "No node is currently serving this model".** Check `/api/p2p/status`. If nodes are
`registered` but not `connected`, the gateway cannot reach them: check their firewall, TLS certificate
and `BEE2BEE_ANNOUNCE_ADDR`. Gateway logs show `dial failed` with the reason.

**Many `rate_limited` errors from nodes.** The node is rate limiting the gateway. Add the gateway's peer
id (`GET /readyz` → `peer_id`) to `BEE2BEE_TRUSTED_PEERS` on the node.

**Many `busy` errors.** Nodes are at `BEE2BEE_MAX_CONCURRENT_GENERATIONS`. Add nodes or raise the cap if
the hardware allows.

**A node misbehaves (spam, abuse, wrong model).** Delete its row from `active_nodes` and, on your
bootstrap nodes, remove it via `BEE2BEE_ALLOWED_PEERS` (private mesh) or block its address at the
firewall. Its reputation drops automatically when it errors.

**Leaked API key.** The user revokes it with `DELETE /api/keys/:id`, or an operator sets `revoked_at` in `api_keys`.
It stops working immediately.

**Leaked Supabase service-role key.** Rotate it in Supabase, update the gateway secret, restart the
gateway. Nodes are unaffected (they never hold it).

**Gateway identity rotation.** Delete `/data/gateway_key.pem` and restart; update `BEE2BEE_TRUSTED_PEERS`
on nodes that trusted the old id.

## Routine tasks

- Apply migrations with `supabase db push` before deploying code that needs them.
- Rotate `METRICS_TOKEN` and static API keys periodically.
- Review `npm audit` / `pip-audit` results from CI weekly.
- Back up Supabase (daily backups are included on paid plans).

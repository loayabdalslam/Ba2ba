# Bee2Bee wire protocol, version 2

Transport: WebSocket (`ws://` or `wss://`). Every frame is a UTF-8 JSON object with a string `type`.
Max frame size: `BEE2BEE_MAX_MESSAGE_BYTES` (default 1 MiB). Unknown types are ignored.

Reference implementations: `bee2bee/protocol.py` (Python) and `gateway/src/protocol.js` (JavaScript).
`gateway/test/interop.test.js` checks that the two interoperate.

## Identity and signatures

- Key: Ed25519. `pubkey` = standard base64 of the 32-byte raw public key.
- `peer_id` = `"peer-"` + first 32 hex characters of `sha256(raw_public_key)`.
- Signatures are Ed25519 over the **canonical JSON** of the signed fields: keys sorted recursively,
  separators `,` and `:` with no whitespace, UTF-8 without `\u` escaping of non-ASCII, and **integers
  only** (no floats in signed payloads). Signature encoding: standard base64.

## Handshake

The connecting side (initiator) and the accepting side (responder) authenticate each other with fresh
challenges, so a recorded `hello` cannot be replayed to impersonate a peer.

```
initiator                                        responder
   | hello {challenge: c1, response_to: ""}  ------>  | verify signature, ts, peer_id
   | <------ hello {challenge: c2, response_to: c1}  | proves possession of its key now
   | verify, check response_to == c1                  |
   | auth {response_to: c2, sig}              ------>  | verify with initiator's pubkey
   |                 both sides authenticated         |
```

`hello` fields (signed fields marked *):

| Field | Type | Notes |
|---|---|---|
| type* | `"hello"` | |
| protocol_version* | int | must be `2` |
| peer_id*, pubkey* | string | see above |
| role* | `"node"` \| `"client"` | clients (e.g. the gateway) do not serve and are not gossiped |
| addr* | string | public `ws(s)://` address of a node, `""` for clients |
| ts* | int | Unix milliseconds; rejected if more than 5 minutes off |
| nonce* | string | random |
| challenge* | string | ≥ 16 characters, random |
| response_to* | string | the peer's challenge being answered, or `""` |
| sig | string | signature over the signed fields |
| region, version, services, api_port, api_host, metrics | any | informational, unsigned |

`services` is `{name: {models: [string], price_per_token: number, backend?: string, tokens_per_sec?: number}}`.

`auth` = `{type: "auth", peer_id, response_to, sig}` where `sig` signs `{type, peer_id, response_to}`.

Any message other than `hello`/`auth` before authentication closes the connection with code **4003**.
Other close codes: 4001 protocol error, 4008 peer limit reached, 4009 duplicate connection (for
simultaneous dials the connection initiated by the lexicographically smaller peer id is kept).

## Messages after authentication

| Type | Direction | Fields |
|---|---|---|
| `peer_list` | responder → initiator | `peers: [addr]` (max 100) |
| `ping` / `pong` | both | `ts` (echoed), optional `metrics` on ping |
| `service_announce` | node → peers | `service`, `meta` (same shape as a `services` entry) |
| `gen_request` | requester → provider | `rid`, `prompt` or `messages`, `model`, `max_new_tokens`, `temperature`, `stream`, `hops` |
| `gen_chunk` | provider → requester | `rid`, `text` |
| `gen_done` | provider → requester | `rid`, `usage {prompt_tokens, completion_tokens, total_tokens, latency_ms, tokens_per_sec}`, `provider`, `backend`, `cost`, and `text` when `stream` was false |
| `gen_error` | provider → requester | `rid`, `code`, `error` |
| `gen_cancel` | requester → provider | `rid` |

Error codes: `bad_request`, `busy`, `no_provider`, `rate_limited`, `timeout`, `provider_error`,
`cancelled`, `unauthorized`. Only the peer a request was sent to may answer it.

Limits enforced by providers: prompt characters (`MAX_PROMPT_CHARS`), `max_new_tokens` is clamped,
`temperature` is clamped to [0, 2], `hops` ≤ `MAX_HOPS` (relays increment it), a per-peer rate limit
and a concurrency cap (`busy`).

`messages` is a list of `{role: "system"|"user"|"assistant", content: string}` (max 256).

Legacy final message names `gen_result`, `gen_success` and `gen_response` are accepted as `gen_done`.

## Signed registration (node → gateway)

`POST {registry}/api/nodes/register` with

```json
{"peer_id": "...", "pubkey": "...", "addr": "wss://...", "models": ["..."], "region": "...",
 "api_port": 4002, "ts": 1790000000000, "nonce": "...", "sig": "...", "metrics": {"cpu_percent": 3.5}}
```

`sig` covers every field except `sig` and `metrics`. The gateway rejects stale timestamps and reused
nonces, then connects to `addr` and requires the handshake `peer_id` to match before storing the row.

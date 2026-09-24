# Load tests

`quick.mjs` needs only Node.js:

```bash
node loadtest/quick.mjs https://coithub.example.com b2b_yourkey 20 500 llama3.2
```

`k6-chat.js` ramps to 50 virtual users and fails if more than 1 % of requests fail or p95 exceeds 5 s:

```bash
k6 run -e BASE_URL=https://coithub.example.com -e API_KEY=b2b_... -e MODEL=llama3.2 loadtest/k6-chat.js
```

Use a dedicated API key with a large quota, and point nodes at the gateway with `BEE2BEE_TRUSTED_PEERS`
first, otherwise node-side per-peer rate limits dominate the result.

Reference result (echo backend, one gateway and one node container on one host, 2026-09-24):

| Concurrency | Requests | Errors | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|---|---|
| 20 | 2,000 | 0 | 505 req/s | 37 ms | 52 ms | 82 ms |
| 100 | 5,000 | 0 | 610 req/s | 162 ms | 203 ms | 215 ms |

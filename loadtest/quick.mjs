// Dependency-free load test: node loadtest/quick.mjs <base-url> <api-key> [concurrency] [requests] [model]
const [base = 'http://localhost:3001', key = '', concurrency = '20', total = '500', model = 'echo'] = process.argv.slice(2);
const latencies = [];
let ok = 0;
let failed = 0;
let next = 0;

async function worker() {
  while (next < Number(total)) {
    next += 1;
    const t0 = performance.now();
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'load test message number ' + next }] }),
      });
      await res.json();
      if (res.ok) ok += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
    latencies.push(performance.now() - t0);
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: Number(concurrency) }, worker));
const seconds = (performance.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const p = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))].toFixed(1);
console.log(JSON.stringify({ requests: latencies.length, ok, failed, seconds: +seconds.toFixed(2), rps: +(latencies.length / seconds).toFixed(1), p50_ms: +p(0.5), p95_ms: +p(0.95), p99_ms: +p(0.99) }));

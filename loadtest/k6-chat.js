// k6 run -e BASE_URL=https://coithub.example.com -e API_KEY=b2b_... -e MODEL=llama3.2 loadtest/k6-chat.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const KEY = __ENV.API_KEY || '';
const MODEL = __ENV.MODEL || 'echo';
const ttlb = new Trend('completion_ms', true);

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m', target: 50 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    completion_ms: ['p(95)<5000'],
  },
};

export default function () {
  const res = http.post(
    `${BASE}/v1/chat/completions`,
    JSON.stringify({ model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'Say hello in five words.' }] }),
    { headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, timeout: '120s' },
  );
  ttlb.add(res.timings.duration);
  check(res, { 'status 200': (r) => r.status === 200, 'has content': (r) => r.status === 200 && r.json('choices.0.message.content') !== '' });
  sleep(1);
}

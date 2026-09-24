import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { Identity } from '../src/identity.js';
import { FakeDb, ndjson, startFakeNode, startGateway, waitFor } from './helpers.js';

const json = (body, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('mesh routing', () => {
  let gw, node, failing, hanging;
  before(async () => {
    node = await startFakeNode({ models: ['echo'] });
    failing = await startFakeNode({ models: ['echo'], behavior: 'fail' });
    hanging = await startFakeNode({ models: ['slow'], behavior: 'hang' });
    gw = await startGateway({ config: { requestTimeoutMs: 500 } });
  });
  after(async () => { await gw.close(); await node.close(); await failing.close(); await hanging.close(); });

  test('handshake connects and exposes node info', async () => {
    const conn = await gw.mesh.connect(node.addr);
    assert.equal(conn.peerId, node.identity.peerId);
    assert.deepEqual(conn.models, ['echo']);
    const status = await (await fetch(`${gw.base}/api/p2p/status`)).json();
    assert.equal(status.connected, true);
    assert.equal(status.peers[0].peer_id, node.identity.peerId);
    assert.ok(status.mesh.test.length >= 1);
  });

  test('web generate streams NDJSON with real usage', async () => {
    const r = await fetch(`${gw.base}/api/p2p/generate`, json({ prompt: 'one two three', model: 'echo', targetNode: node.identity.peerId }));
    assert.equal(r.status, 200);
    const lines = ndjson(await r.text());
    assert.deepEqual(lines.slice(0, 3).map((l) => l.text), ['one', ' two', ' three']);
    assert.equal(lines.at(-1).done, true);
    assert.equal(lines.at(-1).usage.completion_tokens, 3);
  });

  test('fails over from a failing node to a healthy one', async () => {
    await gw.mesh.connect(failing.addr);
    gw.mesh.statsFor(failing.identity.peerId).successes = 100; // rank the failing node first
    const r = await fetch(`${gw.base}/api/p2p/generate`, json({ prompt: 'still fine', model: 'echo' }));
    const lines = ndjson(await r.text());
    assert.equal(lines.at(-1).provider, node.identity.peerId);
    assert.equal(failing.state.requests.length, 1);
    assert.equal(gw.mesh.statsFor(failing.identity.peerId).failures, 1);
  });

  test('timeout cancels the request on the node and reports an error line', async () => {
    await gw.mesh.connect(hanging.addr);
    const r = await fetch(`${gw.base}/api/p2p/generate`, json({ prompt: 'x', model: 'slow' }));
    const lines = ndjson(await r.text());
    assert.equal(lines[0].text, 'partial');
    assert.equal(lines.at(-1).code, 'timeout');
    await waitFor(() => hanging.state.cancels.length === 1);
  });

  test('unknown target returns 503 JSON', async () => {
    const r = await fetch(`${gw.base}/api/p2p/generate`, json({ prompt: 'x', targetNode: 'peer-nope' }));
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'no_provider');
  });

  test('invalid requests are rejected', async () => {
    assert.equal((await fetch(`${gw.base}/api/p2p/generate`, json({}))).status, 400);
    const r = await fetch(`${gw.base}/api/p2p/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(r.status, 400);
  });

  test('node disconnect fails in-flight requests quickly', async () => {
    const extra = await startFakeNode({ models: ['gone'], behavior: 'hang' });
    await gw.mesh.connect(extra.addr);
    const pending = fetch(`${gw.base}/api/p2p/generate`, json({ prompt: 'x', model: 'gone' })).then((r) => r.text());
    await waitFor(() => extra.state.requests.length === 1);
    await extra.close();
    const lines = ndjson(await pending);
    assert.equal(lines.at(-1).code, 'provider_error');
  });
});

describe('registration', () => {
  let gw, node, db;
  before(async () => {
    node = await startFakeNode();
    db = new FakeDb();
    gw = await startGateway({ db });
  });
  after(async () => { await gw.close(); await node.close(); });

  test('join-link registration verifies the node via handshake before persisting', async () => {
    const link = `coithub.org://join?model=echo&bootstrap=${Buffer.from(node.addr).toString('base64url')}`;
    const r = await fetch(`${gw.base}/api/p2p/register`, json({ link }));
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.node.peer_id, node.identity.peerId);
    assert.equal(db.nodes.get(node.identity.peerId).pubkey, node.identity.pubkey);
  });

  test('unreachable join-link node is rejected', async () => {
    const link = `coithub.org://join?bootstrap=${Buffer.from('ws://127.0.0.1:1').toString('base64url')}`;
    assert.equal((await fetch(`${gw.base}/api/p2p/register`, json({ link }))).status, 502);
  });

  const signed = (identity, addr, extra = {}) => {
    const body = { peer_id: identity.peerId, pubkey: identity.pubkey, addr, models: ['echo'], region: 'eu', api_port: 4002, ts: Date.now(), nonce: Math.random().toString(36).slice(2) + 'nonce', ...extra };
    return { ...body, sig: identity.sign(body), metrics: { cpu_percent: 3, evil: 'x' } };
  };

  test('signed self-registration is probed and stored', async () => {
    const payload = signed(node.identity, node.addr);
    const r = await fetch(`${gw.base}/api/nodes/register`, json(payload));
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(db.nodes.get(node.identity.peerId).metrics, { cpu_percent: 3 });
    // Replay is refused.
    assert.equal((await fetch(`${gw.base}/api/nodes/register`, json(payload))).status, 401);
  });

  test('registering someone else\'s address is refused', async () => {
    const attacker = Identity.generate();
    const r = await fetch(`${gw.base}/api/nodes/register`, json(signed(attacker, node.addr)));
    assert.equal(r.status, 403);
    assert.ok(!db.nodes.has(attacker.peerId));
  });

  test('forged signature is refused', async () => {
    const p = signed(Identity.generate(), node.addr);
    p.region = 'tampered';
    assert.equal((await fetch(`${gw.base}/api/nodes/register`, json(p))).status, 401);
  });
});

describe('accounts, API keys and OpenAI API', () => {
  let gw, node, db;
  const userAuth = { authorization: 'Bearer user-token-a' };
  before(async () => {
    node = await startFakeNode({ models: ['echo'] });
    db = new FakeDb();
    gw = await startGateway({ db, config: { defaultQuota: 20 } });
    await gw.mesh.connect(node.addr);
  });
  after(async () => { await gw.close(); await node.close(); });

  test('key management requires a signed-in user', async () => {
    assert.equal((await fetch(`${gw.base}/api/keys`)).status, 401);
    assert.equal((await fetch(`${gw.base}/api/keys`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  });

  let secret, keyId;
  test('create, list and use an API key', async () => {
    const r = await fetch(`${gw.base}/api/keys`, json({ name: 'ci' }, userAuth));
    assert.equal(r.status, 201);
    ({ secret, key: { id: keyId } } = await r.json());
    assert.match(secret, /^b2b_/);
    const list = await (await fetch(`${gw.base}/api/keys`, { headers: userAuth })).json();
    assert.equal(list.keys.length, 1);
    assert.ok(!('secret' in list.keys[0]));

    const completion = await fetch(`${gw.base}/v1/chat/completions`, json({ model: 'echo', messages: [{ role: 'user', content: 'hello world' }] }, { authorization: `Bearer ${secret}` }));
    const body = await completion.json();
    assert.equal(completion.status, 200, JSON.stringify(body));
    assert.equal(body.choices[0].message.content, 'hello world');
    assert.deepEqual(body.usage, { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 });
    await waitFor(() => db.usage.length === 1);
    assert.equal(db.usage[0].api_key_id, keyId);
    assert.equal(db.usage[0].source, 'api');
  });

  test('OpenAI streaming format', async () => {
    const r = await fetch(`${gw.base}/v1/chat/completions`, json({ model: 'echo', stream: true, messages: [{ role: 'user', content: 'a b' }] }, { authorization: `Bearer ${secret}` }));
    const events = (await r.text()).split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => e.slice(6));
    assert.equal(events.at(-1), '[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant' });
    assert.equal(chunks.map((c) => c.choices[0].delta.content || '').join(''), 'a b');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  });

  test('quota is enforced', async () => {
    db.usage.push({ api_key_id: keyId, prompt_tokens: 100, completion_tokens: 0 });
    await new Promise((r) => setTimeout(r, 10));
    const r = await fetch(`${gw.base}/v1/chat/completions`, json({ messages: [{ role: 'user', content: 'x' }] }, { authorization: `Bearer ${secret}` }));
    // usage is cached for up to 10s after a request; the cache was invalidated by the last recorded usage
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error.code, 'quota_exceeded');
  });

  test('revoked keys stop working', async () => {
    assert.equal((await fetch(`${gw.base}/api/keys/${keyId}`, { method: 'DELETE', headers: userAuth })).status, 204);
    const r = await fetch(`${gw.base}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(r.status, 401);
  });

  test('static keys and missing keys', async () => {
    assert.equal((await fetch(`${gw.base}/v1/models`)).status, 401);
    const r = await fetch(`${gw.base}/v1/models`, { headers: { authorization: 'Bearer static-test-key' } });
    assert.deepEqual((await r.json()).data.map((m) => m.id), ['echo']);
  });

  test('signed-in web usage is attributed to the user', async () => {
    const before = db.usage.length;
    await (await fetch(`${gw.base}/api/p2p/generate`, json({ prompt: 'hi there', model: 'echo' }, userAuth))).text();
    await waitFor(() => db.usage.length === before + 1);
    assert.equal(db.usage.at(-1).user_id, '11111111-1111-1111-1111-111111111111');
    const stats = await (await fetch(`${gw.base}/api/p2p/global_metrics`)).json();
    assert.ok(stats.tokens > 0);
  });
});

describe('hardening', () => {
  let gw;
  before(async () => { gw = await startGateway({ config: { rateLimitPerMinute: 3, corsOrigins: ['https://app.example'], metricsToken: 'm' } }); });
  after(async () => { await gw.close(); });

  test('health endpoints', async () => {
    assert.deepEqual(await (await fetch(`${gw.base}/healthz`)).json(), { status: 'ok' });
    assert.equal((await fetch(`${gw.base}/readyz`)).status, 200);
  });

  test('metrics require the token', async () => {
    assert.equal((await fetch(`${gw.base}/metrics`)).status, 401);
    const text = await (await fetch(`${gw.base}/metrics`, { headers: { authorization: 'Bearer m' } })).text();
    assert.match(text, /gateway_connected_nodes 0/);
  });

  test('CORS allowlist', async () => {
    const ok = await fetch(`${gw.base}/healthz`, { headers: { origin: 'https://app.example' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example');
    const bad = await fetch(`${gw.base}/healthz`, { headers: { origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });

  test('rate limiting on API routes', async () => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${gw.base}/api/p2p/global_metrics`)).status);
    assert.ok(codes.includes(429));
  });

  test('private addresses are refused when not allowed', async () => {
    const strict = await startGateway({ config: { allowPrivateNodes: false } });
    strict.mesh.allowPrivate = false;
    const link = `coithub.org://join?bootstrap=${Buffer.from('ws://169.254.169.254:80').toString('base64url')}`;
    const r = await fetch(`${strict.base}/api/p2p/register`, json({ link }));
    assert.equal(r.status, 400);
    await strict.close();
  });

  test('no stack traces or x-powered-by leak', async () => {
    const r = await fetch(`${gw.base}/nope`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('x-powered-by'), null);
  });
});

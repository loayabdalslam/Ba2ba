import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalJson, Identity, peerIdFromPubkey, verify } from '../src/identity.js';
import { isPrivateIp, validateNodeAddr } from '../src/netutil.js';
import { buildAuth, buildHello, modelsMatch, parseGenerationBody, verifyHello, verifyRegistration } from '../src/protocol.js';
import { RateLimiter } from '../src/ratelimit.js';
import { parseJoinLink } from '../src/app.js';

test('canonical JSON sorts keys recursively and rejects floats', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, 'é'], c: null } }), '{"a":{"c":null,"d":[1,"é"]},"b":1}');
  assert.throws(() => canonicalJson({ x: 1.5 }));
});

test('sign/verify and peer id derivation', () => {
  const id = Identity.generate();
  const sig = id.sign({ a: 1 });
  assert.ok(verify(id.pubkey, { a: 1 }, sig));
  assert.ok(!verify(id.pubkey, { a: 2 }, sig));
  assert.equal(peerIdFromPubkey(id.pubkey), id.peerId);
  assert.match(id.peerId, /^peer-[0-9a-f]{32}$/);
});

test('hello verification rejects impersonation and stale challenges', () => {
  const a = Identity.generate();
  const b = Identity.generate();
  const hello = buildHello(a, { role: 'node', challenge: 'x'.repeat(32), responseTo: 'y'.repeat(32) });
  verifyHello(hello, 'y'.repeat(32));
  assert.throws(() => verifyHello(hello, 'z'.repeat(32)), /challenge/);
  assert.throws(() => verifyHello({ ...hello, peer_id: b.peerId }), /does not match/);
  assert.throws(() => verifyHello({ ...hello, addr: 'ws://evil:1' }), /signature/);
  const auth = buildAuth(a, 'c');
  assert.ok(verify(a.pubkey, { type: 'auth', peer_id: a.peerId, response_to: 'c' }, auth.sig));
});

test('signed registration verification', () => {
  const id = Identity.generate();
  const body = { peer_id: id.peerId, pubkey: id.pubkey, addr: 'wss://n.example:4003', models: ['m'], region: 'eu', api_port: 4002, ts: Date.now(), nonce: 'n1' };
  const signed = { ...body, sig: id.sign(body), metrics: { cpu_percent: 1.5 } };
  verifyRegistration(signed);
  assert.throws(() => verifyRegistration({ ...signed, addr: 'wss://other:1' }), /signature/);
  assert.throws(() => verifyRegistration({ ...signed, ts: Date.now() - 3600_000 }), /clock skew/);
});

test('generation body validation and clamping', () => {
  const lim = { maxPromptChars: 10, maxNewTokens: 64 };
  assert.deepEqual(parseGenerationBody({ prompt: 'hi', max_tokens: 1e6, temperature: 9, model: 'default' }, lim),
    { model: null, max_new_tokens: 64, temperature: 2, prompt: 'hi' });
  assert.equal(parseGenerationBody({ task: { prompt: 'legacy' } }, lim).prompt, 'legacy');
  for (const bad of [{}, { prompt: '' }, { prompt: 'x'.repeat(11) }, { messages: [{ role: 'root', content: 'x' }] }, { prompt: 'x', max_tokens: 'many' }]) {
    assert.throws(() => parseGenerationBody(bad, lim));
  }
});

test('model matching is exact modulo :latest', () => {
  assert.ok(modelsMatch('llama3', 'llama3:latest'));
  assert.ok(!modelsMatch('llama', 'llama3:70b'));
  assert.ok(modelsMatch(null, 'x'));
});

test('address validation blocks SSRF targets', () => {
  assert.equal(validateNodeAddr('wss://node.example.com:4003'), 'wss://node.example.com:4003');
  for (const bad of ['http://x:1', 'ws://127.0.0.1:1', 'ws://169.254.169.254', 'ws://[::1]:1', 'ws://localhost:1', 'ws://10.1.2.3:1', 'ws://u:p@h:1']) {
    assert.throws(() => validateNodeAddr(bad), undefined, bad);
  }
  assert.ok(validateNodeAddr('ws://127.0.0.1:1', { allowPrivate: true }));
  assert.throws(() => validateNodeAddr('ws://node.example.com:1', { requireTls: true }), /TLS/);
  assert.ok(isPrivateIp('::ffff:10.0.0.1'));
  assert.ok(!isPrivateIp('8.8.8.8'));
});

test('join link parsing (bare and wrapped)', () => {
  const b64 = Buffer.from('ws://1.2.3.4:4003').toString('base64url');
  const bare = `coithub.org://join?network=x&model=llama3&hash=h&bootstrap=${b64}`;
  assert.deepEqual(parseJoinLink(bare), { addr: 'ws://1.2.3.4:4003', model: 'llama3' });
  const wrapped = `https://coithub.org/register?link=${encodeURIComponent(bare)}&api_port=1`;
  assert.equal(parseJoinLink(wrapped).addr, 'ws://1.2.3.4:4003');
  assert.throws(() => parseJoinLink('https://coithub.org/register'));
});

test('rate limiter', () => {
  const lim = new RateLimiter(60, 2);
  assert.ok(lim.take('a', 1, 0).allowed);
  assert.ok(lim.take('a', 1, 0).allowed);
  const denied = lim.take('a', 1, 0);
  assert.ok(!denied.allowed && denied.retryAfterMs > 0);
  assert.ok(lim.take('a', 1, 1100).allowed);
});

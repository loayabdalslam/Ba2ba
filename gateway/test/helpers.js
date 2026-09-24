// A minimal Bee2Bee node implemented in JS, used to exercise the gateway.
import { WebSocketServer } from 'ws';

import { Identity, newNonce, verify } from '../src/identity.js';
import { buildHello, verifyHello } from '../src/protocol.js';
import { createApp } from '../src/app.js';
import { Mesh } from '../src/mesh.js';
import { Metrics } from '../src/metrics.js';

export async function startFakeNode({ models = ['echo'], behavior = 'echo', region = 'test' } = {}) {
  const identity = Identity.generate();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const addr = `ws://127.0.0.1:${wss.address().port}`;
  const state = { requests: [], cancels: [], sockets: new Set() };
  wss.on('connection', (ws) => {
    state.sockets.add(ws);
    const challenge = newNonce() + newNonce();
    let peer = null;
    let authed = false;
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (!peer) {
        verifyHello(msg);
        peer = msg;
        ws.send(JSON.stringify(buildHello(identity, {
          role: 'node', addr, challenge, responseTo: msg.challenge,
          extra: { region, services: { echo: { models, price_per_token: 0 } }, api_port: 4002, metrics: { cpu_percent: 1 } },
        })));
        return;
      }
      if (!authed) {
        const body = { type: 'auth', peer_id: msg.peer_id, response_to: msg.response_to };
        if (msg.type !== 'auth' || msg.peer_id !== peer.peer_id || msg.response_to !== challenge || !verify(peer.pubkey, body, msg.sig)) {
          ws.close(4003, 'bad auth');
          return;
        }
        authed = true;
        return;
      }
      if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
      if (msg.type === 'gen_cancel') return state.cancels.push(msg.rid);
      if (msg.type !== 'gen_request') return;
      state.requests.push(msg);
      if (behavior === 'fail') return ws.send(JSON.stringify({ type: 'gen_error', rid: msg.rid, code: 'provider_error', error: 'boom' }));
      if (behavior === 'hang') return ws.send(JSON.stringify({ type: 'gen_chunk', rid: msg.rid, text: 'partial' }));
      const text = msg.prompt ?? msg.messages.map((m) => m.content).join(' ');
      const words = text.split(/\s+/).filter(Boolean);
      words.forEach((w, i) => ws.send(JSON.stringify({ type: 'gen_chunk', rid: msg.rid, text: i ? ` ${w}` : w })));
      ws.send(JSON.stringify({
        type: 'gen_done', rid: msg.rid, provider: identity.peerId, backend: 'fake',
        usage: { prompt_tokens: words.length, completion_tokens: words.length },
      }));
    });
    ws.on('close', () => state.sockets.delete(ws));
  });
  return {
    identity, addr, state, wss,
    close: () => new Promise((r) => { for (const s of state.sockets) s.terminate(); wss.close(r); }),
  };
}

export function baseConfig(overrides = {}) {
  return {
    corsOrigins: [], trustProxy: false, allowPrivateNodes: true, requireTlsNodes: false,
    rateLimitPerMinute: 1000, anonRateLimitPerMinute: 1000, maxPromptChars: 1000, maxNewTokens: 256,
    requestTimeoutMs: 2000, metricsToken: '', staticApiKeys: ['static-test-key'], openApi: false,
    defaultQuota: 1000, probeRegistrations: true, staticDir: '', ...overrides,
  };
}

export async function startGateway({ config = {}, db = null } = {}) {
  const cfg = baseConfig(config);
  const metrics = new Metrics();
  const mesh = new Mesh({ identity: Identity.generate(), allowPrivate: true, requestTimeoutMs: cfg.requestTimeoutMs, metrics });
  const app = createApp({ config: cfg, mesh, db, metrics });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, mesh, metrics,
    close: async () => { await mesh.stop(); await new Promise((r) => server.close(r)); },
  };
}

export async function waitFor(fn, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function ndjson(text) {
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** In-memory stand-in for the Supabase-backed Database class. */
export class FakeDb {
  constructor() {
    this.nodes = new Map();
    this.usage = [];
    this.keys = [];
    this.users = new Map([['user-token-a', { id: '11111111-1111-1111-1111-111111111111', email: 'a@x' }]]);
  }
  async listNodes() { return [...this.nodes.values()]; }
  async upsertNode(row) { this.nodes.set(row.peer_id, { ...this.nodes.get(row.peer_id), ...row, verified: true }); }
  async updateReputation() {}
  async stats() { return { total_tokens: this.usage.reduce((s, u) => s + u.prompt_tokens + u.completion_tokens, 0), total_chats: this.usage.length, total_users: 1, active_nodes: this.nodes.size }; }
  async recordUsage(row) { this.usage.push(row); }
  async keyUsageThisMonth(id) { return this.usage.filter((u) => u.api_key_id === id).reduce((s, u) => s + u.prompt_tokens + u.completion_tokens, 0); }
  async getUser(token) { return this.users.get(token) || null; }
  async findApiKey(secret) { return this.keys.find((k) => k.secret === secret && !k.revoked_at) || null; }
  async touchApiKey() {}
  async listApiKeys(userId) { return this.keys.filter((k) => k.user_id === userId).map(({ secret: _s, ...k }) => k); }
  async createApiKey(userId, name, quota) {
    const secret = `b2b_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const key = { id: `aaaaaaaa-0000-0000-0000-00000000000${this.keys.length}`, user_id: userId, name, prefix: secret.slice(0, 12), monthly_token_quota: quota, revoked_at: null, secret };
    this.keys.push(key);
    return { secret, key: { id: key.id, name, prefix: key.prefix, monthly_token_quota: quota } };
  }
  async revokeApiKey(userId, id) {
    const k = this.keys.find((x) => x.id === id && x.user_id === userId && !x.revoked_at);
    if (k) k.revoked_at = new Date().toISOString();
    return Boolean(k);
  }
}

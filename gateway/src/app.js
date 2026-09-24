import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { log } from './logger.js';
import { GenerationError } from './mesh.js';
import { AddressError, validateNodeAddr } from './netutil.js';
import { parseGenerationBody, ProtocolError, verifyRegistration } from './protocol.js';
import { RateLimiter } from './ratelimit.js';
import { Database } from './supabase.js';

const STATUS_FOR_CODE = {
  bad_request: 400,
  unauthorized: 401,
  quota_exceeded: 429,
  rate_limited: 429,
  no_provider: 503,
  busy: 503,
  timeout: 504,
  provider_error: 502,
  cancelled: 499,
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function sanitizeMetrics(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw).slice(0, 20)) {
    if (typeof v === 'number' && Number.isFinite(v) && k.length <= 40) out[k] = v;
  }
  return out;
}

/** Parse a join link (bare `coithub.org://join?...` or wrapped in `https://.../register?link=...`). */
export function parseJoinLink(link) {
  if (typeof link !== 'string' || link.length > 4096) throw new HttpError(400, 'bad_request', 'invalid link');
  let inner = link.trim();
  try {
    const outer = new URL(inner);
    if (outer.searchParams.get('link')) inner = outer.searchParams.get('link');
  } catch {
    /* not a URL with params */
  }
  const query = inner.includes('?') ? inner.slice(inner.indexOf('?') + 1) : inner;
  const params = new URLSearchParams(query);
  const enc = params.get('bootstrap') || params.get('peer');
  if (!enc) throw new HttpError(400, 'bad_request', 'link has no bootstrap address');
  let addr = Buffer.from(enc.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  if (!addr.includes('://')) addr = `ws://${addr}`;
  return { addr, model: params.get('model') || null };
}

export function createApp({ config, mesh, db = null, metrics }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);

  const limiter = new RateLimiter(config.rateLimitPerMinute);
  const anonLimiter = new RateLimiter(config.anonRateLimitPerMinute);
  const registrationLimiter = new RateLimiter(10);
  const seenNonces = new Map();
  const cache = new Map();

  metrics.counter('gateway_http_requests_total', 'HTTP requests');
  metrics.histogram('gateway_http_request_seconds', 'HTTP request latency');
  metrics.counter('gateway_generations_total', 'Generations by source and outcome');
  metrics.counter('gateway_tokens_total', 'Completion tokens served');
  metrics.counter('gateway_node_connections_total', 'Outbound node connections');
  metrics.gauge('gateway_connected_nodes', 'Connected nodes', () => mesh.nodes.size);

  const cached = async (key, ttlMs, fn) => {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await fn();
    cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  };

  // ---------------------------------------------------------------- middleware
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    req.id = String(req.get('x-request-id') || crypto.randomUUID()).slice(0, 64);
    res.set('X-Request-ID', req.id);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = req.route?.path || (res.statusCode === 404 ? 'unmatched' : req.path);
      metrics.inc('gateway_http_requests_total', { method: req.method, route, status: res.statusCode });
      metrics.observe('gateway_http_request_seconds', seconds, { route });
      log.debug('request', { id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(seconds * 1000) });
    });
    next();
  });

  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.corsOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-ID');
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });

  app.use(express.json({ limit: '1mb' }));

  const rateLimit = (lim, keyFn = (req) => req.ip) => (req, res, next) => {
    const { allowed, retryAfterMs } = lim.take(keyFn(req));
    if (allowed) return next();
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).json({ error: 'rate limit exceeded', code: 'rate_limited' });
  };
  app.use(['/api', '/v1'], rateLimit(limiter));

  // ---------------------------------------------------------------- auth
  const bearer = (req) => {
    const h = req.get('authorization') || '';
    return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
  };

  const optionalUser = async (req) => {
    const token = bearer(req);
    if (!token || token.startsWith('b2b_') || !db) return null;
    return db.getUser(token);
  };

  const requireUser = asyncRoute(async (req, res, next) => {
    if (!db) throw new HttpError(503, 'unavailable', 'accounts are not configured on this gateway');
    const user = await optionalUser(req);
    if (!user) throw new HttpError(401, 'unauthorized', 'sign in required');
    req.user = user;
    next();
  });

  const requireApiKey = asyncRoute(async (req, res, next) => {
    const token = bearer(req);
    if (token && config.staticApiKeys.some((k) => timingSafeEqualStr(k, token))) {
      req.apiKey = { id: null, user_id: null, static: true };
      return next();
    }
    if (token && token.startsWith('b2b_') && db) {
      const key = await db.findApiKey(token);
      if (key) {
        const used = await cached(`usage:${key.id}`, 10000, () => db.keyUsageThisMonth(key.id));
        if (used >= key.monthly_token_quota) throw new HttpError(429, 'quota_exceeded', 'monthly token quota exceeded');
        req.apiKey = key;
        db.touchApiKey(key.id).catch(() => {});
        return next();
      }
    }
    if (config.openApi && !token) {
      req.apiKey = null;
      return next();
    }
    throw new HttpError(401, 'unauthorized', 'a valid API key is required (Authorization: Bearer b2b_...)');
  });

  // ---------------------------------------------------------------- helpers
  const recordUsage = (source, { user = null, apiKey = null, model, final }) => {
    const usage = final?.usage || {};
    const completion = Number(usage.completion_tokens) || 0;
    metrics.inc('gateway_tokens_total', { source }, completion);
    if (!db) return;
    db.recordUsage({
      user_id: user?.id || apiKey?.user_id || null,
      api_key_id: apiKey?.id || null,
      source,
      model: model || null,
      provider: final?.provider || null,
      prompt_tokens: Number(usage.prompt_tokens) || 0,
      completion_tokens: completion,
    }).catch((e) => log.warn('usage recording failed', { error: e.message }));
    if (apiKey?.id) cache.delete(`usage:${apiKey.id}`);
  };

  /** Start a generation and await its first item so failures become HTTP errors. */
  const openGeneration = async (genReq, targetPeer, req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const iterator = mesh.generate(genReq, { targetPeer, signal: controller.signal });
    const first = await iterator.next();
    return { first, iterator };
  };

  const generationFailed = (res, e) => {
    const code = e.code || 'provider_error';
    return res.status(STATUS_FOR_CODE[code] || 502).json({ error: e.message, code });
  };

  // ---------------------------------------------------------------- health
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (req, res) => res.json({ status: 'ready', nodes: mesh.nodes.size, database: Boolean(db) }));
  app.get('/metrics', (req, res) => {
    if (config.metricsToken && !timingSafeEqualStr(bearer(req) || '', config.metricsToken)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return res.type('text/plain; version=0.0.4').send(metrics.render());
  });

  // ---------------------------------------------------------------- mesh status
  app.get('/api/p2p/status', asyncRoute(async (req, res) => {
    const connected = mesh.providers();
    let registered = [];
    if (db) {
      try {
        registered = await cached('nodes', 15000, () => db.listNodes(100));
      } catch (e) {
        log.warn('registry read failed', { error: e.message });
      }
    }
    const seen = new Set(connected.map((n) => n.peer_id));
    const peers = [
      ...connected,
      ...registered.filter((n) => !seen.has(n.peer_id)).map((n) => ({
        peer_id: n.peer_id, addr: n.addr, region: n.region || 'Global', models: n.models || [], metrics: n.metrics || {},
        api_port: n.api_port, reputation: n.reputation, connected: false, status: 'registered', last_seen: n.last_seen,
      })),
    ];
    const mesh_ = {};
    for (const p of peers) (mesh_[p.region || 'Global'] ||= []).push(p);
    res.json({
      status: connected.length ? 'active' : 'idle',
      connected: connected.length > 0,
      activeNode: connected[0]?.addr || null,
      poolSize: peers.length,
      connectedNodes: connected.length,
      models: [...new Set(peers.flatMap((p) => p.models || []))].sort(),
      peers,
      mesh: mesh_,
    });
  }));

  // Register a node from a join link: the gateway connects and the handshake
  // proves the node's identity before anything is written to the registry.
  app.post('/api/p2p/register', rateLimit(registrationLimiter), asyncRoute(async (req, res) => {
    const { addr } = parseJoinLink(req.body?.link);
    let node;
    try {
      node = await mesh.connect(addr);
    } catch (e) {
      if (e instanceof AddressError) throw new HttpError(400, 'bad_request', e.message);
      throw new HttpError(502, 'unreachable', `could not reach node: ${e.message}`);
    }
    let persisted = false;
    if (db) {
      try {
        await db.upsertNode({
          peer_id: node.peerId, pubkey: node.pubkey, addr: node.addr, region: node.region || 'Global',
          models: node.models, metrics: sanitizeMetrics(node.metrics), api_port: node.apiPort,
        });
        persisted = true;
        cache.delete('nodes');
      } catch (e) {
        log.warn('registry write failed', { error: e.message });
      }
    }
    res.json({ success: true, persisted, node: node.info(mesh.stats.get(node.peerId)) });
  }));

  // Signed self-registration from nodes (bee2bee/registry.py).
  app.post('/api/nodes/register', rateLimit(registrationLimiter), asyncRoute(async (req, res) => {
    const body = req.body;
    try {
      verifyRegistration(body);
    } catch (e) {
      throw new HttpError(e.code === 'unauthorized' ? 401 : 400, e.code, e.message);
    }
    const now = Date.now();
    for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
    if (seenNonces.has(body.nonce)) throw new HttpError(401, 'unauthorized', 'replayed registration');
    seenNonces.set(body.nonce, now + 10 * 60 * 1000);

    let addr;
    try {
      addr = validateNodeAddr(body.addr, { requireTls: config.requireTlsNodes, allowPrivate: config.allowPrivateNodes });
    } catch (e) {
      throw new HttpError(400, 'bad_request', e.message);
    }
    let node = null;
    if (config.probeRegistrations) {
      try {
        node = await mesh.connect(addr);
      } catch (e) {
        throw new HttpError(422, 'unreachable', `gateway could not reach ${addr}: ${e.message}`);
      }
      if (node.peerId !== body.peer_id) throw new HttpError(403, 'unauthorized', 'address is served by a different node');
    }
    if (!db) return res.json({ ok: true, persisted: false, peer_id: body.peer_id });
    await db.upsertNode({
      peer_id: body.peer_id, pubkey: body.pubkey, addr, region: body.region.slice(0, 64) || 'Global',
      models: node ? node.models : body.models, metrics: sanitizeMetrics(body.metrics),
      api_port: body.api_port || null, reputation: mesh.statsFor(body.peer_id).score,
    });
    cache.delete('nodes');
    return res.json({ ok: true, persisted: true, peer_id: body.peer_id });
  }));

  // ---------------------------------------------------------------- web chat
  app.post('/api/p2p/generate', asyncRoute(async (req, res) => {
    const user = await optionalUser(req);
    if (!user) {
      const { allowed, retryAfterMs } = anonLimiter.take(`anon:${req.ip}`);
      if (!allowed) {
        res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        throw new HttpError(429, 'rate_limited', 'too many anonymous requests; sign in for higher limits');
      }
    }
    let genReq;
    try {
      genReq = parseGenerationBody(req.body || {}, config);
    } catch (e) {
      throw new HttpError(400, e.code || 'bad_request', e.message);
    }
    const target = req.body?.targetNode || req.body?.task?.targetNode || null;
    const targetPeer = typeof target === 'string' && target.length <= 512 ? target : null;

    let gen;
    try {
      gen = await openGeneration(genReq, targetPeer, req, res);
    } catch (e) {
      metrics.inc('gateway_generations_total', { source: 'web', outcome: e.code || 'error' });
      return generationFailed(res, e);
    }
    res.status(200).set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let final = null;
    try {
      let item = gen.first;
      while (!item.done) {
        const value = item.value;
        if (value.done) final = value;
        res.write(JSON.stringify(value) + '\n');
        item = await gen.iterator.next();
      }
      metrics.inc('gateway_generations_total', { source: 'web', outcome: 'ok' });
      recordUsage('web', { user, model: genReq.model, final });
    } catch (e) {
      metrics.inc('gateway_generations_total', { source: 'web', outcome: e.code || 'error' });
      if (!res.destroyed) res.write(JSON.stringify({ error: e.message, code: e.code || 'provider_error' }) + '\n');
    }
    return res.end();
  }));

  app.get('/api/p2p/global_metrics', asyncRoute(async (req, res) => {
    let stats = null;
    if (db) {
      try {
        stats = await cached('stats', 15000, () => db.stats());
      } catch (e) {
        log.warn('stats read failed', { error: e.message });
      }
    }
    res.json({
      tokens: Number(stats?.total_tokens) || 0,
      chats: Number(stats?.total_chats) || 0,
      users: Number(stats?.total_users) || 0,
      active_nodes: Number(stats?.active_nodes) || mesh.nodes.size,
    });
  }));

  app.post('/api/client-errors', rateLimit(new RateLimiter(10)), (req, res) => {
    const b = req.body || {};
    log.warn('client error', {
      id: req.id,
      message: String(b.message || '').slice(0, 500),
      stack: String(b.stack || '').slice(0, 2000),
      url: String(b.url || '').slice(0, 300),
    });
    res.status(204).end();
  });

  // ---------------------------------------------------------------- API keys
  app.get('/api/keys', requireUser, asyncRoute(async (req, res) => {
    res.json({ keys: await db.listApiKeys(req.user.id) });
  }));

  app.post('/api/keys', requireUser, asyncRoute(async (req, res) => {
    const name = String(req.body?.name || 'default').trim().slice(0, 60) || 'default';
    const existing = await db.listApiKeys(req.user.id);
    if (existing.filter((k) => !k.revoked_at).length >= 10) throw new HttpError(400, 'bad_request', 'maximum of 10 active keys');
    const { secret, key } = await db.createApiKey(req.user.id, name, config.defaultQuota);
    res.status(201).json({ key, secret, warning: 'Store this secret now; it cannot be shown again.' });
  }));

  app.delete('/api/keys/:id', requireUser, asyncRoute(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw new HttpError(400, 'bad_request', 'invalid key id');
    const ok = await db.revokeApiKey(req.user.id, req.params.id);
    if (!ok) throw new HttpError(404, 'not_found', 'key not found');
    res.status(204).end();
  }));

  app.get('/api/usage', requireUser, asyncRoute(async (req, res) => {
    const keys = await db.listApiKeys(req.user.id);
    const usage = await Promise.all(keys.filter((k) => !k.revoked_at).map(async (k) => ({
      key_id: k.id, name: k.name, used: await db.keyUsageThisMonth(k.id), quota: k.monthly_token_quota,
    })));
    res.json({ usage });
  }));

  // ---------------------------------------------------------------- OpenAI compatible
  const openaiError = (res, status, code, message) => res.status(status).json({ error: { message, type: 'bee2bee_error', code } });

  app.get('/v1/models', requireApiKey, (req, res) => {
    res.json({ object: 'list', data: mesh.models().map((id) => ({ id, object: 'model', owned_by: 'bee2bee' })) });
  });

  app.post('/v1/chat/completions', requireApiKey, asyncRoute(async (req, res) => {
    const body = req.body || {};
    let genReq;
    try {
      if (!Array.isArray(body.messages)) throw new ProtocolError('bad_request', 'messages is required');
      genReq = parseGenerationBody({ ...body, prompt: undefined }, config);
    } catch (e) {
      return openaiError(res, 400, 'bad_request', e.message);
    }
    let gen;
    try {
      gen = await openGeneration(genReq, null, req, res);
    } catch (e) {
      metrics.inc('gateway_generations_total', { source: 'api', outcome: e.code || 'error' });
      return openaiError(res, STATUS_FOR_CODE[e.code] || 502, e.code || 'provider_error', e.message);
    }
    const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model || 'bee2bee';
    const toUsage = (final) => {
      const p = Number(final?.usage?.prompt_tokens) || 0;
      const c = Number(final?.usage?.completion_tokens) || 0;
      return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
    };

    if (body.stream) {
      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const chunk = (delta, finish = null, usage) => {
        const payload = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
        if (usage) payload.usage = usage;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      chunk({ role: 'assistant' });
      let final = null;
      try {
        let item = gen.first;
        while (!item.done) {
          if (item.value.done) final = item.value;
          else chunk({ content: item.value.text });
          item = await gen.iterator.next();
        }
        chunk({}, 'stop', toUsage(final));
        metrics.inc('gateway_generations_total', { source: 'api', outcome: 'ok' });
        recordUsage('api', { apiKey: req.apiKey, model: genReq.model, final });
      } catch (e) {
        metrics.inc('gateway_generations_total', { source: 'api', outcome: e.code || 'error' });
        res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'bee2bee_error', code: e.code } })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const parts = [];
    let final = null;
    try {
      let item = gen.first;
      while (!item.done) {
        if (item.value.done) final = item.value;
        else parts.push(item.value.text);
        item = await gen.iterator.next();
      }
    } catch (e) {
      metrics.inc('gateway_generations_total', { source: 'api', outcome: e.code || 'error' });
      return openaiError(res, STATUS_FOR_CODE[e.code] || 502, e.code || 'provider_error', e.message);
    }
    metrics.inc('gateway_generations_total', { source: 'api', outcome: 'ok' });
    recordUsage('api', { apiKey: req.apiKey, model: genReq.model, final });
    return res.json({
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: parts.join('') }, finish_reason: 'stop' }],
      usage: toUsage(final),
    });
  }));

  // ---------------------------------------------------------------- static SPA (optional)
  if (config.staticDir && fs.existsSync(config.staticDir)) {
    const root = path.resolve(config.staticDir);
    app.use(express.static(root, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/(api|v1)\/).*/, (req, res) => res.sendFile(path.join(root, 'index.html')));
  }

  // ---------------------------------------------------------------- errors
  app.use((req, res) => res.status(404).json({ error: `route ${req.method} ${req.path} not found`, code: 'not_found' }));
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      if (req.path.startsWith('/v1/')) return openaiError(res, err.status, err.code, err.message);
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err instanceof GenerationError) return generationFailed(res, err);
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'request body too large', code: 'too_large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON', code: 'bad_request' });
    log.error('unhandled error', { id: req.id, error: err?.message, stack: err?.stack });
    return res.status(500).json({ error: 'internal error', code: 'internal', request_id: req.id });
  });

  return app;
}

export { Database };

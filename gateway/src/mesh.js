// Authenticated client connections from the gateway to Bee2Bee nodes.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import { newNonce } from './identity.js';
import { log } from './logger.js';
import { AddressError, makeSafeLookup, validateNodeAddr } from './netutil.js';
import { buildAuth, buildHello, ERROR_CODES, modelsMatch, ProtocolError, verifyHello } from './protocol.js';

const HANDSHAKE_TIMEOUT_MS = 10000;
const PING_INTERVAL_MS = 20000;
const DEAD_AFTER_MS = 60000;
const MAX_FAILOVER = 3;
const MAX_MESSAGE_BYTES = 1024 * 1024;

export class GenerationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function sanitizeServices(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, meta] of Object.entries(raw).slice(0, 16)) {
    if (!meta || typeof meta !== 'object') continue;
    const models = (Array.isArray(meta.models) ? meta.models : []).filter((m) => typeof m === 'string' && m.length > 0 && m.length <= 200).slice(0, 50);
    if (!models.length) continue;
    out[String(name).slice(0, 64)] = {
      models,
      price_per_token: Math.max(0, Number(meta.price_per_token) || 0),
      backend: typeof meta.backend === 'string' ? meta.backend.slice(0, 64) : undefined,
      tokens_per_sec: typeof meta.tokens_per_sec === 'number' ? meta.tokens_per_sec : undefined,
    };
  }
  return out;
}

class NodeConnection {
  constructor(ws, dialAddr) {
    this.ws = ws;
    this.dialAddr = dialAddr;
    this.peerId = null;
    this.pubkey = null;
    this.addr = dialAddr;
    this.region = '';
    this.version = '';
    this.services = {};
    this.metrics = {};
    this.apiPort = null;
    this.lastSeen = Date.now();
    this.latencyMs = null;
    this.connectedAt = Date.now();
  }

  get models() {
    return [...new Set(Object.values(this.services).flatMap((s) => s.models))].sort();
  }

  send(obj) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  info(stats) {
    return {
      peer_id: this.peerId,
      addr: this.addr,
      region: this.region || 'Global',
      version: this.version,
      models: this.models,
      metrics: this.metrics,
      api_port: this.apiPort,
      latency_ms: this.latencyMs,
      connected: true,
      status: 'active',
      ...(stats ? stats.toJSON() : {}),
    };
  }
}

class ProviderStats {
  constructor() {
    this.successes = 0;
    this.failures = 0;
  }
  get score() {
    return (this.successes + 1) / (this.successes + this.failures + 2);
  }
  toJSON() {
    return { successes: this.successes, failures: this.failures, reputation: Math.round(this.score * 1000) / 1000 };
  }
}

export class Mesh extends EventEmitter {
  constructor({ identity, allowPrivate = false, requireTls = false, maxConnections = 20, requestTimeoutMs = 120000, metrics = null }) {
    super();
    this.identity = identity;
    this.allowPrivate = allowPrivate;
    this.requireTls = requireTls;
    this.maxConnections = maxConnections;
    this.requestTimeoutMs = requestTimeoutMs;
    this.metrics = metrics;
    this.nodes = new Map(); // peerId -> NodeConnection
    this.known = new Set(); // addresses to keep connected to
    this.dialing = new Map(); // addr -> Promise
    this.backoff = new Map(); // addr -> {failures, next}
    this.pending = new Map(); // rid -> {peerId, onEvent}
    this.stats = new Map(); // peerId -> ProviderStats
    this.timer = null;
  }

  start() {
    setImmediate(() => this.#maintain()); // dial seeds right away
    this.timer = setInterval(() => this.#maintain(), 5000);
    this.timer.unref?.();
  }

  async stop() {
    clearInterval(this.timer);
    for (const p of this.pending.values()) p.onEvent({ kind: 'error', code: 'cancelled', error: 'gateway shutting down' });
    for (const node of this.nodes.values()) node.ws.close(1001, 'shutdown');
    this.nodes.clear();
  }

  statsFor(peerId) {
    if (!this.stats.has(peerId)) this.stats.set(peerId, new ProviderStats());
    return this.stats.get(peerId);
  }

  addKnown(addr) {
    try {
      this.known.add(validateNodeAddr(addr, { requireTls: this.requireTls, allowPrivate: this.allowPrivate }));
    } catch (e) {
      log.warn('ignoring invalid node address', { addr, error: e.message });
    }
  }

  byAddr(addr) {
    for (const node of this.nodes.values()) if (node.addr === addr || node.dialAddr === addr) return node;
    return null;
  }

  /** Connect to a node and complete the mutual handshake. Resolves with the NodeConnection. */
  connect(rawAddr) {
    const addr = validateNodeAddr(rawAddr, { requireTls: this.requireTls, allowPrivate: this.allowPrivate });
    const existing = this.byAddr(addr);
    if (existing) return Promise.resolve(existing);
    if (this.dialing.has(addr)) return this.dialing.get(addr);
    if (this.nodes.size >= this.maxConnections) return Promise.reject(new Error('connection limit reached'));
    const promise = this.#dial(addr).finally(() => this.dialing.delete(addr));
    this.dialing.set(addr, promise);
    return promise;
  }

  #dial(addr) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(addr, {
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: MAX_MESSAGE_BYTES,
        lookup: makeSafeLookup(this.allowPrivate),
      });
      const conn = new NodeConnection(ws, addr);
      const challenge = newNonce() + newNonce();
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#noteFailure(addr);
        this.metrics?.inc('gateway_node_connections_total', { outcome: 'error' });
        try { ws.terminate(); } catch { /* ignore */ }
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const timer = setTimeout(() => fail(new Error(`handshake with ${addr} timed out`)), HANDSHAKE_TIMEOUT_MS);

      ws.on('open', () => {
        conn.send(buildHello(this.identity, { role: 'client', challenge }));
      });
      ws.on('error', (e) => fail(e));
      ws.on('close', (code, reason) => {
        if (!settled) fail(new Error(`closed during handshake (${code} ${reason})`));
        else this.#onClose(conn);
      });
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          if (!settled) fail(new ProtocolError('bad_request', 'invalid JSON'));
          return;
        }
        conn.lastSeen = Date.now();
        if (!settled) {
          try {
            if (msg.type !== 'hello') throw new ProtocolError('unauthorized', `unexpected ${msg.type} before hello`);
            verifyHello(msg, challenge);
            if (msg.role !== 'node') throw new ProtocolError('unauthorized', 'remote is not a node');
            conn.peerId = msg.peer_id;
            conn.pubkey = msg.pubkey;
            conn.addr = msg.addr || addr;
            conn.region = String(msg.region || '').slice(0, 64);
            conn.version = String(msg.version || '').slice(0, 32);
            conn.services = sanitizeServices(msg.services);
            conn.metrics = msg.metrics && typeof msg.metrics === 'object' ? msg.metrics : {};
            conn.apiPort = Number.isInteger(msg.api_port) ? msg.api_port : null;
            conn.send(buildAuth(this.identity, msg.challenge));
          } catch (e) {
            fail(e);
            return;
          }
          settled = true;
          clearTimeout(timer);
          const previous = this.nodes.get(conn.peerId);
          if (previous && previous !== conn) previous.ws.close(4009, 'replaced');
          this.nodes.set(conn.peerId, conn);
          this.backoff.delete(addr);
          this.known.add(addr);
          this.metrics?.inc('gateway_node_connections_total', { outcome: 'ok' });
          conn.send({ type: 'ping', ts: Date.now() });
          log.info('connected to node', { peer_id: conn.peerId, addr: conn.addr, models: conn.models });
          this.emit('node', conn);
          resolve(conn);
          return;
        }
        this.#onMessage(conn, msg);
      });
    });
  }

  #noteFailure(addr) {
    const failures = (this.backoff.get(addr)?.failures || 0) + 1;
    const delay = Math.min(300000, 2000 * 2 ** (failures - 1)) * (0.8 + Math.random() * 0.4);
    this.backoff.set(addr, { failures, next: Date.now() + delay });
  }

  #onClose(conn) {
    if (conn.peerId && this.nodes.get(conn.peerId) === conn) {
      this.nodes.delete(conn.peerId);
      log.info('node disconnected', { peer_id: conn.peerId });
      for (const p of this.pending.values()) {
        if (p.peerId === conn.peerId) p.onEvent({ kind: 'error', code: 'provider_error', error: 'node disconnected' });
      }
    }
  }

  #onMessage(conn, msg) {
    switch (msg.type) {
      case 'ping':
        if (msg.metrics && typeof msg.metrics === 'object') conn.metrics = msg.metrics;
        conn.send({ type: 'pong', ts: msg.ts });
        return;
      case 'pong':
        if (typeof msg.ts === 'number') {
          const rtt = Date.now() - msg.ts;
          if (rtt >= 0 && rtt < 600000) conn.latencyMs = rtt;
        }
        return;
      case 'service_announce': {
        const svc = sanitizeServices({ [msg.service]: msg.meta });
        Object.assign(conn.services, svc);
        return;
      }
      case 'peer_list':
        return; // the gateway only talks to nodes it was told about
      case 'gen_chunk':
      case 'gen_done':
      case 'gen_result':
      case 'gen_success':
      case 'gen_error': {
        const p = this.pending.get(msg.rid);
        if (!p || p.peerId !== conn.peerId) return;
        if (msg.type === 'gen_chunk') {
          if (typeof msg.text === 'string') p.onEvent({ kind: 'chunk', text: msg.text });
        } else if (msg.type === 'gen_error' || msg.error) {
          p.onEvent({ kind: 'error', code: ERROR_CODES.has(msg.code) ? msg.code : 'provider_error', error: String(msg.error || msg.code).slice(0, 300) });
        } else {
          p.onEvent({ kind: 'done', data: msg });
        }
        return;
      }
      default:
        return;
    }
  }

  #maintain() {
    const now = Date.now();
    for (const node of this.nodes.values()) {
      if (now - node.lastSeen > DEAD_AFTER_MS) {
        log.warn('evicting unresponsive node', { peer_id: node.peerId });
        node.ws.terminate();
      } else if (now - node.lastSeen > PING_INTERVAL_MS / 2) {
        node.send({ type: 'ping', ts: now });
      }
    }
    for (const addr of this.known) {
      if (this.nodes.size + this.dialing.size >= this.maxConnections) break;
      if (this.byAddr(addr) || this.dialing.has(addr)) continue;
      const b = this.backoff.get(addr);
      if (b && b.next > now) continue;
      this.connect(addr).catch((e) => log.debug('dial failed', { addr, error: e.message }));
    }
  }

  providers() {
    return [...this.nodes.values()].map((n) => n.info(this.stats.get(n.peerId)));
  }

  models() {
    return [...new Set([...this.nodes.values()].flatMap((n) => n.models))].sort();
  }

  /** Candidate nodes for a model: those serving it first (best reputation, then latency), then relays. */
  candidates(model, targetPeer) {
    if (targetPeer) {
      const node = this.nodes.get(targetPeer) || this.byAddr(targetPeer);
      return node ? [node] : [];
    }
    const nodes = [...this.nodes.values()];
    const serving = nodes.filter((n) => n.models.some((m) => modelsMatch(model, m)));
    const rank = (a, b) => this.statsFor(b.peerId).score - this.statsFor(a.peerId).score || (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9);
    serving.sort(rank);
    const relays = nodes.filter((n) => !serving.includes(n)).sort(rank);
    return [...serving, ...relays];
  }

  /**
   * Stream a generation. Yields {text} chunks, then a final {done: true, usage, provider}.
   * Fails over to the next candidate if a node errors before producing output.
   */
  async *generate(req, { targetPeer = null, signal } = {}) {
    const candidates = this.candidates(req.model, targetPeer).slice(0, MAX_FAILOVER);
    if (!candidates.length) {
      throw new GenerationError('no_provider', targetPeer ? 'requested node is not connected' : 'no nodes are connected');
    }
    let lastError = null;
    for (const node of candidates) {
      let emitted = false;
      try {
        for await (const item of this.#generateOn(node, req, signal)) {
          if (item.text !== undefined) emitted = true;
          yield item;
        }
        return;
      } catch (e) {
        lastError = e instanceof GenerationError ? e : new GenerationError('provider_error', e.message);
        // Capacity signals (busy, rate_limited) are not failures of the node.
        if (!['cancelled', 'bad_request', 'busy', 'rate_limited'].includes(lastError.code)) this.statsFor(node.peerId).failures += 1;
        if (emitted || ['bad_request', 'cancelled'].includes(lastError.code) || signal?.aborted) throw lastError;
        log.warn('node failed, trying next', { peer_id: node.peerId, code: lastError.code });
      }
    }
    throw lastError;
  }

  async *#generateOn(node, req, signal) {
    const rid = 'gw-' + crypto.randomBytes(8).toString('hex');
    const queue = [];
    let wake = null;
    const onEvent = (ev) => {
      queue.push(ev);
      if (wake) wake();
    };
    this.pending.set(rid, { peerId: node.peerId, onEvent });
    const onAbort = () => onEvent({ kind: 'error', code: 'cancelled', error: 'client cancelled' });
    signal?.addEventListener('abort', onAbort, { once: true });
    const started = Date.now();
    let finished = false;
    try {
      if (!node.send({ type: 'gen_request', rid, ...req, stream: true, hops: 0 })) {
        throw new GenerationError('provider_error', 'node connection is not open');
      }
      while (true) {
        if (!queue.length) {
          let timer;
          await new Promise((resolve) => {
            wake = resolve;
            timer = setTimeout(() => onEvent({ kind: 'error', code: 'timeout', error: 'node timed out' }), this.requestTimeoutMs);
          });
          clearTimeout(timer);
          wake = null;
        }
        const ev = queue.shift();
        if (ev.kind === 'chunk') {
          yield { text: ev.text };
        } else if (ev.kind === 'done') {
          finished = true;
          this.statsFor(node.peerId).successes += 1;
          const d = ev.data;
          if (typeof d.text === 'string' && d.text) yield { text: d.text };
          yield {
            done: true,
            usage: d.usage && typeof d.usage === 'object' ? d.usage : {},
            provider: typeof d.provider === 'string' ? d.provider : node.peerId,
            via: node.peerId,
            backend: d.backend,
            latency_ms: Date.now() - started,
          };
          return;
        } else {
          finished = ev.code !== 'cancelled' && ev.code !== 'timeout';
          throw new GenerationError(ev.code, ev.error);
        }
      }
    } finally {
      this.pending.delete(rid);
      signal?.removeEventListener('abort', onAbort);
      if (!finished) node.send({ type: 'gen_cancel', rid });
    }
  }
}

export { AddressError };

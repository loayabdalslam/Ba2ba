// Bee2Bee wire protocol v2 (see docs/PROTOCOL.md and bee2bee/protocol.py).
import { newNonce, peerIdFromPubkey, verify } from './identity.js';

export const PROTOCOL_VERSION = 2;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const HELLO_SIGNED_FIELDS = ['type', 'protocol_version', 'peer_id', 'pubkey', 'role', 'addr', 'ts', 'nonce', 'challenge', 'response_to'];
export const ERROR_CODES = new Set(['bad_request', 'busy', 'no_provider', 'rate_limited', 'timeout', 'provider_error', 'cancelled', 'unauthorized']);

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

export function buildHello(identity, { role, addr = '', challenge, responseTo = '', extra = {} }) {
  const msg = {
    type: 'hello',
    protocol_version: PROTOCOL_VERSION,
    peer_id: identity.peerId,
    pubkey: identity.pubkey,
    role,
    addr,
    ts: Date.now(),
    nonce: newNonce(),
    challenge,
    response_to: responseTo,
  };
  msg.sig = identity.sign(pick(msg, HELLO_SIGNED_FIELDS));
  return { ...extra, ...msg };
}

export function verifyHello(msg, expectedResponse = null) {
  if (!msg || typeof msg !== 'object') throw new ProtocolError('bad_request', 'hello must be an object');
  if (msg.protocol_version !== PROTOCOL_VERSION) throw new ProtocolError('bad_request', `unsupported protocol_version ${msg.protocol_version}`);
  for (const key of HELLO_SIGNED_FIELDS) {
    if (!(key in msg)) throw new ProtocolError('bad_request', `hello missing ${key}`);
  }
  for (const key of ['peer_id', 'pubkey', 'nonce', 'challenge', 'sig', 'addr', 'response_to']) {
    if (typeof msg[key] !== 'string') throw new ProtocolError('bad_request', `invalid ${key}`);
  }
  if (!['node', 'client'].includes(msg.role)) throw new ProtocolError('bad_request', 'invalid role');
  if (!Number.isInteger(msg.ts)) throw new ProtocolError('bad_request', 'invalid ts');
  if (Math.abs(Date.now() - msg.ts) > MAX_CLOCK_SKEW_MS) throw new ProtocolError('unauthorized', 'hello timestamp outside allowed clock skew');
  if (msg.challenge.length < 16) throw new ProtocolError('bad_request', 'challenge too short');
  let derived;
  try {
    derived = peerIdFromPubkey(msg.pubkey);
  } catch {
    throw new ProtocolError('unauthorized', 'invalid pubkey');
  }
  if (derived !== msg.peer_id) throw new ProtocolError('unauthorized', 'peer_id does not match pubkey');
  if (!verify(msg.pubkey, pick(msg, HELLO_SIGNED_FIELDS), msg.sig)) throw new ProtocolError('unauthorized', 'invalid hello signature');
  if (expectedResponse !== null && msg.response_to !== expectedResponse) throw new ProtocolError('unauthorized', 'hello does not answer our challenge');
}

export function buildAuth(identity, responseTo) {
  const body = { type: 'auth', peer_id: identity.peerId, response_to: responseTo };
  return { ...body, sig: identity.sign(body) };
}

/** Verify a node's signed registration (see bee2bee/registry.py build_registration). */
export const REGISTRATION_SIGNED_FIELDS = ['peer_id', 'pubkey', 'addr', 'models', 'region', 'api_port', 'ts', 'nonce'];

export function verifyRegistration(body) {
  if (!body || typeof body !== 'object') throw new ProtocolError('bad_request', 'invalid body');
  for (const key of ['peer_id', 'pubkey', 'addr', 'region', 'nonce', 'sig']) {
    if (typeof body[key] !== 'string' || body[key].length > 512) throw new ProtocolError('bad_request', `invalid ${key}`);
  }
  if (!Array.isArray(body.models) || body.models.length > 100 || body.models.some((m) => typeof m !== 'string' || m.length > 200)) {
    throw new ProtocolError('bad_request', 'invalid models');
  }
  if (!Number.isInteger(body.ts) || !Number.isInteger(body.api_port)) throw new ProtocolError('bad_request', 'invalid ts/api_port');
  if (Math.abs(Date.now() - body.ts) > MAX_CLOCK_SKEW_MS) throw new ProtocolError('unauthorized', 'registration timestamp outside allowed clock skew');
  if (peerIdFromPubkey(body.pubkey) !== body.peer_id) throw new ProtocolError('unauthorized', 'peer_id does not match pubkey');
  if (!verify(body.pubkey, pick(body, REGISTRATION_SIGNED_FIELDS), body.sig)) throw new ProtocolError('unauthorized', 'invalid signature');
}

export function parseGenerationBody(body, { maxPromptChars, maxNewTokens }) {
  const prompt = body.prompt ?? body.task?.prompt;
  const messages = body.messages;
  if (prompt == null && messages == null) throw new ProtocolError('bad_request', 'prompt or messages is required');
  let chars = 0;
  if (prompt != null) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new ProtocolError('bad_request', 'prompt must be a non-empty string');
    chars += prompt.length;
  }
  let cleanMessages;
  if (messages != null) {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 256) throw new ProtocolError('bad_request', 'messages must be a non-empty list (max 256)');
    cleanMessages = messages.map((m) => {
      if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') {
        throw new ProtocolError('bad_request', 'each message needs a valid role and string content');
      }
      chars += m.content.length;
      return { role: m.role, content: m.content };
    });
  }
  if (chars > maxPromptChars) throw new ProtocolError('bad_request', `prompt exceeds ${maxPromptChars} characters`);
  const model = body.model ?? body.task?.model;
  if (model != null && (typeof model !== 'string' || model.length > 200)) throw new ProtocolError('bad_request', 'invalid model');
  const rawTokens = body.max_new_tokens ?? body.max_tokens ?? body.max_completion_tokens;
  let tokens = rawTokens == null ? Math.min(512, maxNewTokens) : Number.parseInt(rawTokens, 10);
  if (!Number.isFinite(tokens)) throw new ProtocolError('bad_request', 'max_tokens must be an integer');
  tokens = Math.max(1, Math.min(tokens, maxNewTokens));
  let temperature = body.temperature == null ? 0.7 : Number(body.temperature);
  if (!Number.isFinite(temperature)) throw new ProtocolError('bad_request', 'temperature must be a number');
  temperature = Math.max(0, Math.min(temperature, 2));
  const req = { model: model && model !== 'default' ? model : null, max_new_tokens: tokens, temperature };
  if (prompt != null) req.prompt = prompt;
  if (cleanMessages) req.messages = cleanMessages;
  return req;
}

export function normalizeModel(name) {
  let n = String(name).trim().toLowerCase();
  if (n.endsWith(':latest')) n = n.slice(0, -':latest'.length);
  return n;
}

export function modelsMatch(requested, offered) {
  if (!requested) return true;
  return normalizeModel(requested) === normalizeModel(offered);
}

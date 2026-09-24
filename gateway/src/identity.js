// Ed25519 identity, byte-compatible with bee2bee/identity.py.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** JSON with recursively sorted keys and no whitespace (matches Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)). */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isInteger(value)) {
      throw new Error('floats are not allowed in signed payloads');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function peerIdFromPubkey(pubkeyB64) {
  const raw = Buffer.from(pubkeyB64, 'base64');
  return 'peer-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export function verify(pubkeyB64, payload, sigB64) {
  try {
    const raw = Buffer.from(pubkeyB64, 'base64');
    if (raw.length !== 32 || typeof sigB64 !== 'string') return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canonicalJson(payload), 'utf8'), key, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

export function newNonce() {
  return crypto.randomBytes(16).toString('hex');
}

export class Identity {
  constructor(privateKey) {
    this.privateKey = privateKey;
    const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    this.pubkey = spki.subarray(spki.length - 32).toString('base64');
    this.peerId = peerIdFromPubkey(this.pubkey);
  }

  static generate() {
    return new Identity(crypto.generateKeyPairSync('ed25519').privateKey);
  }

  static fromPem(pem) {
    return new Identity(crypto.createPrivateKey(pem));
  }

  /** Load from a PEM file, creating it (mode 0600) when missing. */
  static loadOrCreate(file) {
    if (fs.existsSync(file)) return Identity.fromPem(fs.readFileSync(file, 'utf8'));
    const ident = Identity.generate();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ident.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    return ident;
  }

  sign(payload) {
    return crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), this.privateKey).toString('base64');
  }
}

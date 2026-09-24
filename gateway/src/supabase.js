// Thin Supabase REST client. All writes use the service-role key, which must
// never leave the server.
import crypto from 'node:crypto';

export class SupabaseError extends Error {
  constructor(status, body) {
    super(`Supabase request failed (${status}): ${String(body).slice(0, 200)}`);
    this.status = status;
  }
}

export class Database {
  constructor({ supabaseUrl, supabaseServiceKey, supabaseAnonKey }, fetchImpl = globalThis.fetch) {
    this.url = supabaseUrl.replace(/\/$/, '');
    this.serviceKey = supabaseServiceKey;
    this.anonKey = supabaseAnonKey || supabaseServiceKey;
    this.fetch = fetchImpl;
    this.userCache = new Map();
  }

  async rest(path, { method = 'GET', body, prefer, query = '' } = {}) {
    const headers = { apikey: this.serviceKey, Authorization: `Bearer ${this.serviceKey}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await this.fetch(`${this.url}/rest/v1/${path}${query}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (!res.ok) throw new SupabaseError(res.status, text);
    return text ? JSON.parse(text) : null;
  }

  // ---- mesh registry
  listNodes(limit = 50) {
    return this.rest('active_nodes', {
      query: `?select=peer_id,addr,region,models,metrics,api_port,reputation,last_seen&verified=is.true&order=last_seen.desc&limit=${limit}`,
    });
  }

  upsertNode(row) {
    return this.rest('active_nodes', {
      method: 'POST',
      query: '?on_conflict=peer_id',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: { ...row, verified: true, last_seen: new Date().toISOString() },
    });
  }

  updateReputation(peerId, reputation) {
    return this.rest('active_nodes', {
      method: 'PATCH',
      query: `?peer_id=eq.${encodeURIComponent(peerId)}`,
      prefer: 'return=minimal',
      body: { reputation },
    });
  }

  async stats() {
    const rows = await this.rest('system_stats', { query: '?select=*' });
    return rows?.[0] || null;
  }

  // ---- usage
  recordUsage(row) {
    return this.rest('usage_events', { method: 'POST', prefer: 'return=minimal', body: row });
  }

  async keyUsageThisMonth(keyId) {
    const value = await this.rest('rpc/api_key_usage_this_month', { method: 'POST', body: { p_key: keyId } });
    return Number(value) || 0;
  }

  // ---- API keys
  static hashKey(secret) {
    return crypto.createHash('sha256').update(secret).digest('hex');
  }

  async findApiKey(secret) {
    const rows = await this.rest('api_keys', {
      query: `?select=id,user_id,name,monthly_token_quota,revoked_at&key_hash=eq.${Database.hashKey(secret)}&limit=1`,
    });
    const key = rows?.[0];
    return key && !key.revoked_at ? key : null;
  }

  touchApiKey(id) {
    return this.rest('api_keys', { method: 'PATCH', query: `?id=eq.${id}`, prefer: 'return=minimal', body: { last_used_at: new Date().toISOString() } });
  }

  listApiKeys(userId) {
    return this.rest('api_keys', {
      query: `?select=id,name,prefix,monthly_token_quota,created_at,last_used_at,revoked_at&user_id=eq.${userId}&order=created_at.desc`,
    });
  }

  async createApiKey(userId, name, quota) {
    const secret = 'b2b_' + crypto.randomBytes(32).toString('base64url');
    const [row] = await this.rest('api_keys', {
      method: 'POST',
      prefer: 'return=representation',
      body: { user_id: userId, name, prefix: secret.slice(0, 12), key_hash: Database.hashKey(secret), monthly_token_quota: quota },
    });
    return { secret, key: { id: row.id, name: row.name, prefix: row.prefix, monthly_token_quota: row.monthly_token_quota, created_at: row.created_at } };
  }

  async revokeApiKey(userId, id) {
    const rows = await this.rest('api_keys', {
      method: 'PATCH',
      query: `?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}&revoked_at=is.null`,
      prefer: 'return=representation',
      body: { revoked_at: new Date().toISOString() },
    });
    return rows.length > 0;
  }

  // ---- auth
  /** Resolve a Supabase access token to a user (cached for 60 s). */
  async getUser(accessToken) {
    const cached = this.userCache.get(accessToken);
    if (cached && cached.expires > Date.now()) return cached.user;
    const res = await this.fetch(`${this.url}/auth/v1/user`, {
      headers: { apikey: this.anonKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const user = data?.id ? { id: data.id, email: data.email } : null;
    if (this.userCache.size > 10000) this.userCache.clear();
    this.userCache.set(accessToken, { user, expires: Date.now() + 60000 });
    return user;
  }
}

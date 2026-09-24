import 'dotenv/config';

const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

export function loadConfig(env = process.env) {
  const cfg = {
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT || env.API_PORT, 3001),
    seeds: list(env.BEE2BEE_SEEDS),
    supabaseUrl: env.SUPABASE_URL || env.VITE_SUPABASE_URL || '',
    supabaseAnonKey: env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '',
    supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    corsOrigins: list(env.CORS_ORIGINS),
    trustProxy: bool(env.TRUST_PROXY, false),
    allowPrivateNodes: bool(env.ALLOW_PRIVATE_NODES, false),
    requireTlsNodes: bool(env.REQUIRE_TLS_NODES, false),
    keyFile: env.GATEWAY_KEY_FILE || '',
    privateKeyPem: env.GATEWAY_PRIVATE_KEY || '',
    rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 60),
    anonRateLimitPerMinute: int(env.ANON_RATE_LIMIT_PER_MINUTE, 20),
    maxPromptChars: int(env.MAX_PROMPT_CHARS, 32000),
    maxNewTokens: int(env.MAX_NEW_TOKENS, 4096),
    requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 120000),
    maxNodeConnections: int(env.MAX_NODE_CONNECTIONS, 20),
    registrySyncMs: int(env.REGISTRY_SYNC_MS, 30000),
    metricsToken: env.METRICS_TOKEN || '',
    staticApiKeys: list(env.STATIC_API_KEYS),
    openApi: bool(env.OPEN_API, false),
    defaultQuota: int(env.DEFAULT_MONTHLY_TOKEN_QUOTA, 1000000),
    probeRegistrations: bool(env.PROBE_NODE_REGISTRATIONS, true),
    logLevel: env.LOG_LEVEL || 'info',
    sentryDsn: env.SENTRY_DSN || '',
    staticDir: env.STATIC_DIR || '',
  };
  cfg.supabaseEnabled = Boolean(cfg.supabaseUrl && cfg.supabaseServiceKey);
  return cfg;
}

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Identity } from './identity.js';
import { log, setLevel } from './logger.js';
import { Mesh } from './mesh.js';
import { Metrics } from './metrics.js';
import { Database } from './supabase.js';

async function initSentry(dsn) {
  if (!dsn) return;
  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({ dsn, tracesSampleRate: 0 });
    log.info('sentry enabled');
  } catch {
    log.warn('SENTRY_DSN is set but @sentry/node is not installed');
  }
}

function loadIdentity(config) {
  if (config.privateKeyPem) return Identity.fromPem(config.privateKeyPem.replace(/\\n/g, '\n'));
  if (config.keyFile) return Identity.loadOrCreate(config.keyFile);
  log.warn('no GATEWAY_KEY_FILE or GATEWAY_PRIVATE_KEY set; using an ephemeral identity');
  return Identity.generate();
}

export async function main() {
  const config = loadConfig();
  setLevel(config.logLevel);
  await initSentry(config.sentryDsn);

  const identity = loadIdentity(config);
  const metrics = new Metrics();
  const mesh = new Mesh({
    identity,
    allowPrivate: config.allowPrivateNodes,
    requireTls: config.requireTlsNodes,
    maxConnections: config.maxNodeConnections,
    requestTimeoutMs: config.requestTimeoutMs,
    metrics,
  });
  const db = config.supabaseEnabled ? new Database(config) : null;
  if (!db) log.warn('Supabase is not configured: registry, usage tracking and API keys are disabled');

  for (const seed of config.seeds) mesh.addKnown(seed);
  mesh.start();

  let syncTimer = null;
  if (db) {
    const sync = async () => {
      try {
        const nodes = await db.listNodes(config.maxNodeConnections);
        for (const n of nodes) mesh.addKnown(n.addr);
        await Promise.all([...mesh.nodes.values()].map((n) => db.updateReputation(n.peerId, mesh.statsFor(n.peerId).score).catch(() => {})));
      } catch (e) {
        log.warn('registry sync failed', { error: e.message });
      }
    };
    sync();
    syncTimer = setInterval(sync, config.registrySyncMs);
  }

  const app = createApp({ config, mesh, db, metrics });
  const server = app.listen(config.port, config.host, () => {
    log.info('gateway listening', { host: config.host, port: config.port, peer_id: identity.peerId, seeds: config.seeds.length });
  });
  server.requestTimeout = 0; // streaming responses can be long-lived
  server.headersTimeout = 30000;

  const shutdown = async (signal) => {
    log.info('shutting down', { signal });
    clearInterval(syncTimer);
    server.close();
    await mesh.stop();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return { server, mesh };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    log.error('fatal', { error: e.message, stack: e.stack });
    process.exit(1);
  });
}

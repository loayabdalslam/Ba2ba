// End-to-end: the JS gateway against a real Python node (skipped if bee2bee is not importable).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { FakeDb, ndjson, startGateway, waitFor } from './helpers.js';

const PYTHON = process.env.BEE2BEE_PYTHON || 'python3';
const available = spawnSync(PYTHON, ['-c', 'import bee2bee'], { stdio: 'ignore' }).status === 0;

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

let gw, db, proc, home, port;
const logs = [];

before(async () => {
  if (!available) return;
  db = new FakeDb();
  gw = await startGateway({ db });
  port = await freePort();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'b2b-interop-'));
  proc = spawn(PYTHON, ['-m', 'bee2bee', 'serve-echo', '--model', 'echo-py', '--host', '127.0.0.1', '--port', String(port), '--api-port', '0'], {
    env: {
      ...process.env,
      BEE2BEE_HOME: home,
      BEE2BEE_UPNP: 'false',
      BEE2BEE_ANNOUNCE_HOST: '127.0.0.1',
      BEE2BEE_REGISTRY_URL: gw.base,
      BEE2BEE_PING_INTERVAL: '0.5',
      BEE2BEE_REGISTRY_INTERVAL: '1',
      BEE2BEE_LOG_LEVEL: 'DEBUG',
    },
  });
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));
});

after(async () => {
  if (!available) return;
  proc.kill('SIGTERM');
  await new Promise((r) => proc.once('exit', r));
  await gw.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('python node self-registers with a signature the gateway verifies', { skip: !available && 'bee2bee not importable' }, async () => {
  try {
    await waitFor(() => db.nodes.size === 1, 15000);
  } catch (e) {
    throw new Error(`${e.message}\n${logs.join('')}`);
  }
  const [row] = db.nodes.values();
  assert.equal(row.addr, `ws://127.0.0.1:${port}`);
  assert.deepEqual(row.models, ['echo-py']);
  assert.match(row.peer_id, /^peer-[0-9a-f]{32}$/);
});

test('gateway streams a generation from the python node', { skip: !available && 'bee2bee not importable' }, async () => {
  await waitFor(() => gw.mesh.nodes.size === 1, 10000);
  const r = await fetch(`${gw.base}/api/p2p/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'bees talk to gateways', model: 'echo-py' }),
  });
  const lines = ndjson(await r.text());
  assert.equal(lines.filter((l) => l.text).map((l) => l.text).join(''), 'bees talk to gateways');
  const final = lines.at(-1);
  assert.equal(final.done, true);
  assert.equal(final.usage.completion_tokens, 4);
});

test('OpenAI endpoint with chat messages reaches the python node', { skip: !available && 'bee2bee not importable' }, async () => {
  const r = await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer static-test-key' },
    body: JSON.stringify({ model: 'echo-py', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.choices[0].message.content, 'user: hi assistant:');
});

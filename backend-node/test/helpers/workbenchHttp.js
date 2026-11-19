const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../../src/db/migrate');
const { setupRouter } = require('../../src/routes');

async function openWorkbench(t) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'drama-workbench-'));
  const db = new Database(':memory:');
  t.after(() => { db.close(); fs.rmSync(storage, { recursive: true, force: true }); });
  runMigrationsAndEnsure(db);
  const cfg = { storage: { local_path: storage }, server: {} };
  const app = express();
  app.use(express.json());
  app.use('/static', express.static(storage));
  app.use('/api/v1', setupRouter(cfg, db, console));
  const server = app.listen(0, '127.0.0.1');
  // Synchronous media probes can outlast the default keep-alive timeout between test requests.
  server.keepAliveTimeout = 0;
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  cfg.storage.base_url = origin + '/static';
  const url = resource => origin + '/api/v1' + resource;
  async function request(method, resource, body) {
    const multipart = body instanceof FormData;
    const res = await fetch(url(resource), {
      method,
      headers: body && !multipart ? { 'Content-Type': 'application/json' } : undefined,
      body: multipart ? body : JSON.stringify(body),
    });
    const result = await res.json();
    assert.equal(res.ok && result.success, true, method + ' ' + resource + ' ' + JSON.stringify(result));
    return result.data;
  }
  return { cfg, db, storage, url, request };
}

module.exports = { openWorkbench };

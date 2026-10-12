// v0.5.3: shop return panel shows the order just captured (survives reload). Fake API only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { fakeApi } from './fixtures.js';

test('capture result is retrievable for the shop return panel', async () => {
  const store = createStore(null);
  const app = createApp({ api: fakeApi({}), store, engine: rulesEngine, config: { dryRun: true } });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = `http://127.0.0.1:${s.address().port}`;
  try {
    const miss = await fetch(base + '/api/orders/NOPE/result'); assert.equal(miss.status, 404);
    const cap = await (await fetch(base + '/api/orders/ORD1/capture', { method: 'POST' })).json();
    assert.ok(cap.id);
    const r = await fetch(base + `/api/orders/${cap.id}/result`); assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.id, cap.id); assert.equal(b.status, cap.status); assert.equal(b.captureId, cap.captureId);
    assert.ok(b.risk && Array.isArray(b.risk.flags));
    assert.equal(b.payerEmail, undefined);
  } finally { s.close(); }
});

test('shop page persists the order id and restores the panel on load', () => {
  const html = fs.readFileSync(new URL('../public/shop.html', import.meta.url), 'utf8');
  assert.match(html, /sessionStorage\.setItem\(LAST_KEY/);
  assert.match(html, /\/api\/orders\/\$\{encodeURIComponent\(id\)\}\/result/);
  assert.match(html, /restoreResult\(\)/);
});

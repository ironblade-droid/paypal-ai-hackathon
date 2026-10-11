// Express app factory. Dependencies are injected so tests can run without network or credentials.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, findSku } from './catalog.js';
import { checkShipment } from './engine/risk.js';
import { describeStatus, deadline, sandboxSimLinks } from './engine/status.js';
import { validateClaims } from './engine/evidence.js';
import { analyseDispute, submitDecision, SubmitError } from './disputeService.js';
import { PayPalError } from './paypal/client.js';
import { redact, log } from './lib/redact.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');

export function createApp({ api, store, engine, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use(express.static(pub, { index: false }));
  app.use('/vendor/ag-grid', express.static(path.join(here, '..', 'node_modules', 'ag-grid-community', 'dist')));

  const page = (f) => (_req, res) => res.sendFile(path.join(pub, f));
  app.get('/', page('shop.html'));
  app.get('/seller', page('orders.html'));
  app.get('/disputes', page('queue.html'));
  app.get('/disputes/:id', page('dispute.html'));

  const needApi = (_req, res, next) => api ? next() : res.status(503).json({ error: 'NO_CREDENTIALS', message: 'Set PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET (sandbox app) and restart.' });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  app.get('/healthz', (_req, res) => res.json({ ok: true, sandbox: true, credentials: Boolean(api), dryRun: config.dryRun, engine: engine.name }));
  app.get('/api/config', (_req, res) => res.json({ clientId: config.clientId || null, environment: 'sandbox', credentials: Boolean(api), dryRun: config.dryRun, engine: { name: engine.name, kind: engine.kind } }));
  app.get('/api/catalog', (_req, res) => res.json(CATALOG));

  // ---------- Orders v2 (checkout through our backend)
  app.post('/api/orders', needApi, wrap(async (req, res) => {
    const p = findSku(req.body?.sku); const qty = Math.max(1, Math.min(5, Number(req.body?.quantity || 1)));
    if (!p) return res.status(400).json({ error: 'UNKNOWN_SKU' });
    const order = await api.createOrder({
      items: [{ name: p.name, sku: p.sku, quantity: String(qty), unit_amount: { currency_code: 'USD', value: p.price }, category: p.type === 'DIGITAL' ? 'DIGITAL_GOODS' : 'PHYSICAL_GOODS' }],
      invoiceId: 'pp-' + crypto.randomUUID().slice(0, 12), description: `ProofPilot demo: ${p.name}`,
    });
    store.upsertOrder(order.id, { status: order.status, sku: p.sku, itemType: p.type, quantity: qty, createdAt: new Date().toISOString() });
    res.status(201).json({ id: order.id, status: order.status });
  }));

  app.post('/api/orders/:id/capture', needApi, wrap(async (req, res) => {
    const order = await api.captureOrder(req.params.id);
    const pu = order.purchase_units?.[0] || {}; const cap = pu.payments?.captures?.[0];
    const local = store.getOrder(order.id) || {};
    const risk = checkShipment({ order, capture: cap, itemType: local.itemType || 'PHYSICAL' });
    const saved = store.upsertOrder(order.id, { status: order.status, captureId: cap?.id, captureStatus: cap?.status, amount: cap?.amount,
      sellerProtection: cap?.seller_protection, payerEmail: order.payer?.email_address, shipping: pu.shipping, risk });
    store.audit({ type: 'CAPTURE', orderId: order.id, captureId: cap?.id });
    res.json({ id: order.id, status: order.status, captureId: cap?.id, captureStatus: cap?.status, risk: saved.risk });
  }));

  app.get('/api/orders', (_req, res) => res.json(store.listOrders()));

  // ---------- Pre-shipping risk check against live PayPal records
  async function liveRisk(id, body = {}) {
    const order = await api.getOrder(id);
    const capId = order.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    const capture = capId ? await api.getCapture(capId) : null;
    const local = store.getOrder(id) || {};
    const risk = checkShipment({ order, capture, shipTo: body.shipTo, itemType: body.itemType || local.itemType || 'PHYSICAL', signatureConfirmation: Boolean(body.signatureConfirmation) });
    return { order, capture, risk };
  }
  app.post('/api/orders/:id/risk-check', needApi, wrap(async (req, res) => {
    const { order, capture, risk } = await liveRisk(req.params.id, req.body);
    store.upsertOrder(order.id, { risk, captureId: capture?.id, captureStatus: capture?.status, shipping: order.purchase_units?.[0]?.shipping });
    res.json({ orderId: order.id, captureId: capture?.id, orderShipping: order.purchase_units?.[0]?.shipping, risk });
  }));

  // ---------- Ship: risk gate, then Shipment Tracking, then read back the tracker from PayPal
  app.post('/api/orders/:id/ship', needApi, wrap(async (req, res) => {
    const { carrier, trackingNumber, shipTo, signatureConfirmation, overrideAck } = req.body || {};
    if (!carrier || !trackingNumber) return res.status(400).json({ error: 'MISSING_TRACKING', message: 'carrier and trackingNumber are required' });
    const { order, capture, risk } = await liveRisk(req.params.id, { shipTo, signatureConfirmation });
    if (!capture) return res.status(409).json({ error: 'NOT_CAPTURED', risk });
    if (!risk.ok && overrideAck !== 'I understand Seller Protection may not apply')
      return res.status(409).json({ error: 'RISK_BLOCK', message: 'Pre-ship check found blocking issues. Fix them, or acknowledge the override text exactly.', risk });
    if (config.dryRun) return res.json({ dryRun: true, risk, wouldSend: { capture_id: capture.id, tracking_number: trackingNumber, carrier } });
    const r = await api.addTracking(order.id, { captureId: capture.id, trackingNumber, carrier });
    const trackers = (await api.listTrackers(capture.id))?.trackers || [];
    const orderAddr = order.purchase_units?.[0]?.shipping?.address;
    store.upsertOrder(order.id, { tracking: { carrier, trackingNumber, at: new Date().toISOString() }, shippedTo: shipTo || orderAddr,
      shippedToMatchesOrder: !risk.flags.some(f => f.code === 'ADDRESS_MISMATCH'), risk, overrideUsed: !risk.ok });
    store.audit({ type: 'TRACKING_ADDED', orderId: order.id, captureId: capture.id });
    res.json({ ok: true, orderStatus: r?.status, trackers: trackers.map(t => ({ tracking_number: t.tracking_number, carrier: t.carrier, status: t.status })), risk });
  }));

  // ---------- Disputes v1
  app.get('/api/disputes', needApi, wrap(async (_req, res) => {
    const list = await api.listDisputes(50);
    const items = await Promise.all((list.items || []).map(async (it) => {
      let d = it; try { d = await api.getDispute(it.dispute_id); } catch { /* fall back to list item */ }
      const st = describeStatus(d); const dl = deadline(d);
      return { id: d.dispute_id, reason: d.reason, amount: Number(d.dispute_amount?.value || 0), currency: d.dispute_amount?.currency_code,
        paypalStatus: d.status, label: st.label, tone: st.tone, waiting: st.waiting, stage: d.dispute_life_cycle_stage,
        due: dl?.due || null, hoursLeft: dl?.hoursLeft ?? null, actions: st.actions.join(', '),
        protection: d.disputed_transactions?.[0]?.seller_protection_eligible ?? null,
        requested: (d.evidences || []).filter(e => e.source === 'REQUESTED_FROM_SELLER').map(e => e.evidence_type).join(', '),
        created: d.create_time, updated: d.update_time };
    }));
    res.json({ items, fetchedAt: new Date().toISOString() });
  }));

  app.get('/api/disputes/:id', needApi, wrap(async (req, res) => {
    const { _ctx, ...a } = await analyseDispute({ api, store, engine }, req.params.id);
    res.json(a);
  }));

  // The citation checker, exposed so the seller can test their own statements before approving.
  app.post('/api/disputes/:id/check', needApi, wrap(async (req, res) => {
    const a = await analyseDispute({ api, store, engine }, req.params.id);
    res.json(validateClaims(req.body?.claims || [], a._ctx.recs.registry));
  }));

  app.post('/api/disputes/:id/submit', needApi, wrap(async (req, res) => {
    res.json(await submitDecision({ api, store, engine, config }, req.params.id, req.body));
  }));

  // Sandbox-only helper to open a fresh test dispute as the sandbox buyer (needs buyer consent; off by default).
  app.post('/api/sandbox/disputes', needApi, wrap(async (req, res) => {
    if (process.env.PROOFPILOT_ENABLE_SANDBOX_TOOLS !== '1') return res.status(403).json({ error: 'SANDBOX_TOOLS_DISABLED', message: 'Set PROOFPILOT_ENABLE_SANDBOX_TOOLS=1 to enable.' });
    const { buyerEmail, buyerTransactionId, amount } = req.body || {};
    if (!buyerEmail || !buyerTransactionId) return res.status(400).json({ error: 'MISSING_FIELDS' });
    const d = await api.createSandboxDispute({ buyerEmail, buyerTransactionId, amount: amount || { currency_code: 'USD', value: '5.50' }, clientId: config.clientId });
    const id = d?.dispute_id || (d?.links || []).map(l => l.href).find(h => h.includes('/disputes/'))?.split('/').pop();
    store.audit({ type: 'SANDBOX_DISPUTE_CREATED', disputeId: id });
    res.status(201).json({ id, note: 'New disputes usually take 3 to 5 minutes before PayPal offers seller actions.' });
  }));

  // Sandbox-only: simulate PayPal asking the seller for evidence (only when PayPal offers the require_evidence link).
  app.post('/api/sandbox/disputes/:id/require-evidence', needApi, wrap(async (req, res) => {
    if (process.env.PROOFPILOT_ENABLE_SANDBOX_TOOLS !== '1') return res.status(403).json({ error: 'SANDBOX_TOOLS_DISABLED', message: 'Set PROOFPILOT_ENABLE_SANDBOX_TOOLS=1 to enable.' });
    const d = await api.getDispute(req.params.id);
    if (!sandboxSimLinks(d).includes('require_evidence')) return res.status(409).json({ error: 'NOT_OFFERED', message: 'PayPal does not offer require-evidence on this dispute now.' });
    await api.requireEvidence(req.params.id, req.body?.action === 'BUYER_EVIDENCE' ? 'BUYER_EVIDENCE' : 'SELLER_EVIDENCE');
    const fresh = await api.getDispute(req.params.id);
    store.audit({ type: 'SANDBOX_REQUIRE_EVIDENCE', disputeId: req.params.id });
    res.json({ before: describeStatus(d).label, after: describeStatus(fresh).label, note: 'Sandbox simulation of PayPal requesting evidence.' });
  }));

  // ---------- Webhooks (SHOULD): verified with PayPal when PAYPAL_SANDBOX_WEBHOOK_ID is set
  app.post('/api/webhooks/paypal', wrap(async (req, res) => {
    const evt = req.body || {};
    let verification = 'UNVERIFIED_NO_WEBHOOK_ID';
    if (config.webhookId && api) {
      const h = (k) => req.get(k);
      const r = await api.verifyWebhook({ auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'), webhook_id: config.webhookId, webhook_event: evt }).catch(() => ({ verification_status: 'ERROR' }));
      verification = r?.verification_status || 'ERROR';
      if (verification !== 'SUCCESS') { store.addWebhook({ at: new Date().toISOString(), id: evt.id, type: evt.event_type, verification, accepted: false }); return res.status(400).json({ error: 'WEBHOOK_NOT_VERIFIED' }); }
    }
    const resourceId = evt.resource?.dispute_id || evt.resource?.id;
    store.addWebhook({ at: new Date().toISOString(), id: evt.id, type: evt.event_type, resourceId, verification, accepted: true });
    res.json({ received: true, verification });
  }));
  app.get('/api/webhooks', (_req, res) => res.json(store.data.webhooks.slice(0, 50)));

  // ---------- Errors: PayPal errors are passed through with debug_id, never with credentials
  app.use((err, _req, res, _next) => {
    if (err instanceof SubmitError) return res.status(409).json({ error: err.code, message: err.message, ...err.extra });
    if (err instanceof PayPalError) { log('PayPal error', err.message, err.debugId || ''); return res.status(err.status >= 500 ? 502 : err.status).json({ error: 'PAYPAL_ERROR', issue: err.issue, debugId: err.debugId, status: err.status }); }
    log('Internal error', redact(err.stack || err.message));
    res.status(500).json({ error: 'INTERNAL', message: redact(err.message) });
  });
  return app;
}

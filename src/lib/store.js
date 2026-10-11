// Tiny JSON-file store for local seller data (orders we created, risk checks, approvals, webhook events, audit log).
// PayPal stays the source of truth: every record keeps the PayPal id so it can be re-fetched.
import fs from 'node:fs';
import path from 'node:path';

export function createStore(file) {
  let data = { orders: {}, approvals: [], webhooks: [], audit: [] };
  if (file && fs.existsSync(file)) {
    try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* start fresh */ }
  }
  const save = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  };
  return {
    data,
    save,
    upsertOrder(id, patch) { data.orders[id] = { ...(data.orders[id] || { id }), ...patch, updatedAt: new Date().toISOString() }; save(); return data.orders[id]; },
    getOrder(id) { return data.orders[id]; },
    listOrders() { return Object.values(data.orders).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); },
    findOrderByCapture(captureId) { return Object.values(data.orders).find(o => o.captureId === captureId); },
    addApproval(a) { data.approvals.push(a); save(); return a; },
    addWebhook(e) { data.webhooks.unshift(e); data.webhooks = data.webhooks.slice(0, 200); save(); return e; },
    audit(entry) { data.audit.unshift({ at: new Date().toISOString(), ...entry }); data.audit = data.audit.slice(0, 500); save(); },
  };
}

// Shared helpers for all pages.
window.PP = {
  async api(path, opts = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.message || data.issue || data.error || res.statusText); e.data = data; e.status = res.status; throw e; }
    return data;
  },
  esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  nav(active) {
    const links = [['/', 'Demo shop'], ['/seller', 'Orders & shipping'], ['/disputes', 'Dispute queue']];
    document.body.insertAdjacentHTML('afterbegin', `<header><b>ProofPilot</b><span class="sandbox">PayPal SANDBOX</span>${links.map(([h, t]) => `<a href="${h}" class="${h === active ? 'on' : ''}">${t}</a>`).join('')}</header>`);
    document.body.insertAdjacentHTML('beforeend', '<footer>Sandbox test data only. ProofPilot is not legal advice: Seller Protection rules vary by country and change, so confirm each flag on the linked PayPal page. ProofPilot never predicts or claims a dispute outcome.</footer>');
  },
  async configBanner(el) {
    const c = await PP.api('/api/config');
    if (!c.credentials) el.innerHTML = '<div class="banner err">PayPal sandbox credentials are not set. Export PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET, then restart. See README.</div>';
    else if (c.dryRun) el.innerHTML = '<div class="banner info">Dry-run mode: ProofPilot reads from PayPal but will not submit anything.</div>';
    return c;
  },
  badge(label, tone) { return `<span class="badge t-${tone}">${PP.esc(label)}</span>`; },
};

// Shared helpers for all pages.
window.PP = {
  labels: {},
  async api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const pc = sessionStorage.getItem('pp-passcode'); if (pc) headers['x-proofpilot-passcode'] = pc;
    const res = await fetch(path, { headers, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.error === 'PASSCODE_REQUIRED' && !opts._retried) {
      const v = prompt('Reviewer passcode for this demo host:'); if (v) { sessionStorage.setItem('pp-passcode', v); return PP.api(path, { ...opts, _retried: true }); }
    }
    if (!res.ok) { const e = new Error(data.message || data.issue || data.error || res.statusText); e.data = data; e.status = res.status; throw e; }
    return data;
  },
  // Default for the manual offer box: the pending (else most recent) offer proposal's amount, else the AI's suggested
  // offer, else empty. Never the full disputed amount.
  defaultOfferAmount(disputed, proposals = [], aiOffer = null) {
    const full = String(disputed?.value ?? '').trim(); const cur = disputed?.currency_code;
    const ok = (v) => { const s = String(v ?? '').trim(); return s && s !== full && Number(s) !== Number(full) && Number(s) > 0 ? s : ''; };
    const offers = (proposals || []).filter(p => p?.tool === 'propose_make_offer' && p.canonical?.amount?.value && (!cur || !p.canonical.amount.currency_code || p.canonical.amount.currency_code === cur));
    const pending = offers.find(p => p.status === 'PENDING_SELLER_APPROVAL');
    const latest = [...offers].sort((a, b) => String(b.createdAt || b.executedAt || b.tokenExpiresAt || b.at || '').localeCompare(String(a.createdAt || a.executedAt || a.tokenExpiresAt || a.at || '')))[0];
    return ok(pending?.canonical.amount.value) || ok(latest?.canonical.amount.value) || ok(aiOffer) || '';
  },
  esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  // Plain words for a PayPal code; the raw code stays available as a tooltip.
  h(kind, code) { if (code == null || code === '') return ''; return PP.labels?.[kind]?.[code] || String(code).toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()); },
  hc(kind, code) { return `<span title="PayPal code: ${PP.esc(code)}">${PP.esc(PP.h(kind, code))}</span>`; },
  nav(active) {
    const links = [['/', 'Demo shop'], ['/seller', 'Orders & shipping'], ['/disputes', 'Dispute queue']];
    document.body.insertAdjacentHTML('afterbegin', `<header><b>ProofPilot</b><span class="sandbox">PayPal SANDBOX</span>${links.map(([h, t]) => `<a href="${h}" class="${h === active ? 'on' : ''}">${t}</a>`).join('')}<span id="aiTag" style="margin-left:auto;font-size:12px;color:#cfd8ea"></span></header>`);
    document.body.insertAdjacentHTML('beforeend', '<footer>Sandbox test data only. ProofPilot is not legal advice: Seller Protection rules vary by country and change, so confirm each flag on the linked PayPal page. ProofPilot never predicts or claims a dispute outcome.</footer>');
  },
  async configBanner(el) {
    const c = await PP.api('/api/config'); PP.labels = c.labels || {}; PP.cfg = c;
    const tag = document.getElementById('aiTag'); if (tag) tag.textContent = c.ai?.keySet ? `AI key set: ${c.ai.label}${c.ai.backup ? ' (backup: ' + c.ai.backup.provider + ')' : ''}` : 'AI: no key set (rules engine only)';
    if (!c.credentials) el.innerHTML = '<div class="banner err">PayPal sandbox credentials are not set. Export PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET, then restart. See README.</div>';
    else if (c.dryRun) el.innerHTML = '<div class="banner info">Dry-run mode: ProofPilot reads from PayPal but will not submit anything.</div>';
    return c;
  },
  badge(label, tone) { return `<span class="badge t-${tone}">${PP.esc(label)}</span>`; },
};

// ---- AG Grid cell renderers (Community components)
const TONE = { act: ['#fde7e5', '#b3261e'], wait: ['#fff3d6', '#a15c00'], review: ['#ece6fb', '#5b3fb5'], closed: ['#e6e9ef', '#3b475c'] };
class StatusChipRenderer {
  init(p) { const [bg, fg] = TONE[p.data?.tone] || TONE.wait; this.e = document.createElement('span');
    this.e.className = 'chipcell' + (p.data?.waiting ? ' pulse' : ''); this.e.style.background = bg; this.e.style.color = fg;
    this.e.innerHTML = `<span class="dot"></span>${PP.esc(p.value)}`; this.e.title = `PayPal status: ${p.data?.paypalStatus || ''}`; }
  getGui() { return this.e; } refresh() { return false; }
}
class CountdownRenderer {
  init(p) { this.p = p; this.e = document.createElement('div'); this.tick(); this.t = setInterval(() => this.tick(), 1000); }
  tick() {
    const due = this.p.value; if (!due) { this.e.innerHTML = '<span class="muted">No deadline</span>'; return; }
    const ms = Date.parse(due) - Date.now(); const total = 10 * 864e5; const left = Math.max(0, ms);
    const d = Math.floor(left / 864e5), h = Math.floor(left % 864e5 / 36e5), m = Math.floor(left % 36e5 / 6e4), s = Math.floor(left % 6e4 / 1000);
    const color = ms < 0 ? '#b3261e' : ms < 48 * 36e5 ? '#b3261e' : ms < 5 * 864e5 ? '#a15c00' : '#127a3d';
    const pct = Math.max(0, Math.min(100, (left / total) * 100));
    this.e.className = 'countdown'; this.e.title = 'Respond by ' + new Date(due).toLocaleString();
    this.e.innerHTML = ms < 0 ? '<b style="color:#b3261e">Overdue</b>' : `<b style="color:${color}">${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s</b><span class="bar"><i style="width:${pct}%;background:${color}"></i></span>`;
  }
  getGui() { return this.e; } refresh() { return false; } destroy() { clearInterval(this.t); }
}
class ChipsRenderer {
  init(p) { this.e = document.createElement('span'); const items = (p.value || []);
    this.e.innerHTML = items.length ? items.map(c => `<span class="minichip" title="${PP.esc(c)}">${PP.esc(PP.h(p.colDef.cellRendererParams?.kind || 'evidence', c))}</span>`).join('') : `<span class="muted">${PP.esc(p.colDef.cellRendererParams?.empty || '—')}</span>`; }
  getGui() { return this.e; } refresh() { return false; }
}
class ReadinessRenderer {
  init(p) { this.e = document.createElement('span'); const v = p.value; if (v == null) { this.e.textContent = '—'; return; }
    const c = v >= 80 ? '#127a3d' : v >= 50 ? '#a15c00' : '#b3261e';
    this.e.className = 'ready'; this.e.innerHTML = `<b style="color:${c}">${v}</b><span class="bar"><i style="width:${v}%;background:${c}"></i></span>`; }
  getGui() { return this.e; } refresh() { return false; }
}
Object.assign(window.PP, { StatusChipRenderer, CountdownRenderer, ChipsRenderer, ReadinessRenderer });

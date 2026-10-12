// Optional Postgres persistence (DATABASE_URL). The in-process store stays synchronous and is the working copy; this
// module keeps one JSONB document per store key in Postgres so data survives a Render free-plan restart.
//   - load(): read the saved document at startup (the server is already listening; this never blocks the health check);
//   - schedule(data): write-through after every save, serialised (one write in flight; the newest snapshot is kept).
// Unset DATABASE_URL -> not used; the JSON file / memory store behaves exactly as before.
// Errors are logged by code only (never the connection string) and never crash the app.
import { log } from './redact.js';
import { mergeLedgers } from './store.js';

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS proofpilot_store (key text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
const errCode = (e) => e?.code || e?.message || 'error';

export function createPgMirror({ pool, key = 'default' }) {
  let ready = null, inFlight = null, pending = null;
  // A failed table setup is not cached: the next write retries it.
  const init = () => (ready ||= pool.query(TABLE_SQL).catch(e => { ready = null; throw e; }));
  const write = async (snapshot) => {
    await init();
    await pool.query(`INSERT INTO proofpilot_store (key, data, updated_at) VALUES ($1, $2::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [key, snapshot]);
  };
  const pump = () => {
    if (inFlight || pending === null) return inFlight;
    const snap = pending; pending = null;
    inFlight = write(snap).catch(e => log('Postgres store write failed:', errCode(e)))
      .finally(() => { inFlight = null; pump(); });
    return inFlight;
  };
  const flush = async () => { while (inFlight || pending !== null) await (pump() || inFlight); };
  return {
    async load() {
      await init();
      const r = await pool.query('SELECT data FROM proofpilot_store WHERE key = $1', [key]);
      return r.rows[0]?.data ?? null;
    },
    schedule(data) { pending = JSON.stringify(data); return pump(); },
    flush,
    // Bounded flush for shutdown: resolves after at most `ms` even if the database hangs.
    flushWithin(ms = 5000) { let t; return Promise.race([flush(), new Promise(r => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t)); },
    end: () => pool.end?.(),
  };
}

// Database record replaces the local/file record only when strictly newer; ties (incl. no updatedAt) keep local.
const dbNewer = (db, local) => String(db?.updatedAt || db?.at || '') > String(local?.updatedAt || local?.at || '');
const newer = (a, b) => String(a?.updatedAt || a?.at || '') >= String(b?.updatedAt || b?.at || '');
// Merge a database copy into the live store data without letting older database records overwrite newer local ones.
export function mergeSaved(data, saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (k === 'disputeWrites') { data.disputeWrites = mergeLedgers(data.disputeWrites, v); continue; }
    const cur = data[k];
    if (Array.isArray(v) && Array.isArray(cur)) {
      const byKey = new Map(); const keyOf = (x) => x?.id ?? JSON.stringify(x);
      for (const x of [...v, ...cur]) { const kk = keyOf(x); if (!byKey.has(kk) || newer(x, byKey.get(kk))) byKey.set(kk, x); }
      const merged = [...byKey.values()];
      data[k] = merged.every(x => x?.at) ? merged.sort((a, b) => String(b.at).localeCompare(String(a.at))) : merged;
    } else if (v && typeof v === 'object' && cur && typeof cur === 'object' && !Array.isArray(v)) {
      // Keyed collections (orders, agentRuns, ...): per entry, the record with the newer updatedAt is kept.
      for (const [id, rec] of Object.entries(v)) if (!(id in cur) || (!Array.isArray(rec) && dbNewer(rec, cur[id]))) cur[id] = rec;
        else if (Array.isArray(rec) && Array.isArray(cur[id])) { const seen = new Set(cur[id].map(x => JSON.stringify(x))); cur[id] = [...cur[id], ...rec.filter(x => !seen.has(JSON.stringify(x)))]; }
    } else if (cur === undefined) data[k] = v;
  }
  if (Array.isArray(data.webhooks)) data.webhooks = data.webhooks.slice(0, 200);
  if (Array.isArray(data.audit)) data.audit = data.audit.slice(0, 500);
  return data;
}

// Attach a mirror to a store from createStore(): load the database copy, merge it in (newer records kept), save
// (writes the merged result to the file and back to the database), then mirror every save()/transaction().
export async function attachPgMirror(store, mirror) {
  // Load and merge FIRST. The write hook is registered only after a successful load, so a failed or slow load can
  // never push a near-empty or pre-merge copy over the database. If load() throws, nothing is attached (file store only).
  const saved = await mirror.load();
  if (saved && typeof saved === 'object') mergeSaved(store.data, saved);
  store.onPersist(() => mirror.schedule(store.data));
  store.pgMirror = mirror;
  store.save();
  return store;
}

export async function createPgPool(databaseUrl) {
  const { default: pg } = await import('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl);
  // NOTE: rejectUnauthorized:false encrypts the connection but does NOT verify the server certificate. Acceptable for
  // this sandbox demo only; for real seller data use a verified CA (e.g. sslmode=verify-full with the provider's CA).
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000,
    ssl: local ? false : { rejectUnauthorized: false } });
  return guardPool(pool);
}
// An idle client closed by the database emits 'error' on the pool; without a listener Node would crash the process.
export function guardPool(pool) { pool.on('error', e => log('Postgres idle connection error (ignored):', errCode(e))); return pool; }

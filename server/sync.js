// Sync between servers. Three setups use it:
//
// 1. Shop master + cloud copy (POS_MODE=local on the shop PC, POS_MODE=mirror on Railway)
//    The shop server is the master. Every change is queued in sync_outbox and sent to the read-only cloud copy.
//
// 2. Cloud first + shop standby (POS_MODE=cloud on Railway, POS_MODE=standby on the shop PC)
//    Staff work on the cloud POS. The shop PC keeps a full copy by downloading the cloud's change log.
//    When the internet drops, staff switch to the shop PC (its /start page) and carry on. When the internet
//    is back, the shop PC uploads what was done offline, then staff switch back to the cloud.
//    - The shop PC numbers its own records in a separate range (ids from 1,000,000,001; order and KOT
//      numbers from 900001), so offline records can never clash with records made on the cloud.
//    - A row changed offline wins over the cloud's copy of the same row (it is uploaded before anything
//      is downloaded, and a download never overwrites a row that is still waiting to upload).
//
// Database triggers record every change in sync_outbox in the same transaction as the change itself.
// Changes applied *from* the other server are not recorded again (pos.sync_apply), so nothing echoes back.
const crypto = require('crypto');
const express = require('express');

// Tables that are synced, parents before children. sessions, print_jobs, n8n_events and sync tables stay on each server.
const TABLES = [
  ['staff', ['id']], ['areas', ['id']], ['dining_tables', ['id']], ['printers', ['id']], ['stations', ['id']],
  ['categories', ['id']], ['menu_items', ['id']], ['item_addons', ['id']], ['menu_item_images', ['item_id']],
  ['suppliers', ['id']], ['ingredients', ['id']], ['recipe_items', ['menu_item_id', 'ingredient_id']],
  ['shifts', ['id']], ['orders', ['id']], ['kots', ['id']], ['order_items', ['id']], ['item_voids', ['id']],
  ['refunds', ['id']], ['cash_movements', ['id']], ['audit_log', ['id']], ['purchases', ['id']],
  ['purchase_items', ['id']], ['supplier_payments', ['id']], ['stock_moves', ['id']],
  ['settings', ['key']], ['app_images', ['key']],
];
const PK = Object.fromEntries(TABLES);
// Server-specific settings never leave the server: the print bridge token and the n8n integration (its signing secret).
const LOCAL_ONLY_SETTINGS = { has: (k) => /^(bridge|n8n)_/.test(k) };
const BATCH_BYTES = 3 * 1024 * 1024;
const LOCAL_ID_BASE = 1000000000; // shop standby: record ids from 1,000,000,001 (INT max is 2,147,483,647)
const OFFLINE_NO_BASE = 900000;   // shop standby: order and KOT numbers from 900001
const KEEP_LOG_DAYS = 30;         // the cloud keeps its change log this long; a shop PC off for longer downloads everything again

// Which live-update events to send after changes to these tables were applied
const EVENTS_FOR = {
  orders: ['floor', 'order', 'kitchen'], order_items: ['order', 'kitchen'], kots: ['kitchen'], item_voids: ['order', 'kitchen'],
  dining_tables: ['floor'], areas: ['floor'], shifts: ['shift'], cash_movements: ['shift'], refunds: ['order', 'shift'],
  menu_items: ['menu'], categories: ['menu'], item_addons: ['menu'], menu_item_images: ['menu'], stations: ['menu'],
  ingredients: ['stock'], recipe_items: ['stock'], stock_moves: ['stock'], purchases: ['stock'], purchase_items: ['stock'],
  suppliers: ['stock'], supplier_payments: ['stock'], settings: ['settings'], app_images: ['settings'], staff: ['settings'],
};

const SYNC_SQL = `
CREATE TABLE IF NOT EXISTS sync_outbox (
  id          BIGSERIAL PRIMARY KEY,
  tbl         TEXT NOT NULL,
  op          CHAR(1) NOT NULL,          -- I, U, D
  pk          JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);

-- Records which row changed. The sender reads the row's current state when it sends,
-- so a row edited 20 times while offline is sent once, as it is now.
CREATE OR REPLACE FUNCTION sync_capture() RETURNS trigger AS $$
DECLARE r jsonb; p jsonb := '{}'::jsonb; k text;
BEGIN
  IF current_setting('pos.sync_apply', true) = 'on' THEN RETURN NULL; END IF; -- a change received from the other server
  IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'settings' AND (r->>'key' LIKE 'bridge\\_%' OR r->>'key' LIKE 'n8n\\_%') THEN RETURN NULL; END IF; -- server-only values
  FOREACH k IN ARRAY TG_ARGV LOOP p := p || jsonb_build_object(k, r -> k); END LOOP;
  INSERT INTO sync_outbox(tbl, op, pk) VALUES (TG_TABLE_NAME, left(TG_OP, 1), p);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
`;

const rowKey = (tbl, obj) => PK[tbl].map((c) => String(obj[c])).join('|');

module.exports = function createSync({ pool, tx, wrap, HttpError, notify, MODE, CLOUD_URL, SYNC_TOKEN, onRemoteShiftClosed, allowed }) {
  // the shop PC setups are a plan feature: allowed() returns true, or the message to show
  async function planCheck() { const ok = allowed ? await allowed() : true; if (ok !== true) throw Object.assign(new HttpError(403, ok), { planBlocked: true }); }
  const CAPTURES = ['local', 'cloud', 'standby'].includes(MODE);
  const SENDS = ['local', 'standby'].includes(MODE) && !!(CLOUD_URL && SYNC_TOKEN);
  const state = { online: null, lastOkAt: null, lastPullAt: null, lastError: null, lastErrorAt: null, sending: false, snapshot: null };

  async function getState(c, key) { const { rows: [r] } = await c.query('SELECT value FROM sync_state WHERE key=$1', [key]); return r ? r.value : null; }
  async function setState(c, key, value) {
    await c.query('INSERT INTO sync_state(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
  }

  // ---------- setup ----------
  async function setup() {
    await pool.query(SYNC_SQL);
    for (const [t, cols] of TABLES) {
      await pool.query(`DROP TRIGGER IF EXISTS sync_capture ON ${t}`);
      if (CAPTURES) {
        await pool.query(`CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON ${t}
                          FOR EACH ROW EXECUTE FUNCTION sync_capture(${cols.map((c) => `'${c}'`).join(',')})`);
      }
    }
  }

  // Serial counters never fall behind the data (matters after a restore or a download).
  // Cloud first: the cloud counts below the shop's ranges, the shop standby counts inside them.
  async function repairSequences() {
    const low = MODE === 'cloud'; const high = MODE === 'standby';
    const idMax = high ? `GREATEST((SELECT coalesce(max(%I),0) FROM %I WHERE %I > ${LOCAL_ID_BASE}), ${LOCAL_ID_BASE})`
      : low ? `GREATEST((SELECT coalesce(max(%I),0) FROM %I WHERE %I <= ${LOCAL_ID_BASE}), 1)`
        : 'GREATEST((SELECT coalesce(max(%I),0) FROM %I WHERE %I IS NOT NULL), 1)';
    const no = (seq, col, tbl, start) => (high
      ? `PERFORM setval('${seq}', GREATEST((SELECT coalesce(max(${col}),0) FROM ${tbl} WHERE ${col} > ${OFFLINE_NO_BASE}), ${OFFLINE_NO_BASE},
           CASE WHEN (SELECT last_value FROM ${seq}) > ${OFFLINE_NO_BASE} THEN (SELECT last_value FROM ${seq}) ELSE 0 END));`
      : low
        ? `PERFORM setval('${seq}', GREATEST((SELECT coalesce(max(${col}),${start}) FROM ${tbl} WHERE ${col} <= ${OFFLINE_NO_BASE}),
           CASE WHEN (SELECT last_value FROM ${seq}) <= ${OFFLINE_NO_BASE} THEN (SELECT last_value FROM ${seq}) ELSE 0 END));`
        : `PERFORM setval('${seq}', GREATEST((SELECT coalesce(max(${col}), ${start}) FROM ${tbl}), (SELECT last_value FROM ${seq})));`);
    await pool.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
        FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a'
        JOIN pg_class t ON t.oid = d.refobjid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
        WHERE s.relkind = 'S' AND t.relnamespace = 'public'::regnamespace
      LOOP
        EXECUTE format('SELECT setval(%L, ${idMax})', r.seq, r.col, r.tbl, r.col);
      END LOOP;
      ${no('order_no_seq', 'order_no', 'orders', 1039)}
      ${no('kot_no_seq', 'kot_no', 'kots', 2199)}
    END $$`);
  }

  // ---------- reading changes from the outbox ----------
  async function rowsFor(tbl, pks) {
    if (!pks.length) return new Map();
    const cols = PK[tbl];
    const cond = `concat_ws('|', ${cols.map((c) => `t.${c}::text`).join(', ')}) = ANY($1)`;
    const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${tbl} t WHERE ${cond}`, [pks.map((p) => rowKey(tbl, p))]);
    return new Map(rows.map((r) => [rowKey(tbl, r.row), r.row]));
  }

  // Outbox entries -> changes carrying each row as it is now, one per row, in order of its latest change.
  async function buildChanges(queue) {
    const latest = new Map();
    for (const q of queue) latest.set(`${q.tbl}|${JSON.stringify(q.pk)}`, q);
    const ordered = [...latest.values()].sort((a, b) => Number(a.id) - Number(b.id));
    const byTable = new Map();
    for (const q of ordered) { if (!byTable.has(q.tbl)) byTable.set(q.tbl, []); byTable.get(q.tbl).push(q.pk); }
    const current = new Map();
    for (const [tbl, pks] of byTable) current.set(tbl, await rowsFor(tbl, pks));
    const changes = [];
    for (const q of ordered) {
      if (!PK[q.tbl] || (q.tbl === 'settings' && LOCAL_ONLY_SETTINGS.has(q.pk.key))) continue;
      const row = current.get(q.tbl).get(rowKey(q.tbl, q.pk));
      changes.push({ id: Number(q.id), ch: row ? { tbl: q.tbl, op: 'U', row } : { tbl: q.tbl, op: 'D', pk: q.pk } });
    }
    return changes;
  }

  // ---------- talking to the cloud ----------
  async function call(path, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(`${CLOUD_URL}/sync${path}`, {
        method: body ? 'POST' : 'GET', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'x-sync-token': SYNC_TOKEN },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || `Cloud replied ${res.status}`), { status: res.status });
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Cloud did not answer (timeout)');
      if (!e.status) throw new Error(`No internet or cloud unreachable (${e.cause?.code || e.message})`);
      throw e;
    } finally { clearTimeout(timer); }
  }
  const post = (changes) => call('/ingest', { changes });

  // ---------- sending (shop master, and shop standby's offline work) ----------
  // Shop master, first run: send every row once, table by table, so the cloud copy starts complete.
  async function snapshot() {
    for (const [tbl, cols] of TABLES) {
      let last = null;
      for (;;) {
        const order = cols.map((c) => `t.${c}`).join(',');
        const where = last ? `WHERE (${order}) > (${cols.map((_, i) => `$${i + 1}`).join(',')})` : '';
        const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${tbl} t ${where} ORDER BY ${order} LIMIT 300`, last || []);
        if (!rows.length) break;
        let batch = []; let size = 0;
        for (const { row } of rows) {
          if (tbl === 'settings' && LOCAL_ONLY_SETTINGS.has(row.key)) continue;
          const len = JSON.stringify(row).length;
          if (size + len > BATCH_BYTES && batch.length) { await post(batch); batch = []; size = 0; }
          batch.push({ tbl, op: 'U', row }); size += len;
        }
        if (batch.length) await post(batch);
        state.snapshot = `Copying ${tbl}…`;
        const lastRow = rows[rows.length - 1].row;
        last = cols.map((c) => lastRow[c]);
        if (rows.length < 300) break;
      }
    }
    await setState(pool, 'snapshot_done', new Date().toISOString());
    state.snapshot = null;
  }

  async function drainOnce() {
    const { rows: queue } = await pool.query('SELECT id, tbl, op, pk FROM sync_outbox ORDER BY id LIMIT 500');
    if (!queue.length) return 0;
    const changes = (await buildChanges(queue)).map((x) => x.ch);
    let batch = []; let size = 0;
    for (const ch of changes) {
      const len = JSON.stringify(ch).length;
      if (size + len > BATCH_BYTES && batch.length) { await post(batch); batch = []; size = 0; }
      batch.push(ch); size += len;
    }
    if (batch.length) await post(batch);
    // remove exactly what was sent (a change committed meanwhile with a lower id stays queued)
    await pool.query('DELETE FROM sync_outbox WHERE id = ANY($1::bigint[])', [queue.map((q) => q.id)]);
    return queue.length;
  }
  async function drainAll() { let n = 0; for (let k; (k = await drainOnce()) > 0;) n += k; return n; }

  // ---------- applying changes received from the other server ----------
  const colCache = new Map();
  async function columns(c, tbl) {
    if (!colCache.has(tbl)) {
      const { rows } = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [tbl]);
      colCache.set(tbl, rows.map((r) => r.column_name));
    }
    return colCache.get(tbl);
  }
  let isSuper = null;
  async function superuser() {
    if (isSuper === null) {
      const { rows: [r] } = await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
      isSuper = !!(r && r.rolsuper);
    }
    return isSuper;
  }
  async function applyOne(c, ch) {
    const cols = PK[ch.tbl];
    if (ch.op === 'D') {
      await c.query(`DELETE FROM ${ch.tbl} WHERE ${cols.map((k, i) => `${k}::text = $${i + 1}`).join(' AND ')}`, cols.map((k) => String(ch.pk[k])));
    } else {
      const all = await columns(c, ch.tbl);
      const set = all.filter((k) => !cols.includes(k)).map((k) => `${k}=EXCLUDED.${k}`).join(', ');
      await c.query(`INSERT INTO ${ch.tbl} SELECT * FROM jsonb_populate_record(NULL::${ch.tbl}, $1)
                     ON CONFLICT (${cols.join(',')}) DO ${set ? `UPDATE SET ${set}` : 'NOTHING'}`, [ch.row]);
    }
  }
  // Inside a transaction. A change that fails because a related row hasn't been applied yet is retried
  // after the others (up to 6 passes). With superuser rights, foreign-key checks are skipped while applying.
  async function applyChanges(c, changes) {
    await c.query("SET LOCAL pos.sync_apply = 'on'");
    if (await superuser()) await c.query("SET LOCAL session_replication_role = 'replica'");
    let pending = changes.filter((ch) => PK[ch.tbl]);
    for (let pass = 0; pending.length && pass < 6; pass++) {
      const retry = []; let lastErr = null;
      for (const ch of pending) {
        await c.query('SAVEPOINT ch');
        try { await applyOne(c, ch); await c.query('RELEASE SAVEPOINT ch'); } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT ch');
          if (!['23503', '23505'].includes(e.code)) throw e; // only ordering problems are retried
          retry.push(ch); lastErr = e;
        }
      }
      if (retry.length === pending.length) throw conflictError(lastErr, retry); // no progress: give up, the sender retries later
      pending = retry;
    }
    if (pending.length) throw new Error('Could not apply all changes');
  }
  function conflictError(e, left) {
    const hint = e.constraint === 'orders_open_table_uq'
      ? 'A table has an open order on both the cloud and the shop PC (was the cloud used during the outage?). Close one of them on the cloud, then sync continues.'
      : e.constraint === 'shifts_one_open' ? 'A shift is open on both the cloud and the shop PC. Close the extra shift on the cloud, then sync continues.'
        : `${e.message} (${left[0].tbl})`;
    return Object.assign(new Error(`Sync conflict: ${hint}`), { status: 409 });
  }
  function notifyFor(changes) {
    const kinds = new Set();
    for (const ch of changes) for (const k of (EVENTS_FOR[ch.tbl] || [])) kinds.add(k);
    for (const k of kinds) notify(k);
    notify('sync');
  }

  // ---------- receiving (cloud copy and cloud first) ----------
  function checkToken(req) {
    const got = String(req.headers['x-sync-token'] || '');
    if (!SYNC_TOKEN || got.length !== SYNC_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(SYNC_TOKEN))) {
      throw new HttpError(401, 'Bad sync token');
    }
  }
  const router = express.Router();
  let seenWritten = 0;
  router.post('/ingest', express.json({ limit: '25mb' }), wrap(async (req, res) => {
    if (!['mirror', 'cloud'].includes(MODE)) throw new HttpError(409, 'This server does not accept uploads (set POS_MODE=cloud or POS_MODE=mirror)');
    checkToken(req);
    if (MODE === 'cloud') await planCheck();
    const changes = Array.isArray(req.body.changes) ? req.body.changes : [];
    let closed = [];
    await tx(async (c) => {
      // shifts closed on the shop PC while offline: the cloud sends their Z-report email
      const shiftIds = changes.filter((ch) => ch.tbl === 'shifts' && ch.op === 'U' && ch.row?.status === 'closed').map((ch) => ch.row.id);
      if (MODE === 'cloud' && shiftIds.length) {
        const { rows } = await c.query("SELECT id FROM shifts WHERE id = ANY($1::int[]) AND status = 'closed'", [shiftIds]);
        const already = new Set(rows.map((r) => r.id));
        closed = shiftIds.filter((id) => !already.has(id));
      }
      await applyChanges(c, changes);
      await setState(c, 'last_ingest_at', new Date().toISOString());
      if (MODE === 'cloud' && changes.length) await setState(c, 'shop_seen_at', new Date().toISOString());
      if (onRemoteShiftClosed) for (const id of closed) await onRemoteShiftClosed(c, id);
    });
    notifyFor(changes);
    res.json({ ok: true, applied: changes.length });
  }));

  // Cloud first: the shop standby reads the cloud's change log from here.
  const cloudOnly = async (req) => { if (MODE !== 'cloud') throw new HttpError(409, 'This server is not the main cloud POS (set POS_MODE=cloud)'); checkToken(req); await planCheck(); };
  router.get('/head', wrap(async (req, res) => {
    await cloudOnly(req);
    const { rows: [r] } = await pool.query('SELECT coalesce(max(id),0)::bigint AS id FROM sync_outbox');
    const pruned = Number(await getState(pool, 'pruned_upto') || 0);
    res.json({ cursor: Math.max(Number(r.id), pruned), tables: TABLES.map(([t]) => t) });
  }));
  router.get('/changes', wrap(async (req, res) => {
    await cloudOnly(req);
    const after = Math.max(0, Number(req.query.after) || 0);
    if (after < Number(await getState(pool, 'pruned_upto') || 0)) return res.json({ resync: true });
    if (Date.now() - seenWritten > 30000) { seenWritten = Date.now(); await setState(pool, 'shop_seen_at', new Date().toISOString()); }
    const { rows: queue } = await pool.query('SELECT id, tbl, op, pk FROM sync_outbox WHERE id > $1 ORDER BY id LIMIT 1000', [after]);
    if (!queue.length) return res.json({ changes: [], cursor: after, more: false });
    const built = await buildChanges(queue);
    const out = []; let size = 0; let cursor = Number(queue[queue.length - 1].id);
    for (const x of built) {
      const len = JSON.stringify(x.ch).length;
      if (out.length && size + len > BATCH_BYTES) { cursor = out[out.length - 1].id; break; }
      out.push(x); size += len;
    }
    const more = queue.length === 1000 || cursor < Number(queue[queue.length - 1].id);
    res.json({ changes: out.map((x) => x.ch), cursor, more });
  }));
  router.get('/snapshot', wrap(async (req, res) => {
    await cloudOnly(req);
    const tbl = String(req.query.tbl || ''); const cols = PK[tbl];
    if (!cols) throw new HttpError(400, 'Unknown table');
    let last = null; try { last = req.query.after ? JSON.parse(req.query.after) : null; } catch { last = null; }
    const order = cols.map((c) => `t.${c}`).join(',');
    const where = Array.isArray(last) ? `WHERE (${order}) > (${cols.map((_, i) => `$${i + 1}`).join(',')})` : '';
    const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${tbl} t ${where} ORDER BY ${order} LIMIT 200`, Array.isArray(last) ? last : []);
    const out = rows.map((r) => r.row).filter((row) => !(tbl === 'settings' && LOCAL_ONLY_SETTINGS.has(row.key)));
    const lastRow = rows.length ? rows[rows.length - 1].row : null;
    res.json({ rows: out, after: lastRow ? cols.map((c) => lastRow[c]) : null, more: rows.length === 200 });
  }));

  // The cloud's change log is trimmed after KEEP_LOG_DAYS; a shop PC that missed the trimmed part downloads everything again.
  async function pruneLog() {
    try {
      const { rows: [r] } = await pool.query(`WITH d AS (DELETE FROM sync_outbox WHERE created_at < now() - interval '${KEEP_LOG_DAYS} days' RETURNING id)
                                              SELECT max(id)::bigint AS id FROM d`);
      if (r && r.id) await setState(pool, 'pruned_upto', String(Math.max(Number(r.id), Number(await getState(pool, 'pruned_upto') || 0))));
    } catch (e) { console.error('Sync: trimming the change log failed:', e.message); }
  }

  // ---------- shop standby: downloading from the cloud ----------
  // First start (or after a long time off): replace this PC's data with a full copy of the cloud.
  async function fullDownload() {
    state.snapshot = 'Downloading from the cloud…';
    const head = await call('/head');
    await tx(async (c) => {
      await c.query("SET LOCAL pos.sync_apply = 'on'");
      if (await superuser()) await c.query("SET LOCAL session_replication_role = 'replica'");
      await c.query(`TRUNCATE ${TABLES.map(([t]) => t).join(', ')} RESTART IDENTITY CASCADE`);
      for (const [tbl] of TABLES) {
        state.snapshot = `Downloading ${tbl.replace(/_/g, ' ')}…`;
        let after = null;
        for (;;) {
          const page = await call(`/snapshot?tbl=${tbl}${after ? `&after=${encodeURIComponent(JSON.stringify(after))}` : ''}`);
          await applyChanges(c, page.rows.map((row) => ({ tbl, op: 'U', row })));
          if (!page.more) break;
          after = page.after;
        }
      }
      await setState(c, 'cloud_cursor', String(head.cursor));
      await setState(c, 'standby_ready', new Date().toISOString());
    });
    await repairSequences();
    state.snapshot = null;
    notifyFor(TABLES.map(([tbl]) => ({ tbl })));
  }

  // Download what changed on the cloud. A row still waiting to upload from this PC is not overwritten.
  async function pullOnce() {
    const after = Number(await getState(pool, 'cloud_cursor') || 0);
    const r = await call(`/changes?after=${after}`);
    if (r.resync) {
      const { rows: [q] } = await pool.query('SELECT count(*)::int AS n FROM sync_outbox');
      if (!q.n) await fullDownload();
      return 1;
    }
    if (r.changes.length) {
      await tx(async (c) => {
        const { rows: mine } = await c.query('SELECT DISTINCT tbl, pk FROM sync_outbox');
        const keep = new Set(mine.map((m) => `${m.tbl}|${PK[m.tbl] ? rowKey(m.tbl, m.pk) : ''}`));
        const take = r.changes.filter((ch) => !keep.has(`${ch.tbl}|${rowKey(ch.tbl, ch.op === 'D' ? ch.pk : ch.row)}`));
        await applyChanges(c, take);
        await setState(c, 'cloud_cursor', String(r.cursor));
      });
      notifyFor(r.changes);
    } else if (r.cursor !== after) await setState(pool, 'cloud_cursor', String(r.cursor));
    state.lastPullAt = new Date();
    return r.more ? 2 : r.changes.length ? 1 : 0;
  }

  // ---------- background loops ----------
  async function workerLoop() {
    let backoff = 2000;
    for (;;) {
      let busy = 0;
      try {
        state.sending = true;
        if (MODE === 'local') {
          await planCheck(); // shop first: this PC holds the licence
          if (!(await getState(pool, 'snapshot_done'))) await snapshot();
          busy = await drainOnce();
        } else {
          // standby: upload offline work first, so a download can never overwrite it
          busy = await drainAll();
          if (!(await getState(pool, 'standby_ready'))) { await fullDownload(); busy = 1; }
          busy += await pullOnce();
        }
        state.online = true; state.lastOkAt = new Date(); state.lastError = null;
        backoff = 2000;
      } catch (e) {
        state.online = !e.status ? false : true; // a refusal from the cloud means the internet works
        state.lastError = e.message; state.lastErrorAt = new Date();
        if (state.snapshot) state.snapshot = null;
        backoff = Math.min(15000, backoff * 1.6);
        if (e.status) console.error('Sync:', e.message);
      } finally { state.sending = false; }
      await new Promise((r) => setTimeout(r, state.lastError ? backoff : (busy ? 200 : MODE === 'standby' ? 1500 : 3000)));
    }
  }

  // ---------- status ----------
  async function status() {
    if (MODE === 'local' || MODE === 'standby') {
      const { rows: [q] } = await pool.query('SELECT count(*)::int AS n, min(created_at) AS oldest FROM sync_outbox');
      const base = { mode: MODE, cloud: CLOUD_URL || null, configured: !!(CLOUD_URL && SYNC_TOKEN), online: state.online, pending: q.n,
        oldest_pending: q.oldest, last_ok_at: state.lastOkAt, last_error: state.lastError, last_error_at: state.lastErrorAt, snapshot: state.snapshot };
      if (MODE === 'local') return { ...base, snapshot_done: await getState(pool, 'snapshot_done') };
      return { ...base, ready: !!(await getState(pool, 'standby_ready')), last_pull_at: state.lastPullAt,
        // up to date: the last download finished in the last 20 seconds and nothing is waiting to upload
        current: !!(state.lastPullAt && Date.now() - state.lastPullAt < 20000 && !q.n && !state.lastError) };
    }
    if (MODE === 'mirror') return { mode: MODE, last_ingest_at: await getState(pool, 'last_ingest_at') };
    if (MODE === 'cloud') return { mode: MODE, shop_seen_at: await getState(pool, 'shop_seen_at'), last_ingest_at: await getState(pool, 'last_ingest_at') };
    return { mode: MODE };
  }

  function start() {
    if (SENDS) workerLoop();
    else if (MODE === 'local' || MODE === 'standby') console.log(`Sync: POS_MODE=${MODE} but CLOUD_URL / SYNC_TOKEN not set — running without the cloud.`);
    if (MODE === 'cloud') { pruneLog(); setInterval(pruneLog, 6 * 3600 * 1000).unref(); }
  }

  return { setup, repairSequences, start, status, ingest: router, TABLES, LOCAL_ID_BASE, OFFLINE_NO_BASE };
};
module.exports.TABLES = TABLES;

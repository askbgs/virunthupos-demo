// Live demo (DEMO_MODE=true): a public POS anyone can try from the website.
//
// - Loads the snapshot in server/demo/demo-data.json.gz on first start, every night at DEMO_RESET_HOUR
//   (default 3 AM restaurant time), and when a visitor presses "Reset demo".
// - Moves every date forward so the sales history always ends today: history by whole days (lunch stays
//   at lunchtime), tables that are open in the snapshot by the exact time passed (so "seated 25 min" stays
//   25 minutes).
// - Blocks what could lock visitors out or reach outside the server: staff and PINs, the licence, devices,
//   printers, email integration and image uploads.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { TABLES } = require('./sync');

const FILE = path.join(__dirname, 'demo', 'demo-data.json.gz');
const RESET_HOUR = Math.min(23, Math.max(0, Number(process.env.DEMO_RESET_HOUR || 3)));
const PINS = [['0000', 'Manager', 'everything, incl. Admin and Reports'], ['1234', 'Captain', 'tables, orders and bills'], ['1111', 'Kitchen', 'kitchen screen']];

// What visitors can't change in the demo: [method regex, path regex, message]
const BLOCKED = [
  [/^(POST|PATCH|PUT|DELETE)$/, /^\/api\/admin\/staff/, 'Staff and PINs are fixed in the demo, so everyone can sign in.'],
  [/^(GET|POST|PATCH|PUT|DELETE)$/, /^\/api\/admin\/(license|devices)/, 'The licence and devices are fixed in the demo.'],
  [/^(POST|PATCH|PUT|DELETE)$/, /^\/api\/admin\/integrations/, 'Email reports are switched off in the demo.'],
  [/^(POST|PATCH|PUT|DELETE)$/, /^\/api\/admin\/printing/, 'Printers are fixed in the demo. Bills print through your browser.'],
  [/^(PUT|DELETE)$/, /^\/api\/admin\/(logo|login-bg|items\/\d+\/image)/, 'Uploading pictures is switched off in the demo.'],
];

module.exports = function createDemo({ pool, tx, notify, loadSettings, repairSequences, CONFIG, HttpError }) {
  let lastReset = 0;

  const todayIn = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: CONFIG.timezone || 'Asia/Colombo' });
  const hourIn = (d = new Date()) => Number(d.toLocaleString('en-GB', { timeZone: CONFIG.timezone || 'Asia/Colombo', hour: '2-digit', hour12: false }));

  async function timeColumns(c, tbl) {
    const { rows } = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1
      AND data_type IN ('timestamp with time zone', 'timestamp without time zone')`, [tbl]);
    return rows.map((r) => r.column_name);
  }

  async function reset(reason = 'reset') {
    const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString('utf8'));
    const exported = new Date(snap.exportedAt);
    const now = new Date();
    // whole days to move the history, so the snapshot's last day of sales becomes today
    // (sales later in that day than the current time are moved back one more day, below)
    const paid = (snap.tables.orders || []).filter((o) => o.status !== 'open').map((o) => Date.parse(o.closed_at || o.opened_at)).filter(Boolean);
    const newest = paid.length ? new Date(Math.max(...paid)) : exported;
    const days = Math.round((Date.parse(todayIn(now)) - Date.parse(todayIn(newest))) / 86400000);

    await tx(async (c) => {
      const { rows: [su] } = await c.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
      if (su && su.rolsuper) await c.query("SET LOCAL session_replication_role = 'replica'"); // skip FK checks when allowed (rows load parents first anyway)
      await c.query(`TRUNCATE ${TABLES.map(([t]) => t).join(', ')}, printers, devices RESTART IDENTITY CASCADE`);
      for (const [tbl] of TABLES) {
        const rows = snap.tables[tbl];
        if (!rows || !rows.length) continue;
        await c.query(`INSERT INTO ${tbl} SELECT * FROM jsonb_populate_recordset(NULL::${tbl}, $1)`, [JSON.stringify(rows)]);
        const cols = await timeColumns(c, tbl);
        if (cols.length && days) await c.query(`UPDATE ${tbl} SET ${cols.map((k) => `${k} = ${k} + make_interval(days => $1)`).join(', ')}`, [days]);
      }
      // sales that would now be in the future go back one day, with everything that belongs to them
      const { rows: later } = await c.query(`SELECT o.id FROM orders o WHERE o.status <> 'open' AND (greatest(o.opened_at, coalesce(o.closed_at, o.opened_at)) > now()
        OR EXISTS (SELECT 1 FROM kots k WHERE k.order_id = o.id AND greatest(k.fired_at, coalesce(k.ready_at, k.fired_at), coalesce(k.served_at, k.fired_at)) > now())
        OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.created_at > now()))`);
      if (later.length) {
        const ids = later.map((r) => r.id);
        for (const [tbl, key] of [['orders', 'id'], ['order_items', 'order_id'], ['kots', 'order_id'], ['item_voids', 'order_id'], ['refunds', 'order_id'], ['stock_moves', 'order_id'], ['audit_log', 'order_id']]) {
          const tc = await timeColumns(c, tbl);
          if (tc.length) await c.query(`UPDATE ${tbl} SET ${tc.map((k) => `${k} = ${k} - interval '1 day'`).join(', ')} WHERE ${key} = ANY($1::int[])`, [ids]);
        }
      }
      // closed cash shifts that would end in the future, the same
      for (const tbl of ['shifts', 'cash_movements', 'audit_log', 'stock_moves']) {
        const tc = await timeColumns(c, tbl); const first = tc.includes('closed_at') ? 'closed_at' : tc.includes('created_at') ? 'created_at' : null;
        if (first) await c.query(`UPDATE ${tbl} SET ${tc.map((k) => `${k} = ${k} - interval '1 day'`).join(', ')} WHERE ${first} > now()${tbl === 'shifts' ? " AND status = 'closed'" : ''}`);
      }
      await c.query('DELETE FROM audit_log WHERE created_at > now()'); // stray entries from the day the snapshot was taken
      // tables that are busy in the snapshot: seated between about 10 and 75 minutes ago, each order's
      // kitchen tickets and items moving with it (so the kitchen screen shows sensible times too)
      const { rows: open } = await c.query("SELECT id, opened_at FROM orders WHERE status = 'open' ORDER BY opened_at DESC");
      const cols = { orders: await timeColumns(c, 'orders'), order_items: await timeColumns(c, 'order_items'), kots: await timeColumns(c, 'kots') };
      for (let i = 0; i < open.length; i++) {
        const target = now.getTime() - (10 + Math.round((i * 65) / Math.max(1, open.length - 1))) * 60000;
        const secs = (target - new Date(open[i].opened_at).getTime()) / 1000;
        for (const [tbl, key] of [['orders', 'id'], ['order_items', 'order_id'], ['kots', 'order_id']]) {
          if (cols[tbl].length) await c.query(`UPDATE ${tbl} SET ${cols[tbl].map((k) => `${k} = ${k} + make_interval(secs => $2)`).join(', ')} WHERE ${key} = $1`, [open[i].id, secs]);
        }
      }
      // nothing on a busy table happened in the future (tickets added later than the table opened)
      for (const [tbl, key] of [['orders', 'id'], ['order_items', 'order_id'], ['kots', 'order_id']]) {
        const tc = cols[tbl];
        if (tc.length) await c.query(`UPDATE ${tbl} SET ${tc.map((k) => `${k} = LEAST(${k}, now() - interval '1 minute')`).join(', ')} WHERE ${key} IN (SELECT id FROM orders WHERE status = 'open')`);
      }
      // the open cash shift started this morning (09:30), or an hour ago if it's earlier than that
      await c.query(`UPDATE shifts SET opened_at = LEAST(now() - interval '1 hour', (date_trunc('day', now() AT TIME ZONE $1) + interval '9 hours 30 minutes') AT TIME ZONE $1)
                     WHERE status = 'open'`, [CONFIG.timezone || 'Asia/Colombo']);
      await c.query("INSERT INTO settings(key, value) VALUES ('demo_loaded', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [now.toISOString()]);
    });
    await repairSequences();
    await loadSettings();
    for (const k of ['settings', 'menu', 'floor', 'order', 'kitchen', 'shift', 'stock']) notify(k);
    lastReset = Date.now();
    console.log(`Demo: data ${reason} (history moved ${days} days)`);
  }

  async function start() {
    const { rows: [r] } = await pool.query("SELECT value FROM settings WHERE key='demo_loaded'");
    if (!r) await reset('loaded');
    // nightly reset, checked every minute
    let doneFor = null;
    setInterval(() => {
      const day = todayIn();
      if (hourIn() === RESET_HOUR && doneFor !== day) { doneFor = day; reset('reset for the night').catch((e) => console.error('Demo reset failed:', e.message)); }
    }, 60000).unref();
  }

  // Express middleware: refuse the blocked actions
  function guard(req, res, next) {
    for (const [m, p, msg] of BLOCKED) if (m.test(req.method) && p.test(req.originalUrl)) return next(new HttpError(403, msg));
    next();
  }

  async function resetByVisitor() {
    if (Date.now() - lastReset < 60000) throw new HttpError(429, 'The demo was reset less than a minute ago.');
    await reset('reset by a visitor');
  }

  return { start, reset, guard, resetByVisitor, info: { pins: PINS.map(([pin, role, what]) => ({ pin, role, what })), resetHour: RESET_HOUR } };
};

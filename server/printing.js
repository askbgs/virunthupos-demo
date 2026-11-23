// Thermal printing: a print-job queue in Postgres, consumed by bridge/print-bridge.js running on a PC in the shop.
// Documents are stored as simple JSON lines; the bridge turns them into ESC/POS for the printer.
//   { t:'text', s, align:'left'|'center'|'right', bold, size:1|2 }   { t:'row', l, r, bold, size }
//   { t:'hr' }   { t:'feed', n }   { t:'cut' }
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const bt = require('./billtext');
const { rasterizeDoc } = require('./raster');

module.exports = function createPrinting({ pool, tx, listeners, CONFIG, wrap, HttpError }) {
  const bad = (msg) => { throw new HttpError(400, msg); };
  const int = (v, def = null) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
  const money = (c) => CONFIG.currency + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (d) => new Date(d || Date.now()).toLocaleString('en-GB', { timeZone: CONFIG.timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  const TYPE = { dinein: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery', counter: 'Counter' };
  const title = (o) => (o.type === 'dinein' ? `Table ${o.table_code}` : `${TYPE[o.type]} #${o.order_no}`);
  const pct = (f) => `${+(f * 100).toFixed(3)}%`;

  // ---------- settings ----------
  async function getSetting(c, key) {
    const { rows: [r] } = await c.query('SELECT value FROM settings WHERE key=$1', [key]);
    return r ? r.value : null;
  }
  async function setSetting(c, key, value) {
    if (value === null || value === undefined || value === '') await c.query('DELETE FROM settings WHERE key=$1', [key]);
    else await c.query('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, String(value)]);
  }
  async function printerFor(c, which) {
    const id = int(await getSetting(c, which === 'bill' ? 'bill_printer_id' : 'kitchen_printer_id'));
    if (!id) return null;
    const { rows: [p] } = await c.query('SELECT id FROM printers WHERE id=$1 AND active', [id]);
    return p ? p.id : null;
  }

  // Queue a job; the NOTIFY is delivered when the surrounding transaction commits.
  async function enqueue(c, printerId, kind, jobTitle, doc) {
    if (!printerId) return null;
    if (bt.needsRaster(JSON.stringify(doc))) {
      const { rows: [p] } = await c.query('SELECT width_chars FROM printers WHERE id=$1', [printerId]);
      doc = rasterizeDoc(doc, p?.width_chars || 48);
    }
    const { rows: [j] } = await c.query('INSERT INTO print_jobs(printer_id, kind, title, doc) VALUES ($1,$2,$3,$4) RETURNING id',
      [printerId, kind, jobTitle, JSON.stringify(doc)]);
    await c.query("SELECT pg_notify('pos_events', 'print')");
    return j.id;
  }

  // ---------- documents ----------
  // Logo, name, address, contact and registration no. at the top of every customer-facing slip
  // Restaurant name / address / footer in the bill's language, when set in Admin → Settings
  const local = (key, lang) => (lang === 'ta' && CONFIG[key + 'Ta']) || (lang === 'si' && CONFIG[key + 'Si']) || CONFIG[key];
  function brandHeader({ terminal = true, lang = 'en' } = {}) {
    const d = []; const L = bt.T(lang);
    if (CONFIG.logoRaster) d.push({ t: 'image', w: CONFIG.logoRaster.w, h: CONFIG.logoRaster.h, data: CONFIG.logoRaster.data, align: 'center' });
    d.push({ t: 'text', s: local('restaurant', lang), align: 'center', bold: true, size: 2 });
    for (const line of String(local('address', lang) || '').split('\n').filter(Boolean)) d.push({ t: 'text', s: line, align: 'center' });
    if (CONFIG.phone) d.push({ t: 'text', s: `${L.tel}: ${CONFIG.phone}`, align: 'center' });
    const web = [CONFIG.email, CONFIG.website].filter(Boolean).join(' · ');
    if (web) d.push({ t: 'text', s: web, align: 'center' });
    if (CONFIG.regNo) d.push({ t: 'text', s: `${L.regNo}: ${CONFIG.regNo}`, align: 'center' });
    if (terminal && CONFIG.terminal) d.push({ t: 'text', s: CONFIG.terminal, align: 'center' });
    return d;
  }
  // Add-on wording: "Boiled egg", "Boiled egg x2 pieces", "Extra rice x2 portions". Older lines have no qty (= 1).
  const aq = (a) => a.qty || 1;
  const unitWord = (u, n) => (n === 1 || /s$/i.test(u) ? u : u + 's');
  const addonLabel = (a, n) => (n === 1 ? a.name : `${a.name} x${n}${a.unit ? ' ' + unitWord(a.unit, n) : ''}`);
  // On the kitchen ticket the add-on count is per dish; "each" makes that clear when the dish qty is above 1.
  const mods = (i) => [i.spice, ...(i.addons || []).map((a) => '+ ' + addonLabel(a, aq(a)) + (aq(a) > 1 && i.qty - (i.void_qty || 0) > 1 ? ' each' : ''))].filter(Boolean).join(', ');

  function kotDoc({ kot, order, items, staffName, flag }) {
    const d = [
      { t: 'row', l: `KOT #${kot.kot_no}`, r: (kot.station_name || 'ALL').toUpperCase(), bold: true, size: 2 },
      { t: 'text', s: title(order), bold: true, size: 2 },
      { t: 'text', s: `${when(kot.fired_at || kot.created_at)} · ${staffName || ''}${order.type === 'dinein' ? ` · ${order.guests} pax` : ''}` },
    ];
    if (order.customer_name && order.type !== 'dinein') d.push({ t: 'text', s: `${order.customer_name}${order.phone ? ' · ' + order.phone : ''}` });
    if (order.address) d.push({ t: 'text', s: order.address });
    const flags = [kot.is_addon && 'ADD-ON', flag].filter(Boolean);
    if (flags.length) d.push({ t: 'text', s: flags.map((f) => `[${f}]`).join(' '), bold: true });
    d.push({ t: 'hr' });
    for (const i of items) {
      d.push({ t: 'text', s: `${i.qty - (i.void_qty || 0)} x ${i.name}`, bold: true, size: 2 });
      if (mods(i)) d.push({ t: 'text', s: `   ${mods(i)}` });
      if (i.note) d.push({ t: 'text', s: `   !! ${i.note}`, bold: true });
    }
    d.push({ t: 'hr' }, { t: 'feed', n: 2 }, { t: 'cut' });
    return d;
  }

  function voidDoc({ order, kotNo, stationName, name, qty, reason, staffName }) {
    return [
      { t: 'text', s: '*** VOID ***', align: 'center', bold: true, size: 2 },
      { t: 'row', l: title(order), r: kotNo ? `KOT #${kotNo}` : '', bold: true },
      { t: 'text', s: `${when()} · ${(stationName || '').toUpperCase()}` },
      { t: 'hr' },
      { t: 'text', s: `${qty} x ${name}`, bold: true, size: 2 },
      { t: 'text', s: `Reason: ${reason}` },
      { t: 'text', s: `By: ${staffName || ''}` },
      { t: 'hr' }, { t: 'feed', n: 2 }, { t: 'cut' },
    ];
  }

  // label: 'bill' | 'billCopy' | 'receiptCopy'; lang: 'en' | 'ta' | 'si'
  function billDoc(o, { label = 'bill', refunds = [], lang = CONFIG.billLang } = {}) {
    lang = bt.lang(lang); const L = bt.T(lang); const en = lang === 'en';
    const d = brandHeader({ lang });
    if (label !== 'bill') d.push({ t: 'text', s: `*** ${L[label] || label} ***`, align: 'center', bold: true });
    const head = o.type === 'dinein' ? `${L.table} ${o.table_code}` : `${L.types[o.type] || o.type} #${o.order_no}`;
    d.push({ t: 'hr' },
      { t: 'row', l: head, r: `#${o.order_no}`, bold: true },
      { t: 'text', s: when(o.closed_at || undefined) },
      { t: 'text', s: `${L.server}: ${o.staff_name || ''}${o.type === 'dinein' ? ` · ${L.guests}: ${o.guests}` : ''}` });
    if (o.customer_name) d.push({ t: 'text', s: `${L.customer}: ${o.customer_name}` });
    if (o.phone) d.push({ t: 'text', s: `${L.contact}: ${o.phone}` });
    if (o.type === 'delivery' && o.address) d.push({ t: 'text', s: `${L.deliverTo}: ${o.address}` });
    d.push({ t: 'hr' });
    for (const i of o.items) {
      const q = i.qty - (i.void_qty || 0);
      if (q <= 0) continue;
      // dish at its own price, then each add-on with its price, so the lines add up to the subtotal
      d.push({ t: 'row', l: `${q} x ${bt.itemName(i, lang)}`, r: money(q * i.unit_price_cents) });
      if (i.spice) d.push({ t: 'text', s: `    ${L.spice}: ${L.spiceLevels[i.spice] || i.spice}` });
      for (const a of i.addons || []) {
        const n = q * aq(a);
        d.push({ t: 'row', l: `    + ${en ? addonLabel(a, n) : `${a.name}${n > 1 ? ` × ${n}` : ''}`}`, r: money(n * a.price_cents) });
      }
    }
    d.push({ t: 'hr' }, { t: 'row', l: L.subtotal, r: money(o.subtotal_cents) });
    if (o.discount_cents) d.push({ t: 'row', l: `${L.discount} ${o.discount_pct}%`, r: '-' + money(o.discount_cents) });
    if (o.service_on && o.service_cents) d.push({ t: 'row', l: `${L.service} ${pct(CONFIG.serviceRate)}`, r: money(o.service_cents) });
    d.push({ t: 'row', l: `${CONFIG.taxLabel} ${pct(CONFIG.taxRate)}`, r: money(o.tax_cents) });
    if (o.tip_cents) d.push({ t: 'row', l: `${L.tip} ${o.tip_pct}%`, r: money(o.tip_cents) });
    d.push({ t: 'hr' }, { t: 'row', l: L.total, r: money(o.total_cents), bold: true, size: 2 });
    if (o.split_ways > 1) d.push({ t: 'row', l: `${L.perPerson} (${o.split_ways})`, r: money(Math.ceil(o.total_cents / o.split_ways)) });
    if (o.status === 'paid') {
      d.push({ t: 'row', l: L.paidBy, r: L.methods[o.payment_method] || (o.payment_method || '').toUpperCase() });
      if (o.payment_method === 'card' && o.card_last4) {
        d.push({ t: 'row', l: L.card, r: `${o.card_brand || ''} **** ${o.card_last4}` });
        if (o.card_auth) d.push({ t: 'row', l: L.approval, r: o.card_auth });
      }
      if (o.payment_method === 'cash' && o.cash_received_cents != null) {
        d.push({ t: 'row', l: L.cashReceived, r: money(o.cash_received_cents) });
        d.push({ t: 'row', l: L.change, r: money(o.change_cents || 0) });
      }
    }
    for (const r of refunds) d.push({ t: 'row', l: `${L.refund} (${L.methods[r.method] || r.method})`, r: '-' + money(r.amount_cents) });
    d.push({ t: 'hr' });
    const footer = en ? CONFIG.billFooter : local('billFooter', lang) !== CONFIG.billFooter ? local('billFooter', lang) : L.footer;
    if (footer) d.push({ t: 'text', s: footer, align: 'center' });
    d.push({ t: 'feed', n: 3 }, { t: 'cut' });
    return d;
  }

  function refundDoc({ order, amount, method, reason, staffName, approverName }) {
    return [
      ...brandHeader({ terminal: false }),
      { t: 'text', s: '*** REFUND ***', align: 'center', bold: true, size: 2 },
      { t: 'hr' },
      { t: 'row', l: title(order), r: `#${order.order_no}`, bold: true },
      { t: 'text', s: when() },
      { t: 'row', l: 'Bill total', r: money(order.total_cents) },
      { t: 'row', l: `Refunded (${method})`, r: money(amount), bold: true, size: 2 },
      ...(method === 'card' && order.card_last4 ? [{ t: 'row', l: 'To card', r: `${order.card_brand || ''} **** ${order.card_last4}` }] : []),
      { t: 'text', s: `Reason: ${reason}` },
      { t: 'text', s: `By: ${staffName}${approverName && approverName !== staffName ? ` · Approved: ${approverName}` : ''}` },
      { t: 'feed', n: 3 }, { t: 'text', s: 'Customer signature: ______________' },
      { t: 'feed', n: 3 }, { t: 'cut' },
    ];
  }

  function zReportDoc(s) {
    const d = [
      { t: 'text', s: CONFIG.restaurant, align: 'center', bold: true, size: 2 },
      { t: 'text', s: s.shift.status === 'closed' ? 'Z REPORT · SHIFT CLOSE' : 'X REPORT · SHIFT SO FAR', align: 'center', bold: true },
      { t: 'hr' },
      { t: 'row', l: 'Shift', r: s.shift.id > 1000000000 ? `Offline #${s.shift.id - 1000000000}` : `#${s.shift.id}` },
      { t: 'row', l: 'Opened', r: `${when(s.shift.opened_at)}` },
      { t: 'row', l: 'Opened by', r: s.shift.opened_by_name || '' },
    ];
    if (s.shift.closed_at) d.push({ t: 'row', l: 'Closed', r: when(s.shift.closed_at) }, { t: 'row', l: 'Closed by', r: s.shift.closed_by_name || '' });
    d.push({ t: 'hr' }, { t: 'text', s: 'SALES', bold: true },
      { t: 'row', l: `Orders paid`, r: String(s.sales.orders) },
      { t: 'row', l: 'Gross sales', r: money(s.sales.gross_cents), bold: true },
      { t: 'row', l: 'Discounts', r: '-' + money(s.sales.discount_cents) },
      { t: 'row', l: 'Service charge', r: money(s.sales.service_cents) },
      { t: 'row', l: CONFIG.taxLabel, r: money(s.sales.tax_cents) },
      { t: 'row', l: 'Tips', r: money(s.sales.tip_cents) },
      { t: 'row', l: 'Refunds', r: '-' + money(s.refunds.total_cents) },
      { t: 'row', l: 'Net sales', r: money(s.sales.gross_cents - s.refunds.total_cents), bold: true },
      { t: 'hr' }, { t: 'text', s: 'PAYMENTS', bold: true });
    for (const m of ['cash', 'card', 'wallet']) d.push({ t: 'row', l: m[0].toUpperCase() + m.slice(1), r: money(s.payments[m] - s.refunds[m]) });
    if (s.card_brands && s.card_brands.length) {
      d.push({ t: 'text', s: 'Card payments by type:' });
      for (const b of s.card_brands) d.push({ t: 'row', l: `  ${b.brand} (${b.n})`, r: money(b.v) });
    }
    d.push({ t: 'hr' }, { t: 'text', s: 'CASH DRAWER', bold: true },
      { t: 'row', l: 'Opening float', r: money(s.shift.float_cents) },
      { t: 'row', l: 'Cash sales', r: money(s.payments.cash) },
      { t: 'row', l: 'Cash refunds', r: '-' + money(s.refunds.cash) },
      { t: 'row', l: 'Cash in', r: money(s.cash.in_cents) },
      { t: 'row', l: 'Cash out', r: '-' + money(s.cash.out_cents) },
      { t: 'row', l: 'Expected in drawer', r: money(s.expected_cents), bold: true });
    if (s.shift.counted_cents !== null && s.shift.counted_cents !== undefined) {
      const v = s.shift.counted_cents - s.expected_cents;
      d.push({ t: 'row', l: 'Counted', r: money(s.shift.counted_cents), bold: true },
        { t: 'row', l: v === 0 ? 'Variance' : v > 0 ? 'Over' : 'Short', r: money(Math.abs(v)), bold: true });
    }
    d.push({ t: 'hr' }, { t: 'text', s: 'VOIDS', bold: true },
      { t: 'row', l: `Items voided (${s.voids.count})`, r: money(s.voids.amount_cents) },
      { t: 'row', l: 'Orders voided', r: String(s.voids.orders) });
    if (s.shift.note) d.push({ t: 'hr' }, { t: 'text', s: `Note: ${s.shift.note}` });
    d.push({ t: 'feed', n: 3 }, { t: 'text', s: 'Signature: ______________' }, { t: 'feed', n: 3 }, { t: 'cut' });
    return d;
  }

  function testDoc(p) {
    const w = p.width_chars;
    return [
      { t: 'text', s: 'TEST PRINT', align: 'center', bold: true, size: 2 },
      { t: 'text', s: CONFIG.restaurant, align: 'center' },
      { t: 'hr' },
      { t: 'row', l: 'Printer', r: p.name },
      { t: 'row', l: 'Paper', r: w >= 42 ? '80 mm' : '58 mm' },
      { t: 'row', l: 'Time', r: when() },
      { t: 'text', s: '1234567890'.repeat(Math.ceil(w / 10)).slice(0, w) },
      { t: 'row', l: 'Left', r: 'Right', bold: true },
      { t: 'text', s: 'Big text', size: 2, bold: true },
      { t: 'text', s: 'If you can read this, printing works.', align: 'center' },
      { t: 'feed', n: 3 }, { t: 'cut' },
    ];
  }

  // ---------- bridge API (token auth, no session) ----------
  const bridge = express.Router();
  bridge.get('/print-bridge.js', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="print-bridge.js"');
    res.sendFile(path.join(__dirname, '..', 'bridge', 'print-bridge.js'));
  });
  async function bridgeAuth(req, res, next) {
    try {
      const want = await getSetting(pool, 'bridge_token');
      const got = String(req.headers['x-bridge-token'] || '');
      if (!want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new HttpError(401, 'Bad bridge token');
      next();
    } catch (e) { next(e); }
  }
  async function claimJobs() {
    return tx(async (c) => {
      const { rows } = await c.query(
        `SELECT j.id FROM print_jobs j JOIN printers p ON p.id=j.printer_id
         WHERE p.active AND (j.status='pending' OR (j.status='sent' AND j.claimed_at < now() - interval '60 seconds' AND j.attempts < 5))
         ORDER BY j.id LIMIT 10 FOR UPDATE OF j SKIP LOCKED`);
      if (!rows.length) return [];
      const ids = rows.map((r) => r.id);
      const { rows: jobs } = await c.query(
        `UPDATE print_jobs j SET status='sent', claimed_at=now(), attempts=attempts+1 FROM printers p
         WHERE j.id = ANY($1) AND p.id=j.printer_id
         RETURNING j.id, j.kind, j.title, j.doc, p.name AS printer_name, p.conn, p.address, p.width_chars`, [ids]);
      return jobs.sort((a, b) => a.id - b.id);
    });
  }
  bridge.get('/jobs', bridgeAuth, wrap(async (req, res) => {
    await setSetting(pool, 'bridge_seen', new Date().toISOString());
    let jobs = await claimJobs();
    if (!jobs.length) {
      const waitMs = Math.min(25, Math.max(0, int(req.query.wait, 0))) * 1000;
      if (waitMs) {
        await new Promise((resolve) => {
          const done = () => { clearTimeout(t); listeners.delete(fn); resolve(); };
          const fn = (kind) => { if (kind === 'print') done(); };
          const t = setTimeout(done, waitMs);
          listeners.add(fn);
          req.on('close', done);
        });
        if (!req.destroyed) jobs = await claimJobs();
      }
    }
    if (!req.destroyed) res.json({ jobs });
  }));
  bridge.post('/jobs/:id', bridgeAuth, wrap(async (req, res) => {
    const id = int(req.params.id);
    if (req.body.ok) {
      await pool.query("UPDATE print_jobs SET status='done', printed_at=now(), error=NULL WHERE id=$1", [id]);
    } else {
      await pool.query(`UPDATE print_jobs SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END, error=$2 WHERE id=$1`,
        [id, String(req.body.error || 'Print failed').slice(0, 300)]);
    }
    res.json({ ok: true });
  }));

  // ---------- admin API (mounted under the manager-only admin router) ----------
  const admin = express.Router();
  const str = (v, max = 120) => String(v ?? '').trim().slice(0, max);
  admin.get('/', wrap(async (req, res) => {
    const [printers, stations, jobs, settings] = await Promise.all([
      pool.query('SELECT * FROM printers ORDER BY id'),
      pool.query('SELECT id, name, code, printer_id FROM stations ORDER BY sort, id'),
      pool.query(`SELECT j.id, j.kind, j.title, j.status, j.attempts, j.error, j.created_at, j.printed_at, p.name AS printer_name
                  FROM print_jobs j JOIN printers p ON p.id=j.printer_id ORDER BY j.id DESC LIMIT 25`),
      pool.query("SELECT key, value FROM settings WHERE key IN ('bill_printer_id','kitchen_printer_id','bridge_token','bridge_seen')"),
    ]);
    const s = Object.fromEntries(settings.rows.map((r) => [r.key, r.value]));
    res.json({
      printers: printers.rows, stations: stations.rows, jobs: jobs.rows,
      bill_printer_id: int(s.bill_printer_id), kitchen_printer_id: int(s.kitchen_printer_id),
      bridge_token: s.bridge_token || null, bridge_seen: s.bridge_seen || null,
    });
  }));
  const printerBody = (b) => {
    const conn = b.conn === 'share' ? 'share' : 'network';
    let address = str(b.address, 200);
    if (!address) bad('Enter the printer address');
    if (conn === 'network') {
      if (!/:\d+$/.test(address)) address += ':9100';
      if (!/^[\w.-]+:\d{2,5}$/.test(address)) bad('Network address looks like 192.168.1.50:9100');
    }
    const width = int(b.width_chars, 48);
    return { name: str(b.name, 40) || bad('Name is required'), conn, address, width_chars: [32, 42, 48].includes(width) ? width : 48, active: b.active !== false };
  };
  admin.post('/printers', wrap(async (req, res) => {
    const p = printerBody(req.body);
    const { rows: [row] } = await pool.query('INSERT INTO printers(name, conn, address, width_chars, active) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [p.name, p.conn, p.address, p.width_chars, p.active]);
    res.json({ ok: true, id: row.id });
  }));
  admin.patch('/printers/:id', wrap(async (req, res) => {
    const p = printerBody(req.body);
    await pool.query('UPDATE printers SET name=$2, conn=$3, address=$4, width_chars=$5, active=$6 WHERE id=$1',
      [int(req.params.id), p.name, p.conn, p.address, p.width_chars, p.active]);
    res.json({ ok: true });
  }));
  admin.delete('/printers/:id', wrap(async (req, res) => {
    const id = int(req.params.id);
    await tx(async (c) => {
      for (const k of ['bill_printer_id', 'kitchen_printer_id']) {
        if (int(await getSetting(c, k)) === id) await setSetting(c, k, null);
      }
      await c.query('DELETE FROM printers WHERE id=$1', [id]);
    });
    res.json({ ok: true });
  }));
  admin.post('/printers/:id/test', wrap(async (req, res) => {
    const { rows: [p] } = await pool.query('SELECT * FROM printers WHERE id=$1', [int(req.params.id)]);
    if (!p) throw new HttpError(404, 'Printer not found');
    await tx((c) => enqueue(c, p.id, 'test', `Test print · ${p.name}`, testDoc(p)));
    res.json({ ok: true });
  }));
  admin.patch('/routing', wrap(async (req, res) => {
    await tx(async (c) => {
      await setSetting(c, 'bill_printer_id', int(req.body.bill_printer_id));
      await setSetting(c, 'kitchen_printer_id', int(req.body.kitchen_printer_id));
      for (const [sid, pid] of Object.entries(req.body.stations || {})) {
        await c.query('UPDATE stations SET printer_id=$2 WHERE id=$1', [int(sid), int(pid)]);
      }
    });
    res.json({ ok: true });
  }));
  admin.post('/token', wrap(async (req, res) => {
    const token = crypto.randomBytes(18).toString('base64url');
    await setSetting(pool, 'bridge_token', token);
    res.json({ ok: true, token });
  }));
  admin.post('/jobs/:id/retry', wrap(async (req, res) => {
    await pool.query("UPDATE print_jobs SET status='pending', attempts=0, error=NULL WHERE id=$1", [int(req.params.id)]);
    await pool.query("SELECT pg_notify('pos_events', 'print')");
    res.json({ ok: true });
  }));

  // ---------- direct printing (shop server) ----------
  // On the shop server the POS prints to the printers itself — no bridge PC needed, no internet needed.
  let directOn = false;
  function startDirect() {
    if (directOn) return;
    directOn = true;
    const { render, sendNetwork, sendShare } = require('../bridge/print-bridge.js');
    let wake = null;
    listeners.add((kind) => { if (kind === 'print' && wake) wake(); });
    (async function loop() {
      for (;;) {
        let jobs = []; let failed = false;
        try {
          jobs = await claimJobs();
        } catch (e) { console.error('print queue', e.message); }
        const byPrinter = new Map();
        for (const j of jobs) { const k = `${j.conn}|${j.address}`; if (!byPrinter.has(k)) byPrinter.set(k, []); byPrinter.get(k).push(j); }
        await Promise.all([...byPrinter.values()].map(async (list) => {
          for (const j of list) {
            try {
              const data = render(j.doc, j.width_chars || 48);
              if (j.conn === 'network') await sendNetwork(j.address, data); else await sendShare(j.address, data);
              await pool.query("UPDATE print_jobs SET status='done', printed_at=now(), error=NULL WHERE id=$1", [j.id]);
            } catch (e) {
              failed = true;
              await pool.query(`UPDATE print_jobs SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END, error=$2 WHERE id=$1`,
                [j.id, String(e.message).slice(0, 300)]).catch(() => {});
            }
          }
        }));
        if (failed) await new Promise((r) => setTimeout(r, 4000)); // printer off or out of paper: don't hammer it
        else if (!jobs.length) await new Promise((r) => { wake = r; setTimeout(r, 5000); });
        wake = null;
      }
    })();
  }

  return { startDirect, enqueue, printerFor, getSetting, kotDoc, voidDoc, billDoc, refundDoc, zReportDoc, bridge, admin };
};

// Outgoing events for n8n (or any webhook receiver).
//
// Events are written to the n8n_events outbox in the same transaction as the change that caused them,
// so nothing is lost if the internet is down: the worker keeps retrying until n8n answers 2xx.
//
// Each request is a JSON POST signed with HMAC-SHA256:
//   X-POS-Event:      shift.closed
//   X-POS-Event-Id:   42
//   X-POS-Timestamp:  1763735400                  (unix seconds)
//   X-POS-Signature:  sha256=<hex of HMAC(secret, `${timestamp}.${body}`)>
// The receiver recomputes the HMAC over "<timestamp>.<raw body>" and rejects old timestamps.
const crypto = require('crypto');
const express = require('express');

const EVENTS = {
  'shift.closed': 'Shift closed: Z-report summary',
  'cash.variance': 'Cash count differs from expected by more than the limit',
};
const MAX_ATTEMPTS = 25; // about 10 hours of retries, then "failed" (can be retried by hand)

module.exports = function createIntegrations({ pool, tx, wrap, HttpError, CONFIG, MODE, shiftSummary, allowed }) {
  const bad = (msg) => { throw new HttpError(400, msg); };
  const KEYS = ['n8n_url', 'n8n_secret', 'n8n_events', 'n8n_email', 'n8n_variance_limit_cents'];

  async function config(c = pool) {
    const { rows } = await c.query('SELECT key, value FROM settings WHERE key = ANY($1)', [KEYS]);
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    let events = Object.keys(EVENTS);
    try { if (s.n8n_events) events = JSON.parse(s.n8n_events).filter((e) => EVENTS[e]); } catch { /* keep default */ }
    return {
      url: s.n8n_url || '', secret: s.n8n_secret || '', events, email: s.n8n_email || '',
      variance_limit_cents: s.n8n_variance_limit_cents != null ? parseInt(s.n8n_variance_limit_cents, 10) : 50000,
    };
  }

  // Queue an event inside the caller's transaction. Does nothing on the cloud copy or when n8n isn't set up.
  async function emit(c, event, data, { force = false } = {}) {
    if (MODE === 'mirror' || MODE === 'standby') return null; // standby: the cloud sends it once the shift is uploaded
    if (allowed && !(await allowed())) return null; // emails aren't in this restaurant's plan
    const cfg = await config(c);
    if (!cfg.url || (!force && !cfg.events.includes(event))) return null;
    const payload = {
      event,
      created_at: new Date().toISOString(),
      source: { restaurant: CONFIG.restaurant, terminal: CONFIG.terminal, currency: CONFIG.currency.trim(), timezone: CONFIG.timezone },
      recipients: { email: cfg.email || null },
      data,
    };
    const { rows: [r] } = await c.query('INSERT INTO n8n_events(event, payload) VALUES ($1,$2) RETURNING id', [event, payload]);
    setTimeout(kick, 1500); // safety net; callers also kick() right after their transaction commits
    return r.id;
  }

  // ---------- delivery worker ----------
  let running = false; let timer = null;
  function kick() { clearTimeout(timer); timer = setTimeout(tick, 0); }

  async function deliver(ev, cfg) {
    const body = JSON.stringify({ id: Number(ev.id), ...ev.payload });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', cfg.secret).update(`${ts}.${body}`).digest('hex');
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'user-agent': 'RestaurantPOS-webhook/1',
        'x-pos-event': ev.event, 'x-pos-event-id': String(ev.id), 'x-pos-timestamp': String(ts), 'x-pos-signature': `sha256=${sig}`,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text: text.slice(0, 300) };
  }

  async function tick() {
    if (running) return; running = true;
    let more = false;
    try {
      const cfg = await config();
      if (!cfg.url || !cfg.secret) return;
      const { rows } = await pool.query(
        "SELECT *, next_try_at <= now() AS due FROM n8n_events WHERE status='pending' ORDER BY id LIMIT 10");
      for (const ev of rows) {
        if (!ev.due) { rows.length = 0; break; } // the oldest is waiting to retry: keep newer events behind it, in order
        let r;
        try { r = await deliver(ev, cfg); } catch (e) { r = { ok: false, status: null, text: e.cause?.code || e.name === 'TimeoutError' ? `${e.cause?.code || 'Timeout'}: n8n not reachable` : e.message }; }
        if (r.ok) {
          await pool.query("UPDATE n8n_events SET status='sent', sent_at=now(), attempts=attempts+1, last_status=$2, last_error=NULL WHERE id=$1", [ev.id, r.status]);
        } else {
          const n = ev.attempts + 1;
          const wait = Math.min(30 * 60, 10 * 2 ** Math.min(n, 8)); // 20s, 40s … capped at 30 min
          await pool.query(
            `UPDATE n8n_events SET attempts=$2, last_status=$3, last_error=$4, status=$5, next_try_at=now() + make_interval(secs => $6) WHERE id=$1`,
            [ev.id, n, r.status, (r.status ? `HTTP ${r.status} ${r.text}` : r.text).slice(0, 400), n >= MAX_ATTEMPTS ? 'failed' : 'pending', wait]);
          break; // keep order: don't send newer events while an older one is failing
        }
      }
      more = rows.length === 10;
    } catch (e) {
      console.error('n8n events:', e.message);
    } finally {
      running = false;
      if (more) kick();
    }
  }

  function start() {
    if (MODE === 'mirror') return;
    setInterval(tick, 15000).unref();
    kick();
  }

  // ---------- event builders ----------
  async function shiftClosed(c, sum, opts = {}) {
    const sh = sum.shift;
    const { rows: top } = await c.query(
      `SELECT i.name, sum(i.qty - i.void_qty)::int AS qty, sum((i.qty - i.void_qty) * (i.unit_price_cents + i.addons_cents))::int AS sales_cents
       FROM order_items i JOIN orders o ON o.id=i.order_id
       WHERE o.shift_id=$1 AND o.status='paid' AND i.qty > i.void_qty
       GROUP BY i.name ORDER BY 3 DESC, 2 DESC LIMIT 5`, [sh.id]);
    const variance = (sh.counted_cents ?? 0) - sum.expected_cents;
    const shift = {
      id: sh.id, label: sh.id > 1000000000 ? `offline #${sh.id - 1000000000}` : `#${sh.id}`, opened_at: sh.opened_at, closed_at: sh.closed_at,
      opened_by: sh.opened_by_name, closed_by: sh.closed_by_name, note: sh.note,
    };
    const data = {
      shift,
      sales: { ...sum.sales, net_cents: sum.sales.gross_cents - sum.refunds.total_cents },
      payments: { cash_cents: sum.payments.cash, card_cents: sum.payments.card, wallet_cents: sum.payments.wallet },
      card_brands: sum.card_brands.map((b) => ({ brand: b.brand, count: b.n, total_cents: b.v })),
      refunds: { cash_cents: sum.refunds.cash, card_cents: sum.refunds.card, wallet_cents: sum.refunds.wallet, total_cents: sum.refunds.total_cents, count: sum.refund_list.length },
      voids: { items: sum.voids.count, amount_cents: sum.voids.amount_cents, orders: sum.voids.orders },
      cash: {
        float_cents: sh.float_cents, cash_sales_cents: sum.payments.cash, cash_refunds_cents: sum.refunds.cash,
        paid_in_cents: sum.cash.in_cents, paid_out_cents: sum.cash.out_cents,
        expected_cents: sum.expected_cents, counted_cents: sh.counted_cents, variance_cents: variance,
      },
      top_items: top,
    };
    await emit(c, 'shift.closed', data, opts);
    const cfg = await config(c);
    if (variance !== 0 && Math.abs(variance) >= cfg.variance_limit_cents) {
      await emit(c, 'cash.variance', {
        shift, expected_cents: sum.expected_cents, counted_cents: sh.counted_cents, variance_cents: variance,
        direction: variance > 0 ? 'over' : 'short', limit_cents: cfg.variance_limit_cents,
      }, opts);
    }
  }

  // ---------- admin API (manager-only; mounted under /api/admin) ----------
  const admin = express.Router();
  admin.get('/', wrap(async (req, res) => {
    const cfg = await config();
    const { rows: log } = await pool.query(
      `SELECT id, event, status, attempts, last_status, last_error, created_at, sent_at, next_try_at FROM n8n_events ORDER BY id DESC LIMIT 50`);
    const { rows: [counts] } = await pool.query(
      `SELECT count(*) FILTER (WHERE status='pending')::int AS pending, count(*) FILTER (WHERE status='failed')::int AS failed,
              max(sent_at) AS last_sent FROM n8n_events`);
    res.json({ ...cfg, secret: cfg.secret, available: EVENTS, log, counts, mode: MODE });
  }));
  admin.patch('/', wrap(async (req, res) => {
    const b = req.body || {};
    const url = String(b.url || '').trim();
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) bad('Enter the full webhook URL, starting with https://');
    const email = String(b.email || '').trim();
    if (email && !email.split(/[,;]\s*/).every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) bad('Enter a valid email address (separate several with commas)');
    const limit = Math.round(Number(b.variance_limit || 0) * 100);
    if (!Number.isFinite(limit) || limit < 0) bad('Enter a valid variance limit');
    const events = (Array.isArray(b.events) ? b.events : []).filter((e) => EVENTS[e]);
    await tx(async (c) => {
      const set = (k, v) => c.query('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
      await set('n8n_url', url); await set('n8n_email', email); await set('n8n_events', JSON.stringify(events));
      await set('n8n_variance_limit_cents', String(limit));
      const { rows: [s] } = await c.query("SELECT value FROM settings WHERE key='n8n_secret'");
      if (!s || !s.value || b.new_secret) await set('n8n_secret', crypto.randomBytes(24).toString('hex'));
    });
    kick();
    res.json(await config());
  }));
  admin.post('/test', wrap(async (req, res) => {
    const id = await tx(async (c) => {
      const cfg = await config(c);
      if (!cfg.url) bad('Save the n8n webhook URL first');
      return emit(c, 'test', { message: 'Test event from Restaurant POS. If you can read this, the connection works.', sent_by: req.user.name }, { force: true });
    });
    kick();
    res.json({ id });
  }));
  // Re-send the last Z-report (handy when setting up the email template)
  admin.post('/resend-last-shift', wrap(async (req, res) => {
    const id = await tx(async (c) => {
      const cfg = await config(c);
      if (!cfg.url) bad('Save the n8n webhook URL first');
      const { rows: [sh] } = await c.query("SELECT id FROM shifts WHERE status='closed' ORDER BY closed_at DESC LIMIT 1");
      if (!sh) bad('No closed shift yet');
      await shiftClosed(c, await shiftSummary(c, sh.id), { force: true });
      return sh.id;
    });
    kick();
    res.json({ shift_id: id });
  }));
  admin.post('/events/:id/retry', wrap(async (req, res) => {
    const { rowCount } = await pool.query(
      "UPDATE n8n_events SET status='pending', attempts=0, next_try_at=now(), last_error=NULL WHERE id=$1 AND status<>'sent'", [req.params.id]);
    if (!rowCount) throw new HttpError(404, 'Nothing to retry');
    kick();
    res.json({ ok: true });
  }));
  admin.post('/retry-all', wrap(async (req, res) => {
    const { rowCount } = await pool.query("UPDATE n8n_events SET status='pending', attempts=0, next_try_at=now() WHERE status<>'sent'");
    kick();
    res.json({ retried: rowCount });
  }));

  return { emit, start, kick, shiftClosed, admin, EVENTS };
};

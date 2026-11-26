const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { pool, tx, migrate, hashPin, checkPin, startListener, notify, listeners } = require('./db');
const adminRouter = require('./admin');
const createPrinting = require('./printing');
const createIntegrations = require('./integrations');
const billtext = require('./billtext');
const reportsRouter = require('./reports');
const createInventory = require('./inventory');

const CONFIG = {
  restaurant: process.env.RESTAURANT_NAME || 'Virundhu & Co',
  terminal: process.env.TERMINAL_NAME || 'Terminal 2',
  currency: process.env.CURRENCY_SYMBOL || 'Rs ',
  taxLabel: process.env.TAX_LABEL || 'VAT',
  taxRate: Number(process.env.TAX_RATE ?? 0.18),          // fraction, e.g. 0.18 = 18%
  serviceRate: Number(process.env.SERVICE_RATE ?? 0.10),  // fraction
  lateMinutes: Number(process.env.LATE_MINUTES ?? 12),
  timezone: process.env.TZ_DISPLAY || 'Asia/Colombo',
  // business details printed on bills (set in Admin → Settings)
  address: '', phone: '', email: '', website: '', regNo: '', billFooter: 'Thank you! Come again.',
  // bill language (en | ta | si) and the restaurant's own wording in Tamil and Sinhala (optional)
  // menu category the order screen opens on ('' = 'Sri Lankan' if there is one, else the first)
  defaultCategory: '',
  billLang: 'en', restaurantTa: '', addressTa: '', billFooterTa: '', restaurantSi: '', addressSi: '', billFooterSi: '',
  logoRaster: null, // 1-bit logo for thermal printers: { w, h, data (base64, packed rows) }
};
const ENV_CONFIG = { ...CONFIG };
const NUMERIC = ['taxRate', 'serviceRate', 'lateMinutes'];

// Settings saved in Admin override the environment defaults.
async function loadSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  Object.assign(CONFIG, ENV_CONFIG);
  for (const { key, value } of rows) {
    if (!(key in ENV_CONFIG) || key === 'timezone') continue;
    if (key === 'logoRaster') { try { CONFIG.logoRaster = JSON.parse(value); } catch { CONFIG.logoRaster = null; } continue; }
    CONFIG[key] = NUMERIC.includes(key) ? Number(value) : value;
  }
}
listeners.add((kind) => { if (kind === 'settings') loadSettings().catch((e) => console.error('settings reload', e.message)); });

// Packages: Basic / Pro / Business, unlocked by a signed licence key (server/license.js)
const DEMO = process.env.DEMO_MODE === 'true'; // public live demo (server/demo.js)
const license = require('./license')({ pool, CONFIG, DEMO });
const VENDOR_WHATSAPP = (process.env.VENDOR_WHATSAPP || '94786036092').replace(/\D/g, '');
// Route guard: the feature must be in this restaurant's plan
const need = (feature) => (req, res, next) => license.has(feature)
  .then((ok) => (ok ? next() : next(Object.assign(new HttpError(403, license.upgradeMessage(feature)), { upgrade: feature }))), next);
const DEVICE_ACTIVE_DAYS = 30; // a device unused this long no longer counts towards the limit

const app = express();
app.set('trust proxy', 1);
// ---------- deployment mode ----------
//   standalone: one server, used directly (default)
//   local:      the shop server — the master copy; works with no internet and syncs to the cloud when it can
//   mirror:     the cloud copy on Railway — read-only, kept up to date by the shop server
//   cloud:      the main POS on Railway; a shop PC in standby keeps a copy for when the internet drops
//   standby:    the shop PC for 'cloud' — downloads everything from the cloud, takes over during an outage, uploads after
const MODE = ['local', 'mirror', 'cloud', 'standby'].includes(process.env.POS_MODE) ? process.env.POS_MODE : 'standalone';
const CLOUD_URL = String(process.env.CLOUD_URL || '').replace(/\/+$/, '');
const SYNC_TOKEN = String(process.env.SYNC_TOKEN || '');
const PRINT_DIRECT = process.env.PRINT_DIRECT ? process.env.PRINT_DIRECT === 'true' : ['local', 'standby'].includes(MODE);

const jsonBody = express.json({ limit: '200kb' });
// the logo upload and the sync endpoint parse their own larger bodies
app.use((req, res, next) => (req.path === '/api/admin/logo' || req.path === '/sync/ingest' ? next() : jsonBody(req, res, next)));

// The cloud copy is read-only: changes are made on the shop server and synced up.
app.use((req, res, next) => {
  if (MODE !== 'mirror' || req.method === 'GET' || req.path.startsWith('/sync/') || ['/api/login', '/api/logout'].includes(req.path)) return next();
  res.status(403).json({ error: 'This is the cloud copy (read-only). Make changes on the POS in the shop; they appear here automatically.' });
});

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };
const int = (v) => (v === null || v === undefined || v === '' ? null : parseInt(v, 10));

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function computeTotals(order, items) {
  const subtotal = items.reduce((s, i) => s + (i.qty - (i.void_qty || 0)) * (i.unit_price_cents + i.addons_cents), 0);
  const discount = Math.round(subtotal * (order.discount_pct || 0) / 100);
  const base = subtotal - discount;
  const service = order.service_on ? Math.round(base * CONFIG.serviceRate) : 0;
  const tax = Math.round(base * CONFIG.taxRate);
  const tip = Math.round(base * (order.tip_pct || 0) / 100);
  const total = base + service + tax + tip;
  return { subtotal_cents: subtotal, discount_cents: discount, service_cents: service, tax_cents: tax, tip_cents: tip, total_cents: total };
}

async function saveTotals(client, orderId) {
  const { rows: [o] } = await client.query('SELECT * FROM orders WHERE id=$1', [orderId]);
  const { rows: items } = await client.query('SELECT qty, void_qty, unit_price_cents, addons_cents FROM order_items WHERE order_id=$1', [orderId]);
  const t = computeTotals(o, items);
  await client.query(
    `UPDATE orders SET subtotal_cents=$2, discount_cents=$3, service_cents=$4, tax_cents=$5, tip_cents=$6, total_cents=$7 WHERE id=$1`,
    [orderId, t.subtotal_cents, t.discount_cents, t.service_cents, t.tax_cents, t.tip_cents, t.total_cents]);
  return t;
}

// Derive a single display status for an order from its KOTs and items.
function orderStatus(o) {
  if (o.status === 'paid') return 'paid';
  if (o.status === 'void') return 'void';
  if (o.bill_printed_at) return 'billed';
  if (o.kot_ready > 0) return 'ready';
  if (o.kot_live > 0) return 'kitchen';
  if (o.pending_items > 0 || o.item_count === 0) return 'ordering';
  return 'dining';
}

const ORDER_SUMMARY_SQL = `
  SELECT o.*, t.code AS table_code, s.name AS staff_name,
    (SELECT count(*)::int FROM order_items i WHERE i.order_id=o.id) AS item_count,
    (SELECT coalesce(sum(qty - void_qty),0)::int FROM order_items i WHERE i.order_id=o.id) AS item_qty,
    (SELECT coalesce(sum(amount_cents),0)::int FROM refunds r WHERE r.order_id=o.id) AS refunded_cents,
    (SELECT count(*)::int FROM order_items i WHERE i.order_id=o.id AND i.kot_id IS NULL AND NOT i.served_direct) AS pending_items,
    (SELECT count(*)::int FROM kots k WHERE k.order_id=o.id) AS kot_count,
    (SELECT count(*)::int FROM kots k WHERE k.order_id=o.id AND k.status IN ('held','new','cooking')) AS kot_live,
    (SELECT count(*)::int FROM kots k WHERE k.order_id=o.id AND k.status='ready') AS kot_ready
  FROM orders o
  LEFT JOIN dining_tables t ON t.id=o.table_id
  LEFT JOIN staff s ON s.id=o.staff_id`;

async function loadOrder(id, client = pool) {
  const { rows: [o] } = await client.query(`${ORDER_SUMMARY_SQL} WHERE o.id=$1`, [id]);
  if (!o) throw new HttpError(404, 'Order not found');
  const { rows: items } = await client.query(
    `SELECT i.*, k.kot_no, k.status AS kot_status, st.name AS station_name, m.name_ta, m.name_si
     FROM order_items i LEFT JOIN kots k ON k.id=i.kot_id LEFT JOIN stations st ON st.id=i.station_id
     LEFT JOIN menu_items m ON m.id=i.menu_item_id
     WHERE i.order_id=$1 ORDER BY i.id`, [id]);
  const { rows: kots } = await client.query(
    `SELECT k.*, st.name AS station_name FROM kots k LEFT JOIN stations st ON st.id=k.station_id
     WHERE k.order_id=$1 ORDER BY k.id`, [id]);
  const { rows: refunds } = await client.query(
    `SELECT r.*, s.name AS staff_name, a.name AS approved_name FROM refunds r LEFT JOIN staff s ON s.id=r.staff_id
     LEFT JOIN staff a ON a.id=r.approved_by WHERE r.order_id=$1 ORDER BY r.id`, [id]);
  const { rows: voids } = await client.query(
    `SELECT v.*, s.name AS staff_name, a.name AS approved_name FROM item_voids v LEFT JOIN staff s ON s.id=v.staff_id
     LEFT JOIN staff a ON a.id=v.approved_by WHERE v.order_id=$1 ORDER BY v.id`, [id]);
  o.display_status = orderStatus(o);
  o.items = items;
  o.kots = kots;
  o.refunds = refunds;
  o.voids = voids;
  Object.assign(o, computeTotals(o, items));
  return o;
}

// ---------- audit log + manager approval ----------
async function audit(c, { action, staffId = null, approvedBy = null, orderId = null, summary, details = {} }) {
  if (MODE === 'mirror') return; // the cloud copy receives the shop's audit log instead
  await c.query('INSERT INTO audit_log(action, staff_id, approved_by, order_id, summary, details) VALUES ($1,$2,$3,$4,$5,$6)',
    [action, staffId, approvedBy && approvedBy !== staffId ? approvedBy : null, orderId, String(summary).slice(0, 300), JSON.stringify(details)]);
}
// Returns the approving staff id: the user themself if their role is allowed, otherwise whoever owns approval_pin.
async function approval(req, roles = ['Manager']) {
  if (roles.includes(req.user.role)) return req.user.id;
  const pin = String(req.body.approval_pin || '');
  if (!pin) throw new HttpError(403, `${roles.join(' or ')} approval needed`);
  const { rows } = await pool.query('SELECT id, pin_hash FROM staff WHERE active AND role = ANY($1)', [roles]);
  const ok = rows.find((s) => checkPin(pin, s.pin_hash));
  if (!ok) throw new HttpError(403, 'Approval PIN not accepted');
  return ok.id;
}
const CARD_BRANDS = ['Visa', 'Mastercard', 'Amex', 'UnionPay', 'JCB', 'Other'];
const reason = (v) => { const r = String(v || '').trim().slice(0, 200); if (r.length < 3) bad('Give a reason'); return r; };
// shifts opened on the shop PC during an outage have ids from 1,000,000,001
const shiftNo = (id) => (id > 1000000000 ? `offline #${id - 1000000000}` : `#${id}`);
const otitle = (o) => (o.type === 'dinein' ? `Table ${o.table_code}` : `${({ takeaway: 'Takeaway', delivery: 'Delivery', counter: 'Counter' })[o.type]} #${o.order_no}`);
async function openShift(c) {
  const { rows: [sh] } = await c.query("SELECT * FROM shifts WHERE status='open'");
  return sh || null;
}

const printing = createPrinting({ pool, tx, listeners, CONFIG, wrap, HttpError });
const integrations = createIntegrations({ pool, tx, wrap, HttpError, CONFIG, MODE, shiftSummary: (c, id) => shiftSummary(c, id), allowed: () => license.has('emails') });
const inventory = createInventory({ pool, tx, wrap, HttpError, audit, notify });
app.use('/bridge', printing.bridge);
const sync = require('./sync')({ pool, tx, wrap, HttpError, notify, MODE, CLOUD_URL, SYNC_TOKEN,
  allowed: async () => (await license.has('offline')) || license.upgradeMessage('offline'),
  // a shift closed on the shop PC during an outage: the cloud sends its Z-report email once it arrives
  onRemoteShiftClosed: async (c, id) => { await integrations.shiftClosed(c, await shiftSummary(c, id)); setTimeout(() => integrations.kick(), 500); } });
app.use('/sync', sync.ingest);

// Shop standby: the /start page (public/start.html) asks here whether to send staff to the cloud or keep them on this PC.
app.get('/start/status', wrap(async (req, res) => {
  if (MODE !== 'standby') return res.json({ mode: MODE });
  const y = await sync.status();
  res.json({ mode: MODE, cloud: CLOUD_URL || null, configured: y.configured, ready: y.ready, online: y.online, current: y.current,
    pending: y.pending, downloading: y.snapshot, problem: y.last_error && y.online ? y.last_error : null, last_pull_at: y.last_pull_at });
}));

// ---------- auth ----------
app.get('/api/config', wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT key, extract(epoch FROM updated_at)::bigint AS v FROM app_images WHERE key IN ('login_bg','logo')");
  const ver = Object.fromEntries(rows.map((r) => [r.key, r.v]));
  const { logoRaster, ...pub } = CONFIG;
  const lic = await license.current();
  res.json({ ...pub, license: { ...lic, id: undefined }, vendorWhatsapp: VENDOR_WHATSAPP,
    demo: demo ? { ...demo.info, trialUrl: process.env.DEMO_TRIAL_URL || 'https://virunthu.shop/#trial' } : undefined, mode: MODE, printDirect: PRINT_DIRECT, billText: billtext.TEXT, cloudUrl: MODE === 'standby' ? CLOUD_URL : undefined,
    loginBg: DEMO ? '/img/demo-login-bg.jpg' : ver.login_bg ? `/login-bg?v=${ver.login_bg}` : '/img/login-bg.jpg', logo: ver.logo ? `/logo?v=${ver.logo}` : null });
}));

// Restaurant logo (public: shown on the login screen and printed bills)
app.get('/logo', wrap(async (req, res) => {
  const { rows: [img] } = await pool.query("SELECT mime, data FROM app_images WHERE key='logo'");
  if (!img) return res.status(404).end();
  res.set({ 'Content-Type': img.mime, 'Cache-Control': req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.send(img.data);
}));

// Login background: the uploaded photo, or the built-in one. Public, because it shows before sign-in.
app.get('/login-bg', wrap(async (req, res) => {
  const { rows: [img] } = await pool.query("SELECT mime, data FROM app_images WHERE key='login_bg'");
  if (!img) return res.redirect('/img/login-bg.jpg');
  res.set({ 'Content-Type': img.mime, 'Cache-Control': req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.send(img.data);
}));

// Dish photos are public (no session needed) and cached; the ?v= version changes on every upload.
app.get('/menu-img/:id', wrap(async (req, res) => {
  const { rows: [img] } = await pool.query('SELECT mime, data FROM menu_item_images WHERE item_id=$1', [int(req.params.id)]);
  if (!img) return res.status(404).end();
  res.set({ 'Content-Type': img.mime, 'Cache-Control': req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.send(img.data);
}));

app.post('/api/login', wrap(async (req, res) => {
  const pin = String(req.body.pin || '');
  if (!/^\d{4,8}$/.test(pin)) bad('Enter your PIN');
  const { rows } = await pool.query('SELECT * FROM staff WHERE active');
  const user = rows.find((s) => checkPin(pin, s.pin_hash));
  if (!user) {
    await audit(pool, { action: 'login.failed', summary: 'Wrong PIN entered', details: { ip: req.ip } });
    throw new HttpError(401, 'Wrong PIN');
  }
  const deviceId = await claimDevice(req, user);
  await audit(pool, { action: 'login', staffId: user.id, summary: `${user.name} signed in` });
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO sessions(token, staff_id, device_id) VALUES ($1,$2,$3)', [token, user.id, deviceId]);
  res.setHeader('Set-Cookie', `pos_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 16}${req.secure ? '; Secure' : ''}`);
  res.json({ id: user.id, name: user.name, initials: user.initials, role: user.role });
}));

// Device limit. Each browser sends its own device id (kept in its localStorage) when signing in.
// A device that is already registered always gets in. A new one gets in while the plan has room;
// when it's full, a Manager signing in on the new device replaces the device unused the longest,
// and other staff are asked to fetch a manager.
async function claimDevice(req, user) {
  const raw = String(req.body.device || '');
  const id = /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw
    : `legacy-${crypto.createHash('sha256').update(`${req.ip}|${req.headers['user-agent'] || ''}`).digest('hex').slice(0, 16)}`;
  const name = String(req.body.deviceName || '').replace(/[\u0000-\u001f]/g, '').slice(0, 60);
  const { limits, planName } = await license.current();
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(4711)'); // two tablets signing in at once can't both take the last place
    const { rows: [known] } = await c.query('SELECT id, revoked_at FROM devices WHERE id=$1', [id]);
    if (!known || known.revoked_at) {
      if (limits.devices != null) {
        const { rows: active } = await c.query(`SELECT id FROM devices WHERE revoked_at IS NULL AND last_seen > now() - interval '${DEVICE_ACTIVE_DAYS} days'
                                                ORDER BY last_seen ASC`);
        if (active.length >= limits.devices) {
          if (user.role !== 'Manager') {
            throw new HttpError(403, `This POS is already in use on ${active.length} device${active.length === 1 ? '' : 's'}, the most the ${planName} plan allows. Ask a manager to sign in on this device, or to remove an old device in Admin → Plan & licence.`);
          }
          const drop = active.slice(0, active.length - limits.devices + 1).map((d) => d.id);
          await c.query('UPDATE devices SET revoked_at=now() WHERE id = ANY($1)', [drop]);
          await c.query('DELETE FROM sessions WHERE device_id = ANY($1)', [drop]);
          await audit(c, { action: 'device.replaced', staffId: user.id, summary: `${user.name} signed in on a new device; the device unused the longest was removed (plan limit ${limits.devices})` });
        }
      }
      await c.query(`INSERT INTO devices(id, name, last_staff) VALUES ($1,$2,$3)
                     ON CONFLICT (id) DO UPDATE SET revoked_at=NULL, first_seen=now(), last_seen=now(), name=EXCLUDED.name, last_staff=EXCLUDED.last_staff`, [id, name, user.id]);
    } else {
      await c.query('UPDATE devices SET last_seen=now(), last_staff=$2, name=CASE WHEN $3 <> \'\' THEN $3 ELSE name END WHERE id=$1', [id, user.id, name]);
    }
    return id;
  });
}

async function auth(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie).pos_session;
    if (!token) throw new HttpError(401, 'Not signed in');
    const { rows: [u] } = await pool.query(
      `SELECT s.id, s.name, s.initials, s.role, x.device_id FROM sessions x JOIN staff s ON s.id=x.staff_id
       WHERE x.token=$1 AND s.active AND x.created_at > now() - interval '16 hours'`, [token]);
    if (!u) throw new HttpError(401, 'Session expired');
    req.user = u; req.token = token;
    // keep the device counted as in use (at most one write every 10 minutes per device)
    if (u.device_id) pool.query("UPDATE devices SET last_seen=now() WHERE id=$1 AND last_seen < now() - interval '10 minutes'", [u.device_id]).catch(() => {});
    next();
  } catch (e) { next(e); }
}
app.use('/api', auth);

app.get('/api/me', (req, res) => res.json(req.user));
app.get('/api/sync/status', wrap(async (req, res) => res.json(await sync.status())));
// Live demo: blocked actions, and a reset button for visitors
const demo = DEMO ? require('./demo')({ pool, tx, notify, loadSettings, repairSequences: () => sync.repairSequences(), CONFIG, HttpError }) : null;
if (demo) {
  app.use('/api', demo.guard);
  app.post('/api/demo/reset', wrap(async (req, res) => { await demo.resetByVisitor(); res.json({ ok: true }); }));
}
app.use('/api/admin/audit', need('audit'));
app.use('/api/admin', adminRouter({ pool, tx, hashPin, checkPin, notify, wrap, HttpError, CONFIG, ENV_CONFIG, loadSettings, audit, license }));
app.use('/api/admin/printing', printing.admin);
app.use('/api/admin/integrations', need('emails'), integrations.admin);
app.use('/api/reports', reportsRouter({ pool, wrap, HttpError, CONFIG, license }));
app.use('/api/inventory', need('stock'), inventory.router);

// ---------- Admin → Plan & licence (managers) ----------
const managersOnly = (req) => { if (req.user.role !== 'Manager') throw new HttpError(403, 'Managers only'); };
async function licenseInfo() {
  const lic = await license.current();
  const { rows: devices } = await pool.query(`SELECT d.id, d.name, d.first_seen, d.last_seen, s.name AS last_staff_name,
      d.last_seen > now() - interval '${DEVICE_ACTIVE_DAYS} days' AS active
    FROM devices d LEFT JOIN staff s ON s.id = d.last_staff WHERE d.revoked_at IS NULL ORDER BY d.last_seen DESC`);
  const { rows: [st] } = await pool.query('SELECT count(*)::int AS n FROM staff WHERE active');
  return { license: lic, plans: license.PLANS, features: license.FEATURES, vendorWhatsapp: VENDOR_WHATSAPP, hasPublicKey: license.hasPublicKey(),
    keyFromEnv: !!process.env.LICENSE_KEY, devices, usage: { devices: devices.filter((d) => d.active).length, staff: st.n } };
}
app.get('/api/admin/license', wrap(async (req, res) => { managersOnly(req); res.json(await licenseInfo()); }));
app.post('/api/admin/license', wrap(async (req, res) => {
  managersOnly(req);
  if (process.env.LICENSE_KEY) throw new HttpError(409, 'The licence key is set on the server (LICENSE_KEY). Change it there.');
  let p; try { p = license.verifyKey(req.body.key); } catch (e) { throw new HttpError(400, e.message); }
  await tx(async (c) => {
    await c.query("INSERT INTO settings(key, value) VALUES ('license_key', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [String(req.body.key).trim().replace(/\s+/g, '')]);
    await audit(c, { action: 'license.set', staffId: req.user.id, summary: `Licence key entered: ${license.PLANS[p.plan].name} plan for ${p.client}, until ${p.expires}` });
  });
  license.forget(); notify('settings');
  res.json(await licenseInfo());
}));
app.delete('/api/admin/devices/:id', wrap(async (req, res) => {
  managersOnly(req);
  const id = String(req.params.id);
  const { rows: [me] } = await pool.query('SELECT device_id FROM sessions WHERE token=$1', [req.token]);
  if (me && me.device_id === id) throw new HttpError(400, 'This is the device you are using. Remove it from another device.');
  await tx(async (c) => {
    const { rowCount } = await c.query('UPDATE devices SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [id]);
    if (!rowCount) throw new HttpError(404, 'Device not found');
    await c.query('DELETE FROM sessions WHERE device_id=$1', [id]);
    await audit(c, { action: 'device.removed', staffId: req.user.id, summary: `${req.user.name} removed a device from the POS` });
  });
  res.json(await licenseInfo());
}));
app.post('/api/logout', wrap(async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE token=$1', [req.token]);
  res.setHeader('Set-Cookie', 'pos_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
}));

// ---------- live events (SSE, fanned out across instances via LISTEN/NOTIFY) ----------
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = (kind) => res.write(`data: ${kind}\n\n`);
  const hb = setInterval(() => res.write(': hb\n\n'), 25000);
  listeners.add(send);
  req.on('close', () => { clearInterval(hb); listeners.delete(send); });
});

// ---------- menu ----------
app.get('/api/menu', wrap(async (req, res) => {
  const { rows: categories } = await pool.query('SELECT * FROM categories ORDER BY sort, id');
  const { rows: items } = await pool.query(
    `SELECT m.*, st.name AS station_name, st.code AS station_code, ${inventory.STOCK_OUT_SQL} AS stock_out,
       coalesce((SELECT json_agg(json_build_object('id',a.id,'name',a.name,'price_cents',a.price_cents,'unit',a.unit,'max_qty',a.max_qty) ORDER BY a.id)
                 FROM item_addons a WHERE a.item_id=m.id), '[]') AS addons
     FROM menu_items m JOIN stations st ON st.id=m.station_id WHERE m.active ORDER BY m.sort, m.id`);
  const { rows: stations } = await pool.query('SELECT * FROM stations ORDER BY sort, id');
  res.json({ categories: categories.map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id) })).filter((c) => c.items.length), stations });
}));

// ---------- floor + queue ----------
app.get('/api/floor', wrap(async (req, res) => {
  const { rows: areas } = await pool.query('SELECT * FROM areas ORDER BY sort, id');
  const { rows: tables } = await pool.query('SELECT * FROM dining_tables WHERE active ORDER BY sort, id');
  const { rows: open } = await pool.query(`${ORDER_SUMMARY_SQL} WHERE o.status='open' ORDER BY o.opened_at`);
  for (const o of open) o.display_status = orderStatus(o);
  const byTable = Object.fromEntries(open.filter((o) => o.table_id).map((o) => [o.table_id, o]));
  const outTables = tables.map((t) => {
    const o = byTable[t.id];
    return { ...t, status: o ? o.display_status : 'free', order: o ? {
      id: o.id, order_no: o.order_no, guests: o.guests, opened_at: o.opened_at, total_cents: o.total_cents } : null };
  });
  const queue = open.filter((o) => o.type !== 'dinein').map((o) => ({
    id: o.id, order_no: o.order_no, type: o.type, customer_name: o.customer_name, opened_at: o.opened_at,
    total_cents: o.total_cents, status: o.display_status }));
  const { rows: [counts] } = await pool.query(
    `SELECT (SELECT count(*)::int FROM kots WHERE status IN ('held','new','cooking','ready')) AS live_tickets,
            (SELECT count(*)::int FROM orders WHERE status='paid' AND closed_at::date = (now() AT TIME ZONE $1)::date) AS closed_today,
            (SELECT count(*)::int FROM ingredients WHERE active AND stock <= reorder_level) AS stock_alerts`,
    [CONFIG.timezone]);
  const seated = outTables.filter((t) => t.order);
  res.json({
    areas: areas.map((a) => ({ ...a, tables: outTables.filter((t) => t.area_id === a.id) })),
    queue,
    stats: { tables: tables.length, seated: seated.length, covers: seated.reduce((s, t) => s + t.order.guests, 0), ...counts },
  });
}));

// ---------- orders ----------
app.post('/api/orders', wrap(async (req, res) => {
  const lic = await license.current();
  if (lic.state === 'expired') {
    throw new HttpError(403, `The ${lic.planName === 'Free trial' ? 'free trial' : 'licence'} ended on ${lic.expires}. Open orders can still be finished and printed. Contact us on WhatsApp to ${lic.plan === 'trial' ? 'choose a plan' : 'renew'}.`);
  }
  const { type } = req.body;
  if (!['dinein', 'takeaway', 'delivery', 'counter'].includes(type)) bad('Unknown order type');
  if (!(await openShift(pool))) throw new HttpError(409, 'No shift is open. Open a shift before starting orders.');
  const tableId = int(req.body.table_id);
  if (type === 'dinein' && !tableId) bad('Pick a table');
  if (type === 'takeaway' && !req.body.customer_name) bad('Customer name is required');
  if (type === 'delivery' && (!req.body.customer_name || !req.body.address)) bad('Name and address are required');
  if (tableId) {
    const { rows: [tbl] } = await pool.query('SELECT id FROM dining_tables WHERE id=$1 AND active', [tableId]);
    if (!tbl) bad('Table not found');
    const { rows: [existing] } = await pool.query("SELECT id FROM orders WHERE table_id=$1 AND status='open'", [tableId]);
    if (existing) return res.json(await loadOrder(existing.id));
  }
  const guests = Math.max(1, int(req.body.guests) || (type === 'dinein' ? 2 : 1));
  const { rows: [o] } = await pool.query(
    `INSERT INTO orders(type, table_id, guests, customer_name, phone, address, staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [type, type === 'dinein' ? tableId : null, guests, req.body.customer_name || null, req.body.phone || null, req.body.address || null, req.user.id]);
  notify('floor');
  res.status(201).json(await loadOrder(o.id));
}));

app.get('/api/orders/:id', wrap(async (req, res) => res.json(await loadOrder(int(req.params.id)))));

app.patch('/api/orders/:id', wrap(async (req, res) => {
  const id = int(req.params.id);
  const allowed = {
    guests: (v) => Math.max(1, int(v)),
    discount_pct: (v) => { const n = int(v); if (![0, 10, 20].includes(n)) bad('Bad discount'); return n; },
    service_on: (v) => !!v,
    tip_pct: (v) => { const n = int(v); if (n < 0 || n > 50) bad('Bad tip'); return n; },
    split_ways: (v) => { const n = int(v); if (n < 1 || n > 10) bad('Bad split'); return n; },
    payment_method: (v) => { if (!['card', 'cash', 'wallet'].includes(v)) bad('Bad payment method'); return v; },
    customer_name: (v) => String(v || '').trim().slice(0, 80) || null,
    phone: (v) => { const p = String(v || '').trim().slice(0, 20); if (p && !/^[+\d][\d\s-]{5,19}$/.test(p)) bad('Phone number looks wrong'); return p || null; },
    address: (v) => String(v || '').trim().slice(0, 300) || null,
  };
  const sets = []; const vals = [id];
  for (const [k, fn] of Object.entries(allowed)) {
    if (k in req.body) { vals.push(fn(req.body[k])); sets.push(`${k}=$${vals.length}`); }
  }
  if (!sets.length) bad('Nothing to update');
  await tx(async (c) => {
    const { rows: [before] } = await c.query(`${ORDER_SUMMARY_SQL} WHERE o.id=$1`, [id]);
    const r = await c.query(`UPDATE orders SET ${sets.join(', ')} WHERE id=$1 AND status='open'`, vals);
    if (!r.rowCount) bad('Order is closed');
    await saveTotals(c, id);
    if ('discount_pct' in req.body && before.discount_pct !== int(req.body.discount_pct)) {
      await audit(c, { action: 'order.discount', staffId: req.user.id, orderId: id,
        summary: `${otitle(before)} discount ${before.discount_pct}% → ${int(req.body.discount_pct)}%` });
    }
  });
  notify('order');
  res.json(await loadOrder(id));
}));

app.post('/api/orders/:id/items', wrap(async (req, res) => {
  const id = int(req.params.id);
  const qty = Math.max(1, int(req.body.qty) || 1);
  const out = await tx(async (c) => {
    const { rows: [o] } = await c.query("SELECT id FROM orders WHERE id=$1 AND status='open' FOR UPDATE", [id]);
    if (!o) bad('Order is closed');
    const { rows: [m] } = await c.query(
      'SELECT m.*, c.default_course FROM menu_items m JOIN categories c ON c.id=m.category_id WHERE m.id=$1 AND m.active', [int(req.body.menu_item_id)]);
    if (!m) bad('Dish not found');
    // Add-ons with a quantity per dish: [{ id, qty }] (addon_ids = qty 1 each, for older terminals)
    const want = new Map();
    for (const a of Array.isArray(req.body.addons) ? req.body.addons : []) {
      const aid = int(a && a.id), aq = int(a && a.qty);
      if (aid && aq > 0) want.set(aid, aq);
    }
    for (const aid of (req.body.addon_ids || []).map(int).filter(Boolean)) if (!want.has(aid)) want.set(aid, 1);
    const addonIds = [...want.keys()];
    const { rows: addonRows } = addonIds.length
      ? await c.query('SELECT id, name, price_cents, unit, max_qty FROM item_addons WHERE item_id=$1 AND id = ANY($2) ORDER BY id', [m.id, addonIds])
      : { rows: [] };
    if (addonRows.length !== addonIds.length) bad('An add-on is no longer available for this dish');
    const addons = addonRows.map((a) => {
      const q = want.get(a.id);
      if (q > a.max_qty) bad(`${a.name}: at most ${a.max_qty} per dish`);
      return { id: a.id, name: a.name, price_cents: a.price_cents, qty: q, ...(a.unit ? { unit: a.unit } : {}) };
    });
    const course = ['drink', 'starter', 'main', 'dessert'].includes(req.body.course) ? req.body.course : m.default_course;
    const spice = m.has_spice && req.body.spice && req.body.spice !== 'Standard' ? String(req.body.spice).slice(0, 20) : null;
    const note = req.body.note ? String(req.body.note).slice(0, 200) : null;
    // served without a KOT: the dish's own setting, unless the line says otherwise
    const direct = typeof req.body.no_kot === 'boolean' ? req.body.no_kot : m.no_kot;
    // merge with an identical unsent line
    const { rows: [same] } = await c.query(
      `SELECT id FROM order_items WHERE order_id=$1 AND kot_id IS NULL AND menu_item_id=$2 AND course=$3
         AND spice IS NOT DISTINCT FROM $4 AND note IS NOT DISTINCT FROM $5 AND addons=$6::jsonb AND served_direct=$7 AND void_qty=0`,
      [id, m.id, course, spice, note, JSON.stringify(addons), direct]);
    if (same) {
      await c.query('UPDATE order_items SET qty=qty+$2 WHERE id=$1', [same.id, qty]);
    } else {
      await c.query(
        `INSERT INTO order_items(order_id, menu_item_id, station_id, name, qty, unit_price_cents, addons, addons_cents, spice, course, note, served_direct, done)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
        [id, m.id, m.station_id, m.name, qty, m.price_cents, JSON.stringify(addons), addons.reduce((s, a) => s + a.price_cents * a.qty, 0), spice, course, note, direct]);
    }
    await saveTotals(c, id);
    return id;
  });
  notify('order');
  res.json(await loadOrder(out));
}));

app.patch('/api/items/:id', wrap(async (req, res) => {
  const itemId = int(req.params.id);
  const qty = int(req.body.qty);
  const orderId = await tx(async (c) => {
    const { rows: [i] } = await c.query(
      "SELECT i.* FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.id=$1 AND o.status='open'", [itemId]);
    if (!i) bad('Item not found');
    if (i.kot_id) bad('Already sent to the kitchen. Use Void to remove it.');
    if (i.served_direct) bad('Already served. Use Void to remove it.');
    if (req.body.served_direct === true) {
      await c.query('UPDATE order_items SET served_direct=TRUE, done=TRUE WHERE id=$1', [itemId]);
      const { rows: [o] } = await c.query(`${ORDER_SUMMARY_SQL} WHERE o.id=$1`, [i.order_id]);
      await audit(c, { action: 'item.no_kot', staffId: req.user.id, orderId: i.order_id,
        summary: `${i.qty} × ${i.name} served without KOT on ${otitle(o)}` });
    } else if (!qty || qty < 1) await c.query('DELETE FROM order_items WHERE id=$1', [itemId]);
    else await c.query('UPDATE order_items SET qty=$2 WHERE id=$1', [itemId, qty]);
    await saveTotals(c, i.order_id);
    return i.order_id;
  });
  notify('order');
  res.json(await loadOrder(orderId));
}));

// Send unsent items to the kitchen as KOTs.
app.post('/api/orders/:id/kots', wrap(async (req, res) => {
  const id = int(req.params.id);
  const mode = req.body.mode === 'single' ? 'single' : 'station';
  const holdLater = !!req.body.hold_later; // hold mains & desserts until fired
  const created = await tx(async (c) => {
    const { rows: [o] } = await c.query("SELECT * FROM orders WHERE id=$1 AND status='open' FOR UPDATE", [id]);
    if (!o) bad('Order is closed');
    const out = await createKots(c, id, mode, holdLater, req.user.id, req.user.name);
    if (!out.length) bad('Nothing new to send');
    return out;
  });
  notify('kitchen');
  res.json({ kots: created, order: await loadOrder(id) });
}));

// Send a KOT to its station printer (or the default kitchen printer). No printer configured → nothing queued.
async function printKot(c, kotId, staffName, flag) {
  const { rows: [k] } = await c.query(
    'SELECT k.*, st.name AS station_name, st.printer_id FROM kots k LEFT JOIN stations st ON st.id=k.station_id WHERE k.id=$1', [kotId]);
  const printerId = k.printer_id || await printing.printerFor(c, 'kitchen');
  if (!printerId) return null;
  const { rows: [order] } = await c.query(`${ORDER_SUMMARY_SQL} WHERE o.id=$1`, [k.order_id]);
  const { rows: items } = await c.query('SELECT * FROM order_items WHERE kot_id=$1 AND qty > void_qty ORDER BY id', [kotId]);
  if (!items.length) return null;
  return printing.enqueue(c, printerId, 'kot', `KOT #${k.kot_no} · ${otitle(order)}`, printing.kotDoc({ kot: k, order, items, staffName, flag }));
}

// Groups unsent lines into KOTs (per station or one combined ticket). Returns the created KOTs.
async function createKots(c, id, mode, holdLater, staffId, staffName) {
    const { rows: pending } = await c.query('SELECT * FROM order_items WHERE order_id=$1 AND kot_id IS NULL AND NOT served_direct ORDER BY id', [id]);
    if (!pending.length) return [];
    const { rows: [prev] } = await c.query('SELECT count(*)::int AS n FROM kots WHERE order_id=$1', [id]);
    const isAddon = prev.n > 0;
    const groups = new Map();
    for (const it of pending) {
      const held = holdLater && (it.course === 'main' || it.course === 'dessert');
      const key = `${mode === 'single' ? 'all' : it.station_id}|${held ? 'held' : 'now'}`;
      if (!groups.has(key)) groups.set(key, { station: mode === 'single' ? null : it.station_id, held, items: [] });
      groups.get(key).items.push(it);
    }
    const out = [];
    for (const g of groups.values()) {
      const { rows: [k] } = await c.query(
        'INSERT INTO kots(order_id, station_id, status, is_addon, staff_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [id, g.station, g.held ? 'held' : 'new', isAddon, staffId]);
      await c.query('UPDATE order_items SET kot_id=$1 WHERE id = ANY($2)', [k.id, g.items.map((i) => i.id)]);
      out.push(k);
      if (!g.held) await printKot(c, k.id, staffName);
    }
    // printing a bill then adding items re-opens the bill
    await c.query('UPDATE orders SET bill_printed_at=NULL WHERE id=$1', [id]);
    return out;
}

app.post('/api/orders/:id/print-bill', wrap(async (req, res) => {
  const id = int(req.params.id);
  const printed = await tx(async (c) => {
    const r = await c.query("UPDATE orders SET bill_printed_at=now() WHERE id=$1 AND status='open'", [id]);
    if (!r.rowCount) bad('Order is closed');
    await saveTotals(c, id);
    const o = await loadOrder(id, c);
    await audit(c, { action: 'bill.print', staffId: req.user.id, orderId: id, summary: `Bill printed for ${otitle(o)} · ${o.total_cents / 100}` });
    const pid = await printing.printerFor(c, 'bill');
    return pid ? !!(await printing.enqueue(c, pid, 'bill', `Bill · ${otitle(o)}`, printing.billDoc(o, { lang: req.body.lang }))) : false;
  });
  notify('floor');
  res.json({ ...(await loadOrder(id)), printed_to_printer: printed });
}));

// Reprint a receipt (any order) — goes to the bill printer, or the browser prints it.
app.post('/api/orders/:id/reprint', wrap(async (req, res) => {
  const id = int(req.params.id);
  const printed = await tx(async (c) => {
    const o = await loadOrder(id, c);
    await audit(c, { action: 'bill.reprint', staffId: req.user.id, orderId: id, summary: `Receipt reprinted for ${otitle(o)}` });
    const pid = await printing.printerFor(c, 'bill');
    return pid ? !!(await printing.enqueue(c, pid, 'bill', `Receipt copy · ${otitle(o)}`,
      printing.billDoc(o, { label: o.status === 'paid' ? 'receiptCopy' : 'billCopy', refunds: o.refunds, lang: req.body.lang }))) : false;
  });
  res.json({ ...(await loadOrder(id)), printed_to_printer: printed });
}));

app.post('/api/kots/:id/reprint', wrap(async (req, res) => {
  const id = int(req.params.id);
  const job = await tx(async (c) => {
    const j = await printKot(c, id, req.user.name, 'REPRINT');
    if (!j) bad('No kitchen printer is set up for this station');
    await audit(c, { action: 'kot.reprint', staffId: req.user.id, summary: `KOT reprinted (ticket ${id})` });
    return j;
  });
  res.json({ ok: true, job });
}));

const fmtMoney = (c) => CONFIG.currency + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
app.post('/api/orders/:id/pay', wrap(async (req, res) => {
  const id = int(req.params.id);
  const method = req.body.payment_method;
  if (!['card', 'cash', 'wallet'].includes(method)) bad('Pick a payment method');
  // Card payments record the card type and the last 4 digits (as on the terminal slip) — never the full number.
  let card = { brand: null, last4: null, auth: null };
  if (method === 'card') {
    const brand = String(req.body.card_brand || '');
    if (!CARD_BRANDS.includes(brand)) bad('Pick the card type (Visa, Mastercard…)');
    const last4 = String(req.body.card_last4 || '').trim();
    if (!/^\d{4}$/.test(last4)) bad('Enter the last 4 digits of the card');
    const auth = String(req.body.card_auth || '').trim().toUpperCase();
    if (auth && !/^[A-Z0-9]{2,12}$/.test(auth)) bad('Approval code should be 2–12 letters or numbers');
    card = { brand, last4, auth: auth || null };
  }
  // Cash payments must cover the bill: cash received >= total (checked again below against the final total).
  let cashGot = null;
  if (method === 'cash') {
    const v = req.body.cash_received_cents;
    if (v === undefined || v === null || v === '') bad('Enter the cash received');
    cashGot = Number(v);
    if (!Number.isInteger(cashGot) || cashGot <= 0 || cashGot > 100000000) bad('Cash received is not a valid amount');
  }
  let kitchenTouched = false;
  await tx(async (c) => {
    const { rows: [o] } = await c.query("SELECT * FROM orders WHERE id=$1 AND status='open' FOR UPDATE", [id]);
    if (!o) bad('Order is closed');
    const shift = await openShift(c);
    if (!shift) throw new HttpError(409, 'No shift is open. Open a shift before taking payments.');
    const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM order_items WHERE order_id=$1', [id]);
    if (!n.n) bad('Order has no items');
    // Unsent lines are part of the sale: send them to the kitchen rather than dropping them.
    const sent = await createKots(c, id, 'station', false, req.user.id, req.user.name);
    if (sent.length) kitchenTouched = true;
    const t = await saveTotals(c, id);
    if (t.total_cents <= 0) bad('Order total is zero');
    if (cashGot !== null && cashGot < t.total_cents) {
      bad(`Cash received (${fmtMoney(cashGot)}) is less than the total (${fmtMoney(t.total_cents)}). Short by ${fmtMoney(t.total_cents - cashGot)}.`);
    }
    await c.query(`UPDATE orders SET status='paid', payment_method=$2, closed_at=now(), shift_id=$3, card_brand=$4, card_last4=$5, card_auth=$6,
                   cash_received_cents=$7, change_cents=$8 WHERE id=$1`,
      [id, method, shift.id, card.brand, card.last4, card.auth, cashGot, cashGot === null ? null : cashGot - t.total_cents]);
    await inventory.deductForOrder(c, id, req.user.id); // recipe ingredients come out of stock
  });
  notify(kitchenTouched ? 'kitchen' : 'floor');
  res.json(await loadOrder(id));
}));

app.post('/api/orders/:id/void', wrap(async (req, res) => {
  const id = int(req.params.id);
  const { rows: [pre] } = await pool.query(
    'SELECT (SELECT count(*) FROM kots WHERE order_id=$1) + (SELECT count(*) FROM order_items WHERE order_id=$1 AND served_direct) AS n', [id]);
  pre.n = Number(pre.n);
  const sentToKitchen = pre.n > 0;
  const why = sentToKitchen ? reason(req.body.reason) : String(req.body.reason || 'Cancelled before sending').slice(0, 200);
  const approvedBy = sentToKitchen ? await approval(req) : req.user.id;
  await tx(async (c) => {
    const o = await loadOrder(id, c);
    if (o.status !== 'open') bad('Order is closed');
    const shift = await openShift(c);
    const r = await c.query("UPDATE orders SET status='void', closed_at=now(), shift_id=$2 WHERE id=$1 AND status='open'", [id, shift ? shift.id : null]);
    if (!r.rowCount) bad('Order is closed');
    // record every sent line as voided, and tell the kitchen
    for (const i of o.items.filter((x) => (x.kot_id || x.served_direct) && x.qty > x.void_qty)) {
      const q = i.qty - i.void_qty;
      await c.query(`INSERT INTO item_voids(order_id, order_item_id, name, qty, amount_cents, reason, staff_id, approved_by, shift_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, i.id, i.name, q, q * (i.unit_price_cents + i.addons_cents), why, req.user.id, approvedBy, shift ? shift.id : null]);
    }
    const live = o.kots.filter((k) => k.status !== 'served');
    for (const k of live) {
      const { rows: [st] } = await c.query('SELECT printer_id FROM stations WHERE id=$1', [k.station_id]);
      const pid = (st && st.printer_id) || await printing.printerFor(c, 'kitchen');
      const names = o.items.filter((i) => i.kot_id === k.id && i.qty > i.void_qty);
      for (const i of names) {
        await printing.enqueue(c, pid, 'void', `VOID · ${otitle(o)}`, printing.voidDoc({ order: o, kotNo: k.kot_no, stationName: k.station_name, name: i.name, qty: i.qty - i.void_qty, reason: why, staffName: req.user.name }));
      }
    }
    await c.query("UPDATE kots SET status='served', served_at=now() WHERE order_id=$1 AND status<>'served'", [id]);
    await audit(c, { action: 'order.void', staffId: req.user.id, approvedBy, orderId: id,
      summary: `${otitle(o)} voided (${sentToKitchen ? 'after sending to kitchen' : 'before sending'}) · ${why}`, details: { total_cents: o.total_cents } });
  });
  notify('kitchen');
  res.json({ ok: true });
}));

// Void some or all of a line that has already gone to the kitchen.
app.post('/api/items/:id/void', wrap(async (req, res) => {
  const itemId = int(req.params.id);
  const why = reason(req.body.reason);
  const approvedBy = await approval(req);
  const orderId = await tx(async (c) => {
    const { rows: [i] } = await c.query(
      `SELECT i.*, o.status AS order_status, k.kot_no, k.status AS kot_status, st.name AS station_name, st.printer_id
       FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN kots k ON k.id=i.kot_id
       LEFT JOIN stations st ON st.id=i.station_id WHERE i.id=$1 FOR UPDATE OF i`, [itemId]);
    if (!i) throw new HttpError(404, 'Item not found');
    if (i.order_status !== 'open') bad('Order is closed. Use a refund instead.');
    if (!i.kot_id && !i.served_direct) bad('This item has not been sent. Remove it with the − button.');
    const left = i.qty - i.void_qty;
    const q = Math.min(left, Math.max(1, int(req.body.qty) || left));
    if (left <= 0) bad('Already voided');
    const shift = await openShift(c);
    await c.query('UPDATE order_items SET void_qty = void_qty + $2 WHERE id=$1', [itemId, q]);
    await c.query(`INSERT INTO item_voids(order_id, order_item_id, name, qty, amount_cents, reason, staff_id, approved_by, shift_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [i.order_id, itemId, i.name, q, q * (i.unit_price_cents + i.addons_cents), why, req.user.id, approvedBy, shift ? shift.id : null]);
    // a ticket whose every line is voided leaves the kitchen screen
    if (i.kot_id) {
      const { rows: [rest] } = await c.query('SELECT count(*)::int AS n FROM order_items WHERE kot_id=$1 AND qty > void_qty', [i.kot_id]);
      if (!rest.n) await c.query("UPDATE kots SET status='served', served_at=now() WHERE id=$1 AND status<>'served'", [i.kot_id]);
    }
    await saveTotals(c, i.order_id);
    const o = await loadOrder(i.order_id, c);
    if (i.kot_id && i.kot_status !== 'served') {
      const pid = i.printer_id || await printing.printerFor(c, 'kitchen');
      await printing.enqueue(c, pid, 'void', `VOID · ${otitle(o)}`,
        printing.voidDoc({ order: o, kotNo: i.kot_no, stationName: i.station_name, name: i.name, qty: q, reason: why, staffName: req.user.name }));
    }
    await audit(c, { action: 'item.void', staffId: req.user.id, approvedBy, orderId: i.order_id,
      summary: `Voided ${q} × ${i.name} on ${otitle(o)} · ${why}`, details: { amount_cents: q * (i.unit_price_cents + i.addons_cents) } });
    return i.order_id;
  });
  notify('kitchen');
  res.json(await loadOrder(orderId));
}));

// Refund all or part of a paid bill.
app.post('/api/orders/:id/refund', wrap(async (req, res) => {
  const id = int(req.params.id);
  const why = reason(req.body.reason);
  const approvedBy = await approval(req);
  await tx(async (c) => {
    const o = await loadOrder(id, c);
    if (o.status !== 'paid') bad('Only paid bills can be refunded');
    const left = o.total_cents - o.refunded_cents;
    if (left <= 0) bad('This bill is already fully refunded');
    const amount = req.body.full ? left : Math.round(Number(req.body.amount) * 100);
    if (!Number.isFinite(amount) || amount <= 0) bad('Enter the refund amount');
    if (amount > left) bad(`You can refund at most ${(left / 100).toFixed(2)}`);
    const method = ['card', 'cash', 'wallet'].includes(req.body.method) ? req.body.method : o.payment_method;
    const shift = await openShift(c);
    if (method === 'cash' && !shift) throw new HttpError(409, 'Open a shift to give a cash refund from the drawer.');
    await c.query('INSERT INTO refunds(order_id, amount_cents, method, reason, staff_id, approved_by, shift_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, amount, method, why, req.user.id, approvedBy, shift ? shift.id : null]);
    const { rows: [ap] } = await c.query('SELECT name FROM staff WHERE id=$1', [approvedBy]);
    await audit(c, { action: 'order.refund', staffId: req.user.id, approvedBy, orderId: id,
      summary: `Refunded ${(amount / 100).toFixed(2)} (${method}) on ${otitle(o)} · ${why}`, details: { amount_cents: amount, method } });
    const pid = await printing.printerFor(c, 'bill');
    await printing.enqueue(c, pid, 'refund', `Refund · ${otitle(o)}`,
      printing.refundDoc({ order: o, amount, method, reason: why, staffName: req.user.name, approverName: ap && ap.name }));
  });
  notify('floor');
  res.json(await loadOrder(id));
}));

// ---------- kitchen display ----------
app.get('/api/kitchen', wrap(async (req, res) => {
  const { rows: kots } = await pool.query(
    `SELECT k.*, st.name AS station_name, st.code AS station_code, o.order_no, o.type, o.guests, o.customer_name,
            t.code AS table_code,
            extract(epoch FROM (now() - k.fired_at))::int AS age_sec
     FROM kots k JOIN orders o ON o.id=k.order_id LEFT JOIN dining_tables t ON t.id=o.table_id
     LEFT JOIN stations st ON st.id=k.station_id
     WHERE k.status <> 'served' ORDER BY k.fired_at, k.id`);
  const ids = kots.map((k) => k.id);
  const { rows: items } = ids.length
    ? await pool.query('SELECT id, kot_id, name, qty, void_qty, spice, note, addons, done, course FROM order_items WHERE kot_id = ANY($1) ORDER BY id', [ids])
    : { rows: [] };
  for (const k of kots) {
    k.items = items.filter((i) => i.kot_id === k.id);
    k.late = k.status === 'cooking' && k.age_sec > CONFIG.lateMinutes * 60;
  }
  const { rows: stations } = await pool.query('SELECT * FROM stations ORDER BY sort, id');
  res.json({ kots, stations });
}));

const NEXT = { held: 'new', new: 'cooking', cooking: 'ready', ready: 'served' };
app.post('/api/kots/:id/advance', wrap(async (req, res) => {
  const id = int(req.params.id);
  const { rows: [k] } = await pool.query('SELECT * FROM kots WHERE id=$1', [id]);
  if (!k) throw new HttpError(404, 'Ticket not found');
  const next = NEXT[k.status];
  if (!next) bad('Ticket already cleared');
  const stamp = { new: 'fired_at', cooking: 'started_at', ready: 'ready_at', served: 'served_at' }[next];
  await tx(async (c) => {
    const u = await c.query(`UPDATE kots SET status=$2, ${stamp}=now() WHERE id=$1 AND status=$3`, [id, next, k.status]);
    if (u.rowCount && k.status === 'held') await printKot(c, id, req.user.name, 'FIRE NOW');
  });
  if (next === 'served') await pool.query('UPDATE order_items SET done=TRUE WHERE kot_id=$1', [id]);
  notify('kitchen');
  res.json({ ok: true, status: next });
}));

app.post('/api/items/:id/toggle-done', wrap(async (req, res) => {
  await pool.query('UPDATE order_items SET done = NOT done WHERE id=$1 AND kot_id IS NOT NULL', [int(req.params.id)]);
  notify('kitchen');
  res.json({ ok: true });
}));

// ---------- shifts & cash drawer ----------
const DRAWER_ROLES = ['Manager', 'Cashier'];
const toCents = (v, label) => { const n = Math.round(Number(v) * 100); if (!Number.isFinite(n) || n < 0) bad(`Enter a valid ${label}`); return n; };

async function shiftSummary(c, shiftId) {
  const { rows: [shift] } = await c.query(
    `SELECT sh.*, a.name AS opened_by_name, b.name AS closed_by_name FROM shifts sh
     LEFT JOIN staff a ON a.id=sh.opened_by LEFT JOIN staff b ON b.id=sh.closed_by WHERE sh.id=$1`, [shiftId]);
  if (!shift) throw new HttpError(404, 'Shift not found');
  // one query at a time: c may be a transaction client, which can't run queries in parallel
  const q = (sql) => async () => (await c.query(sql, [shiftId])).rows;
  const inTurn = async (fns) => { const out = []; for (const f of fns) out.push(await f()); return out; };
  const [[sales], pays, refs, cardBrands, cash, [voids], [voidOrders], open, movements, refundList] = await inTurn([
    q(`SELECT count(*)::int AS orders, coalesce(sum(total_cents),0)::int AS gross_cents, coalesce(sum(discount_cents),0)::int AS discount_cents,
              coalesce(sum(service_cents),0)::int AS service_cents, coalesce(sum(tax_cents),0)::int AS tax_cents, coalesce(sum(tip_cents),0)::int AS tip_cents,
              coalesce(sum(guests) FILTER (WHERE type='dinein'),0)::int AS covers
       FROM orders WHERE shift_id=$1 AND status='paid'`),
    q(`SELECT payment_method AS m, coalesce(sum(total_cents),0)::int AS v FROM orders WHERE shift_id=$1 AND status='paid' GROUP BY 1`),
    q(`SELECT method AS m, coalesce(sum(amount_cents),0)::int AS v FROM refunds WHERE shift_id=$1 GROUP BY 1`),
    q(`SELECT coalesce(card_brand,'Not recorded') AS brand, count(*)::int AS n, coalesce(sum(total_cents),0)::int AS v
       FROM orders WHERE shift_id=$1 AND status='paid' AND payment_method='card' GROUP BY 1 ORDER BY 3 DESC`),
    q(`SELECT kind, coalesce(sum(amount_cents),0)::int AS v FROM cash_movements WHERE shift_id=$1 GROUP BY 1`),
    q(`SELECT count(*)::int AS count, coalesce(sum(amount_cents),0)::int AS amount_cents FROM item_voids WHERE shift_id=$1`),
    q(`SELECT count(*)::int AS n FROM orders WHERE shift_id=$1 AND status='void'`),
    async () => (shift.status === 'open' ? (await c.query("SELECT count(*)::int AS n FROM orders WHERE status='open'")).rows : [{ n: 0 }]),
    q(`SELECT m.*, s.name AS staff_name FROM cash_movements m LEFT JOIN staff s ON s.id=m.staff_id WHERE m.shift_id=$1 ORDER BY m.id`),
    q(`SELECT r.*, o.order_no, s.name AS staff_name FROM refunds r JOIN orders o ON o.id=r.order_id LEFT JOIN staff s ON s.id=r.staff_id WHERE r.shift_id=$1 ORDER BY r.id`),
  ]);
  const by = (rows) => ({ cash: 0, card: 0, wallet: 0, ...Object.fromEntries(rows.map((r) => [r.m, r.v])) });
  const payments = by(pays);
  const refunds = by(refs);
  refunds.total_cents = refunds.cash + refunds.card + refunds.wallet;
  const cashIn = (cash.find((x) => x.kind === 'in') || { v: 0 }).v;
  const cashOut = (cash.find((x) => x.kind === 'out') || { v: 0 }).v;
  const expected = shift.float_cents + payments.cash - refunds.cash + cashIn - cashOut;
  return {
    shift, sales, payments, refunds, expected_cents: expected, card_brands: cardBrands,
    cash: { in_cents: cashIn, out_cents: cashOut, movements },
    voids: { ...voids, orders: voidOrders.n }, refund_list: refundList, open_orders: open[0].n,
  };
}

app.get('/api/shift', wrap(async (req, res) => {
  const sh = await openShift(pool);
  res.json(sh ? await shiftSummary(pool, sh.id) : { shift: null });
}));

app.post('/api/shift/open', wrap(async (req, res) => {
  const float = toCents(req.body.float || 0, 'opening float');
  const id = await tx(async (c) => {
    if (await openShift(c)) bad('A shift is already open');
    const { rows: [sh] } = await c.query('INSERT INTO shifts(opened_by, float_cents) VALUES ($1,$2) RETURNING id', [req.user.id, float]);
    await audit(c, { action: 'shift.open', staffId: req.user.id, summary: `Shift ${shiftNo(sh.id)} opened with float ${(float / 100).toFixed(2)}` });
    return sh.id;
  });
  notify('shift');
  res.json(await shiftSummary(pool, id));
}));

app.post('/api/shift/cash', wrap(async (req, res) => {
  const kind = req.body.kind === 'in' ? 'in' : 'out';
  const amount = toCents(req.body.amount, 'amount');
  if (!amount) bad('Enter an amount');
  const why = reason(req.body.reason);
  const approvedBy = await approval(req, DRAWER_ROLES);
  const id = await tx(async (c) => {
    const sh = await openShift(c);
    if (!sh) bad('No shift is open');
    await c.query('INSERT INTO cash_movements(shift_id, kind, amount_cents, reason, staff_id, approved_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [sh.id, kind, amount, why, req.user.id, approvedBy]);
    await audit(c, { action: `cash.${kind}`, staffId: req.user.id, approvedBy, summary: `Cash ${kind} ${(amount / 100).toFixed(2)} · ${why}` });
    return sh.id;
  });
  notify('shift');
  res.json(await shiftSummary(pool, id));
}));

app.post('/api/shift/close', wrap(async (req, res) => {
  const counted = toCents(req.body.counted, 'counted cash amount');
  const note = String(req.body.note || '').trim().slice(0, 300) || null;
  const approvedBy = await approval(req, DRAWER_ROLES);
  const { id, printed } = await tx(async (c) => {
    const sh = await openShift(c);
    if (!sh) bad('No shift is open');
    const before = await shiftSummary(c, sh.id);
    await c.query(`UPDATE shifts SET status='closed', closed_at=now(), closed_by=$2, counted_cents=$3, expected_cents=$4, note=$5 WHERE id=$1`,
      [sh.id, approvedBy, counted, before.expected_cents, note]);
    const v = counted - before.expected_cents;
    await audit(c, { action: 'shift.close', staffId: req.user.id, approvedBy,
      summary: `Shift ${shiftNo(sh.id)} closed · expected ${(before.expected_cents / 100).toFixed(2)}, counted ${(counted / 100).toFixed(2)} (${v === 0 ? 'balanced' : v > 0 ? 'over ' + (v / 100).toFixed(2) : 'short ' + (-v / 100).toFixed(2)})` });
    const after = await shiftSummary(c, sh.id);
    const pid = await printing.printerFor(c, 'bill');
    const job = await printing.enqueue(c, pid, 'zreport', `Z report · shift ${shiftNo(sh.id)}`, printing.zReportDoc(after));
    await integrations.shiftClosed(c, after); // n8n: shift.closed (+ cash.variance when over the limit)
    return { id: sh.id, printed: !!job };
  });
  notify('shift');
  integrations.kick(); // send the Z-report to n8n now that it's committed
  res.json({ ...(await shiftSummary(pool, id)), printed_to_printer: printed });
}));

app.get('/api/shifts', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT sh.*, a.name AS opened_by_name, b.name AS closed_by_name,
       (SELECT coalesce(sum(total_cents),0)::int FROM orders o WHERE o.shift_id=sh.id AND o.status='paid') AS gross_cents,
       (SELECT count(*)::int FROM orders o WHERE o.shift_id=sh.id AND o.status='paid') AS orders
     FROM shifts sh LEFT JOIN staff a ON a.id=sh.opened_by LEFT JOIN staff b ON b.id=sh.closed_by
     ORDER BY sh.opened_at DESC, sh.id DESC LIMIT 30`);
  res.json({ shifts: rows });
}));
app.get('/api/shifts/:id', wrap(async (req, res) => res.json(await shiftSummary(pool, int(req.params.id)))));
app.post('/api/shifts/:id/print', wrap(async (req, res) => {
  const id = int(req.params.id);
  const printed = await tx(async (c) => {
    const sum = await shiftSummary(c, id);
    const pid = await printing.printerFor(c, 'bill');
    return !!(await printing.enqueue(c, pid, 'zreport', `${sum.shift.status === 'closed' ? 'Z' : 'X'} report · shift ${shiftNo(id)}`, printing.zReportDoc(sum)));
  });
  res.json({ printed_to_printer: printed });
}));

// ---------- history ----------
app.get('/api/history', wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const { rows } = await pool.query(
    `${ORDER_SUMMARY_SQL}
     WHERE (o.status='open' OR (o.opened_at AT TIME ZONE $1)::date = coalesce($2::date, (now() AT TIME ZONE $1)::date))
     ORDER BY o.opened_at DESC`, [CONFIG.timezone, date]);
  for (const o of rows) o.display_status = orderStatus(o);
  const paid = rows.filter((o) => o.status === 'paid');
  res.json({
    orders: rows,
    stats: { paid: paid.length, collected_cents: paid.reduce((s, o) => s + o.total_cents, 0), open: rows.filter((o) => o.status === 'open').length },
  });
}));

// ---------- static SPA ----------
app.get('/healthz', wrap(async (req, res) => { await pool.query('SELECT 1'); res.send('ok'); }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message, ...(err.upgrade ? { upgrade: err.upgrade } : {}) });
});

const PORT = process.env.PORT || 3000;
(async () => {
  await migrate({ seed: !['mirror', 'standby'].includes(MODE) }); // these get their data from the other server
  await sync.setup();
  if (!['mirror', 'standby'].includes(MODE)) await license.ensureTrialStart(); // these take it from the other server
  await license.adoptEnvKey();
  if (demo) { if (MODE !== 'standalone') throw new Error('DEMO_MODE needs POS_MODE=standalone'); await demo.start(); }
  await sync.repairSequences();
  await loadSettings();
  await startListener();
  sync.start();
  if (PRINT_DIRECT) printing.startDirect();
  integrations.start();
  console.log(`Mode: ${MODE}${['local', 'standby'].includes(MODE) ? ` · cloud: ${CLOUD_URL || 'not set'} · printing: ${PRINT_DIRECT ? 'direct' : 'via bridge'}` : ''}`);
  if (MODE === 'standby') console.log(`Staff start page: http://<this PC's IP>:${PORT}/start`);
  app.listen(PORT, () => console.log(`POS listening on :${PORT}`));
})().catch((e) => { console.error(e); process.exit(1); });

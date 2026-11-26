// Manager-only admin API: menu, categories, floor (areas + tables), stations, staff.
const express = require('express');

module.exports = function adminRouter({ pool, tx, hashPin, checkPin, notify, wrap, HttpError, CONFIG, ENV_CONFIG, loadSettings, audit, license }) {
  const { loadMenu } = require('./menu-data');
  const r = express.Router();
  const bad = (msg) => { throw new HttpError(400, msg); };
  const int = (v, def = null) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
  const str = (v, max = 120) => String(v ?? '').trim().slice(0, max);
  const need = (v, label) => { if (!v) bad(`${label} is required`); return v; };
  const COURSES = ['drink', 'starter', 'main', 'dessert'];
  const ROLES = ['Manager', 'Captain', 'Server', 'Cashier', 'Kitchen'];

  // Translate FK / unique violations into friendly messages
  const friendly = (fn, inUse) => wrap(async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) {
      if (e.code === '23503') throw new HttpError(409, inUse || 'This record is in use and cannot be deleted. Hide it instead.');
      if (e.code === '23505') throw new HttpError(409, 'That code or name is already used.');
      throw e;
    }
  });

  r.use((req, res, next) => (req.user.role === 'Manager' ? next() : next(new HttpError(403, 'Managers only'))));

  // Every successful admin change is written to the audit log (PINs and photo bytes are never logged).
  const NOUN = { categories: 'category', items: 'dish', areas: 'area', tables: 'table', stations: 'station', staff: 'staff member',
    settings: 'settings', 'sample-menu': 'sample menu', printing: 'printing', integrations: 'n8n integration' };
  r.use((req, res, next) => {
    if (req.method === 'GET') return next();
    const parts = req.path.split('/').filter(Boolean); // captured before sub-routers rewrite the path
    const b = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const verb = { POST: 'added', PATCH: 'changed', PUT: 'uploaded', DELETE: 'deleted' }[req.method] || req.method;
      const label = b.name || b.code || '';
      let summary;
      if (parts[0] === 'sample-menu') summary = 'Loaded the Asian sample menu';
      else if (parts[0] === 'logo') summary = req.method === 'DELETE' ? 'Restaurant logo removed' : 'Restaurant logo uploaded';
      else if (parts[0] === 'login-bg') summary = req.method === 'DELETE' ? 'Login background reset to default' : 'Login background photo uploaded';
      else if (parts[0] === 'settings') summary = `Settings changed (name "${b.restaurant}", terminal "${b.terminal}", tax ${b.taxRate}%, service ${b.serviceRate}%)`;
      else if (parts[0] === 'printing') {
        const sub = parts[1];
        summary = sub === 'routing' ? 'Printer routing changed'
          : sub === 'token' ? 'Print bridge token regenerated'
          : sub === 'jobs' ? `Print job #${parts[2]} retried`
          : parts[3] === 'test' ? `Test print sent to printer #${parts[2]}`
          : `Printer ${label || '#' + (parts[2] || '')} ${verb}`;
      } else if (parts[0] === 'integrations') {
        summary = parts[1] === 'test' ? 'n8n test event sent' : parts[1] === 'resend-last-shift' ? 'Last Z-report re-sent to n8n'
          : parts[1] === 'events' || parts[1] === 'retry-all' ? 'n8n events retried'
          : `n8n integration settings changed${b.new_secret ? ' (new signing secret)' : ''}`;
      } else if (parts[1] && parts[2] === 'image') summary = `Photo ${req.method === 'DELETE' ? 'removed from' : 'uploaded for'} dish #${parts[1]}`;
      else {
        const what = NOUN[parts[0]] || parts[0] || 'record';
        summary = `${what[0].toUpperCase()}${what.slice(1)} ${label || (parts[1] ? '#' + parts[1] : '')} ${verb}`.replace(/\s+/g, ' ');
      }
      if (parts[0] === 'staff' && b.pin) summary += ' (PIN changed)';
      const details = Object.fromEntries(Object.entries(b).filter(([k]) => !/pin|token|image|raster|secret/i.test(k)).slice(0, 20));
      audit(pool, { action: `admin.${parts[0] || 'change'}`, staffId: req.user.id, summary, details }).catch(() => {});
    });
    next();
  });

  r.get('/audit', wrap(async (req, res) => {
    const action = String(req.query.action || '');
    const { rows } = await pool.query(
      `SELECT a.*, s.name AS staff_name, ap.name AS approved_name, o.order_no
       FROM audit_log a LEFT JOIN staff s ON s.id=a.staff_id LEFT JOIN staff ap ON ap.id=a.approved_by LEFT JOIN orders o ON o.id=a.order_id
       WHERE ($1 = '' OR a.action LIKE $1 || '%') ORDER BY a.created_at DESC, a.id DESC LIMIT 300`, [action]);
    res.json({ entries: rows });
  }));

  r.get('/data', wrap(async (req, res) => {
    const [categories, items, areas, tables, stations, staff] = await Promise.all([
      pool.query(`SELECT c.*, (SELECT count(*)::int FROM menu_items m WHERE m.category_id=c.id) AS item_count
                  FROM categories c ORDER BY sort, id`),
      pool.query(`SELECT m.*, coalesce((SELECT json_agg(json_build_object('id',a.id,'name',a.name,'price_cents',a.price_cents,'unit',a.unit,'max_qty',a.max_qty) ORDER BY a.id)
                    FROM item_addons a WHERE a.item_id=m.id), '[]') AS addons
                  FROM menu_items m ORDER BY m.category_id, m.sort, m.id`),
      pool.query(`SELECT a.*, (SELECT count(*)::int FROM dining_tables t WHERE t.area_id=a.id) AS table_count FROM areas a ORDER BY sort, id`),
      pool.query(`SELECT t.*, EXISTS(SELECT 1 FROM orders o WHERE o.table_id=t.id AND o.status='open') AS busy
                  FROM dining_tables t ORDER BY sort, id`),
      pool.query(`SELECT s.*, (SELECT count(*)::int FROM menu_items m WHERE m.station_id=s.id) AS item_count FROM stations s ORDER BY sort, id`),
      pool.query('SELECT id, name, initials, role, active FROM staff ORDER BY active DESC, name'),
    ]);
    res.json({ categories: categories.rows, items: items.rows, areas: areas.rows, tables: tables.rows,
      stations: stations.rows, staff: staff.rows, roles: ROLES, courses: COURSES,
      settings: { restaurant: CONFIG.restaurant, terminal: CONFIG.terminal, currency: CONFIG.currency, taxLabel: CONFIG.taxLabel,
        taxRate: CONFIG.taxRate, serviceRate: CONFIG.serviceRate, lateMinutes: CONFIG.lateMinutes,
        address: CONFIG.address, phone: CONFIG.phone, email: CONFIG.email, website: CONFIG.website, regNo: CONFIG.regNo, billFooter: CONFIG.billFooter,
        defaultCategory: CONFIG.defaultCategory, billLang: CONFIG.billLang, restaurantTa: CONFIG.restaurantTa, addressTa: CONFIG.addressTa, billFooterTa: CONFIG.billFooterTa,
        restaurantSi: CONFIG.restaurantSi, addressSi: CONFIG.addressSi, billFooterSi: CONFIG.billFooterSi } });
  }));

  const done = (res, kind = 'menu') => { notify(kind); res.json({ ok: true }); };

  // ---------- settings ----------
  r.patch('/settings', wrap(async (req, res) => {
    const b = req.body;
    const addr = (v) => String(v ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join('\n').slice(0, 200);
    const pctIn = (v, label) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100) bad(`${label} must be 0–100%`); return String(n / 100); };
    const vals = {
      restaurant: need(str(b.restaurant, 40), 'Restaurant name'),
      terminal: need(str(b.terminal, 40), 'Terminal name'),
      currency: ((cur) => (/[A-Za-z.]$/.test(cur) ? cur + ' ' : cur))(str(b.currency, 6) || 'Rs'),
      taxLabel: need(str(b.taxLabel, 20), 'Tax label'),
      taxRate: pctIn(b.taxRate, 'Tax rate'),
      serviceRate: pctIn(b.serviceRate, 'Service charge'),
      lateMinutes: String(Math.min(120, Math.max(1, int(b.lateMinutes, 12)))),
      address: String(b.address ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join('\n').slice(0, 160),
      phone: str(b.phone, 60), email: str(b.email, 80), website: str(b.website, 80), regNo: str(b.regNo, 60),
      billFooter: str(b.billFooter, 120),
      defaultCategory: /^\d{1,9}$/.test(String(b.defaultCategory ?? '')) ? String(b.defaultCategory) : '',
      billLang: ['en', 'ta', 'si'].includes(b.billLang) ? b.billLang : 'en',
      restaurantTa: str(b.restaurantTa, 60), addressTa: addr(b.addressTa), billFooterTa: str(b.billFooterTa, 120),
      restaurantSi: str(b.restaurantSi, 60), addressSi: addr(b.addressSi), billFooterSi: str(b.billFooterSi, 120),
    };
    await tx(async (c) => {
      for (const [k, v] of Object.entries(vals)) {
        await c.query('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
      }
    });
    await loadSettings();
    done(res, 'settings');
  }));

  // Restaurant logo: the display image plus a 1-bit raster (made in the browser) for thermal printers
  r.put('/logo', express.json({ limit: '3mb' }), wrap(async (req, res) => {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(String(req.body.image || ''));
    if (!m) bad('Upload a PNG, JPEG or WebP image');
    const data = Buffer.from(m[2], 'base64');
    if (data.length > 2 * 1024 * 1024) bad('Logo image is too large');
    const rs = req.body.raster || {};
    const w = int(rs.w); const h = int(rs.h);
    if (!w || !h || w > 576 || h > 400 || w % 8) bad('Bad print image');
    const bits = Buffer.from(String(rs.data || ''), 'base64');
    if (bits.length !== (w / 8) * h) bad('Bad print image');
    await tx(async (c) => {
      await c.query(`INSERT INTO app_images(key, mime, data) VALUES ('logo', $1, $2)
                     ON CONFLICT (key) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now()`, [m[1], data]);
      await c.query(`INSERT INTO settings(key, value) VALUES ('logoRaster', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
        [JSON.stringify({ w, h, data: bits.toString('base64') })]);
    });
    await loadSettings();
    done(res, 'settings');
  }));
  r.delete('/logo', wrap(async (req, res) => {
    await pool.query("DELETE FROM app_images WHERE key='logo'");
    await pool.query("DELETE FROM settings WHERE key='logoRaster'");
    await loadSettings();
    done(res, 'settings');
  }));

  // Login screen background photo
  r.put('/login-bg', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '4mb' }), wrap(async (req, res) => {
    const mime = req.headers['content-type'];
    const sig = { 'image/jpeg': [0xff, 0xd8], 'image/png': [0x89, 0x50], 'image/webp': [0x52, 0x49] }[mime];
    if (!Buffer.isBuffer(req.body) || !req.body.length || !sig || req.body[0] !== sig[0] || req.body[1] !== sig[1]) bad('Upload a JPEG, PNG or WebP image');
    await pool.query(`INSERT INTO app_images(key, mime, data) VALUES ('login_bg', $1, $2)
                      ON CONFLICT (key) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now()`, [mime, req.body]);
    done(res, 'settings');
  }));
  r.delete('/login-bg', wrap(async (req, res) => {
    await pool.query("DELETE FROM app_images WHERE key='login_bg'");
    done(res, 'settings');
  }));

  // Replace the current menu with the Asian sample menu.
  r.post('/sample-menu', wrap(async (req, res) => {
    const out = await tx(async (c) => {
      const result = await loadMenu(c, { replace: true });
      if (CONFIG.terminal === ENV_CONFIG.terminal) {
        await c.query("INSERT INTO settings(key, value) VALUES ('terminal', 'Asian Cuisine') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
      }
      return result;
    });
    await loadSettings();
    notify('settings');
    notify('menu');
    res.json({ ok: true, ...out });
  }));

  // ---------- categories ----------
  const catBody = (b) => ({
    name: need(str(b.name, 60), 'Name'),
    default_course: COURSES.includes(b.default_course) ? b.default_course : bad('Pick a course'),
    sort: int(b.sort, 0),
  });
  r.post('/categories', friendly(async (req, res) => {
    const c = catBody(req.body);
    await pool.query('INSERT INTO categories(name, default_course, sort) VALUES ($1,$2,$3)', [c.name, c.default_course, c.sort]);
    done(res);
  }));
  r.patch('/categories/:id', friendly(async (req, res) => {
    const c = catBody(req.body);
    await pool.query('UPDATE categories SET name=$2, default_course=$3, sort=$4 WHERE id=$1', [int(req.params.id), c.name, c.default_course, c.sort]);
    done(res);
  }));
  r.delete('/categories/:id', friendly(async (req, res) => {
    await pool.query('DELETE FROM categories WHERE id=$1', [int(req.params.id)]);
    done(res);
  }, 'Move or delete the dishes in this category first.'));

  // ---------- menu items (+ add-ons) ----------
  const itemBody = (b) => {
    const price = Math.round(Number(b.price) * 100);
    if (!Number.isFinite(price) || price < 0) bad('Enter a valid price');
    const addons = (Array.isArray(b.addons) ? b.addons : []).map((a) => ({
      name: str(a.name, 60), price_cents: Math.round(Number(a.price || 0) * 100),
      unit: str(a.unit, 20) || null, max_qty: a.max_qty === undefined || a.max_qty === '' ? 5 : int(a.max_qty),
    })).filter((a) => a.name);
    if (addons.some((a) => !Number.isFinite(a.price_cents) || a.price_cents < 0)) bad('Enter valid add-on prices');
    if (addons.some((a) => !(a.max_qty >= 1 && a.max_qty <= 20))) bad('Add-on max quantity must be 1–20');
    return {
      name: need(str(b.name, 80), 'Name'),
      name_ta: str(b.name_ta, 80) || null, name_si: str(b.name_si, 80) || null,
      category_id: need(int(b.category_id), 'Category'),
      station_id: need(int(b.station_id), 'Station'),
      price_cents: price,
      tags: String(b.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8),
      has_spice: !!b.has_spice,
      no_kot: b.send_kot === false,
      active: b.active !== false,
      sort: int(b.sort, 0),
      addons,
    };
  };
  async function saveAddons(c, itemId, addons) {
    await c.query('DELETE FROM item_addons WHERE item_id=$1', [itemId]);
    for (const a of addons) {
      await c.query('INSERT INTO item_addons(item_id, name, price_cents, unit, max_qty) VALUES ($1,$2,$3,$4,$5)', [itemId, a.name, a.price_cents, a.unit, a.max_qty]);
    }
  }
  // "Spice level" tag is managed by the has_spice switch
  const tagsFor = (m) => m.tags.filter((t) => t.toLowerCase() !== 'spice level').concat(m.has_spice ? ['Spice level'] : []);

  r.post('/items', friendly(async (req, res) => {
    const m = itemBody(req.body);
    const id = await tx(async (c) => {
      const { rows: [row] } = await c.query(
        `INSERT INTO menu_items(category_id, station_id, name, price_cents, tags, has_spice, active, sort, no_kot, name_ta, name_si)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [m.category_id, m.station_id, m.name, m.price_cents, tagsFor(m), m.has_spice, m.active, m.sort, m.no_kot, m.name_ta, m.name_si]);
      await saveAddons(c, row.id, m.addons);
      return row.id;
    });
    notify('menu');
    res.json({ ok: true, id });
  }));

  // ---------- dish photos ----------
  const IMG_TYPES = { 'image/jpeg': [0xff, 0xd8], 'image/png': [0x89, 0x50], 'image/webp': [0x52, 0x49] };
  r.put('/items/:id/image', express.raw({ type: Object.keys(IMG_TYPES), limit: '3mb' }), wrap(async (req, res) => {
    const id = int(req.params.id);
    const mime = req.headers['content-type'];
    const sig = IMG_TYPES[mime];
    if (!Buffer.isBuffer(req.body) || !req.body.length || !sig || req.body[0] !== sig[0] || req.body[1] !== sig[1]) bad('Upload a JPEG, PNG or WebP image');
    await tx(async (c) => {
      const u = await c.query('UPDATE menu_items SET image_ver = coalesce(image_ver, 0) + 1 WHERE id=$1', [id]);
      if (!u.rowCount) throw new HttpError(404, 'Dish not found');
      await c.query(`INSERT INTO menu_item_images(item_id, mime, data) VALUES ($1,$2,$3)
                     ON CONFLICT (item_id) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now()`, [id, mime, req.body]);
    });
    done(res);
  }));
  r.delete('/items/:id/image', wrap(async (req, res) => {
    const id = int(req.params.id);
    await pool.query('DELETE FROM menu_item_images WHERE item_id=$1', [id]);
    await pool.query('UPDATE menu_items SET image_ver=NULL WHERE id=$1', [id]);
    done(res);
  }));
  r.patch('/items/:id', friendly(async (req, res) => {
    const m = itemBody(req.body);
    const id = int(req.params.id);
    await tx(async (c) => {
      const u = await c.query(
        `UPDATE menu_items SET category_id=$2, station_id=$3, name=$4, price_cents=$5, tags=$6, has_spice=$7, active=$8, sort=$9, no_kot=$10,
           name_ta=$11, name_si=$12 WHERE id=$1`,
        [id, m.category_id, m.station_id, m.name, m.price_cents, tagsFor(m), m.has_spice, m.active, m.sort, m.no_kot, m.name_ta, m.name_si]);
      if (!u.rowCount) throw new HttpError(404, 'Dish not found');
      await saveAddons(c, id, m.addons);
    });
    done(res);
  }));
  r.delete('/items/:id', friendly(async (req, res) => {
    await pool.query('DELETE FROM menu_items WHERE id=$1', [int(req.params.id)]);
    done(res);
  }, 'This dish is on past orders, so it cannot be deleted. Untick "Show on menu" to hide it.'));

  // ---------- areas ----------
  const areaBody = (b) => ({ name: need(str(b.name, 40), 'Name'), short: str(b.short, 20) || str(b.name, 20), sort: int(b.sort, 0) });
  r.post('/areas', friendly(async (req, res) => {
    const a = areaBody(req.body);
    await pool.query('INSERT INTO areas(name, short, sort) VALUES ($1,$2,$3)', [a.name, a.short, a.sort]);
    done(res, 'floor');
  }));
  r.patch('/areas/:id', friendly(async (req, res) => {
    const a = areaBody(req.body);
    await pool.query('UPDATE areas SET name=$2, short=$3, sort=$4 WHERE id=$1', [int(req.params.id), a.name, a.short, a.sort]);
    done(res, 'floor');
  }));
  r.delete('/areas/:id', friendly(async (req, res) => {
    await pool.query('DELETE FROM areas WHERE id=$1', [int(req.params.id)]);
    done(res, 'floor');
  }, 'Move or delete the tables in this area first.'));

  // ---------- tables ----------
  const tableBody = (b) => {
    const seats = int(b.seats);
    if (!seats || seats < 1 || seats > 40) bad('Seats must be 1–40');
    return { code: need(str(b.code, 10).toUpperCase(), 'Table code'), area_id: need(int(b.area_id), 'Area'), seats, sort: int(b.sort, 0), active: b.active !== false };
  };
  r.post('/tables', friendly(async (req, res) => {
    const t = tableBody(req.body);
    await pool.query('INSERT INTO dining_tables(code, area_id, seats, sort, active) VALUES ($1,$2,$3,$4,$5)', [t.code, t.area_id, t.seats, t.sort, t.active]);
    done(res, 'floor');
  }));
  r.patch('/tables/:id', friendly(async (req, res) => {
    const t = tableBody(req.body);
    const id = int(req.params.id);
    if (!t.active) {
      const { rows: [busy] } = await pool.query("SELECT 1 FROM orders WHERE table_id=$1 AND status='open'", [id]);
      if (busy) bad('This table has an open order. Close it before hiding the table.');
    }
    await pool.query('UPDATE dining_tables SET code=$2, area_id=$3, seats=$4, sort=$5, active=$6 WHERE id=$1', [id, t.code, t.area_id, t.seats, t.sort, t.active]);
    done(res, 'floor');
  }));
  r.delete('/tables/:id', friendly(async (req, res) => {
    await pool.query('DELETE FROM dining_tables WHERE id=$1', [int(req.params.id)]);
    done(res, 'floor');
  }, 'This table has past orders, so it cannot be deleted. Untick "Show on floor" to hide it.'));

  // ---------- stations ----------
  const stationBody = (b) => ({
    code: need(str(b.code, 12).toUpperCase().replace(/[^A-Z0-9_]/g, ''), 'Code'),
    name: need(str(b.name, 30), 'Name'), printer: str(b.printer, 60) || `${str(b.name, 30)} printer`, sort: int(b.sort, 0),
  });
  r.post('/stations', friendly(async (req, res) => {
    const s = stationBody(req.body);
    await pool.query('INSERT INTO stations(code, name, printer, sort) VALUES ($1,$2,$3,$4)', [s.code, s.name, s.printer, s.sort]);
    done(res);
  }));
  r.patch('/stations/:id', friendly(async (req, res) => {
    const s = stationBody(req.body);
    await pool.query('UPDATE stations SET code=$2, name=$3, printer=$4, sort=$5 WHERE id=$1', [int(req.params.id), s.code, s.name, s.printer, s.sort]);
    done(res);
  }));
  r.delete('/stations/:id', friendly(async (req, res) => {
    await pool.query('DELETE FROM stations WHERE id=$1', [int(req.params.id)]);
    done(res);
  }, 'Dishes or kitchen tickets use this station. Move the dishes to another station first.'));

  // ---------- staff ----------
  async function pinTaken(pin, exceptId) {
    const { rows } = await pool.query('SELECT id, pin_hash FROM staff WHERE active AND id <> $1', [exceptId || 0]);
    return rows.some((s) => checkPin(pin, s.pin_hash));
  }
  async function managersLeft(exceptId) {
    const { rows: [n] } = await pool.query("SELECT count(*)::int AS n FROM staff WHERE active AND role='Manager' AND id <> $1", [exceptId]);
    return n.n;
  }
  const staffBody = (b) => {
    const name = need(str(b.name, 40), 'Name');
    const initials = (str(b.initials, 3) || name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2)).toUpperCase();
    const role = ROLES.includes(b.role) ? b.role : bad('Pick a role');
    const pin = str(b.pin, 8);
    if (pin && !/^\d{4,8}$/.test(pin)) bad('PIN must be 4–8 digits');
    return { name, initials, role, pin, active: b.active !== false };
  };
  // the plan's staff limit counts active staff; it only stops adding or re-activating someone
  async function staffRoom(exceptId = 0) {
    const { limits, planName } = await license.current();
    if (limits.staff == null) return;
    const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM staff WHERE active AND id <> $1', [exceptId]);
    if (n.n >= limits.staff) {
      throw Object.assign(new HttpError(403, `The ${planName} plan allows ${limits.staff} active staff, and you have ${n.n}. Turn off sign-in for someone who has left, or contact us on WhatsApp to upgrade.`), { upgrade: 'staff' });
    }
  }
  r.post('/staff', wrap(async (req, res) => {
    const s = staffBody(req.body);
    if (s.active) await staffRoom();
    if (!s.pin) bad('Set a PIN');
    if (await pinTaken(s.pin)) bad('Another staff member already uses that PIN');
    await pool.query('INSERT INTO staff(name, initials, role, pin_hash, active) VALUES ($1,$2,$3,$4,$5)', [s.name, s.initials, s.role, hashPin(s.pin), s.active]);
    done(res, 'staff');
  }));
  r.patch('/staff/:id', wrap(async (req, res) => {
    const id = int(req.params.id);
    const s = staffBody(req.body);
    if ((s.role !== 'Manager' || !s.active) && (await managersLeft(id)) === 0) bad('Keep at least one active manager');
    if (id === req.user.id && !s.active) bad('You cannot deactivate yourself');
    if (s.pin && (await pinTaken(s.pin, id))) bad('Another staff member already uses that PIN');
    if (s.active) { const { rows: [was] } = await pool.query('SELECT active FROM staff WHERE id=$1', [id]); if (was && !was.active) await staffRoom(id); }
    await tx(async (c) => {
      await c.query('UPDATE staff SET name=$2, initials=$3, role=$4, active=$5 WHERE id=$1', [id, s.name, s.initials, s.role, s.active]);
      if (s.pin) await c.query('UPDATE staff SET pin_hash=$2 WHERE id=$1', [id, hashPin(s.pin)]);
      if (s.pin || !s.active) await c.query('DELETE FROM sessions WHERE staff_id=$1 AND token <> $2', [id, req.token]);
    });
    done(res, 'staff');
  }));

  return r;
};

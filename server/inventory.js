// Inventory: ingredients, recipes, stock ledger, suppliers, purchases (goods received) and supplier payments.
// Stock is deducted from recipes when a bill is paid. Costs use a weighted average per ingredient.
const express = require('express');

const UNITS = ['kg', 'g', 'l', 'ml', 'pcs', 'pack', 'bottle', 'bunch'];
const PAY_METHODS = ['drawer', 'cash', 'bank', 'card', 'cheque'];

module.exports = function createInventory({ pool, tx, wrap, HttpError, audit, notify }) {
  const bad = (msg) => { throw new HttpError(400, msg); };
  const int = (v, def = null) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
  const num = (v, label, { min = 0, allowZero = true } = {}) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || (!allowZero && n === 0)) bad(`Enter a valid ${label}`);
    return Math.round(n * 1000) / 1000;
  };
  const str = (v, max = 120) => String(v ?? '').trim().slice(0, max);
  const cents = (v, label) => { const n = Math.round(Number(v) * 100); if (!Number.isFinite(n) || n < 0) bad(`Enter a valid ${label}`); return n; };

  // ---------- core stock operations (usable inside any transaction) ----------
  async function move(c, { ingredientId, kind, change, note = null, orderId = null, purchaseId = null, staffId = null, unitCost = null }) {
    const { rows: [g] } = await c.query(
      'UPDATE ingredients SET stock = stock + $2 WHERE id=$1 RETURNING stock, cost_cents, name', [ingredientId, change]);
    if (!g) throw new HttpError(404, 'Ingredient not found');
    const value = Math.round(Math.abs(change) * (unitCost ?? g.cost_cents));
    await c.query(`INSERT INTO stock_moves(ingredient_id, kind, change, stock_after, value_cents, order_id, purchase_id, note, staff_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [ingredientId, kind, change, g.stock, value, orderId, purchaseId, note, staffId]);
    return g;
  }

  // Called inside the payment transaction: takes the recipe ingredients for everything sold (not voided).
  async function deductForOrder(c, orderId, staffId) {
    const { rows: [o] } = await c.query('UPDATE orders SET stock_deducted=TRUE WHERE id=$1 AND NOT stock_deducted RETURNING id', [orderId]);
    if (!o) return 0;
    const { rows } = await c.query(
      `SELECT r.ingredient_id, sum((i.qty - i.void_qty) * r.qty) AS need
       FROM order_items i JOIN recipe_items r ON r.menu_item_id=i.menu_item_id JOIN ingredients g ON g.id=r.ingredient_id
       WHERE i.order_id=$1 AND i.qty > i.void_qty GROUP BY 1`, [orderId]);
    for (const r of rows) {
      if (r.need > 0) await move(c, { ingredientId: r.ingredient_id, kind: 'sale', change: -Math.round(r.need * 1000) / 1000, orderId, staffId });
    }
    if (rows.length) await c.query("SELECT pg_notify('pos_events', 'stock')");
    return rows.length;
  }

  // Dishes whose recipe can't be made even once with current stock
  const STOCK_OUT_SQL = `EXISTS (SELECT 1 FROM recipe_items r JOIN ingredients g ON g.id=r.ingredient_id
                                 WHERE r.menu_item_id=m.id AND g.active AND g.stock < r.qty)`;

  // ---------- router (manager only) ----------
  const r = express.Router();
  r.use((req, res, next) => (req.user.role === 'Manager' ? next() : next(new HttpError(403, 'Managers only'))));
  const changed = (res, extra = {}) => { notify('stock'); res.json({ ok: true, ...extra }); };

  r.get('/', wrap(async (req, res) => {
    const [ings, sups] = await Promise.all([
      pool.query(`SELECT g.*, s.name AS supplier_name,
                    (SELECT count(*)::int FROM recipe_items r WHERE r.ingredient_id=g.id) AS used_in
                  FROM ingredients g LEFT JOIN suppliers s ON s.id=g.supplier_id ORDER BY g.active DESC, g.name`),
      pool.query(`SELECT s.*,
                    coalesce((SELECT sum(total_cents) FROM purchases p WHERE p.supplier_id=s.id),0)::bigint AS purchased_cents,
                    coalesce((SELECT sum(amount_cents) FROM supplier_payments x WHERE x.supplier_id=s.id),0)::bigint AS paid_cents,
                    (SELECT max(invoice_date) FROM purchases p WHERE p.supplier_id=s.id) AS last_purchase
                  FROM suppliers s ORDER BY s.active DESC, s.name`),
    ]);
    const ingredients = ings.rows.map((g) => ({
      ...g, value_cents: Math.round(Math.max(0, g.stock) * g.cost_cents),
      status: !g.active ? 'hidden' : g.stock <= 0 ? 'out' : g.stock <= g.reorder_level ? 'low' : 'ok',
    }));
    const suppliers = sups.rows.map((s) => ({ ...s, purchased_cents: Number(s.purchased_cents), paid_cents: Number(s.paid_cents),
      balance_cents: Number(s.purchased_cents) - Number(s.paid_cents) }));
    const act = ingredients.filter((g) => g.active);
    res.json({
      units: UNITS, ingredients, suppliers,
      stats: {
        count: act.length, low: act.filter((g) => g.status === 'low').length, out: act.filter((g) => g.status === 'out').length,
        value_cents: act.reduce((t, g) => t + g.value_cents, 0), owed_cents: suppliers.reduce((t, s) => t + Math.max(0, s.balance_cents), 0),
      },
    });
  }));

  // ---------- ingredients ----------
  const ingBody = (b) => ({
    name: str(b.name, 60) || bad('Name is required'),
    unit: UNITS.includes(b.unit) ? b.unit : bad('Pick a unit'),
    reorder_level: num(b.reorder_level || 0, 'reorder level'),
    par_level: num(b.par_level || 0, 'order-up-to level'),
    cost_cents: Math.round(Number(b.cost || 0) * 100 * 100) / 100,
    supplier_id: int(b.supplier_id),
    active: b.active !== false,
  });
  r.post('/ingredients', wrap(async (req, res) => {
    const g = ingBody(req.body);
    const opening = req.body.opening_stock ? num(req.body.opening_stock, 'opening stock') : 0;
    const id = await tx(async (c) => {
      const { rows: [row] } = await c.query(
        `INSERT INTO ingredients(name, unit, reorder_level, par_level, cost_cents, supplier_id, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [g.name, g.unit, g.reorder_level, g.par_level, g.cost_cents, g.supplier_id, g.active]).catch((e) => {
        if (e.code === '23505') bad('An ingredient with that name already exists'); throw e;
      });
      if (opening > 0) await move(c, { ingredientId: row.id, kind: 'opening', change: opening, note: 'Opening stock', staffId: req.user.id });
      await audit(c, { action: 'stock.ingredient', staffId: req.user.id, summary: `Ingredient ${g.name} added${opening ? ` with ${opening} ${g.unit}` : ''}` });
      return row.id;
    });
    changed(res, { id });
  }));
  r.patch('/ingredients/:id', wrap(async (req, res) => {
    const g = ingBody(req.body);
    await pool.query(`UPDATE ingredients SET name=$2, unit=$3, reorder_level=$4, par_level=$5, cost_cents=$6, supplier_id=$7, active=$8 WHERE id=$1`,
      [int(req.params.id), g.name, g.unit, g.reorder_level, g.par_level, g.cost_cents, g.supplier_id, g.active]).catch((e) => {
      if (e.code === '23505') bad('An ingredient with that name already exists'); throw e;
    });
    changed(res);
  }));
  r.get('/ingredients/:id/moves', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT m.*, s.name AS staff_name, o.order_no, p.invoice_no FROM stock_moves m LEFT JOIN staff s ON s.id=m.staff_id
       LEFT JOIN orders o ON o.id=m.order_id LEFT JOIN purchases p ON p.id=m.purchase_id
       WHERE m.ingredient_id=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT 60`, [int(req.params.id)]);
    res.json({ moves: rows });
  }));
  // Waste (always reduces) or a manual correction (+/-)
  r.post('/ingredients/:id/adjust', wrap(async (req, res) => {
    const id = int(req.params.id);
    const kind = req.body.kind === 'waste' ? 'waste' : 'adjust';
    const qty = num(kind === 'waste' ? req.body.qty : Math.abs(req.body.qty), 'quantity', { allowZero: false });
    const change = kind === 'waste' ? -qty : (req.body.direction === 'remove' ? -qty : qty);
    const note = str(req.body.note, 200);
    if (note.length < 3) bad('Give a reason');
    await tx(async (c) => {
      const g = await move(c, { ingredientId: id, kind, change, note, staffId: req.user.id });
      await audit(c, { action: `stock.${kind}`, staffId: req.user.id,
        summary: `${kind === 'waste' ? 'Waste' : 'Adjustment'}: ${change > 0 ? '+' : ''}${change} of ${g.name} · ${note}` });
    });
    changed(res);
  }));

  // ---------- recipes ----------
  r.get('/recipes', wrap(async (req, res) => {
    const { rows: items } = await pool.query(
      `SELECT m.id, m.name, m.price_cents, m.active, m.no_kot, c.name AS category, c.sort AS csort, m.sort,
         coalesce((SELECT json_agg(json_build_object('ingredient_id', r.ingredient_id, 'qty', r.qty, 'name', g.name, 'unit', g.unit,
                     'cost_cents', g.cost_cents, 'stock', g.stock) ORDER BY g.name)
                   FROM recipe_items r JOIN ingredients g ON g.id=r.ingredient_id WHERE r.menu_item_id=m.id), '[]') AS lines,
         ${STOCK_OUT_SQL} AS stock_out
       FROM menu_items m JOIN categories c ON c.id=m.category_id ORDER BY m.active DESC, c.sort, m.sort, m.name`);
    for (const m of items) {
      m.cost_cents = Math.round(m.lines.reduce((t, l) => t + Number(l.qty) * Number(l.cost_cents), 0));
      m.food_cost_pct = m.lines.length && m.price_cents ? Math.round((m.cost_cents / m.price_cents) * 1000) / 10 : null;
      m.can_make = m.lines.length ? Math.max(0, Math.floor(Math.min(...m.lines.map((l) => Number(l.stock) / Number(l.qty))))) : null;
    }
    res.json({ items });
  }));
  r.put('/recipes/:menuItemId', wrap(async (req, res) => {
    const mid = int(req.params.menuItemId);
    const lines = (Array.isArray(req.body.lines) ? req.body.lines : []).map((l) => ({ ingredient_id: int(l.ingredient_id), qty: Number(l.qty) }))
      .filter((l) => l.ingredient_id && Number.isFinite(l.qty) && l.qty > 0);
    if (new Set(lines.map((l) => l.ingredient_id)).size !== lines.length) bad('Each ingredient can appear once in a recipe');
    await tx(async (c) => {
      const { rows: [m] } = await c.query('SELECT name FROM menu_items WHERE id=$1', [mid]);
      if (!m) throw new HttpError(404, 'Dish not found');
      await c.query('DELETE FROM recipe_items WHERE menu_item_id=$1', [mid]);
      for (const l of lines) await c.query('INSERT INTO recipe_items(menu_item_id, ingredient_id, qty) VALUES ($1,$2,$3)', [mid, l.ingredient_id, l.qty]);
      await audit(c, { action: 'stock.recipe', staffId: req.user.id, summary: `Recipe for ${m.name} saved (${lines.length} ingredients)` });
    });
    notify('menu');
    changed(res);
  }));

  // ---------- suppliers ----------
  const supBody = (b) => ({ name: str(b.name, 80) || bad('Name is required'), phone: str(b.phone, 30) || null, email: str(b.email, 80) || null,
    address: str(b.address, 200) || null, notes: str(b.notes, 300) || null, active: b.active !== false });
  r.post('/suppliers', wrap(async (req, res) => {
    const s = supBody(req.body);
    const { rows: [row] } = await pool.query('INSERT INTO suppliers(name, phone, email, address, notes, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [s.name, s.phone, s.email, s.address, s.notes, s.active]);
    changed(res, { id: row.id });
  }));
  r.patch('/suppliers/:id', wrap(async (req, res) => {
    const s = supBody(req.body);
    await pool.query('UPDATE suppliers SET name=$2, phone=$3, email=$4, address=$5, notes=$6, active=$7 WHERE id=$1',
      [int(req.params.id), s.name, s.phone, s.email, s.address, s.notes, s.active]);
    changed(res);
  }));
  r.get('/suppliers/:id', wrap(async (req, res) => {
    const id = int(req.params.id);
    const [p, x] = await Promise.all([
      pool.query(`SELECT p.*, coalesce((SELECT sum(amount_cents) FROM supplier_payments y WHERE y.purchase_id=p.id),0)::int AS paid_cents
                  FROM purchases p WHERE p.supplier_id=$1 ORDER BY p.invoice_date DESC, p.id DESC LIMIT 50`, [id]),
      pool.query(`SELECT y.*, s.name AS staff_name, p.invoice_no FROM supplier_payments y LEFT JOIN staff s ON s.id=y.staff_id
                  LEFT JOIN purchases p ON p.id=y.purchase_id WHERE y.supplier_id=$1 ORDER BY y.paid_at DESC LIMIT 50`, [id]),
    ]);
    res.json({ purchases: p.rows, payments: x.rows });
  }));

  // Pay a supplier. "drawer" takes the cash from the open shift's drawer (recorded as cash out).
  async function paySupplier(c, { supplierId, purchaseId = null, amount, method, reference, user }) {
    if (!PAY_METHODS.includes(method)) bad('Pick how it was paid');
    const { rows: [sup] } = await c.query('SELECT name FROM suppliers WHERE id=$1', [supplierId]);
    if (!sup) throw new HttpError(404, 'Supplier not found');
    let cmId = null;
    if (method === 'drawer') {
      const { rows: [sh] } = await c.query("SELECT id FROM shifts WHERE status='open'");
      if (!sh) throw new HttpError(409, 'No shift is open, so the cash drawer cannot be used. Pick another payment method.');
      const { rows: [d] } = await c.query(
        `SELECT sh.float_cents
           + coalesce((SELECT sum(total_cents) FROM orders WHERE shift_id=sh.id AND status='paid' AND payment_method='cash'),0)
           - coalesce((SELECT sum(amount_cents) FROM refunds WHERE shift_id=sh.id AND method='cash'),0)
           + coalesce((SELECT sum(amount_cents) FROM cash_movements WHERE shift_id=sh.id AND kind='in'),0)
           - coalesce((SELECT sum(amount_cents) FROM cash_movements WHERE shift_id=sh.id AND kind='out'),0) AS cash
         FROM shifts sh WHERE sh.id=$1`, [sh.id]);
      if (amount > Number(d.cash)) bad(`Only ${(Math.max(0, Number(d.cash)) / 100).toFixed(2)} should be in the cash drawer. Pay the rest another way.`);
      const { rows: [cm] } = await c.query(
        `INSERT INTO cash_movements(shift_id, kind, amount_cents, reason, staff_id, approved_by) VALUES ($1,'out',$2,$3,$4,$4) RETURNING id`,
        [sh.id, amount, `Supplier payment: ${sup.name}${reference ? ' · ' + reference : ''}`, user.id]);
      cmId = cm.id;
    }
    await c.query(`INSERT INTO supplier_payments(supplier_id, purchase_id, amount_cents, method, reference, staff_id, cash_movement_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7)`, [supplierId, purchaseId, amount, method, reference || null, user.id, cmId]);
    await audit(c, { action: 'stock.payment', staffId: user.id,
      summary: `Paid ${sup.name} ${(amount / 100).toFixed(2)} by ${method === 'drawer' ? 'cash from drawer' : method}${reference ? ' · ' + reference : ''}` });
    return cmId;
  }
  r.post('/suppliers/:id/payments', wrap(async (req, res) => {
    const amount = cents(req.body.amount, 'amount');
    if (!amount) bad('Enter an amount');
    const fromDrawer = await tx((c) => paySupplier(c, { supplierId: int(req.params.id), purchaseId: int(req.body.purchase_id), amount,
      method: req.body.method, reference: str(req.body.reference, 80), user: req.user }));
    if (fromDrawer) notify('shift');
    changed(res);
  }));

  // ---------- purchases (goods received) ----------
  r.get('/purchases', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT p.*, s.name AS supplier_name, st.name AS staff_name,
         (SELECT count(*)::int FROM purchase_items i WHERE i.purchase_id=p.id) AS lines,
         coalesce((SELECT sum(amount_cents) FROM supplier_payments y WHERE y.purchase_id=p.id),0)::int AS paid_cents
       FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN staff st ON st.id=p.staff_id
       ORDER BY p.invoice_date DESC, p.id DESC LIMIT 100`);
    res.json({ purchases: rows });
  }));
  r.get('/purchases/:id', wrap(async (req, res) => {
    const id = int(req.params.id);
    const { rows: [p] } = await pool.query(
      `SELECT p.*, s.name AS supplier_name, st.name AS staff_name FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id
       LEFT JOIN staff st ON st.id=p.staff_id WHERE p.id=$1`, [id]);
    if (!p) throw new HttpError(404, 'Purchase not found');
    const [items, pays] = await Promise.all([
      pool.query('SELECT i.*, g.name, g.unit FROM purchase_items i JOIN ingredients g ON g.id=i.ingredient_id WHERE i.purchase_id=$1 ORDER BY i.id', [id]),
      pool.query('SELECT y.*, s.name AS staff_name FROM supplier_payments y LEFT JOIN staff s ON s.id=y.staff_id WHERE y.purchase_id=$1 ORDER BY y.id', [id]),
    ]);
    res.json({ ...p, items: items.rows, payments: pays.rows, paid_cents: pays.rows.reduce((t, x) => t + x.amount_cents, 0) });
  }));
  r.post('/purchases', wrap(async (req, res) => {
    const b = req.body;
    const supplierId = int(b.supplier_id) || bad('Pick a supplier');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.invoice_date || '') ? b.invoice_date : null;
    const due = /^\d{4}-\d{2}-\d{2}$/.test(b.due_date || '') ? b.due_date : null;
    const lines = (Array.isArray(b.lines) ? b.lines : []).filter((l) => int(l.ingredient_id) && Number(l.qty) > 0).map((l) => {
      const qty = num(l.qty, 'quantity', { allowZero: false });
      const lineCents = l.line_total !== undefined && l.line_total !== '' ? cents(l.line_total, 'line total') : Math.round(Number(l.unit_cost) * 100 * qty);
      if (!Number.isFinite(lineCents) || lineCents < 0) bad('Enter a cost for every line');
      return { ingredient_id: int(l.ingredient_id), qty, line_cents: lineCents, unit_cost_cents: Math.round((lineCents / qty) * 10000) / 10000 };
    });
    if (!lines.length) bad('Add at least one item');
    const total = lines.reduce((t, l) => t + l.line_cents, 0);
    const payAmount = b.pay_amount ? cents(b.pay_amount, 'payment amount') : 0;
    if (payAmount > total) bad('Payment is more than the invoice total');
    let usedDrawer = false;
    const id = await tx(async (c) => {
      const { rows: [p] } = await c.query(
        `INSERT INTO purchases(supplier_id, invoice_no, invoice_date, due_date, total_cents, notes, staff_id)
         VALUES ($1,$2,coalesce($3::date, CURRENT_DATE),$4,$5,$6,$7) RETURNING id`,
        [supplierId, str(b.invoice_no, 40) || null, date, due, total, str(b.notes, 300) || null, req.user.id]);
      for (const l of lines) {
        await c.query('INSERT INTO purchase_items(purchase_id, ingredient_id, qty, unit_cost_cents, line_cents) VALUES ($1,$2,$3,$4,$5)',
          [p.id, l.ingredient_id, l.qty, l.unit_cost_cents, l.line_cents]);
        // weighted average cost: (current value + new value) / new quantity; negative stock counts as zero
        const { rows: [g] } = await c.query('SELECT stock, cost_cents FROM ingredients WHERE id=$1 FOR UPDATE', [l.ingredient_id]);
        if (!g) bad('Unknown ingredient');
        const have = Math.max(0, g.stock);
        const newCost = have + l.qty > 0 ? (have * g.cost_cents + l.line_cents) / (have + l.qty) : l.unit_cost_cents;
        await c.query('UPDATE ingredients SET cost_cents=$2, supplier_id=coalesce(supplier_id, $3) WHERE id=$1',
          [l.ingredient_id, Math.round(newCost * 10000) / 10000, supplierId]);
        await move(c, { ingredientId: l.ingredient_id, kind: 'purchase', change: l.qty, purchaseId: p.id, staffId: req.user.id,
          unitCost: l.unit_cost_cents, note: str(b.invoice_no, 40) ? `Invoice ${str(b.invoice_no, 40)}` : null });
      }
      const { rows: [sup] } = await c.query('SELECT name FROM suppliers WHERE id=$1', [supplierId]);
      await audit(c, { action: 'stock.purchase', staffId: req.user.id,
        summary: `Goods received from ${sup ? sup.name : 'supplier'}${b.invoice_no ? ' · invoice ' + str(b.invoice_no, 40) : ''} · ${(total / 100).toFixed(2)} (${lines.length} items)` });
      if (payAmount > 0) {
        usedDrawer = !!(await paySupplier(c, { supplierId, purchaseId: p.id, amount: payAmount, method: b.pay_method, reference: str(b.pay_reference, 80), user: req.user }));
      }
      return p.id;
    });
    if (usedDrawer) notify('shift');
    notify('menu');
    changed(res, { id });
  }));

  // ---------- reorder list ----------
  r.get('/reorder', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT g.*, s.name AS supplier_name, s.phone AS supplier_phone FROM ingredients g LEFT JOIN suppliers s ON s.id=g.supplier_id
       WHERE g.active AND g.stock <= g.reorder_level ORDER BY s.name NULLS LAST, g.name`);
    const groups = new Map();
    for (const g of rows) {
      const target = g.par_level > 0 ? g.par_level : g.reorder_level * 2;
      const suggest = Math.max(0, Math.ceil((target - g.stock) * 10) / 10);
      const key = g.supplier_id || 0;
      if (!groups.has(key)) groups.set(key, { supplier_id: g.supplier_id, supplier_name: g.supplier_name || 'No supplier set', supplier_phone: g.supplier_phone, items: [] });
      groups.get(key).items.push({ ...g, suggest, est_cents: Math.round(suggest * g.cost_cents) });
    }
    res.json({ groups: [...groups.values()].map((x) => ({ ...x, est_cents: x.items.reduce((t, i) => t + i.est_cents, 0) })) });
  }));

  // ---------- stock count (stock take) ----------
  r.post('/stocktake', wrap(async (req, res) => {
    const counts = (Array.isArray(req.body.counts) ? req.body.counts : [])
      .filter((x) => int(x.ingredient_id) && x.counted !== '' && x.counted !== null && x.counted !== undefined);
    if (!counts.length) bad('Enter at least one count');
    const note = str(req.body.note, 200) || 'Stock count';
    const result = await tx(async (c) => {
      let changedLines = 0; let gain = 0; let loss = 0;
      for (const x of counts) {
        const counted = num(x.counted, 'count');
        const { rows: [g] } = await c.query('SELECT stock, cost_cents FROM ingredients WHERE id=$1 FOR UPDATE', [int(x.ingredient_id)]);
        if (!g) continue;
        const diff = Math.round((counted - g.stock) * 1000) / 1000;
        if (diff === 0) continue;
        await move(c, { ingredientId: int(x.ingredient_id), kind: 'count', change: diff, note, staffId: req.user.id });
        changedLines++;
        if (diff > 0) gain += Math.round(diff * g.cost_cents); else loss += Math.round(-diff * g.cost_cents);
      }
      await audit(c, { action: 'stock.count', staffId: req.user.id,
        summary: `Stock count saved: ${counts.length} counted, ${changedLines} changed · loss ${(loss / 100).toFixed(2)}, gain ${(gain / 100).toFixed(2)}` });
      return { counted: counts.length, changed: changedLines, loss_cents: loss, gain_cents: gain };
    });
    changed(res, result);
  }));

  // ---------- sample data for the Asian menu ----------
  r.post('/sample', wrap(async (req, res) => {
    const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM ingredients');
    if (n.n) bad('Ingredients already exist. The sample is only for an empty stock list.');
    const out = await tx((c) => require('./inventory-sample').load(c, { move, staffId: req.user.id }));
    await audit(pool, { action: 'stock.sample', staffId: req.user.id, summary: `Loaded sample ingredients (${out.ingredients}) and recipes (${out.recipes})` });
    notify('menu');
    changed(res, out);
  }));

  return { router: r, deductForOrder, STOCK_OUT_SQL };
};

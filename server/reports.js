// Manager-only sales reports for a date range (inclusive), in the restaurant's time zone.
const express = require('express');

module.exports = function reportsRouter({ pool, wrap, HttpError, CONFIG, license }) {
  const r = express.Router();
  r.use((req, res, next) => (req.user.role === 'Manager' ? next() : next(new HttpError(403, 'Managers only'))));

  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

  r.get('/', wrap(async (req, res) => {
    const tz = CONFIG.timezone;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const from = isDate(req.query.from) ? req.query.from : today;
    const to = isDate(req.query.to) ? req.query.to : from;
    if (from > to) throw new HttpError(400, 'Start date is after end date');
    const days = (new Date(to) - new Date(from)) / 86400000 + 1;
    if (days > 370) throw new HttpError(400, 'Pick a range of a year or less');
    // Basic plan: the last 7 days only
    if (license && !(await license.has('fullReports'))) {
      const oldest = new Date(Date.parse(today) - 6 * 86400000).toISOString().slice(0, 10);
      if (from < oldest) throw Object.assign(new HttpError(403, `Reports older than 7 days: available in the Pro plan. Contact us on WhatsApp to upgrade.`), { upgrade: 'fullReports' });
    }

    // Paid orders belong to the day they were paid; voids and refunds to the day they happened.
    const P = [tz, from, to];
    const inRange = (col) => `(${col} AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`;
    const PAID = `o.status='paid' AND ${inRange('o.closed_at')}`;
    const q = async (sql) => (await pool.query(sql, P)).rows;
    // effective line value before bill-level discount
    const LINE = '(i.qty - i.void_qty) * (i.unit_price_cents + i.addons_cents)';

    const [
      [k], [ref], [vd], [vo], byHour, byDay, byType, byPay, refByMethod, byCat, items, slow, staff, tables, voids, refunds, discounts,
      [stk], dishCost, wasteList, cardBrands,
    ] = await Promise.all([
      q(`SELECT count(*)::int AS orders, coalesce(sum(total_cents),0)::bigint AS gross_cents, coalesce(sum(subtotal_cents),0)::bigint AS subtotal_cents,
                coalesce(sum(discount_cents),0)::bigint AS discount_cents, coalesce(sum(service_cents),0)::bigint AS service_cents,
                coalesce(sum(tax_cents),0)::bigint AS tax_cents, coalesce(sum(tip_cents),0)::bigint AS tip_cents,
                coalesce(sum(guests) FILTER (WHERE type='dinein'),0)::int AS covers,
                count(*) FILTER (WHERE type='dinein')::int AS dinein_orders
         FROM orders o WHERE ${PAID}`),
      q(`SELECT count(*)::int AS count, coalesce(sum(amount_cents),0)::bigint AS amount_cents FROM refunds r WHERE ${inRange('r.created_at')}`),
      q(`SELECT count(*)::int AS count, coalesce(sum(qty),0)::int AS qty, coalesce(sum(amount_cents),0)::bigint AS amount_cents FROM item_voids v WHERE ${inRange('v.created_at')}`),
      q(`SELECT count(*)::int AS count FROM orders o WHERE o.status='void' AND ${inRange('o.closed_at')}`),
      q(`SELECT extract(hour FROM o.opened_at AT TIME ZONE $1)::int AS hour, count(*)::int AS orders, coalesce(sum(total_cents),0)::bigint AS cents
         FROM orders o WHERE ${PAID} GROUP BY 1 ORDER BY 1`),
      q(`SELECT d::date::text AS day, coalesce(x.orders,0)::int AS orders, coalesce(x.cents,0)::bigint AS cents
         FROM generate_series($2::date, $3::date, interval '1 day') d
         LEFT JOIN (SELECT (o.closed_at AT TIME ZONE $1)::date AS day, count(*) AS orders, sum(total_cents) AS cents
                    FROM orders o WHERE ${PAID} GROUP BY 1) x ON x.day = d::date ORDER BY d`),
      q(`SELECT type, count(*)::int AS orders, coalesce(sum(total_cents),0)::bigint AS cents FROM orders o WHERE ${PAID} GROUP BY 1 ORDER BY 3 DESC`),
      q(`SELECT payment_method AS method, count(*)::int AS orders, coalesce(sum(total_cents),0)::bigint AS cents FROM orders o WHERE ${PAID} GROUP BY 1 ORDER BY 3 DESC`),
      q(`SELECT method, coalesce(sum(amount_cents),0)::bigint AS cents FROM refunds r WHERE ${inRange('r.created_at')} GROUP BY 1`),
      q(`SELECT coalesce(c.name, 'Other') AS category, coalesce(sum(i.qty - i.void_qty),0)::int AS qty, coalesce(sum(${LINE}),0)::bigint AS cents
         FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN menu_items m ON m.id=i.menu_item_id LEFT JOIN categories c ON c.id=m.category_id
         WHERE ${PAID} GROUP BY 1 HAVING sum(i.qty - i.void_qty) > 0 ORDER BY 3 DESC`),
      q(`SELECT i.name, coalesce(c.name,'Other') AS category, sum(i.qty - i.void_qty)::int AS qty, sum(${LINE})::bigint AS cents
         FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN menu_items m ON m.id=i.menu_item_id LEFT JOIN categories c ON c.id=m.category_id
         WHERE ${PAID} GROUP BY 1, 2 HAVING sum(i.qty - i.void_qty) > 0 ORDER BY 3 DESC, 4 DESC`),
      q(`SELECT m.name, c.name AS category, coalesce(x.qty,0)::int AS qty, coalesce(x.cents,0)::bigint AS cents
         FROM menu_items m JOIN categories c ON c.id=m.category_id
         LEFT JOIN (SELECT i.menu_item_id, sum(i.qty - i.void_qty) AS qty, sum(${LINE}) AS cents FROM order_items i JOIN orders o ON o.id=i.order_id
                    WHERE ${PAID} GROUP BY 1) x ON x.menu_item_id=m.id
         WHERE m.active ORDER BY 3, 4, m.name LIMIT 8`),
      q(`SELECT s.name, s.role, count(o.id)::int AS orders, coalesce(sum(o.total_cents),0)::bigint AS cents, coalesce(sum(o.tip_cents),0)::bigint AS tip_cents,
                (SELECT count(*)::int FROM item_voids v WHERE v.staff_id=s.id AND ${inRange('v.created_at')}) AS voids
         FROM staff s LEFT JOIN orders o ON o.staff_id=s.id AND ${PAID}
         GROUP BY s.id HAVING count(o.id) > 0 OR (SELECT count(*) FROM item_voids v WHERE v.staff_id=s.id AND ${inRange('v.created_at')}) > 0
         ORDER BY 4 DESC`),
      q(`SELECT t.code, a.name AS area, count(o.id)::int AS orders, coalesce(sum(o.guests),0)::int AS covers, coalesce(sum(o.total_cents),0)::bigint AS cents,
                round(avg(extract(epoch FROM (o.closed_at - o.opened_at)) / 60))::int AS avg_minutes
         FROM orders o JOIN dining_tables t ON t.id=o.table_id JOIN areas a ON a.id=t.area_id
         WHERE ${PAID} AND o.type='dinein' GROUP BY t.id, a.name ORDER BY 3 DESC, 5 DESC`),
      q(`SELECT v.created_at, v.name, v.qty, v.amount_cents, v.reason, o.order_no, s.name AS staff_name, ap.name AS approved_name
         FROM item_voids v JOIN orders o ON o.id=v.order_id LEFT JOIN staff s ON s.id=v.staff_id LEFT JOIN staff ap ON ap.id=v.approved_by
         WHERE ${inRange('v.created_at')} ORDER BY v.created_at DESC, v.id DESC LIMIT 200`),
      q(`SELECT r.created_at, r.amount_cents, r.method, r.reason, o.order_no, s.name AS staff_name, ap.name AS approved_name
         FROM refunds r JOIN orders o ON o.id=r.order_id LEFT JOIN staff s ON s.id=r.staff_id LEFT JOIN staff ap ON ap.id=r.approved_by
         WHERE ${inRange('r.created_at')} ORDER BY r.created_at DESC, r.id DESC LIMIT 200`),
      q(`SELECT discount_pct AS pct, count(*)::int AS orders, coalesce(sum(discount_cents),0)::bigint AS cents
         FROM orders o WHERE ${PAID} AND discount_pct > 0 GROUP BY 1 ORDER BY 1`),
      // stock: cost of what was sold (valued when sold), waste, count differences, purchases
      q(`SELECT coalesce(sum(value_cents) FILTER (WHERE kind='sale'),0)::bigint AS cogs_cents,
                coalesce(sum(value_cents) FILTER (WHERE kind='waste'),0)::bigint AS waste_cents,
                coalesce(sum(value_cents) FILTER (WHERE kind='count' AND change < 0),0)::bigint AS count_loss_cents,
                coalesce(sum(value_cents) FILTER (WHERE kind='count' AND change > 0),0)::bigint AS count_gain_cents,
                (SELECT coalesce(sum(total_cents),0) FROM purchases p WHERE p.invoice_date BETWEEN $2::date AND $3::date)::bigint AS purchases_cents,
                (SELECT count(*) FROM recipe_items)::int AS recipe_lines
         FROM stock_moves m WHERE ${inRange('m.created_at')}`),
      // profit per dish: sales vs. current recipe cost
      q(`SELECT i.name, sum(i.qty - i.void_qty)::int AS qty, sum(${LINE})::bigint AS cents,
                coalesce(max(rc.cost),0)::numeric AS unit_cost, bool_or(rc.cost IS NOT NULL) AS has_recipe
         FROM order_items i JOIN orders o ON o.id=i.order_id
         LEFT JOIN (SELECT r.menu_item_id, sum(r.qty * g.cost_cents) AS cost FROM recipe_items r JOIN ingredients g ON g.id=r.ingredient_id GROUP BY 1) rc
           ON rc.menu_item_id=i.menu_item_id
         WHERE ${PAID} GROUP BY i.name HAVING sum(i.qty - i.void_qty) > 0 ORDER BY 3 DESC`),
      q(`SELECT m.created_at, g.name, g.unit, -m.change AS qty, m.value_cents, m.note, s.name AS staff_name
         FROM stock_moves m JOIN ingredients g ON g.id=m.ingredient_id LEFT JOIN staff s ON s.id=m.staff_id
         WHERE m.kind='waste' AND ${inRange('m.created_at')} ORDER BY m.created_at DESC, m.id DESC LIMIT 100`),
      q(`SELECT coalesce(card_brand,'Not recorded') AS brand, count(*)::int AS orders, coalesce(sum(total_cents),0)::bigint AS cents
         FROM orders o WHERE ${PAID} AND payment_method='card' GROUP BY 1 ORDER BY 3 DESC`),
    ]);

    const n = (v) => Number(v);
    const kpi = Object.fromEntries(Object.entries(k).map(([a, b]) => [a, n(b)]));
    const refundsCents = n(ref.amount_cents);
    res.json({
      from, to, days,
      kpis: {
        ...kpi,
        refunds_cents: refundsCents, refunds_count: ref.count,
        net_cents: kpi.gross_cents - refundsCents,
        avg_bill_cents: kpi.orders ? Math.round(kpi.gross_cents / kpi.orders) : 0,
        avg_per_cover_cents: kpi.covers ? Math.round(kpi.gross_cents / kpi.covers) : 0,
        voided_items: vd.qty, voided_lines: vd.count, voided_cents: n(vd.amount_cents), voided_orders: vo.count,
      },
      by_hour: Array.from({ length: 24 }, (_, h) => {
        const x = byHour.find((r0) => r0.hour === h);
        return { hour: h, orders: x ? x.orders : 0, cents: x ? n(x.cents) : 0 };
      }),
      by_day: byDay.map((x) => ({ ...x, cents: n(x.cents) })),
      by_type: byType.map((x) => ({ ...x, cents: n(x.cents) })),
      by_payment: byPay.map((x) => ({ ...x, cents: n(x.cents), refund_cents: n((refByMethod.find((y) => y.method === x.method) || { cents: 0 }).cents) })),
      by_category: byCat.map((x) => ({ ...x, cents: n(x.cents) })),
      top_items: items.slice(0, 10).map((x) => ({ ...x, cents: n(x.cents) })),
      slow_items: slow.map((x) => ({ ...x, cents: n(x.cents) })),
      all_items: items.map((x) => ({ ...x, cents: n(x.cents) })),
      staff: staff.map((x) => ({ ...x, cents: n(x.cents), tip_cents: n(x.tip_cents), avg_cents: x.orders ? Math.round(n(x.cents) / x.orders) : 0 })),
      tables: tables.map((x) => ({ ...x, cents: n(x.cents) })),
      discounts: discounts.map((x) => ({ ...x, cents: n(x.cents) })),
      voids: voids.map((x) => ({ ...x, amount_cents: n(x.amount_cents) })),
      refunds: refunds.map((x) => ({ ...x, amount_cents: n(x.amount_cents) })),
      stock: (() => {
        const food = kpi.subtotal_cents - kpi.discount_cents; // food & drink sales before service charge and tax
        const cogs = n(stk.cogs_cents);
        return {
          food_sales_cents: food, cogs_cents: cogs, gross_profit_cents: food - cogs,
          food_cost_pct: food ? Math.round((cogs / food) * 1000) / 10 : null,
          waste_cents: n(stk.waste_cents), count_loss_cents: n(stk.count_loss_cents), count_gain_cents: n(stk.count_gain_cents),
          purchases_cents: n(stk.purchases_cents), has_recipes: stk.recipe_lines > 0,
        };
      })(),
      dish_profit: dishCost.map((x) => {
        const cost = Math.round(n(x.unit_cost) * x.qty);
        return { name: x.name, qty: x.qty, cents: n(x.cents), cost_cents: x.has_recipe ? cost : null,
          profit_cents: x.has_recipe ? n(x.cents) - cost : null, margin_pct: x.has_recipe && n(x.cents) ? Math.round(((n(x.cents) - cost) / n(x.cents)) * 1000) / 10 : null };
      }),
      waste: wasteList.map((x) => ({ ...x, value_cents: n(x.value_cents) })),
      card_brands: cardBrands.map((x) => ({ ...x, cents: n(x.cents) })),
    });
  }));

  return r;
};

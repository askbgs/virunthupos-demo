// Demo data: staff, floor plan, stations and the Asian sample menu.
module.exports = async function seed(pool, hashPin) {
  const q = (sql, params) => pool.query(sql, params);

  const staff = [
    ['Ravi K.', 'RK', 'Captain', '1234'],
    ['Manager', 'MG', 'Manager', '0000'],
    ['Kitchen', 'KT', 'Kitchen', '1111'],
  ];
  for (const [name, initials, role, pin] of staff) {
    await q('INSERT INTO staff(name, initials, role, pin_hash) VALUES ($1,$2,$3,$4)', [name, initials, role, hashPin(pin)]);
  }

  const areas = [['Main hall', 'Main hall', 1], ['Patio', 'Patio', 2], ['Bar counter', 'Bar', 3]];
  const areaIds = [];
  for (const a of areas) {
    const { rows } = await q('INSERT INTO areas(name, short, sort) VALUES ($1,$2,$3) RETURNING id', a);
    areaIds.push(rows[0].id);
  }
  const tables = [
    ['T1', 0, 2], ['T2', 0, 2], ['T3', 0, 4], ['T4', 0, 4], ['T5', 0, 4], ['T6', 0, 6], ['T7', 0, 6], ['T8', 0, 8],
    ['P1', 1, 2], ['P2', 1, 2], ['P3', 1, 4], ['P4', 1, 4],
    ['B1', 2, 1], ['B2', 2, 1], ['B3', 2, 2], ['B4', 2, 2],
  ];
  let s = 0;
  for (const [code, ai, seats] of tables) {
    await q('INSERT INTO dining_tables(code, area_id, seats, sort) VALUES ($1,$2,$3,$4)', [code, areaIds[ai], seats, s++]);
  }

  // Kitchen stations + Asian sample menu (shared with Admin → "Load Asian menu")
  await require('./menu-data').loadMenu(pool);
  await q("INSERT INTO settings(key, value) VALUES ('terminal', 'Asian Cuisine') ON CONFLICT (key) DO NOTHING");
  // Sample suppliers, ingredients with opening stock, and recipes
  const move = async (c, { ingredientId, kind, change, note }) => {
    const { rows: [g] } = await c.query('UPDATE ingredients SET stock = stock + $2 WHERE id=$1 RETURNING stock, cost_cents', [ingredientId, change]);
    await c.query('INSERT INTO stock_moves(ingredient_id, kind, change, stock_after, value_cents, note) VALUES ($1,$2,$3,$4,$5,$6)',
      [ingredientId, kind, change, g.stock, Math.round(Math.abs(change) * g.cost_cents), note]);
  };
  await require('./inventory-sample').load(pool, { move, staffId: null });
};

// Sample Asian menu. Prices are in rupees (major units); the loader converts to cents.
// Item: [name, price, stationCode, tags, askSpice, addons[[name, price]]]

const STATIONS = [
  ['WOK', 'Wok', 'Wok printer'],
  ['CURRY', 'Curry', 'Curry kitchen printer'],
  ['TANDOOR', 'Tandoor', 'Tandoor printer'],
  ['GRILL', 'Grill', 'Grill & griddle printer'],
  ['STEAM', 'Steam', 'Steam printer'],
  ['COLD', 'Cold', 'Cold kitchen printer'],
  ['BAR', 'Bar', 'Bar printer'],
];

const EGG = ['Fried egg', 150, 'piece'];

const MENU = [
  ['Short Eats', 'starter', [
    ['Fish Cutlets (4)', 450, 'GRILL', ['Sri Lankan'], true, []],
    ['Vegetable Rolls (2)', 400, 'GRILL', ['Sri Lankan', 'Veg'], false, []],
    ['Vegetable Samosa (2)', 450, 'GRILL', ['Indian', 'Veg'], true, [['Mint chutney', 100]]],
    ['Chicken Spring Rolls (4)', 750, 'WOK', ['Chinese'], false, [['Sweet chilli dip', 100]]],
    ['Chicken Gyoza (5)', 950, 'STEAM', ['Japanese'], false, []],
  ]],
  ['Sri Lankan', 'main', [
    ['Chicken Kottu', 1450, 'GRILL', ['Griddle'], true, [['Extra cheese', 300, 'portion'], EGG]],
    ['Cheese Kottu', 1650, 'GRILL', ['Griddle', 'Veg'], true, [EGG]],
    ['Rice & Curry – Chicken', 1350, 'CURRY', ['Curry'], true, [['Extra papadam', 100, 'piece'], ['Boiled egg', 120, 'piece'], ['Extra rice', 250, 'portion'], ['Chicken curry', 450, 'portion']]],
    ['Rice & Curry – Vegetable', 950, 'CURRY', ['Curry', 'Veg'], true, [['Extra papadam', 100, 'piece'], ['Boiled egg', 120, 'piece'], ['Extra rice', 250, 'portion']]],
    ['Egg Hoppers (2)', 600, 'GRILL', ['Griddle'], false, [['Lunu miris', 100], ['Chicken curry', 450]]],
    ['String Hoppers (10) & Kiri Hodi', 750, 'STEAM', ['Steam', 'Veg'], false, [['Pol sambol', 150]]],
    ['Lamprais', 1850, 'CURRY', ['Curry'], false, []],
    ['Devilled Chicken', 1650, 'WOK', ['Wok'], true, []],
    ['Fish Ambul Thiyal', 1750, 'CURRY', ['Curry'], true, []],
  ]],
  ['Indian', 'main', [
    ['Butter Chicken', 1950, 'CURRY', ['Curry'], true, [['Garlic naan', 450, 'piece'], ['Jeera rice', 500, 'portion']]],
    ['Chicken Biryani', 1850, 'CURRY', ['Dum'], true, [['Raita', 250]]],
    ['Paneer Tikka', 1650, 'TANDOOR', ['Tandoor', 'Veg'], true, []],
    ['Tandoori Chicken (Half)', 2250, 'TANDOOR', ['Tandoor'], true, []],
    ['Masala Dosa', 950, 'GRILL', ['Griddle', 'Veg'], true, [['Extra sambar', 200]]],
    ['Dal Makhani', 1250, 'CURRY', ['Curry', 'Veg'], true, []],
    ['Garlic Naan', 450, 'TANDOOR', ['Tandoor', 'Veg'], false, [['Butter', 100]]],
  ]],
  ['Chinese', 'main', [
    ['Chicken Fried Rice', 1450, 'WOK', ['Wok'], false, [EGG]],
    ['Szechuan Chilli Chicken', 1750, 'WOK', ['Wok'], true, []],
    ['Hot Butter Cuttlefish', 1950, 'WOK', ['Wok'], true, []],
    ['Pork Dumplings (6)', 1250, 'STEAM', ['Steam'], false, []],
    ['Vegetable Chop Suey', 1150, 'WOK', ['Wok', 'Veg'], false, []],
  ]],
  ['Thai', 'main', [
    ['Thai Green Curry', 1950, 'CURRY', ['Curry'], true, [['Jasmine rice', 400, 'portion']]],
    ['Pad Thai Prawns', 2150, 'WOK', ['Wok'], true, []],
    ['Tom Yum Soup', 1350, 'CURRY', ['Soup'], true, []],
    ['Som Tam Papaya Salad', 1150, 'COLD', ['Cold', 'Veg'], true, []],
  ]],
  ['Japanese', 'main', [
    ['Chicken Katsu Curry', 2250, 'GRILL', ['Fryer'], false, []],
    ['Salmon Sushi Platter (8)', 3450, 'COLD', ['Cold'], false, [['Extra wasabi', 100]]],
    ['Tonkotsu Ramen', 2650, 'WOK', ['Noodles'], true, [['Extra egg', 200, 'piece'], ['Extra chashu', 500, 'portion']]],
    ['Vegetable Tempura', 1550, 'WOK', ['Fryer', 'Veg'], false, []],
  ]],
  ['Korean', 'main', [
    ['Korean Fried Chicken', 1950, 'GRILL', ['Fryer'], true, []],
    ['Bibimbap', 1950, 'GRILL', ['Stone pot'], true, [EGG]],
    ['Kimchi Fried Rice', 1650, 'WOK', ['Wok'], true, [EGG]],
    ['Tteokbokki', 1450, 'WOK', ['Wok'], true, []],
  ]],
  ['Desserts', 'dessert', [
    ['Watalappan', 650, 'COLD', ['Sri Lankan'], false, []],
    ['Gulab Jamun (2)', 550, 'COLD', ['Indian', 'Veg'], false, [['Vanilla ice cream', 250]]],
    ['Mango Sticky Rice', 950, 'COLD', ['Thai', 'Veg'], false, []],
    ['Matcha Ice Cream', 750, 'COLD', ['Japanese', 'Veg'], false, []],
  ]],
  ['Drinks', 'drink', [
    ['Ceylon Milk Tea', 350, 'BAR', ['Hot'], false, []],
    ['Faluda', 650, 'BAR', ['Sri Lankan'], false, []],
    ['Mango Lassi', 750, 'BAR', ['Indian'], false, []],
    ['Thai Iced Tea', 650, 'BAR', ['Thai'], false, []],
    ['King Coconut', 400, 'BAR', ['Fresh'], false, []],
    ['Fresh Lime Soda', 450, 'BAR', ['Fresh'], false, []],
  ]],
];

// Load the menu. With replace=true, the current menu is retired first:
// dishes never ordered are deleted, ordered ones are hidden and parked in "Old menu (hidden)".
async function loadMenu(c, { replace = false } = {}) {
  const st = {};
  let s = 0;
  for (const [code, name, printer] of STATIONS) {
    const { rows: [row] } = await c.query(
      `INSERT INTO stations(code, name, printer, sort) VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, printer=EXCLUDED.printer, sort=EXCLUDED.sort RETURNING id`,
      [code, name, printer, s++]);
    st[code] = row.id;
  }

  if (replace) {
    await c.query('DELETE FROM menu_items m WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.menu_item_id=m.id)');
    const { rows: left } = await c.query('SELECT count(*)::int AS n FROM menu_items');
    if (left[0].n) {
      const { rows: [old] } = await c.query(
        "INSERT INTO categories(name, default_course, sort) VALUES ('Old menu (hidden)', 'main', 999) RETURNING id");
      await c.query('UPDATE menu_items SET active=FALSE, category_id=$1', [old.id]);
      await c.query('DELETE FROM categories WHERE id <> $1', [old.id]);
    } else {
      await c.query('DELETE FROM categories');
    }
  }

  let cs = 0;
  let count = 0;
  for (const [cname, course, items] of MENU) {
    const { rows: [cat] } = await c.query('INSERT INTO categories(name, default_course, sort) VALUES ($1,$2,$3) RETURNING id', [cname, course, cs++]);
    let is = 0;
    for (const [name, price, station, tags, spice, addons] of items) {
      const { rows: [m] } = await c.query(
        'INSERT INTO menu_items(category_id, station_id, name, price_cents, tags, has_spice, sort) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [cat.id, st[station], name, price * 100, tags.concat(spice ? ['Spice level'] : []), spice, is++]);
      for (const [an, ap, unit] of addons) {
        await c.query('INSERT INTO item_addons(item_id, name, price_cents, unit) VALUES ($1,$2,$3,$4)', [m.id, an, ap * 100, unit || null]);
      }
      count++;
    }
  }
  return { categories: MENU.length, items: count };
}

module.exports = { STATIONS, MENU, loadMenu };

// Sample suppliers, ingredients (with opening stock) and recipes for the Asian sample menu.
// Costs are rupees per unit; recipes are per single portion, in the ingredient's unit.
const SUPPLIERS = [
  ['MEAT', 'Trinco Fresh Meats & Seafood', '+94 26 222 1001'],
  ['DRY', 'Lanka Wholesale Traders', '+94 26 222 1002'],
  ['VEG', 'Green Valley Vegetables', '+94 77 123 4567'],
  ['DAIRY', 'Ceylon Dairy & Bakery', '+94 26 222 1004'],
];

// [name, unit, cost, reorder, par, supplier, opening stock]
const INGREDIENTS = [
  ['Chicken (boneless)', 'kg', 1600, 5, 20, 'MEAT', 12],
  ['Chicken (bone-in)', 'kg', 1100, 4, 15, 'MEAT', 8],
  ['Fish (seer)', 'kg', 2800, 2, 8, 'MEAT', 4],
  ['Prawns', 'kg', 3200, 1, 5, 'MEAT', 2.5],
  ['Cuttlefish', 'kg', 2400, 1.5, 5, 'MEAT', 1.2],
  ['Pork mince', 'kg', 2200, 1, 4, 'MEAT', 2],
  ['Salmon', 'kg', 9000, 0.5, 2, 'MEAT', 1],
  ['Eggs', 'pcs', 55, 30, 120, 'DAIRY', 60],
  ['Basmati rice', 'kg', 650, 10, 40, 'DRY', 25],
  ['Samba rice', 'kg', 260, 10, 40, 'DRY', 18],
  ['Jasmine rice', 'kg', 800, 3, 10, 'DRY', 2],
  ['Godamba roti', 'pcs', 60, 20, 100, 'DAIRY', 40],
  ['Wheat flour', 'kg', 220, 5, 20, 'DRY', 10],
  ['Rice noodles', 'kg', 900, 2, 8, 'DRY', 3],
  ['Ramen noodles', 'kg', 1200, 2, 6, 'DRY', 0],
  ['Coconut milk', 'l', 650, 3, 12, 'DRY', 6],
  ['Curry powder', 'kg', 2400, 1, 3, 'DRY', 1.2],
  ['Cooking oil', 'l', 750, 5, 20, 'DRY', 9],
  ['Onions', 'kg', 380, 5, 25, 'VEG', 7],
  ['Garlic', 'kg', 900, 1, 4, 'VEG', 1.5],
  ['Tomatoes', 'kg', 450, 3, 10, 'VEG', 4],
  ['Cabbage', 'kg', 250, 3, 10, 'VEG', 5],
  ['Leeks', 'kg', 500, 2, 6, 'VEG', 2],
  ['Green chillies', 'kg', 800, 0.5, 2, 'VEG', 0.8],
  ['Limes', 'kg', 700, 1, 4, 'VEG', 1],
  ['King coconut', 'pcs', 120, 20, 60, 'VEG', 25],
  ['Paneer', 'kg', 3000, 1, 4, 'DAIRY', 1.5],
  ['Butter', 'kg', 3200, 1, 4, 'DAIRY', 1.5],
  ['Cheese', 'kg', 3600, 1, 3, 'DAIRY', 1],
  ['Fresh milk', 'l', 420, 5, 20, 'DAIRY', 8],
  ['Vanilla ice cream', 'l', 1400, 2, 8, 'DAIRY', 3],
  ['Tea leaves', 'kg', 2000, 0.5, 2, 'DRY', 1],
  ['Mango pulp', 'l', 900, 2, 8, 'DRY', 3],
  ['Sugar', 'kg', 260, 5, 20, 'DRY', 8],
  ['Kimchi', 'kg', 2200, 1, 3, 'DRY', 0.6],
  ['Gochujang', 'kg', 4000, 0.3, 1, 'DRY', 0.5],
];

const RECIPES = {
  'Fish Cutlets (4)': [['Fish (seer)', 0.08], ['Wheat flour', 0.05], ['Eggs', 1], ['Cooking oil', 0.08]],
  'Vegetable Rolls (2)': [['Wheat flour', 0.08], ['Cabbage', 0.05], ['Eggs', 1], ['Cooking oil', 0.08]],
  'Chicken Kottu': [['Godamba roti', 2], ['Chicken (boneless)', 0.12], ['Eggs', 1], ['Cabbage', 0.05], ['Leeks', 0.03], ['Onions', 0.04], ['Cooking oil', 0.03], ['Curry powder', 0.005]],
  'Cheese Kottu': [['Godamba roti', 2], ['Cheese', 0.06], ['Eggs', 1], ['Cabbage', 0.05], ['Leeks', 0.03], ['Onions', 0.04], ['Cooking oil', 0.03]],
  'Rice & Curry – Chicken': [['Samba rice', 0.2], ['Chicken (bone-in)', 0.15], ['Coconut milk', 0.08], ['Curry powder', 0.008], ['Onions', 0.03], ['Cooking oil', 0.02]],
  'Rice & Curry – Vegetable': [['Samba rice', 0.2], ['Cabbage', 0.08], ['Tomatoes', 0.05], ['Coconut milk', 0.08], ['Curry powder', 0.006], ['Onions', 0.03]],
  'Egg Hoppers (2)': [['Wheat flour', 0.08], ['Coconut milk', 0.06], ['Eggs', 2]],
  'Devilled Chicken': [['Chicken (boneless)', 0.2], ['Onions', 0.06], ['Tomatoes', 0.04], ['Green chillies', 0.01], ['Cooking oil', 0.04]],
  'Fish Ambul Thiyal': [['Fish (seer)', 0.2], ['Curry powder', 0.006], ['Garlic', 0.005], ['Cooking oil', 0.02]],
  'Butter Chicken': [['Chicken (boneless)', 0.2], ['Butter', 0.03], ['Tomatoes', 0.1], ['Onions', 0.04], ['Curry powder', 0.006]],
  'Chicken Biryani': [['Basmati rice', 0.2], ['Chicken (bone-in)', 0.2], ['Onions', 0.05], ['Butter', 0.015], ['Curry powder', 0.008], ['Cooking oil', 0.02]],
  'Paneer Tikka': [['Paneer', 0.18], ['Onions', 0.04], ['Curry powder', 0.005], ['Cooking oil', 0.015]],
  'Tandoori Chicken (Half)': [['Chicken (bone-in)', 0.45], ['Curry powder', 0.01], ['Limes', 0.02]],
  'Garlic Naan': [['Wheat flour', 0.12], ['Garlic', 0.01], ['Butter', 0.015]],
  'Chicken Fried Rice': [['Basmati rice', 0.2], ['Chicken (boneless)', 0.08], ['Eggs', 1], ['Leeks', 0.03], ['Cooking oil', 0.03]],
  'Szechuan Chilli Chicken': [['Chicken (boneless)', 0.2], ['Onions', 0.05], ['Green chillies', 0.015], ['Cooking oil', 0.03]],
  'Hot Butter Cuttlefish': [['Cuttlefish', 0.2], ['Butter', 0.02], ['Wheat flour', 0.04], ['Cooking oil', 0.1], ['Green chillies', 0.01]],
  'Pork Dumplings (6)': [['Pork mince', 0.12], ['Wheat flour', 0.08], ['Cabbage', 0.03]],
  'Thai Green Curry': [['Chicken (boneless)', 0.18], ['Coconut milk', 0.2], ['Green chillies', 0.01], ['Onions', 0.03]],
  'Pad Thai Prawns': [['Rice noodles', 0.15], ['Prawns', 0.12], ['Eggs', 1], ['Cooking oil', 0.03], ['Limes', 0.02]],
  'Tonkotsu Ramen': [['Ramen noodles', 0.15], ['Pork mince', 0.08], ['Eggs', 1]],
  'Salmon Sushi Platter (8)': [['Salmon', 0.12], ['Jasmine rice', 0.15]],
  'Korean Fried Chicken': [['Chicken (bone-in)', 0.3], ['Wheat flour', 0.06], ['Gochujang', 0.03], ['Cooking oil', 0.12]],
  'Bibimbap': [['Jasmine rice', 0.2], ['Chicken (boneless)', 0.08], ['Eggs', 1], ['Cabbage', 0.05], ['Gochujang', 0.02]],
  'Kimchi Fried Rice': [['Jasmine rice', 0.2], ['Kimchi', 0.08], ['Eggs', 1], ['Cooking oil', 0.02]],
  'Gulab Jamun (2)': [['Fresh milk', 0.1], ['Sugar', 0.05], ['Cooking oil', 0.02]],
  'Watalappan': [['Coconut milk', 0.08], ['Eggs', 1], ['Sugar', 0.04]],
  'Ceylon Milk Tea': [['Tea leaves', 0.005], ['Fresh milk', 0.1], ['Sugar', 0.02]],
  'Faluda': [['Fresh milk', 0.25], ['Vanilla ice cream', 0.05], ['Sugar', 0.03]],
  'Mango Lassi': [['Mango pulp', 0.12], ['Fresh milk', 0.15], ['Sugar', 0.02]],
  'King Coconut': [['King coconut', 1]],
  'Fresh Lime Soda': [['Limes', 0.05], ['Sugar', 0.03]],
};

async function load(c, { move, staffId }) {
  const sup = {};
  for (const [key, name, phone] of SUPPLIERS) {
    const { rows: [s] } = await c.query('INSERT INTO suppliers(name, phone) VALUES ($1,$2) RETURNING id', [name, phone]);
    sup[key] = s.id;
  }
  const ing = {};
  for (const [name, unit, cost, reorder, par, s, opening] of INGREDIENTS) {
    const { rows: [g] } = await c.query(
      'INSERT INTO ingredients(name, unit, cost_cents, reorder_level, par_level, supplier_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [name, unit, cost * 100, reorder, par, sup[s]]);
    ing[name] = g.id;
    if (opening > 0) await move(c, { ingredientId: g.id, kind: 'opening', change: opening, note: 'Opening stock (sample)', staffId });
  }
  let recipes = 0;
  for (const [dish, lines] of Object.entries(RECIPES)) {
    const { rows } = await c.query('SELECT id FROM menu_items WHERE name=$1 AND active', [dish]);
    for (const m of rows) {
      for (const [iname, qty] of lines) {
        await c.query('INSERT INTO recipe_items(menu_item_id, ingredient_id, qty) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [m.id, ing[iname], qty]);
      }
      recipes++;
    }
  }
  return { suppliers: SUPPLIERS.length, ingredients: INGREDIENTS.length, recipes };
}

module.exports = { load };

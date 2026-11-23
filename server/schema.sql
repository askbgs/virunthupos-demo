-- Ember & Bao Restaurant POS schema (PostgreSQL)
-- All money is stored as integer cents.

CREATE TABLE IF NOT EXISTS staff (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  initials    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'Server',      -- Captain, Server, Cashier, Kitchen, Manager
  pin_hash    TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  staff_id    INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS areas (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL,
  short  TEXT NOT NULL,
  sort   INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id       SERIAL PRIMARY KEY,
  code     TEXT NOT NULL UNIQUE,
  area_id  INT NOT NULL REFERENCES areas(id),
  seats    INT NOT NULL DEFAULT 2,
  sort     INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stations (
  id       SERIAL PRIMARY KEY,
  code     TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  printer  TEXT NOT NULL,
  sort     INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  default_course  TEXT NOT NULL DEFAULT 'main',   -- drink | starter | main | dessert
  sort            INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id           SERIAL PRIMARY KEY,
  category_id  INT NOT NULL REFERENCES categories(id),
  station_id   INT NOT NULL REFERENCES stations(id),
  name         TEXT NOT NULL,
  price_cents  INT NOT NULL,
  tags         TEXT[] NOT NULL DEFAULT '{}',
  has_spice    BOOLEAN NOT NULL DEFAULT FALSE,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort         INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS item_addons (
  id           SERIAL PRIMARY KEY,
  item_id      INT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  price_cents  INT NOT NULL DEFAULT 0
);

CREATE SEQUENCE IF NOT EXISTS order_no_seq START 1040;
CREATE SEQUENCE IF NOT EXISTS kot_no_seq START 2200;

CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  order_no        INT NOT NULL DEFAULT nextval('order_no_seq'),
  type            TEXT NOT NULL CHECK (type IN ('dinein','takeaway','delivery','counter')),
  table_id        INT REFERENCES dining_tables(id),
  guests          INT NOT NULL DEFAULT 1,
  customer_name   TEXT,
  phone           TEXT,
  address         TEXT,
  staff_id        INT REFERENCES staff(id),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  bill_printed_at TIMESTAMPTZ,
  discount_pct    INT NOT NULL DEFAULT 0,
  service_on      BOOLEAN NOT NULL DEFAULT TRUE,
  tip_pct         INT NOT NULL DEFAULT 0,
  split_ways      INT NOT NULL DEFAULT 1,
  payment_method  TEXT,
  subtotal_cents  INT NOT NULL DEFAULT 0,
  discount_cents  INT NOT NULL DEFAULT 0,
  service_cents   INT NOT NULL DEFAULT 0,
  tax_cents       INT NOT NULL DEFAULT 0,
  tip_cents       INT NOT NULL DEFAULT 0,
  total_cents     INT NOT NULL DEFAULT 0
);
-- one open dine-in order per table
CREATE UNIQUE INDEX IF NOT EXISTS orders_open_table_uq
  ON orders(table_id) WHERE status = 'open' AND table_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kots (
  id          SERIAL PRIMARY KEY,
  kot_no      INT NOT NULL DEFAULT nextval('kot_no_seq'),
  order_id    INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  station_id  INT REFERENCES stations(id),          -- NULL = single combined ticket
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('held','new','cooking','ready','served')),
  is_addon    BOOLEAN NOT NULL DEFAULT FALSE,
  staff_id    INT REFERENCES staff(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  ready_at    TIMESTAMPTZ,
  served_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS order_items (
  id                SERIAL PRIMARY KEY,
  order_id          INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id      INT REFERENCES menu_items(id),
  station_id        INT REFERENCES stations(id),
  name              TEXT NOT NULL,
  qty               INT NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_cents  INT NOT NULL,
  addons            JSONB NOT NULL DEFAULT '[]',
  addons_cents      INT NOT NULL DEFAULT 0,
  spice             TEXT,
  course            TEXT NOT NULL DEFAULT 'main',
  note              TEXT,
  kot_id            INT REFERENCES kots(id) ON DELETE SET NULL,
  done              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
CREATE INDEX IF NOT EXISTS kots_status_idx ON kots(status);
CREATE INDEX IF NOT EXISTS orders_opened_idx ON orders(opened_at);

-- v2: admin page
ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- v3: dish photos (stored in Postgres so they survive Railway redeploys)
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS image_ver INT;
CREATE TABLE IF NOT EXISTS menu_item_images (
  item_id     INT PRIMARY KEY REFERENCES menu_items(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v4: editable settings (Admin → Settings). Values override environment defaults.
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- v5: voids, refunds, audit log, shifts & cash drawer, thermal printing
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS void_qty INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS shifts (
  id              SERIAL PRIMARY KEY,
  opened_by       INT REFERENCES staff(id),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  float_cents     INT NOT NULL DEFAULT 0,
  closed_by       INT REFERENCES staff(id),
  closed_at       TIMESTAMPTZ,
  counted_cents   INT,
  expected_cents  INT,
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open ON shifts((status)) WHERE status = 'open';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shift_id INT REFERENCES shifts(id);

CREATE TABLE IF NOT EXISTS cash_movements (
  id            SERIAL PRIMARY KEY,
  shift_id      INT NOT NULL REFERENCES shifts(id),
  kind          TEXT NOT NULL CHECK (kind IN ('in','out')),
  amount_cents  INT NOT NULL CHECK (amount_cents > 0),
  reason        TEXT NOT NULL,
  staff_id      INT REFERENCES staff(id),
  approved_by   INT REFERENCES staff(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS item_voids (
  id             SERIAL PRIMARY KEY,
  order_id       INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id  INT REFERENCES order_items(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  qty            INT NOT NULL,
  amount_cents   INT NOT NULL,
  reason         TEXT NOT NULL,
  staff_id       INT REFERENCES staff(id),
  approved_by    INT REFERENCES staff(id),
  shift_id       INT REFERENCES shifts(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refunds (
  id            SERIAL PRIMARY KEY,
  order_id      INT NOT NULL REFERENCES orders(id),
  amount_cents  INT NOT NULL CHECK (amount_cents > 0),
  method        TEXT NOT NULL CHECK (method IN ('card','cash','wallet')),
  reason        TEXT NOT NULL,
  staff_id      INT REFERENCES staff(id),
  approved_by   INT REFERENCES staff(id),
  shift_id      INT REFERENCES shifts(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           SERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  action       TEXT NOT NULL,
  staff_id     INT REFERENCES staff(id),
  approved_by  INT REFERENCES staff(id),
  order_id     INT REFERENCES orders(id) ON DELETE SET NULL,
  summary      TEXT NOT NULL,
  details      JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS printers (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  conn         TEXT NOT NULL CHECK (conn IN ('network','share')),
  address      TEXT NOT NULL,             -- "192.168.1.50:9100", "\\\\PC\\XP80" or "/dev/usb/lp0"
  width_chars  INT NOT NULL DEFAULT 48,   -- 48 = 80 mm, 32 = 58 mm
  active       BOOLEAN NOT NULL DEFAULT TRUE
);
ALTER TABLE stations ADD COLUMN IF NOT EXISTS printer_id INT REFERENCES printers(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS print_jobs (
  id          SERIAL PRIMARY KEY,
  printer_id  INT NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  doc         JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','done','failed')),
  attempts    INT NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at  TIMESTAMPTZ,
  printed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS print_jobs_pending_idx ON print_jobs(status, created_at);

-- v6: items that are served without a kitchen ticket (ready-made, already cooked)
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS no_kot BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS served_direct BOOLEAN NOT NULL DEFAULT FALSE;

-- v7: login screen background photo (uploaded in Admin → Settings)
CREATE TABLE IF NOT EXISTS app_images (
  key         TEXT PRIMARY KEY,
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v8: inventory — ingredients, recipes, stock ledger, suppliers, purchases
CREATE TABLE IF NOT EXISTS suppliers (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  phone     TEXT,
  email     TEXT,
  address   TEXT,
  notes     TEXT,
  active    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS ingredients (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  unit           TEXT NOT NULL DEFAULT 'kg',            -- kg, g, l, ml, pcs, pack, bottle, bunch
  stock          NUMERIC(14,3) NOT NULL DEFAULT 0,
  reorder_level  NUMERIC(14,3) NOT NULL DEFAULT 0,      -- alert at or below this
  par_level      NUMERIC(14,3) NOT NULL DEFAULT 0,      -- order up to this
  cost_cents     NUMERIC(14,4) NOT NULL DEFAULT 0,      -- weighted average cost per unit
  supplier_id    INT REFERENCES suppliers(id) ON DELETE SET NULL,
  active         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS recipe_items (
  menu_item_id   INT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id  INT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty            NUMERIC(12,4) NOT NULL CHECK (qty > 0),
  PRIMARY KEY (menu_item_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS purchases (
  id            SERIAL PRIMARY KEY,
  supplier_id   INT REFERENCES suppliers(id),
  invoice_no    TEXT,
  invoice_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date      DATE,
  total_cents   INT NOT NULL DEFAULT 0,
  notes         TEXT,
  staff_id      INT REFERENCES staff(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id               SERIAL PRIMARY KEY,
  purchase_id      INT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  ingredient_id    INT NOT NULL REFERENCES ingredients(id),
  qty              NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  unit_cost_cents  NUMERIC(14,4) NOT NULL,
  line_cents       INT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id            SERIAL PRIMARY KEY,
  supplier_id   INT NOT NULL REFERENCES suppliers(id),
  purchase_id   INT REFERENCES purchases(id) ON DELETE SET NULL,
  amount_cents  INT NOT NULL CHECK (amount_cents > 0),
  method        TEXT NOT NULL CHECK (method IN ('drawer','cash','bank','card','cheque')),
  reference     TEXT,
  staff_id      INT REFERENCES staff(id),
  cash_movement_id INT REFERENCES cash_movements(id),
  paid_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- every stock change, with its value at the time (for cost of goods sold and waste reports)
CREATE TABLE IF NOT EXISTS stock_moves (
  id             SERIAL PRIMARY KEY,
  ingredient_id  INT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('sale','purchase','waste','count','adjust','opening')),
  change         NUMERIC(14,3) NOT NULL,
  stock_after    NUMERIC(14,3) NOT NULL,
  value_cents    INT NOT NULL DEFAULT 0,          -- |change| × cost at the time
  order_id       INT REFERENCES orders(id) ON DELETE SET NULL,
  purchase_id    INT REFERENCES purchases(id) ON DELETE SET NULL,
  note           TEXT,
  staff_id       INT REFERENCES staff(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_moves_ing_idx ON stock_moves(ingredient_id, id DESC);
CREATE INDEX IF NOT EXISTS stock_moves_created_idx ON stock_moves(created_at);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_deducted BOOLEAN NOT NULL DEFAULT FALSE;

-- v9: card details for card payments (card type + last 4 digits only — never the full number)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS card_brand TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS card_last4 CHAR(4);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS card_auth TEXT;

-- v10: cash payments record the cash handed over and the change given
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_received_cents INT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS change_cents INT;

-- v11: add-on quantities — each add-on has a unit (portion, piece…) and a max per dish
ALTER TABLE item_addons ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE item_addons ADD COLUMN IF NOT EXISTS max_qty INT NOT NULL DEFAULT 5;

-- v12: outgoing integration events (n8n). Kept on the shop server, never synced to the cloud copy.
CREATE TABLE IF NOT EXISTS n8n_events (
  id           BIGSERIAL PRIMARY KEY,
  event        TEXT NOT NULL,
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  attempts     INT NOT NULL DEFAULT 0,
  next_try_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status  INT,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS n8n_events_due ON n8n_events (next_try_at) WHERE status = 'pending';

-- v13: dish names in Tamil and Sinhala, for bills printed in those languages
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS name_ta TEXT;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS name_si TEXT;

-- v14: packages (Basic / Pro / Business): devices signed in on this server, for the plan's device limit.
-- Not synced: the cloud and a shop PC each count their own devices.
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_staff  INT,
  revoked_at  TIMESTAMPTZ
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id TEXT;

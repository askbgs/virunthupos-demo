const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, Client } = require('pg');
// NUMERIC (stock quantities, unit costs) as JS numbers rather than strings
require('pg').types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
// DATE columns as plain 'YYYY-MM-DD' strings (no time-zone shifting)
require('pg').types.setTypeParser(1082, (v) => v);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. On Railway, add a PostgreSQL service and reference ${{Postgres.DATABASE_URL}}.');
  process.exit(1);
}

// Railway's internal network (postgres.railway.internal) does not use SSL; the public proxy URL does.
const useSsl = process.env.PGSSL === 'true' ||
  (/proxy\.rlwy\.net|railway\.app/.test(connectionString) && process.env.PGSSL !== 'false');
const ssl = useSsl ? { rejectUnauthorized: false } : undefined;

const pool = new Pool({ connectionString, ssl, max: 10 });

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function checkPin(pin, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function migrate({ seed = true } = {}) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM staff');
  if (rows[0].n === 0 && seed) {
    await require('./seed')(pool, hashPin);
    console.log('Seeded demo data (staff, floor, stations, menu).');
  }
}

// Cross-instance live updates via LISTEN/NOTIFY
const listeners = new Set();
let listenClient;
async function startListener() {
  listenClient = new Client({ connectionString, ssl });
  listenClient.on('notification', (msg) => {
    for (const fn of listeners) fn(msg.payload);
  });
  listenClient.on('error', (e) => {
    console.error('LISTEN connection error, reconnecting', e.message);
    setTimeout(startListener, 2000);
  });
  await listenClient.connect();
  await listenClient.query('LISTEN pos_events');
}
function notify(kind) {
  pool.query("SELECT pg_notify('pos_events', $1)", [kind]).catch(() => {});
}

module.exports = { pool, tx, migrate, hashPin, checkPin, startListener, notify, listeners };

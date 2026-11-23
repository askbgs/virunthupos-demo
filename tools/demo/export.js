#!/usr/bin/env node
// Save the restaurant in a database as the live-demo snapshot (server/demo/demo-data.json.gz).
//
//   DATABASE_URL=postgres://... node tools/demo/export.js
//
// Set the restaurant up the way the demo should look (menu, tables, a week or two of sales, a few open
// tables), then run this. The demo server (DEMO_MODE=true) loads this snapshot on first start and every
// night, moving all dates forward so the history always ends today.
//
// Left out on purpose: printers (the demo prints with the browser), the licence, the n8n settings and the
// print-bridge token, devices and sessions.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Pool } = require('pg');
const { TABLES } = require('../../server/sync');

const SKIP_TABLES = new Set(['printers']);
const SKIP_SETTINGS = /^(bridge_|n8n_|license_key$|trial_started$|bill_printer_id$|kitchen_printer_id$|demo_)/;

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const out = { exportedAt: new Date().toISOString(), tables: {} };
  for (const [tbl, pk] of TABLES) {
    if (SKIP_TABLES.has(tbl)) continue;
    const { rows } = await pool.query(`SELECT to_jsonb(t) AS r FROM ${tbl} t ORDER BY ${pk.map((c) => `t.${c}`).join(',')}`);
    let list = rows.map((x) => x.r);
    if (tbl === 'settings') list = list.filter((s) => !SKIP_SETTINGS.test(s.key));
    if (tbl === 'stations') list = list.map((s) => ({ ...s, printer_id: null }));
    out.tables[tbl] = list;
    console.log(`${tbl.padEnd(18)} ${list.length}`);
  }
  await pool.end();
  const file = path.join(__dirname, '..', '..', 'server', 'demo', 'demo-data.json.gz');
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(out), { level: 9 }));
  console.log(`\nSaved ${file} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
})().catch((e) => { console.error(e); process.exit(1); });

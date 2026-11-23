// Packages (Basic / Pro / Business) and the licence key that unlocks them.
//
// A licence key is   base64url(JSON payload) + "." + base64url(Ed25519 signature)
// signed with the vendor's private key (tools/license/issue.js) and checked here with the public key in
// server/license-public.pem. Without the private key nobody can make or change a key, so a client
// can't upgrade themselves by editing the database or the .env file.
//
// Payload: { v: 1, id, client, plan: 'basic'|'pro'|'business', expires: 'YYYY-MM-DD', issued,
//            devices?, staff? }   (devices / staff override the plan's limits for one client)
//
// No key: a free trial with every feature for TRIAL_DAYS from the first start.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TRIAL_DAYS = 14;
const GRACE_DAYS = 14; // after expiry everything still works for this long, with a red bar
const WARN_DAYS = 7;   // managers see a reminder this long before expiry

// What each package includes. `null` = no limit.
const FEATURES = {
  stock: 'Stock, recipes & suppliers',
  audit: 'Audit log',
  emails: 'Z-report & cash-variance emails',
  fullReports: 'Reports for any date range, with CSV export',
  offline: 'Shop PC backup (works when the internet drops)',
};
const PLANS = {
  basic: { name: 'Basic', devices: 2, staff: 5, features: [] },
  pro: { name: 'Pro', devices: 5, staff: 20, features: ['stock', 'audit', 'emails', 'fullReports'] },
  business: { name: 'Business', devices: null, staff: null, features: ['stock', 'audit', 'emails', 'fullReports', 'offline'] },
  trial: { name: 'Free trial', devices: 3, staff: null, features: ['stock', 'audit', 'emails', 'fullReports', 'offline'] },
};
// The smallest package that includes a feature (for "Available in Pro" messages)
const PLAN_FOR = Object.fromEntries(Object.keys(FEATURES).map((f) => [f, ['basic', 'pro', 'business'].find((p) => PLANS[p].features.includes(f))]));

let PUBLIC_KEY = null;
try { PUBLIC_KEY = crypto.createPublicKey(fs.readFileSync(path.join(__dirname, 'license-public.pem'))); } catch { /* no key yet: only the trial works */ }

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// Check a key's signature and shape. Returns the payload, or throws with a reason staff can read.
function verifyKey(key) {
  const k = String(key || '').trim().replace(/\s+/g, '');
  const [body, sig, extra] = k.split('.');
  if (!body || !sig || extra !== undefined) throw new Error('That is not a licence key. Copy the whole key you were sent.');
  if (!PUBLIC_KEY) throw new Error('This installation has no licence public key (server/license-public.pem). Run the key generator first.');
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(body), PUBLIC_KEY, Buffer.from(sig, 'base64url')); } catch { ok = false; }
  if (!ok) throw new Error('This licence key is not valid. It may have been changed or typed wrongly.');
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new Error('This licence key is damaged.'); }
  if (p.v !== 1 || !PLANS[p.plan] || p.plan === 'trial' || !/^\d{4}-\d{2}-\d{2}$/.test(p.expires || '')) throw new Error('This licence key is for a different version of the POS.');
  return p;
}

const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000); // a − b in whole days

module.exports = function createLicense({ pool, CONFIG, DEMO = false }) {
  let cache = { stamp: null, value: null };

  async function setting(key) { const { rows: [r] } = await pool.query('SELECT value FROM settings WHERE key=$1', [key]); return r ? r.value : null; }

  // The trial clock starts the first time the POS runs (kept in settings, so a shop PC copy shares it).
  async function ensureTrialStart() {
    await pool.query("INSERT INTO settings(key, value) VALUES ('trial_started', $1) ON CONFLICT (key) DO NOTHING", [today()]);
  }
  // A key in the LICENSE_KEY variable is copied into settings, so a shop PC standby gets it too.
  async function adoptEnvKey() {
    const k = (process.env.LICENSE_KEY || '').trim();
    if (!k) return;
    try { verifyKey(k); } catch (e) { console.error(`LICENSE_KEY: ${e.message}`); return; }
    await pool.query("INSERT INTO settings(key, value) VALUES ('license_key', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [k]);
  }

  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: CONFIG.timezone || 'Asia/Colombo' });

  // The licence as it applies today: plan, limits, features and state (active / warning / grace / expired).
  async function current() {
    if (DEMO) { // the public demo shows everything and never expires
      return { plan: 'business', planName: 'Business', client: 'Live demo', id: null, expires: '2099-12-31', daysLeft: 9999, state: 'active', problem: null, graceEnds: '2099-12-31',
        limits: { devices: null, staff: null }, features: Object.fromEntries(Object.keys(FEATURES).map((f) => [f, true])) };
    }
    const key = await setting('license_key');
    const started = await setting('trial_started');
    const stamp = `${today()}|${key}|${started}`;
    if (cache.stamp === stamp) return cache.value;
    let lic; let problem = null;
    if (key) {
      try { lic = verifyKey(key); } catch (e) { problem = e.message; }
    }
    let planId; let expires; let client = null; let id = null;
    if (lic) { planId = lic.plan; expires = lic.expires; client = lic.client || null; id = lic.id || null; } else {
      planId = 'trial';
      const s = started || today();
      expires = new Date(Date.parse(s) + TRIAL_DAYS * 86400000).toISOString().slice(0, 10);
    }
    const plan = PLANS[planId];
    const daysLeft = dayDiff(expires, today()); // 0 = last day
    const state = daysLeft >= 0 ? (daysLeft < WARN_DAYS ? 'warning' : 'active') : (-daysLeft <= GRACE_DAYS ? 'grace' : 'expired');
    const value = {
      plan: planId, planName: plan.name, client, id, expires, daysLeft, state, problem,
      graceEnds: new Date(Date.parse(expires) + GRACE_DAYS * 86400000).toISOString().slice(0, 10),
      limits: { devices: lic && lic.devices !== undefined ? lic.devices : plan.devices, staff: lic && lic.staff !== undefined ? lic.staff : plan.staff },
      features: Object.fromEntries(Object.keys(FEATURES).map((f) => [f, plan.features.includes(f)])),
    };
    cache = { stamp, value };
    return value;
  }
  const forget = () => { cache = { stamp: null, value: null }; };

  async function has(feature) { return (await current()).features[feature]; }

  function upgradeMessage(feature) {
    const p = PLANS[PLAN_FOR[feature]];
    return `${FEATURES[feature]}: available in the ${p.name} plan. Contact us on WhatsApp to upgrade.`;
  }

  return {
    PLANS, FEATURES, PLAN_FOR, GRACE_DAYS, verifyKey, current, has, forget, upgradeMessage, ensureTrialStart, adoptEnvKey, today,
    hasPublicKey: () => !!PUBLIC_KEY,
  };
};
module.exports.verifyKey = verifyKey;
module.exports.PLANS = PLANS;
module.exports.b64u = b64u;

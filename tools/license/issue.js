#!/usr/bin/env node
// Make a licence key for a client (on your own computer, where the private key is):
//
//   node tools/license/issue.js --client "Seaside Cafe, Trincomalee" --plan pro --months 12
//   node tools/license/issue.js --client "Hotel Blue" --plan business --until 2027-12-31
//   node tools/license/issue.js --client "Kade" --plan basic --months 1 --devices 3     (one extra device)
//
// Options:
//   --client   restaurant name, shown in Admin → Plan & licence           (required)
//   --plan     basic | pro | business                                     (required)
//   --months   licence length from today, or --until YYYY-MM-DD           (one of them required)
//   --devices  override the plan's device limit for this client (0 = no limit)
//   --staff    override the plan's staff limit for this client (0 = no limit)
//   --key      path to the private key (default: ~/virundhu-license-private.pem)
//
// The client pastes the key in Admin → Plan & licence, or you set it as LICENSE_KEY on Railway.
// Renewing or changing plan = issue a new key. Nothing in their data changes.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const fail = (m) => { console.error(m); process.exit(1); };

const client = (opt('client') || '').trim();
const plan = (opt('plan') || '').toLowerCase();
if (!client) fail('Give the restaurant name: --client "Name"');
if (!['basic', 'pro', 'business'].includes(plan)) fail('Plan must be basic, pro or business: --plan pro');

let expires = opt('until');
if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) fail('--until must look like 2027-12-31');
if (!expires) {
  const months = Number(opt('months'));
  if (!(months > 0 && months <= 60)) fail('Give the length: --months 12 (or --until 2027-12-31)');
  const d = new Date(); d.setMonth(d.getMonth() + months);
  expires = d.toISOString().slice(0, 10);
}

const payload = { v: 1, id: crypto.randomBytes(6).toString('hex'), client, plan, expires, issued: new Date().toISOString().slice(0, 10) };
for (const k of ['devices', 'staff']) {
  if (opt(k) !== null) {
    const n = Number(opt(k));
    if (!Number.isInteger(n) || n < 0 || n > 999) fail(`--${k} must be a whole number (0 = no limit)`);
    payload[k] = n === 0 ? null : n;
  }
}

const keyFile = opt('key') || path.join(os.homedir(), 'virundhu-license-private.pem');
let privateKey;
try { privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile)); } catch { fail(`Can't read the private key at ${keyFile}. Run tools/license/keygen.js first, or pass --key <file>.`); }

const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
const sig = crypto.sign(null, Buffer.from(body), privateKey).toString('base64url');
const key = `${body}.${sig}`;

console.log(`Client:  ${client}`);
console.log(`Plan:    ${plan}${payload.devices !== undefined ? ` · devices ${payload.devices ?? 'no limit'}` : ''}${payload.staff !== undefined ? ` · staff ${payload.staff ?? 'no limit'}` : ''}`);
console.log(`Expires: ${expires}   (licence id ${payload.id})`);
console.log('\nLicence key:\n');
console.log(key);

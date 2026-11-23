#!/usr/bin/env node
// Run ONCE, on your own computer:   node tools/license/keygen.js
//
// Makes your licence signing key pair:
//   - license-private.pem  → kept OUTSIDE the project (default: your home folder). Keep it secret and backed up.
//                            Anyone with this file can make licence keys. If you lose it, you can't make new keys
//                            for existing installations.
//   - server/license-public.pem → goes into the project and is deployed with the POS. It can only check keys.
//
// Options: --out <folder>   where to save the private key (default: your home folder)
//          --force          replace an existing key pair (old licence keys stop working!)
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const force = args.includes('--force');

const pubFile = path.join(__dirname, '..', '..', 'server', 'license-public.pem');
const privFile = path.join(opt('out') || os.homedir(), 'virundhu-license-private.pem');

if (!force && (fs.existsSync(pubFile) || fs.existsSync(privFile))) {
  console.error('A key pair already exists:');
  if (fs.existsSync(pubFile)) console.error(`  ${pubFile}`);
  if (fs.existsSync(privFile)) console.error(`  ${privFile}`);
  console.error('Replacing it makes every licence key you have issued invalid. Use --force only if you really mean that.');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(privFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }));

console.log('Done.');
console.log(`  Private key (keep secret, back it up): ${privFile}`);
console.log(`  Public key (deploy with the POS):     ${pubFile}`);
console.log('\nNext: deploy the POS so it includes server/license-public.pem, then issue keys with');
console.log('  node tools/license/issue.js --client "Restaurant name" --plan pro --months 12');

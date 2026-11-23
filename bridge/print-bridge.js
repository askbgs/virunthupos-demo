#!/usr/bin/env node
/*
 * Restaurant POS — print bridge (v2: prints the restaurant logo)
 * Runs on a PC in the restaurant, collects print jobs from the POS server and sends them to
 * ESC/POS thermal printers (Xprinter, Epson TM, Rongta, etc.). No npm install needed (Node 18+).
 *
 *   node print-bridge.js --server https://your-pos.up.railway.app --token YOUR_BRIDGE_TOKEN
 *
 * or set POS_SERVER and POS_BRIDGE_TOKEN as environment variables.
 *
 * Printer address formats (set in POS → Admin → Printers):
 *   Network (LAN/Wi-Fi printer):   192.168.1.50:9100
 *   Windows shared USB printer:    \\localhost\XP80      (share the printer in Windows, use the share name)
 *   Linux USB printer:             /dev/usb/lp0
 */
'use strict';
const net = require('net');
const fs = require('fs');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
  if (v.startsWith('--')) a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return a;
}, []));
const SERVER = String(args.server || process.env.POS_SERVER || '').replace(/\/+$/, '');
const TOKEN = String(args.token || process.env.POS_BRIDGE_TOKEN || '');
const RUN_AS_BRIDGE = require.main === module; // when required by the POS server, only the printing functions are used
if (RUN_AS_BRIDGE && (!SERVER || !TOKEN)) {
  console.error('Usage: node print-bridge.js --server https://your-pos.example.com --token BRIDGE_TOKEN');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ESC/POS rendering ----------
const ESC = 0x1b, GS = 0x1d;
const ASCII = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '·': '-', '›': '>', '‹': '<', '₹': 'Rs', '…': '...', '×': 'x', '•': '*', 'é': 'e', 'è': 'e', 'ü': 'u', '→': '->' };
const clean = (s) => String(s ?? '').replace(/[^\x20-\x7e]/g, (ch) => (ch in ASCII ? ASCII[ch] : '?'));

function wrap(text, width) {
  const out = [];
  for (const raw of clean(text).split('\n')) {
    // keep leading indentation (e.g. "    Spice: Hot"), wrap the rest
    const indent = raw.match(/^ */)[0].slice(0, Math.floor(width / 2));
    const para = raw.slice(indent.length);
    const w = width - indent.length;
    const start = out.length;
    let line = '';
    for (const word of para.split(' ')) {
      if (!line) line = word;
      else if ((line + ' ' + word).length <= w) line += ' ' + word;
      else { out.push(line); line = word; }
      while (line.length > w) { out.push(line.slice(0, w)); line = line.slice(w); }
    }
    out.push(line);
    for (let k = start; k < out.length; k++) out[k] = indent + out[k];
  }
  return out;
}

function render(doc, width) {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const str = (s) => { for (const ch of clean(s)) bytes.push(ch.charCodeAt(0)); };
  push(ESC, 0x40, ESC, 0x74, 0x00); // init, code page 437
  for (const l of doc) {
    const big = l.size === 2;
    const w = big ? Math.floor(width / 2) : width;
    push(ESC, 0x61, { center: 1, right: 2 }[l.align] || 0);
    push(ESC, 0x45, l.bold ? 1 : 0);
    push(GS, 0x21, big ? 0x11 : 0x00);
    if (l.t === 'text') {
      for (const line of wrap(l.s, w)) { str(line); push(0x0a); }
    } else if (l.t === 'row') {
      const left = clean(l.l), right = clean(l.r);
      if (left.length + right.length + 1 <= w) {
        str(left + ' '.repeat(w - left.length - right.length) + right); push(0x0a);
      } else {
        for (const line of wrap(left, w)) { str(line); push(0x0a); }
        str(' '.repeat(Math.max(0, w - right.length)) + right); push(0x0a);
      }
    } else if (l.t === 'image') {
      // 1-bit raster logo (GS v 0), sent in 64-row strips so small printer buffers don't overflow
      const bytesPerRow = l.w / 8;
      const bits = Buffer.from(l.data, 'base64');
      for (let y = 0; y < l.h; y += 64) {
        const rows = Math.min(64, l.h - y);
        push(GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff);
        const chunk = bits.subarray(y * bytesPerRow, (y + rows) * bytesPerRow);
        for (const b of chunk) bytes.push(b);
      }
      push(0x0a);
    } else if (l.t === 'hr') {
      str('-'.repeat(width)); push(0x0a);
    } else if (l.t === 'feed') {
      push(ESC, 0x64, Math.min(10, l.n || 1));
    } else if (l.t === 'cut') {
      push(GS, 0x56, 0x42, 0x00);
    }
  }
  push(ESC, 0x45, 0, GS, 0x21, 0, ESC, 0x61, 0);
  return Buffer.from(bytes);
}

// ---------- sending ----------
function sendNetwork(address, data) {
  const [host, port] = [address.slice(0, address.lastIndexOf(':')), Number(address.split(':').pop()) || 9100];
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const fail = (e) => { sock.destroy(); reject(e); };
    sock.setTimeout(8000, () => fail(new Error(`Printer ${address} did not respond`)));
    sock.on('error', fail);
    sock.on('connect', () => sock.end(data));
    sock.on('close', (hadError) => { if (!hadError) resolve(); });
  });
}
const sendShare = (address, data) => fs.promises.writeFile(address, data);

async function api(path, opts = {}) {
  const res = await fetch(SERVER + path, {
    ...opts,
    headers: { 'x-bridge-token': TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) throw Object.assign(new Error('Bridge token rejected. Copy the token again from Admin → Printers.'), { fatal: true });
  if (!res.ok) throw new Error(`Server replied ${res.status}`);
  return res.json();
}

async function handle(job) {
  try {
    const data = render(job.doc, job.width_chars || 48);
    if (job.conn === 'network') await sendNetwork(job.address, data);
    else await sendShare(job.address, data);
    await api(`/bridge/jobs/${job.id}`, { method: 'POST', body: JSON.stringify({ ok: true }) });
    log(`printed  #${job.id}  ${job.title}  → ${job.printer_name}`);
  } catch (e) {
    log(`FAILED   #${job.id}  ${job.title}  → ${job.printer_name}: ${e.message}`);
    await api(`/bridge/jobs/${job.id}`, { method: 'POST', body: JSON.stringify({ ok: false, error: e.message }) }).catch(() => {});
  }
}

if (RUN_AS_BRIDGE) (async function main() {
  log(`Print bridge connected to ${SERVER}. Waiting for jobs… (Ctrl+C to stop)`);
  let backoff = 1000;
  for (;;) {
    try {
      const { jobs } = await api('/bridge/jobs?wait=25');
      backoff = 1000;
      // one printer at a time keeps tickets in order; different printers run in parallel
      const byPrinter = new Map();
      for (const j of jobs) {
        const key = `${j.conn}|${j.address}`;
        if (!byPrinter.has(key)) byPrinter.set(key, []);
        byPrinter.get(key).push(j);
      }
      await Promise.all([...byPrinter.values()].map(async (list) => { for (const j of list) await handle(j); }));
    } catch (e) {
      log(e.message);
      if (e.fatal) process.exit(1);
      await sleep(backoff);
      backoff = Math.min(30000, backoff * 2);
    }
  }
})();

module.exports = { render, sendNetwork, sendShare };

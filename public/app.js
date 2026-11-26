/* Restaurant POS — single-page client (no build step). */
(() => {
  'use strict';

  // ---------- state ----------
  const S = {
    user: null, cfg: null, menu: null, floor: null,
    tab: 'floor', order: null,
    areaFilter: 'all', cat: null, search: '',
    kitchen: null, station: 'all',
    history: null, histFilter: 'all', histSel: null, histOrder: null,
    admin: { section: 'items', data: null, sel: null, cat: 'all', q: '', printing: null, audit: null, auditFilter: '' },
    shift: null, shifts: [], shiftSel: null, shiftDetail: null,
    rep: { preset: 'today', from: '', to: '', data: null },
    inv: { section: 'stock', data: null, recipes: null, purchases: null, reorder: null, sel: null, filter: 'all', rfilter: 'all', q: '', moves: null, supDetail: null, purDetail: null },
    payMethod: 'card', payCard: { brand: '', last4: '', auth: '' }, cashIn: '', modal: null, live: false,
  };
  const COURSES = ['drink', 'starter', 'main', 'dessert'];
  const COURSE_LABEL = { drink: 'Drink', starter: 'Starter', main: 'Main', dessert: 'Dessert' };
  const TYPE_LABEL = { dinein: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery', counter: 'Counter' };
  const STATUS_LABEL = { free: 'Free', ordering: 'Ordering', kitchen: 'In kitchen', ready: 'Food ready', dining: 'Dining', billed: 'Bill printed', paid: 'Paid', void: 'Void' };
  const KOT_LABEL = { held: 'On hold', new: 'Sent', cooking: 'Cooking', ready: 'Ready', served: 'Served' };
  const SPICE = [['Standard', 'As listed'], ['Mild', '●'], ['Medium', '●●'], ['Hot', '●●●'], ['Thai hot', '●●●●']];

  const $ = (sel, root = document) => root.querySelector(sel);
  const root = $('#root');
  const modalEl = $('#modal');

  // ---------- utils ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => (S.cfg?.currency ?? '') + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const clock = (d) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: S.cfg?.timezone });
  const mins = (d) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 60000));
  const pct = (f) => `${+(f * 100).toFixed(3)}%`;
  const orderTitle = (o) => (o.type === 'dinein' ? `Table ${o.table_code}` : `${TYPE_LABEL[o.type]} #${o.order_no}`);
  const CARD_BRANDS = ['Visa', 'Mastercard', 'Amex', 'UnionPay', 'JCB', 'Other'];
  const isPending = (i) => !i.kot_id && !i.served_direct;
  const lineTotal = (i) => (i.qty - (i.void_qty || 0)) * (i.unit_price_cents + i.addons_cents);
  // Add-on quantity per dish (older lines have none = 1) and its wording: "Boiled egg x2 pieces"
  const aq = (a) => a.qty || 1;
  const unitWord = (u, n) => (n === 1 || /s$/i.test(u) ? u : u + 's');
  const addonLabel = (a, n) => (n === 1 ? a.name : `${a.name} x${n}${a.unit ? ' ' + unitWord(a.unit, n) : ''}`);

  function toast(msg, err) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method: opts.method || (opts.body ? 'POST' : 'GET'),
        headers: opts.body ? { 'Content-Type': 'application/json' } : {},
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        credentials: 'same-origin',
      });
    } catch { netState(false); throw new Error('No connection. Check the internet.'); }
    netState(true);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') { S.user = null; renderLogin(); throw new Error('Signed out'); }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  const run = (fn) => (...a) => Promise.resolve(fn(...a)).catch((e) => { if (e.message !== 'Signed out') toast(e.message, true); });

  // ---------- data loading ----------
  async function loadFloor() {
    [S.floor, S.shift] = await Promise.all([api('/floor'), api('/shift'), loadSync()]);
  }
  async function loadSync() { if (S.cfg?.mode && S.cfg.mode !== 'standalone') S.sync = await api('/sync/status').catch(() => S.sync); }
  // shifts opened on the shop PC during an outage have ids from 1,000,000,001: show them as "offline #1"
  const shiftNo = (id) => (id > 1000000000 ? `offline #${id - 1000000000}` : `#${id}`);
  const ago = (t) => {
    if (!t) return 'never';
    const s0 = Math.max(0, Math.round((Date.now() - new Date(t)) / 1000));
    return s0 < 60 ? 'just now' : s0 < 3600 ? `${Math.floor(s0 / 60)} min ago` : s0 < 86400 ? `${Math.floor(s0 / 3600)} h ago` : `${Math.floor(s0 / 86400)} days ago`;
  };
  // Shop server: is the cloud copy up to date? Cloud copy: when did the shop last send changes?
  function syncPill() {
    const y = S.sync; if (!y) return '';
    if (y.mode === 'local') {
      if (!y.configured) return '<span class="sync-pill" title="No cloud copy configured">Shop server</span>';
      if (y.online === false) return `<span class="sync-pill off" title="No internet. The POS keeps working normally; ${y.pending} change(s) will upload to the cloud copy when the internet is back.">Offline${y.pending ? ` · ${y.pending} to sync` : ''}</span>`;
      if (y.snapshot || !y.snapshot_done) return '<span class="sync-pill busy">Copying to cloud…</span>';
      return `<span class="sync-pill ok" title="Cloud copy updated ${ago(y.last_ok_at)}">${y.pending ? `Syncing ${y.pending}…` : 'Cloud synced'}</span>`;
    }
    if (y.mode === 'mirror') return `<span class="sync-pill" title="Cloud copy. Changes from the shop arrive automatically.">Updated ${ago(y.last_ingest_at)}</span>`;
    if (y.mode === 'standby') {
      if (!y.configured) return '<span class="sync-pill" title="No cloud address set">Shop PC</span>';
      if (!y.ready) return '<span class="sync-pill busy">Downloading…</span>';
      if (y.online === false) return `<span class="sync-pill off" title="No internet. Keep working; changes upload when it's back.">Offline${y.pending ? ` · ${y.pending} to upload` : ''}</span>`;
      return `<span class="sync-pill ${y.pending ? 'busy' : 'ok'}">${y.pending ? `Uploading ${y.pending}…` : 'Up to date'}</span>`;
    }
    if (y.mode === 'cloud') {
      const fresh = y.shop_seen_at && Date.now() - new Date(y.shop_seen_at) < 120000;
      return `<span class="sync-pill ${fresh ? 'ok' : ''}" title="The shop PC keeps a copy of this POS for when the internet drops.">${y.shop_seen_at ? `Shop PC ${fresh ? 'in sync' : `seen ${ago(y.shop_seen_at)}`}` : 'Shop PC not connected'}</span>`;
    }
    return '';
  }

  // ---------- packages (Basic / Pro / Business) ----------
  const LIC = () => S.cfg?.license || {};
  const can = (f) => !LIC().features || LIC().features[f] !== false;
  const FEAT = {
    stock: ['Stock, recipes & suppliers', 'Pro', 'Track ingredients, recipe cost and food cost %, suppliers, deliveries and reorder lists. Stock comes off automatically when a bill is paid.'],
    audit: ['Audit log', 'Pro', 'A permanent record of every void, refund, discount, reprint, cash movement and admin change, with who did it and who approved it.'],
    emails: ['Email reports', 'Pro', 'The Z-report emailed to the owner when a shift closes, and an alert when the cash drawer is over or short.'],
    fullReports: ['Full reports', 'Pro', 'Reports for any date range (30 days, months, a year) and CSV export for Excel.'],
    offline: ['Shop PC backup', 'Business', 'A PC in the restaurant keeps working when the internet drops, and uploads everything when it is back.'],
  };
  const waLink = (text) => `https://wa.me/${S.cfg.vendorWhatsapp || ''}?text=${encodeURIComponent(text)}`;
  const upgradeText = (plan) => `Hello, I'd like to ${plan ? `upgrade ${S.cfg.restaurant || 'our restaurant'} to the ${plan} plan` : `renew the POS licence for ${S.cfg.restaurant || 'our restaurant'}`}${LIC().client ? ` (licence: ${LIC().client})` : ''}.`;
  const lockTag = (f) => (can(f) ? '' : `<span class="plan-tag" title="${esc(FEAT[f][1])} plan">${esc(FEAT[f][1])}</span>`);
  function upgradeView(f, wrap = true) {
    const [name, plan, text] = FEAT[f];
    const card = `<div class="upgrade-card"><div class="eyebrow">${esc(plan)} plan</div><h2>${esc(name)}</h2><p>${esc(text)}</p>
      <p class="muted">Your plan: <b>${esc(LIC().planName || '')}</b>. Upgrading keeps all your data.</p>
      <a class="btn red" href="${esc(waLink(upgradeText(plan)))}" target="_blank" rel="noopener">Upgrade on WhatsApp</a>
      ${isManager() ? '<button type="button" class="btn" data-act="go-plan">See plans</button>' : ''}</div>`;
    return wrap ? `<section class="upgrade-wrap scroll">${card}</section>` : card;
  }
  function askUpgrade(f) {
    const [name, plan] = FEAT[f];
    S.modal = { kind: 'confirm', eyebrow: `${plan} plan`, title: name, text: `${FEAT[f][2]} This is part of the ${plan} plan. Your plan: ${LIC().planName}.`,
      yes: 'Upgrade on WhatsApp', run: () => { window.open(waLink(upgradeText(plan)), '_blank', 'noopener'); S.modal = null; renderModal(); } };
    renderModal();
  }
  // Reminder before expiry (managers), and the hard stop after the grace period (everyone)
  function licenceBar() {
    const L = LIC(); if (!L.state || !S.user) return '';
    const mgr = isManager(); const trial = L.plan === 'trial';
    const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
    const btn = (t) => `<a class="bar-btn" href="${esc(waLink(upgradeText(trial ? 'Pro' : null)))}" target="_blank" rel="noopener">${t}</a>`;
    let cls = ''; let txt = '';
    const choose = btn(trial ? 'Choose a plan' : 'Renew on WhatsApp');
    let act = '';
    if (L.problem && mgr) { cls = 'off'; txt = `<b>Licence key problem:</b> ${esc(L.problem)} Running as ${esc(L.planName)}.`; }
    else if (L.state === 'expired') { cls = 'off'; txt = `<b>The ${trial ? 'free trial' : 'licence'} ended on ${esc(L.expires)}.</b> New orders can't be started. Open orders can still be finished and printed.${mgr ? '' : ' Please tell a manager.'}`; act = mgr ? choose : ''; }
    else if (!mgr) return '';
    else if (L.state === 'grace') { cls = 'off'; txt = `<b>The ${trial ? 'free trial' : `${esc(L.planName)} licence`} ended on ${esc(L.expires)}.</b> Everything keeps working until ${esc(L.graceEnds)}.`; act = choose; }
    else if (L.state === 'warning') { cls = 'busy'; txt = `<b>${trial ? 'Free trial' : `${esc(L.planName)} plan`}: ${L.daysLeft === 0 ? 'last day today' : `${days(L.daysLeft)} left`}</b> (until ${esc(L.expires)}).`; act = choose; }
    else if (trial) { txt = `<b>Free trial</b> with every feature included: ${days(L.daysLeft)} left.`; act = '<button type="button" class="bar-btn" data-act="go-plan">See plans</button>'; }
    else return '';
    return `<div class="standby-bar licence-bar ${cls}" role="status"><span>${txt}</span>${act}</div>`;
  }
  const deviceId = () => {
    try {
      let id = localStorage.getItem('posDevice');
      if (!id) { id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('posDevice', id); }
      return id;
    } catch { return ''; }
  };
  const deviceName = () => {
    const u = navigator.userAgent;
    const kind = /iPad/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1) ? 'iPad' : /iPhone/.test(u) ? 'iPhone'
      : /Android/.test(u) ? (/Mobile/.test(u) ? 'Android phone' : 'Android tablet') : /Windows/.test(u) ? 'Windows PC' : /Mac/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux PC' : 'Device';
    const br = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : '';
    return `${kind}${br ? ` · ${br}` : ''}`;
  };

  function demoBar() {
    const D = S.cfg?.demo; if (!D) return '';
    const h = D.resetHour; const at = `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
    return `<div class="standby-bar demo-bar" role="status"><span><b>Live demo.</b> Try anything: take orders, send KOTs, print bills, close a shift. It all resets every night at ${at}.</span>
      <button type="button" class="bar-btn ghost" data-act="demo-reset">Reset demo</button><a class="bar-btn" href="${esc(D.trialUrl)}" target="_blank" rel="noopener">Start your free trial</a></div>`;
  }

  // ---------- Admin → Plan & licence ----------
  async function loadPlan() { S.admin.plan = await api('/admin/license'); }
  function planView() {
    const P = S.admin.plan; if (!P) return '<div class="empty">Loading…</div>';
    const L = P.license; const lim = L.limits; const trial = L.plan === 'trial';
    const stateChip = { active: ['ok', 'Active'], warning: ['busy', 'Ends soon'], grace: ['off', 'Ended · grace period'], expired: ['off', 'Ended'] }[L.state];
    const meter = (used, max) => (max == null ? `<b>${used}</b> <span class="muted">· no limit</span>`
      : `<b>${used} of ${max}</b><div class="meter ${used >= max ? 'full' : ''}"><i style="width:${Math.min(100, Math.round((used / max) * 100))}%"></i></div>`);
    const plans = ['basic', 'pro', 'business'];
    const rows = [['Devices signed in', (p) => (P.plans[p].devices == null ? 'No limit' : P.plans[p].devices)], ['Active staff', (p) => (P.plans[p].staff == null ? 'No limit' : P.plans[p].staff)],
      ...Object.keys(P.features).map((f) => [P.features[f], (p) => (P.plans[p].features.includes(f) ? '✓' : '–')])];
    const mine = deviceId();
    return `<div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Admin</div><h1 class="title">Plan &amp; licence</h1>
        <div class="muted">Your package, what it includes, and the devices using this POS.</div></div>
        <a class="btn red" href="${esc(waLink(upgradeText(L.plan === 'business' ? null : L.plan === 'pro' ? 'Business' : 'Pro')))}" target="_blank" rel="noopener">${L.plan === 'business' ? 'Renew on WhatsApp' : 'Upgrade on WhatsApp'}</a></div>
      <div class="plan-grid">
        <div class="plan-card"><div class="eyebrow">Your plan</div><div class="plan-name">${esc(L.planName)}</div>
          <div><span class="state-chip ${stateChip[0]}">${stateChip[1]}</span></div>
          ${L.client ? `<div class="kv"><span>Licensed to</span><b>${esc(L.client)}</b></div>` : ''}
          <div class="kv"><span>${L.daysLeft >= 0 ? 'Valid until' : 'Ended on'}</span><b>${esc(L.expires)}</b></div>
          <div class="kv"><span>${L.daysLeft >= 0 ? 'Days left' : 'Works until'}</span><b>${L.daysLeft >= 0 ? L.daysLeft : esc(L.graceEnds)}</b></div>
          ${L.problem ? `<div class="note-red" style="margin-top:10px">${esc(L.problem)}</div>` : ''}
        </div>
        <div class="plan-card"><div class="eyebrow">Usage</div>
          <div class="kv col"><span>Devices signed in (last 30 days)</span>${meter(P.usage.devices, lim.devices)}</div>
          <div class="kv col"><span>Active staff</span>${meter(P.usage.staff, lim.staff)}</div>
        </div>
      </div>
      <h3 class="plan-h">Compare plans</h3>
      <div class="htable-wrap"><table class="htable plan-table"><thead><tr><th></th>${plans.map((p) => `<th class="${L.plan === p ? 'cur' : ''}">${esc(P.plans[p].name)}${L.plan === p ? ' · yours' : ''}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(([label, f]) => `<tr><td class="name">${esc(label)}</td>${plans.map((p) => `<td class="${L.plan === p ? 'cur' : ''}">${f(p)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${trial ? '<p class="muted" style="margin:8px 20px 0">The free trial includes everything, on up to 3 devices.</p>' : ''}
      <h3 class="plan-h">Devices</h3>
      <div class="htable-wrap"><table class="htable"><thead><tr><th>Device</th><th>Last used</th><th>By</th><th></th></tr></thead><tbody>
        ${P.devices.length ? P.devices.map((d) => `<tr><td class="name">${esc(d.name || 'Device')}${d.id === mine ? ' <span class="plan-tag">this device</span>' : ''}${d.active ? '' : ' <span class="muted">· not counted</span>'}</td>
          <td>${esc(ago(d.last_seen))}</td><td>${esc(d.last_staff_name || '')}</td>
          <td style="text-align:right">${d.id === mine ? '' : `<button type="button" class="btn sm" data-act="device-remove" data-id="${esc(d.id)}">Remove</button>`}</td></tr>`).join('')
          : '<tr><td colspan="4" class="muted">No devices yet.</td></tr>'}</tbody></table></div>
      <p class="muted" style="margin:8px 20px 0">Removing a device signs it out. It can sign in again while the plan has room. Devices unused for 30 days stop counting by themselves.</p>
      <h3 class="plan-h">Licence key</h3>
      <div style="padding:0 20px 28px">
        ${!P.hasPublicKey ? '<div class="note-red" style="margin-bottom:10px">This installation has no licence public key yet, so keys can\'t be checked. (Vendor: run the key generator and redeploy.)</div>' : ''}
        ${P.keyFromEnv ? '<div class="muted">The licence key is set on the server (LICENSE_KEY). To change plan, the key is replaced there.</div>'
          : `<form id="license-form"><textarea name="key" rows="3" placeholder="Paste the licence key you received on WhatsApp" spellcheck="false" autocomplete="off" required></textarea>
            <button type="submit" class="btn dark" style="margin-top:8px">Save licence key</button></form>`}
      </div>`;
  }

  // Shop PC (standby): what staff should do right now
  function standbyBar() {
    if (S.cfg?.mode !== 'standby') return '';
    const y = S.sync || {}; const n = y.pending || 0; const ch = `${n} change${n === 1 ? '' : 's'}`;
    let cls = ''; let txt;
    if (!y.configured) txt = '<b>Shop PC.</b> No cloud address is set (CLOUD_URL, SYNC_TOKEN).';
    else if (!y.ready) { cls = 'busy'; txt = `<b>The shop PC is getting ready.</b> ${esc(y.snapshot || 'Downloading from the cloud…')} Don't take orders here until it finishes.`; }
    else if (y.online === false) { cls = 'off'; txt = `<b>Offline mode: you're on the shop PC.</b> Keep working as normal. ${n ? `${ch} will upload` : 'Everything you do uploads'} to the cloud when the internet is back.`; }
    else if (y.online && y.last_error) { cls = 'off'; txt = `<b>Upload problem.</b> ${esc(y.last_error)}`; }
    else if (y.online && n) { cls = 'busy'; txt = `<b>Internet is back.</b> Uploading ${ch} to the cloud…`; }
    else if (y.online && y.current) { cls = 'ok'; txt = '<b>Internet is back and everything is uploaded.</b> <a class="bar-btn" href="/start">Switch to the cloud POS</a>'; }
    else txt = '<b>Shop PC.</b> Checking the cloud…';
    return `<div id="standby-bar" class="standby-bar ${cls}" role="status">${txt}</div>`;
  }

  // Cloud POS: when the connection drops, offer the shop PC (its /start address is remembered from the last visit)
  let netTimer = null;
  function netState(ok) {
    if (S.cfg?.mode !== 'cloud') return;
    if (ok) { clearTimeout(netTimer); netTimer = null; $('#net-bar')?.remove(); return; }
    if (netTimer || $('#net-bar')) return;
    netTimer = setTimeout(() => { netTimer = null; showNetBar(); }, 5000);
  }
  function showNetBar() {
    let shop = null; try { shop = localStorage.getItem('posShopUrl'); } catch { /* private mode */ }
    const el = document.createElement('div'); el.id = 'net-bar'; el.setAttribute('role', 'alert');
    el.innerHTML = `<div><b>No connection to the cloud POS.</b> ${shop ? 'Carry on with the POS on the shop PC. Everything uploads to the cloud when the internet is back.'
      : 'Open the POS on the shop PC (its address ends in <b>:3000/start</b>) and carry on there.'}</div>${shop ? `<a class="bar-btn" href="${esc(shop)}">Switch to the shop PC</a>` : ''}`;
    document.body.appendChild(el);
  }
  (() => {
    const shop = new URLSearchParams(location.search).get('shop');
    if (shop && /^https?:\/\/[^\s"'<>]+$/.test(shop)) { try { localStorage.setItem('posShopUrl', shop); } catch { /* ignore */ } }
    if (shop) history.replaceState(null, '', location.pathname);
  })();
  async function checkCloud() {
    if (S.cfg?.mode !== 'cloud') return;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    try { const r = await fetch('/healthz', { cache: 'no-store', signal: ctl.signal }); netState(r.ok); } catch { netState(false); } finally { clearTimeout(t); }
  }
  setInterval(checkCloud, 4000);
  window.addEventListener('offline', () => netState(false));
  async function loadOrder(id) { S.order = await api('/orders/' + (id || S.order.id)); if (S.order.payment_method) S.payMethod = S.order.payment_method; }
  async function loadKitchen() { S.kitchen = await api('/kitchen'); S.kitchen.fetchedAt = Date.now(); }
  async function loadHistory() {
    S.history = await api('/history');
    if (S.histSel) S.histOrder = await api('/orders/' + S.histSel).catch(() => null);
  }

  async function refresh() {
    const jobs = [loadFloor()];
    if (S.order && (S.tab === 'order' || S.tab === 'bill')) {
      jobs.push(loadOrder().then(() => { if (S.order.status !== 'open') { S.order = null; } }).catch(() => { S.order = null; }));
    }
    if (S.tab === 'kitchen') jobs.push(loadKitchen());
    if (S.tab === 'history') jobs.push(loadHistory());
    await Promise.all(jobs);
    if (S.tab === 'shift') await loadShift();
    if (['admin', 'reports', 'stock'].includes(S.tab)) { const h = $('header.topbar'); if (h) h.outerHTML = header(); return; }
    render();
  }

  let refreshTimer;
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(run(refresh), 250); }

  function connectEvents() {
    const es = new EventSource('/api/events');
    es.onopen = () => { S.live = true; updateLiveDot(); netState(true); };
    es.onmessage = (e) => {
      if (e.data === 'menu' || e.data === 'stock') api('/menu').then((m) => { S.menu = m; if (S.tab === 'order' && $('#dish-area')) $('#dish-area').innerHTML = dishAreaHtml(); }).catch(() => {});
      if (e.data === 'settings') fetch('/api/config').then((x) => x.json()).then((c) => { S.cfg = c; document.title = `${c.restaurant} · POS`; scheduleRefresh(); }).catch(() => {});
      scheduleRefresh();
    };
    es.onerror = () => { S.live = false; updateLiveDot(); netState(false); };
  }
  function updateLiveDot() { const d = $('.live-dot'); if (d) d.classList.toggle('off', !S.live); }

  // ---------- login ----------
  let pin = '';
  function renderLogin(err = '') {
    modalEl.innerHTML = '';
    const box = `
        <div class="hd">${S.cfg?.logo ? `<img class="login-logo" src="${esc(S.cfg.logo)}" alt="">` : ''}<div class="eyebrow">${esc(S.cfg?.terminal || '')}</div><h1>${esc(S.cfg?.restaurant || 'POS')}</h1>
          <div class="muted" style="margin-top:4px">Enter your staff PIN</div></div>
        <div class="pin-dots">${[0, 1, 2, 3].map((i) => `<i class="${i < pin.length ? 'f' : ''}"></i>`).join('')}${pin.length > 4 ? `<span>+${pin.length - 4}</span>` : ''}</div>
        <div class="login-err">${esc(err)}</div>
        <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-act="pin" data-k="${n}">${n}</button>`).join('')}
          <button type="button" data-act="pin" data-k="back">⌫</button><button type="button" data-act="pin" data-k="0">0</button>
          <button type="button" data-act="pin" data-k="ok" style="background:var(--red);color:#fff">→</button></div>
        ${S.cfg?.demo ? `<div class="demo-pins"><div class="eyebrow">Live demo · tap to sign in</div>${S.cfg.demo.pins.map((p) => `<button type="button" data-act="demo-login" data-pin="${esc(p.pin)}"><b>${esc(p.role)}</b><span>PIN ${esc(p.pin)} · ${esc(p.what)}</span></button>`).join('')}</div>` : ''}`;
    // keep the background (and its fade-in) in place while typing; only the PIN box redraws
    const existing = root.querySelector('.login .login-box');
    if (existing) { existing.innerHTML = box; return; }
    const bg = S.cfg?.loginBg || '/img/login-bg.jpg';
    root.innerHTML = `
      <div class="login">
        <div class="login-bg" style="background-image:url('${esc(bg)}')"></div>
        <div class="login-fade"></div>
        <div class="login-box">${box}</div>
      </div>`;
    // start the fade once the photo has loaded, so it never pops in half-drawn
    const im = new Image();
    im.onload = im.onerror = () => root.querySelector('.login-bg')?.classList.add('loaded');
    im.src = bg;
  }
  async function pinKey(k) {
    if (k === 'back') pin = pin.slice(0, -1);
    else if (k === 'ok') {
      if (pin.length < 4) return renderLogin('PIN is at least 4 digits');
      try {
        S.user = await api('/login', { body: { pin, device: deviceId(), deviceName: deviceName() } });
        S.booted = false; // start on this person's home screen
        pin = '';
        return boot();
      } catch (e) { pin = ''; return renderLogin(e.message); }
    } else if (pin.length < 8) pin += k;
    renderLogin();
  }

  // ---------- header ----------
  function header() {
    const f = S.floor?.stats || {};
    const o = S.order;
    const tab = (id, title, sub, disabled) => `
      <button type="button" class="tab ${S.tab === id ? 'active' : ''}" data-act="tab" data-tab="${id}" ${disabled ? 'disabled' : ''}>
        <b>${title}</b><small>${esc(sub)}</small></button>`;
    return `
      <header class="topbar">
        <div class="brand">${S.cfg.logo ? `<div class="logo has-img"><img src="${esc(S.cfg.logo)}" alt=""></div>` : `<div class="logo">${esc((S.cfg.restaurant.match(/\b\w/g) || ['P']).slice(0, 2).join('').toUpperCase())}</div>`}
          <div><b>${esc(S.cfg.restaurant)}</b><small>${esc(S.cfg.terminal)}</small></div></div>
        <nav class="tabs">
          ${tab('floor', 'Floor', `${f.seated ?? 0}/${f.tables ?? 0} tables`)}
          ${S.cfg.mode === 'mirror' ? '' : tab('order', 'Order', o ? orderTitle(o) : 'New order')}
          ${tab('kitchen', 'Kitchen', `${f.live_tickets ?? 0} live tickets`)}
          ${S.cfg.mode === 'mirror' ? '' : tab('bill', 'Bill', o ? money(o.total_cents) : 'No order', !o)}
          ${tab('history', 'History', `${f.closed_today ?? 0} closed`)}
          ${tab('shift', 'Shift', S.shift?.shift ? `${shiftNo(S.shift.shift.id)} open` : 'Not open')}
          ${isManager() ? tab('stock', 'Stock', !can('stock') ? 'Pro plan' : f.stock_alerts ? `${f.stock_alerts} to reorder` : 'Ingredients') : ''}
          ${isManager() ? tab('reports', 'Reports', 'Sales') : ''}
          ${isManager() ? tab('admin', 'Admin', 'Menu & staff') : ''}
        </nav>
        <div class="top-right">
          <span id="sync-pill">${syncPill()}</span>
          <span class="live-dot ${S.live ? '' : 'off'}" title="Live updates"></span>
          <span class="clock" id="clock">${clock(Date.now())}</span>
          <button type="button" class="avatar" data-act="logout" title="${esc(S.user.name)} · ${esc(S.user.role)}">${esc(S.user.initials)}</button>
        </div>
      </header>`;
  }

  // ---------- floor ----------
  function floorView() {
    const F = S.floor;
    const areas = F.areas.filter((a) => S.areaFilter === 'all' || String(a.id) === S.areaFilter);
    const tableCard = (t) => {
      const o = t.order;
      return `<button type="button" class="tcard ${t.status}" data-act="table" data-id="${t.id}">
        <div class="row1"><span class="code">${esc(t.code)}</span><span class="seats">${t.seats} seats</span></div>
        <span class="st">${STATUS_LABEL[t.status]}</span>
        ${o ? `<div class="meta"><span>${o.guests} guest${o.guests > 1 ? 's' : ''}</span><span>${mins(o.opened_at)} min</span></div>
               <div class="amt">${money(o.total_cents)}</div>` : ''}
      </button>`;
    };
    return `
      <section class="floor">
        <div class="floor-main scroll">
          ${shiftBanner()}
          <div class="page-head">
            <div><div class="eyebrow">Dine-in</div><h1 class="title">Floor</h1>
              <div class="muted">${F.stats.seated} of ${F.stats.tables} tables seated · ${F.stats.covers} covers · ${F.stats.live_tickets} tickets in the kitchen</div></div>
            <div class="seg">
              <button type="button" class="${S.areaFilter === 'all' ? 'on' : ''}" data-act="area" data-id="all">All</button>
              ${F.areas.map((a) => `<button type="button" class="${S.areaFilter === String(a.id) ? 'on' : ''}" data-act="area" data-id="${a.id}">${esc(a.short)}</button>`).join('')}
            </div>
          </div>
          <div class="legend">
            ${['free', 'ordering', 'kitchen', 'ready', 'dining', 'billed'].map((s) => `<span><i class="sw ${s}"></i>${STATUS_LABEL[s]}</span>`).join('')}
          </div>
          ${areas.map((a) => `
            <div class="area"><h3>${esc(a.name)}<small>${a.tables.filter((t) => t.order).length} of ${a.tables.length} occupied</small></h3>
              <div class="grid4">${a.tables.map(tableCard).join('')}</div></div>`).join('')}
          <div style="height:28px"></div>
        </div>
        ${queuePanel()}
      </section>`;
  }

  function queuePanel() {
    const q = S.floor.queue;
    return `
      <aside class="queue">
        <div class="queue-head"><div class="eyebrow">Off-floor</div><h2>Order queue</h2></div>
        <div class="qnew">
          ${['takeaway', 'delivery', 'counter'].map((t) => `<button type="button" data-act="new-order" data-type="${t}"><small>+ New</small><b>${TYPE_LABEL[t]}</b></button>`).join('')}
        </div>
        <div class="scroll" style="flex:1">
          ${q.length ? q.map((o) => `
            <button type="button" class="qitem" data-act="open-order" data-id="${o.id}">
              <div><div><span class="tag">${TYPE_LABEL[o.type]}</span><b>#${o.order_no}</b></div>
                <div style="margin-top:4px">${esc(o.customer_name || 'Walk-in')}</div>
                <div class="s ${o.status}">${STATUS_LABEL[o.status]}</div></div>
              <div style="text-align:right"><b>${money(o.total_cents)}</b><div class="muted" style="margin-top:4px">${mins(o.opened_at)} min</div></div>
            </button>`).join('') : '<div class="empty">No takeaway, delivery or counter orders open.</div>'}
        </div>
      </aside>`;
  }

  // ---------- order ----------
  function startView() {
    const cards = [
      ['dinein', 'Pick a table on the floor plan.'],
      ['takeaway', 'Customer collects. Name and phone on the ticket.'],
      ['delivery', 'Address prints on the expo ticket.'],
      ['counter', 'Quick sale. Sends the KOT and goes straight to payment.'],
    ];
    return `<section class="start scroll">${shiftBanner()}<div class="eyebrow">New order</div><h1 class="title">Start an order</h1>
      <div class="start-grid">${cards.map(([t, d]) => `<button type="button" data-act="new-order" data-type="${t}"><b>${TYPE_LABEL[t]}</b><span>${d}</span></button>`).join('')}</div></section>`;
  }

  function dishAreaHtml() {
    const cats = S.menu.categories;
    let title, items, sub;
    const q = S.search.trim().toLowerCase();
    if (q) {
      items = cats.flatMap((c) => c.items).filter((i) => i.name.toLowerCase().includes(q));
      title = `Results for “${esc(S.search.trim())}”`; sub = `${items.length} dishes`;
    } else {
      const c = cats.find((x) => x.id === S.cat) || cats[0];
      items = c.items; title = esc(c.name);
      sub = `${items.length} dishes · fires as ${COURSE_LABEL[c.default_course].toLowerCase()}`;
    }
    return `<h3>${title}<small>${sub}</small></h3>
      <div class="dgrid">${items.map((i) => `
        <div class="dish">
          <button type="button" class="add" data-act="quick-add" data-id="${i.id}">
            ${i.image_ver ? `<img class="dish-img" src="/menu-img/${i.id}?v=${i.image_ver}" alt="" loading="lazy">` : ''}
            <span class="n">${esc(i.name)}</span><span class="tags">${i.tags.map(esc).join(' · ')}${i.no_kot ? `${i.tags.length ? ' · ' : ''}<b class="ready-tag">Ready · no KOT</b>` : ''}</span>
            ${i.stock_out ? '<span class="stk out" style="align-self:flex-start">Low on ingredients</span>' : ''}<span class="p">${money(i.price_cents)}</span>
          </button>
          <button type="button" class="opt" data-act="options" data-id="${i.id}">Options</button>
        </div>`).join('') || '<div class="empty">No dishes found.</div>'}</div>`;
  }

  function orderView() {
    if (!S.order && !S.draft) return startView();
    const o = S.order || { type: 'counter', draft: true, items: [], kots: [], subtotal_cents: 0, discount_cents: 0, tax_cents: 0, opened_at: new Date().toISOString(), staff_name: S.user?.name };
    const cats = S.menu.categories;
    if (!S.cat || !cats.some((c) => c.id === S.cat)) S.cat = defaultCat();
    const pending = o.items.filter(isPending);
    const byCourse = COURSES.map((c) => [c, o.items.filter((i) => i.course === c)]).filter(([, l]) => l.length);
    const ticketTotal = o.subtotal_cents - o.discount_cents + o.tax_cents;
    return `
      <section class="order">
        <aside class="cats scroll"><div class="label">MENU</div>
          ${cats.map((c) => `<button type="button" class="cat ${c.id === S.cat && !S.search ? 'on' : ''}" data-act="cat" data-id="${c.id}">${esc(c.name)}<small>${c.items.length}</small></button>`).join('')}
        </aside>
        <div class="dishes">
          <div class="searchbar"><input id="search" type="search" placeholder="Search dishes..." value="${esc(S.search)}" autocomplete="off"><span class="muted">Tap to add · Options for extras</span></div>
          <div class="dish-area scroll" id="dish-area" style="flex:1">${dishAreaHtml()}</div>
        </div>
        <aside class="ticket">
          <div class="ticket-head">
            <div><div class="eyebrow">${TYPE_LABEL[o.type]}</div><h2>${o.draft ? 'New counter sale' : esc(orderTitle(o))}</h2>
              <div class="muted" style="font-size:14px">${o.draft ? `Tap a dish to start · ${esc(o.staff_name || '')}` : `Opened ${clock(o.opened_at)} · ${mins(o.opened_at)} min · ${esc(o.staff_name || '')}`}</div>
              ${o.type !== 'dinein' && o.customer_name ? `<div style="font-size:14px;margin-top:4px">${esc(o.customer_name)}${o.phone ? ' · ' + esc(o.phone) : ''}</div>` : ''}
              ${o.address ? `<div class="muted" style="font-size:13px">${esc(o.address)}</div>` : ''}
              ${o.draft ? `<button type="button" class="link-red" style="margin-top:8px" data-act="new-order-other">Other order type</button>` : `<button type="button" class="link-red" style="margin-top:8px" data-act="void">`}${o.draft ? '' : `${o.kots.length || o.items.some((i) => i.served_direct) ? 'Void order' : 'Cancel order'}</button>`}
            </div>
            ${o.type === 'dinein' ? `<div><div class="muted" style="font-size:12px;margin-bottom:4px">Guests</div>
              <div class="stepper"><button type="button" data-act="guests" data-d="-1">−</button><span>${o.guests}</span><button type="button" data-act="guests" data-d="1">+</button></div></div>` : ''}
          </div>
          <div class="ticket-lines">
            ${byCourse.length ? byCourse.map(([c, lines]) => `
              <div class="course-h">${COURSE_LABEL[c]}<small>${((n) => `${n} item${n === 1 ? '' : 's'}`)(lines.reduce((s, i) => s + i.qty, 0))}</small></div>
              ${lines.map(lineHtml).join('')}`).join('') : '<div class="empty">Tap a dish to start the ticket.</div>'}
          </div>
          <div class="totals">
            <div class="r"><span>Subtotal</span><span>${money(o.subtotal_cents)}</span></div>
            ${o.discount_cents ? `<div class="r muted"><span>Discount ${o.discount_pct}%</span><span>−${money(o.discount_cents)}</span></div>` : ''}
            <div class="r muted"><span>${esc(S.cfg.taxLabel)} ${pct(S.cfg.taxRate)}</span><span>${money(o.tax_cents)}</span></div>
            <div class="r grand"><span>Total</span><b>${money(ticketTotal)}</b></div>
          </div>
          <div class="ticket-actions">
            <button type="button" class="btn" data-act="tab" data-tab="bill" ${o.items.length ? '' : 'disabled'}>Bill</button>
            <button type="button" class="btn red" data-act="review-kot" ${pending.length ? '' : 'disabled'}>
              <span>Review KOT</span><small>${pending.length ? `${pending.reduce((s, i) => s + i.qty, 0)} new item${pending.length > 1 || pending[0].qty > 1 ? 's' : ''}` : 'All sent'}</small></button>
          </div>
        </aside>
      </section>`;
  }

  function modsHtml(i) {
    const parts = [];
    if (i.spice) parts.push(esc(i.spice));
    for (const a of i.addons || []) parts.push('+ ' + esc(addonLabel(a, aq(a))) + (aq(a) > 1 && i.qty - (i.void_qty || 0) > 1 ? ' each' : ''));
    let h = parts.join(' · ');
    if (i.note) h += `${h ? ' · ' : ''}<span class="note">! ${esc(i.note)}</span>`;
    return h;
  }

  function lineHtml(i) {
    const left = eq(i);
    return `<div class="line ${left === 0 ? 'voided' : ''}">
      <div class="r"><span>${left} × ${esc(i.name)}</span><span>${left === 0 ? 'VOID' : money(lineTotal(i))}</span></div>
      ${modsHtml(i) ? `<div class="mods">${modsHtml(i)}</div>` : ''}
      ${i.void_qty ? `<div class="mods note-red">${i.void_qty} voided</div>` : ''}
      ${i.kot_id || i.served_direct ? `<div class="ctl"><span class="badge ${i.served_direct ? 'direct' : ''}" style="margin-top:0">${i.served_direct ? 'Served · no KOT' : `KOT #${i.kot_no} · ${KOT_LABEL[i.kot_status]}`}</span>
           ${left > 0 ? `<button type="button" class="void-btn" data-act="void-item" data-id="${i.id}">Void</button>` : ''}</div>`
        : `<div class="ctl"><button type="button" data-act="qty" data-id="${i.id}" data-q="${i.qty - 1}">−</button><button type="button" data-act="qty" data-id="${i.id}" data-q="${i.qty + 1}">+</button>
           <span class="badge new" style="margin-top:0">New · not sent</span>
           <button type="button" class="nokot-btn" data-act="no-kot" data-id="${i.id}" title="Already cooked or ready-made: mark served without a kitchen ticket">No KOT</button></div>`}
    </div>`;
  }

  // ---------- kitchen ----------
  function kitchenView() {
    if (!S.kitchen) return '<section class="kds"><div class="empty">Loading…</div></section>';
    const { kots, stations } = S.kitchen;
    const live = kots.filter((k) => S.station === 'all' || k.station_id === null || String(k.station_id) === S.station);
    const count = (sid) => kots.filter((k) => k.station_id === sid).length;
    const drift = Math.floor((Date.now() - S.kitchen.fetchedAt) / 1000);
    const cols = [['new', 'New'], ['cooking', 'Cooking'], ['ready', 'Ready'], ['held', 'On hold']];
    const action = { new: 'Start cooking', cooking: 'Mark ready', ready: 'Picked up · clear', held: 'Fire now' };
    const card = (k) => {
      const title = k.type === 'dinein' ? `Table ${k.table_code}` : `${TYPE_LABEL[k.type]} #${k.order_no}`;
      const age = Math.floor((k.age_sec + drift) / 60);
      const late = k.status === 'cooking' && age >= S.cfg.lateMinutes;
      const cls = late ? 'late' : k.status === 'ready' ? 'ready' : k.status === 'held' ? 'held' : '';
      return `<div class="kcard ${cls}">
        <div class="kh"><div><b>${esc(title)}</b><small>KOT #${k.kot_no} · ${esc(k.station_name || 'All')} · ${k.type === 'dinein' ? `${k.guests} pax` : TYPE_LABEL[k.type]}${k.is_addon ? ' · Add-on' : ''}</small></div>
          <div class="age">${age}m${late ? '<small style="display:block">LATE</small>' : k.status === 'held' ? '<small style="display:block">HOLD</small>' : ''}</div></div>
        ${k.items.map((i) => `<button type="button" class="ki ${i.done || eq(i) === 0 ? 'done' : ''}" data-act="tick" data-id="${i.id}"><span>${eq(i) === 0 ? '<b class="note-red">VOID</b>' : eq(i)}</span>
          <span><span class="nm">${esc(i.name)}</span>${modsHtml(i) ? `<small>${modsHtml(i)}</small>` : ''}</span></button>`).join('')}
        <button type="button" class="act ${k.status}" data-act="advance" data-id="${k.id}">${action[k.status]}</button>
      </div>`;
    };
    return `
      <section class="kds">
        <div class="kds-head">
          <div class="kds-title"><div class="eyebrow">Kitchen display</div><h2>${S.station === 'all' ? 'All stations' : esc(stations.find((s) => String(s.id) === S.station)?.name || '')}</h2></div>
          <div class="stabs">
            <button type="button" class="stab ${S.station === 'all' ? 'on' : ''}" data-act="station" data-id="all"><b>All</b><small>${kots.length} live</small></button>
            ${stations.map((s) => `<button type="button" class="stab ${S.station === String(s.id) ? 'on' : ''}" data-act="station" data-id="${s.id}"><b>${esc(s.name)}</b><small>${count(s.id)} live</small></button>`).join('')}
          </div>
          <div class="kds-hint">Tap an item to tick it off. Tap the bar to move the ticket on.</div>
        </div>
        <div class="kcols">
          ${cols.map(([st, label]) => {
            const list = live.filter((k) => k.status === st);
            return `<div class="kcol ${st === 'held' ? 'hold' : ''}"><div class="kcol-h">${label.toUpperCase()}<small>${list.length}</small></div>
              <div class="kcol-b">${list.map(card).join('') || '<div class="empty" style="padding:8px">—</div>'}</div></div>`;
          }).join('')}
        </div>
      </section>`;
  }

  // ---------- bill ----------
  function billView() {
    const o = S.order;
    if (!o) return startView();
    const pending = o.items.filter(isPending);
    const segBtn = (act, val, cur, label, extra = '') => `<button type="button" class="${String(val) === String(cur) ? 'on' : ''}" data-act="${act}" data-v="${val}" ${extra}>${label}</button>`;
    const per = o.split_ways > 1 ? Math.ceil(o.total_cents / o.split_ways) : 0;
    return `
      <section class="bill">
        <div class="bill-left scroll"><div class="inner">
          <div class="eyebrow">Bill · ${TYPE_LABEL[o.type]}</div>
          <h1 class="title" style="font-size:44px">${esc(orderTitle(o))}</h1>
          <div class="muted">Opened ${clock(o.opened_at)} · ${mins(o.opened_at)} min · ${esc(o.staff_name || '')}${o.bill_printed_at ? ` · Bill printed ${clock(o.bill_printed_at)}` : ''}</div>
          ${pending.length ? `<div class="warn"><span>${pending.length} item${pending.length > 1 ? 's have' : ' has'} not been sent to the kitchen. Charging sends ${pending.length > 1 ? 'them' : 'it'} automatically.</span>
            <button type="button" data-act="tab" data-tab="order">Back to order</button></div>` : '<div style="height:22px"></div>'}
          <div class="blines">${o.items.filter((i) => eq(i) > 0).map((i) => `<div class="bline-group">
              <div class="bline"><span>${eq(i)}</span><span>${esc(i.name)}${i.spice ? `<small>Spice: ${esc(i.spice)}</small>` : ''}</span><span>${money(eq(i) * i.unit_price_cents)}</span></div>
              ${(i.addons || []).map((a) => `<div class="bline addon"><span></span><span>+ ${esc(addonLabel(a, eq(i) * aq(a)))}</span><span>${money(eq(i) * aq(a) * a.price_cents)}</span></div>`).join('')}
            </div>`).join('') || '<div class="empty">No items yet.</div>'}</div>
          <div class="bsum" style="margin-top:14px">
            <div class="r"><span>Subtotal</span><span>${money(o.subtotal_cents)}</span></div>
            ${o.discount_cents ? `<div class="r"><span>Discount ${o.discount_pct}%</span><span>−${money(o.discount_cents)}</span></div>` : ''}
            ${o.service_on ? `<div class="r"><span>Service charge ${pct(S.cfg.serviceRate)}</span><span>${money(o.service_cents)}</span></div>` : ''}
            <div class="r"><span>${esc(S.cfg.taxLabel)} ${pct(S.cfg.taxRate)}</span><span>${money(o.tax_cents)}</span></div>
            ${o.tip_cents ? `<div class="r"><span>Tip ${o.tip_pct}%</span><span>${money(o.tip_cents)}</span></div>` : ''}
            <div class="r total"><span>Total</span><b>${money(o.total_cents)}</b></div>
            ${per ? `<div class="r" style="margin-top:8px"><span>Per person · ${o.split_ways} ways</span><b>${money(per)}</b></div>` : ''}
          </div>
        </div></div>
        <aside class="bill-right">
          <div class="bill-opts">
            <div class="msec"><div class="hd"><b>Customer</b><small>Printed on the bill</small></div>
              <div class="cust-row"><input id="cust-name" data-cust="customer_name" maxlength="80" placeholder="Customer name" value="${esc(o.customer_name || '')}">
                <input id="cust-phone" data-cust="phone" maxlength="20" inputmode="tel" placeholder="Contact no. +94 7X XXX XXXX" value="${esc(o.phone || '')}"></div></div>
            <div class="msec"><div class="hd"><b>Discount</b>${o.discount_cents ? `<small>−${money(o.discount_cents)}</small>` : ''}</div>
              <div class="seg full">${segBtn('bill-set', 0, o.discount_pct, 'None', 'data-k="discount_pct"')}${segBtn('bill-set', 10, o.discount_pct, '10%', 'data-k="discount_pct"')}${segBtn('bill-set', 20, o.discount_pct, 'Staff 20%', 'data-k="discount_pct"')}</div></div>
            <div class="msec"><div class="hd"><b>Service charge</b><small>${money(o.service_cents)}</small></div>
              <div class="seg full">${segBtn('bill-set', 'false', String(o.service_on), 'Off', 'data-k="service_on"')}${segBtn('bill-set', 'true', String(o.service_on), pct(S.cfg.serviceRate), 'data-k="service_on"')}</div></div>
            <div class="msec"><div class="hd"><b>Tip</b>${o.tip_cents ? `<small>${money(o.tip_cents)}</small>` : ''}</div>
              <div class="seg full">${[0, 10, 15, 18].map((t) => segBtn('bill-set', t, o.tip_pct, t ? t + '%' : 'None', 'data-k="tip_pct"')).join('')}</div></div>
            <div class="msec"><div class="hd"><b>Split</b>${per ? `<small>${money(per)} each</small>` : ''}</div>
              <div class="seg full">${[1, 2, 3, 4].map((t) => segBtn('bill-set', t, o.split_ways, t === 1 ? 'One bill' : `${t} ways`, 'data-k="split_ways"')).join('')}</div></div>
            <div class="msec" style="border-bottom:0"><div class="hd"><b>Payment method</b></div>
              <div class="seg full">${['card', 'cash', 'wallet'].map((m) => segBtn('pay-method', m, S.payMethod, m[0].toUpperCase() + m.slice(1))).join('')}</div>
              ${S.payMethod === 'card' ? `<div class="card-box">
                <label>Card type <small class="muted">as shown on the card or the terminal slip</small></label>
                <div class="chips card-chips">${CARD_BRANDS.map((b) => `<button type="button" class="chip ${S.payCard.brand === b ? 'on' : ''}" data-act="card-brand" data-v="${b}">${b}</button>`).join('')}</div>
                <div class="two" style="margin-top:10px"><div><label>Last 4 digits</label>
                  <div class="last4"><span>••••</span><input id="card-last4" inputmode="numeric" maxlength="4" pattern="\\d{4}" placeholder="1234" autocomplete="off" value="${esc(S.payCard.last4)}"></div></div>
                  <div><label>Approval code <small class="muted">(optional)</small></label><input id="card-auth" maxlength="12" autocomplete="off" placeholder="From the slip" value="${esc(S.payCard.auth)}"></div></div>
                <small class="muted" style="display:block;margin-top:6px">Only the card type and last 4 digits are saved. Never type the full card number.</small></div>` : ''}
              ${S.payMethod === 'cash' ? `<label style="display:block;margin-top:14px;font-size:14px;font-weight:600">Cash received</label>
                <input id="cash-in" class="cash-in ${cashState(o).short ? 'short' : ''}" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(S.cashIn)}">
                <div id="change" class="cash-msg ${cashState(o).short ? 'short' : ''}">${cashState(o).msg}</div>` : ''}
            </div>
          </div>
          <div class="due">
            <div class="r"><span>Amount due</span><b>${money(o.total_cents)}</b></div>
            <div class="bill-lang" role="group" aria-label="Bill language"><span>Print bill in</span>${billLangButtons()}</div>
            <div class="acts">
              <button type="button" class="btn" data-act="print-bill" ${o.items.length ? '' : 'disabled'}>Print bill</button>
              <button type="button" class="btn red" data-act="charge" ${o.items.length ? '' : 'disabled'}>Charge ${money(o.total_cents)}</button>
            </div>
          </div>
        </aside>
      </section>`;
  }

  // Cash tendered vs amount due. Cents, so Rs 1,350.00 typed as "1350" or "1,350.00" both work.
  function parseCash(v) {
    const t = String(v || '').replace(/[,\s]/g, '').replace(/^rs\.?/i, '');
    if (!t) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
    return Math.round(parseFloat(t) * 100);
  }
  function cashState(o) {
    const got = parseCash(S.cashIn);
    if (got === null) return { got, short: false, msg: '' };
    if (Number.isNaN(got)) return { got, short: true, msg: 'Enter an amount like 5000 or 5000.00' };
    const ch = got - o.total_cents;
    return ch >= 0 ? { got, short: false, msg: `Change: <b>${money(ch)}</b>` } : { got, short: true, msg: `Short by <b>${money(-ch)}</b> · must be at least ${money(o.total_cents)}` };
  }

  // ---------- history ----------
  function historyView() {
    if (!S.history) return '<section class="hist"><div class="empty">Loading…</div></section>';
    const H = S.history;
    const list = H.orders.filter((o) => S.histFilter === 'all' || o.type === S.histFilter);
    const d = S.histOrder;
    return `
      <section class="hist">
        <div class="scroll">
          <div class="page-head" style="border-bottom:0">
            <div><div class="eyebrow">Today</div><h1 class="title">Orders</h1>
              <div class="muted">${H.stats.paid} paid · ${money(H.stats.collected_cents)} collected · ${H.stats.open} open</div></div>
            <div class="seg">${['all', 'dinein', 'takeaway', 'delivery', 'counter'].map((t) => `<button type="button" class="${S.histFilter === t ? 'on' : ''}" data-act="hist-filter" data-v="${t}">${t === 'all' ? 'All' : TYPE_LABEL[t]}</button>`).join('')}</div>
          </div>
          <div class="htable-wrap">
            <table class="htable"><thead><tr><th>Order</th><th>Type</th><th>Table / Guest</th><th>Items · KOT</th><th>Opened</th><th>Status</th><th>Total</th></tr></thead>
            <tbody>${list.map((o) => `<tr class="${S.histSel === o.id ? 'sel' : ''}" data-act="hist-sel" data-id="${o.id}">
              <td><b>#${o.order_no}</b></td><td>${TYPE_LABEL[o.type]}</td>
              <td class="name">${o.type === 'dinein' ? `Table ${esc(o.table_code)} · ${o.guests} pax` : esc(o.customer_name || 'Walk-in')}</td>
              <td>${o.item_qty} · ${o.kot_count}</td><td>${clock(o.opened_at)}</td>
              <td><span class="s ${o.display_status}">${STATUS_LABEL[o.display_status]}</span></td><td><b>${money(o.total_cents)}</b></td></tr>`).join('')
              || '<tr><td colspan="7" class="muted">No orders yet today.</td></tr>'}</tbody></table>
          </div>
        </div>
        <aside class="hdetail scroll">
          ${d ? `<div class="hd"><div class="eyebrow">${TYPE_LABEL[d.type]} · #${d.order_no}</div><h2>${esc(d.type === 'dinein' ? `Table ${d.table_code}` : d.customer_name || orderTitle(d))}</h2>
              <div class="muted">${d.type === 'dinein' ? `${d.guests} guests · ` : ''}Opened ${clock(d.opened_at)}${d.closed_at ? ` · Closed ${clock(d.closed_at)}` : ''}</div>
              ${d.customer_name || d.phone ? `<div style="margin-top:4px">${[d.customer_name, d.phone].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
              ${d.status === 'open' ? `<button type="button" class="btn dark" style="margin-top:12px" data-act="open-order" data-id="${d.id}">Open order</button>` : ''}
              ${d.status === 'paid' ? `<div style="margin-top:8px"><b>${money(d.total_cents)}</b> · ${esc((d.payment_method || '').toUpperCase())}${d.card_last4 ? ` · ${esc(d.card_brand || '')} •••• ${esc(d.card_last4)}${d.card_auth ? ` · auth ${esc(d.card_auth)}` : ''}` : ''}${d.cash_received_cents != null ? ` · received ${money(d.cash_received_cents)}, change ${money(d.change_cents || 0)}` : ''}${d.refunded_cents ? ` · <span class="note-red">refunded ${money(d.refunded_cents)}</span>` : ''}</div>` : ''}
              <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
                ${d.status === 'paid' && d.refunded_cents < d.total_cents ? `<button type="button" class="btn" data-act="refund" data-id="${d.id}">Refund</button>` : ''}
                ${d.items.length ? `<button type="button" class="btn" data-act="reprint" data-id="${d.id}">Reprint ${d.status === 'paid' ? 'receipt' : 'bill'}</button>` : ''}</div>
                ${d.items.length ? `<div class="bill-lang" role="group" aria-label="Reprint language" style="margin-top:10px"><span>In</span>${billLangButtons()}</div>` : ''}</div>
            <div class="sec"><div class="lbl">ITEMS</div>${d.items.map((i) => `<div class="r ${eq(i) === 0 ? 'voided' : ''}"><span>${eq(i)}</span><span>${esc(i.name)}${i.void_qty ? ` <span class="note-red">(${i.void_qty} voided)</span>` : ''}</span><span>${money(lineTotal(i))}</span></div>`).join('') || '<div class="muted">None</div>'}</div>
            ${d.voids.length ? `<div class="sec"><div class="lbl">VOIDS</div>${d.voids.map((v) => `<div class="note-line"><b>${v.qty} × ${esc(v.name)}</b> · ${money(v.amount_cents)}<div class="muted">${clock(v.created_at)} · ${esc(v.reason)} · ${esc(v.staff_name || '')}${v.approved_name && v.approved_name !== v.staff_name ? ` · approved by ${esc(v.approved_name)}` : ''}</div></div>`).join('')}</div>` : ''}
            ${d.refunds.length ? `<div class="sec"><div class="lbl">REFUNDS</div>${d.refunds.map((r) => `<div class="note-line"><b>${money(r.amount_cents)}</b> · ${esc(r.method)}<div class="muted">${clock(r.created_at)} · ${esc(r.reason)} · ${esc(r.staff_name || '')}${r.approved_name && r.approved_name !== r.staff_name ? ` · approved by ${esc(r.approved_name)}` : ''}</div></div>`).join('')}</div>` : ''}
            <div class="sec"><div class="lbl">KITCHEN TICKETS</div>${d.kots.map((k) => `<div class="k"><b>#${k.kot_no}</b><span>${esc(k.station_name || 'All')}</span><span class="muted">${KOT_LABEL[k.status]}${k.served_at ? ' · ' + clock(k.served_at) : ''} · <button type="button" class="link-red" style="font-size:13px" data-act="kot-reprint" data-id="${k.id}">Reprint</button></span></div>`).join('') || '<div class="muted">None</div>'}</div>`
            : '<div class="empty" style="padding:28px 20px">Select an order to see its items and kitchen tickets.</div>'}
        </aside>
      </section>`;
  }

  // ---------- admin ----------
  const ADMIN_SECTIONS = [['items', 'Menu items'], ['categories', 'Categories'], ['floor', 'Floor & tables'], ['stations', 'Stations'], ['staff', 'Staff'], ['printers', 'Printers'], ['integrations', 'Integrations'], ['audit', 'Audit log'], ['settings', 'Settings'], ['plan', 'Plan & licence']];
  const SECTION_FEATURE = { audit: 'audit', integrations: 'emails' };
  const ADMIN_PATH = { item: 'items', category: 'categories', area: 'areas', table: 'tables', station: 'stations', staff: 'staff' };
  const ADMIN_NOUN = { item: 'dish', category: 'category', area: 'area', table: 'table', station: 'station', staff: 'staff member' };
  const isManager = () => S.user?.role === 'Manager';
  const major = (c) => ((c || 0) / 100).toFixed(2);
  async function loadAdmin() { S.admin.data = await api('/admin/data'); }

  const field = (label, input, hint = '') => `<div class="field"><label>${label}</label>${input}${hint ? `<small>${hint}</small>` : ''}</div>`;
  const inp = (name, val, extra = '') => `<input name="${name}" value="${esc(val ?? '')}" ${extra}>`;
  const sel = (name, opts, cur) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const check = (name, on, label) => `<label class="check"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}> ${label}</label>`;
  const addonRow = (a = {}) => `<div class="addon-row"><input data-f="name" placeholder="Add-on name" value="${esc(a.name || '')}">
    <input data-f="price" inputmode="decimal" placeholder="0.00" title="Price for one" value="${a.price_cents != null ? major(a.price_cents) : ''}">
    <input data-f="unit" list="addon-units" placeholder="Unit" title="Portion, piece, cup… (optional)" value="${esc(a.unit || '')}">
    <input data-f="max" inputmode="numeric" placeholder="5" title="Most a guest can add per dish" value="${a.max_qty != null ? a.max_qty : ''}">
    <button type="button" data-act="admin-addon-del" title="Remove">✕</button></div>`;

  function imgPreview(rec) {
    const A = S.admin;
    const src = A.img ? A.img.url : !A.imgRemove && rec?.image_ver ? `/menu-img/${rec.id}?v=${rec.image_ver}` : '';
    return src ? `<img src="${src}" alt="">` : '<span>No photo</span>';
  }
  function resetImg() { if (S.admin.img) URL.revokeObjectURL(S.admin.img.url); S.admin.img = null; S.admin.imgRemove = false; }
  // Shrink to max 800px and re-encode as JPEG in the browser so uploads stay small.
  async function resizeImage(file, maxSide = 800) {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file');
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => { throw new Error('Could not read that image'); });
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', 0.82));
    if (!blob) throw new Error('Could not process that image');
    return blob;
  }
  async function uploadImage(id, blob) {
    const res = await fetch(`/api/admin/items/${id}/image`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob, credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Photo upload failed');
  }

  function adminForm() {
    const A = S.admin; const D = A.data; const s = A.sel;
    if (!s && A.section === 'plan') {
      return `<div class="empty" style="padding:28px 20px"><b>Changing plan</b><br><br>Message us on WhatsApp to upgrade, renew or add devices. You'll get a new licence key: paste it under <b>Licence key</b> and it applies straight away on every device.<br><br>Nothing is deleted when a plan changes. Features you don't have keep their data until you upgrade again.</div>`;
    }
    if (!s) return `<div class="empty" style="padding:28px 20px">Select a row to edit it, or add a new one.</div>`;
    const find = (list) => (s.id ? list.find((x) => x.id === s.id) : null);
    let rec, body;
    if (s.kind === 'item') {
      rec = find(D.items) || { name: '', category_id: A.cat !== 'all' ? +A.cat : D.categories[0]?.id, station_id: D.stations[0]?.id, price_cents: 0, tags: [], has_spice: false, active: true, sort: 0, addons: [] };
      body = field('Dish name', inp('name', rec.name, 'required maxlength="80"'))
        + `<div class="two lang-field">${field('Name in Tamil', inp('name_ta', rec.name_ta || '', 'maxlength="80" lang="ta" placeholder="e.g. சிக்கன் கொத்து"'), 'Used on Tamil bills.')}
             ${field('Name in Sinhala', inp('name_si', rec.name_si || '', 'maxlength="80" lang="si" placeholder="e.g. චිකන් කොත්තු"'), 'Used on Sinhala bills.')}</div>`
        + `<div class="two">${field('Category', sel('category_id', D.categories.map((c) => [c.id, c.name]), rec.category_id))}
             ${field('Kitchen station', sel('station_id', D.stations.map((x) => [x.id, x.name]), rec.station_id))}</div>`
        + `<div class="two">${field(`Price (${esc(S.cfg.currency.trim())})`, inp('price', major(rec.price_cents), 'inputmode="decimal" required'))}
             ${field('Sort order', inp('sort', rec.sort, 'inputmode="numeric"'))}</div>`
        + field('Tags', inp('tags', rec.tags.filter((t) => t !== 'Spice level').join(', '), 'placeholder="Wok, Veg"'), 'Comma separated. Shown under the dish name.')
        + `<div class="field">${check('has_spice', rec.has_spice, 'Ask for spice level')}${check('active', rec.active, 'Show on menu')}
             ${check('send_kot', !rec.no_kot, 'Send to kitchen (print a KOT)')}
             <small style="margin-top:-4px">Untick for ready-made items such as bottled drinks, cakes or pre-made short eats. They are served straight away, and staff can still choose per order.</small></div>`
        + `<div class="field"><label>Photo</label>
             <div class="img-edit"><div class="img-box" id="img-box">${imgPreview(rec)}</div>
               <div class="img-actions"><label class="btn" style="cursor:pointer">Choose photo<input type="file" id="img-file" accept="image/*" hidden></label>
                 <button type="button" class="link-red" data-act="admin-img-remove">Remove photo</button>
                 <small class="muted">Resized to 800 px before upload.</small></div></div></div>`
        + `<div class="field"><label>Add-ons</label>
             <div class="addon-row addon-head"><span>Name</span><span>Price (each)</span><span>Unit</span><span>Max</span><span></span></div>
             <div id="addons">${rec.addons.map(addonRow).join('')}</div>
             <datalist id="addon-units"><option value="portion"><option value="piece"><option value="cup"><option value="scoop"><option value="plate"><option value="bowl"></datalist>
             <small class="muted" style="display:block;margin:2px 0 6px">The cashier picks how many (up to Max) per dish. Unit shows on bills, e.g. "Boiled egg x2 pieces".</small>
             <button type="button" class="link-red" data-act="admin-addon-add">+ Add add-on</button></div>`;
    } else if (s.kind === 'category') {
      rec = find(D.categories) || { name: '', default_course: 'main', sort: D.categories.length };
      body = field('Category name', inp('name', rec.name, 'required maxlength="60"'))
        + field('Fires as course', sel('default_course', D.courses.map((c) => [c, COURSE_LABEL[c]]), rec.default_course), 'Default course for dishes in this category.')
        + field('Sort order', inp('sort', rec.sort, 'inputmode="numeric"'));
    } else if (s.kind === 'area') {
      rec = find(D.areas) || { name: '', short: '', sort: D.areas.length + 1 };
      body = field('Area name', inp('name', rec.name, 'required maxlength="40"'))
        + field('Short label', inp('short', rec.short, 'maxlength="20"'), 'Used on the Floor filter buttons.')
        + field('Sort order', inp('sort', rec.sort, 'inputmode="numeric"'));
    } else if (s.kind === 'table') {
      rec = find(D.tables) || { code: '', area_id: D.areas[0]?.id, seats: 2, sort: D.tables.length, active: true };
      body = `<div class="two">${field('Table code', inp('code', rec.code, 'required maxlength="10" placeholder="T9"'))}${field('Seats', inp('seats', rec.seats, 'inputmode="numeric" required'))}</div>`
        + field('Area', sel('area_id', D.areas.map((a) => [a.id, a.name]), rec.area_id))
        + field('Sort order', inp('sort', rec.sort, 'inputmode="numeric"'))
        + `<div class="field">${check('active', rec.active, 'Show on floor')}</div>`
        + (rec.busy ? '<div class="warn" style="margin:0">This table has an open order right now.</div>' : '');
    } else if (s.kind === 'station') {
      rec = find(D.stations) || { code: '', name: '', printer: '', sort: D.stations.length };
      body = `<div class="two">${field('Code', inp('code', rec.code, 'required maxlength="12" placeholder="FRY"'))}${field('Name', inp('name', rec.name, 'required maxlength="30"'))}</div>`
        + field('Printer label', inp('printer', rec.printer, 'maxlength="60"'), 'Shown at the bottom of each KOT.')
        + field('Sort order', inp('sort', rec.sort, 'inputmode="numeric"'));
    } else if (s.kind === 'staff') {
      rec = find(D.staff) || { name: '', initials: '', role: 'Server', active: true };
      body = `<div class="two">${field('Name', inp('name', rec.name, 'required maxlength="40"'))}${field('Initials', inp('initials', rec.initials, 'maxlength="3"'))}</div>`
        + field('Role', sel('role', D.roles.map((r) => [r, r]), rec.role), 'Only Managers can open Admin.')
        + field(s.id ? 'New PIN' : 'PIN', inp('pin', '', `inputmode="numeric" maxlength="8" autocomplete="off" ${s.id ? 'placeholder="Leave blank to keep"' : 'required'}`), '4–8 digits. Must be unique.')
        + `<div class="field">${check('active', rec.active, 'Can sign in')}</div>`;
    }
    const canDelete = s.id && s.kind !== 'staff';
    return `<form id="admin-form" autocomplete="off">
      <div class="hd"><div class="eyebrow">${s.id ? 'Edit' : 'New'} ${ADMIN_NOUN[s.kind]}</div><h2>${esc(s.id ? rec.name || rec.code : `Add ${ADMIN_NOUN[s.kind]}`)}</h2></div>
      <div class="form-body">${body}</div>
      <div class="form-foot">
        ${canDelete ? `<button type="button" class="btn" data-act="admin-delete">Delete</button>` : '<span></span>'}
        <button type="button" class="btn" data-act="admin-cancel">Cancel</button>
        <button type="submit" class="btn red">Save</button>
      </div></form>`;
  }

  function adminList() {
    const A = S.admin; const D = A.data;
    const selRow = (kind, id) => (A.sel?.kind === kind && A.sel?.id === id ? 'sel' : '');
    const head = (title, sub, kind, extra = '') => `<div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Admin</div><h1 class="title">${title}</h1><div class="muted">${sub}</div></div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${extra}<button type="button" class="btn dark" data-act="admin-new" data-kind="${kind}">+ Add ${ADMIN_NOUN[kind]}</button></div></div>`;
    const catName = (id) => D.categories.find((c) => c.id === id)?.name || '—';
    const stName = (id) => D.stations.find((c) => c.id === id)?.name || '—';
    if (A.section === 'items') {
      const q = A.q.trim().toLowerCase();
      const list = D.items.filter((i) => (A.cat === 'all' || i.category_id === +A.cat) && (!q || i.name.toLowerCase().includes(q)));
      return head('Menu items', `${D.items.filter((i) => i.active).length} on the menu · ${D.items.filter((i) => !i.active).length} hidden`, 'item',
        `<button type="button" class="btn" data-act="admin-sample-menu">Load Asian menu</button>
         <input id="admin-q" class="admin-search" type="search" placeholder="Search dishes..." value="${esc(A.q)}">
         <select id="admin-cat" class="admin-select"><option value="all">All categories</option>${D.categories.map((c) => `<option value="${c.id}" ${String(c.id) === A.cat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`)
        + `<div class="htable-wrap"><table class="htable"><thead><tr><th>Dish</th><th>Category</th><th>Station</th><th>Add-ons</th><th>Status</th><th style="text-align:right">Price</th></tr></thead><tbody>
          ${list.map((i) => `<tr class="${selRow('item', i.id)}" data-act="admin-sel" data-kind="item" data-id="${i.id}">
            <td class="name"><div class="dish-cell">${i.image_ver ? `<img src="/menu-img/${i.id}?v=${i.image_ver}" alt="" loading="lazy">` : '<span class="noimg"></span>'}
              <div><b>${esc(i.name)}</b><div class="muted" style="font-size:12.5px">${i.tags.map(esc).join(' · ')}</div></div></div></td><td>${esc(catName(i.category_id))}</td><td>${esc(stName(i.station_id))}</td>
            <td>${i.addons.length || '—'}</td><td><span class="s ${i.active ? 'paid' : 'void'}">${i.active ? 'On menu' : 'Hidden'}</span>${i.no_kot ? '<div class="muted" style="font-size:12px">No KOT</div>' : ''}</td><td style="text-align:right"><b>${money(i.price_cents)}</b></td></tr>`).join('')
            || '<tr><td colspan="6" class="muted">No dishes match.</td></tr>'}</tbody></table></div>`;
    }
    if (A.section === 'categories') {
      return head('Categories', `${D.categories.length} categories · shown in sort order on the Order screen`, 'category')
        + `<div class="htable-wrap"><table class="htable"><thead><tr><th>Sort</th><th>Category</th><th>Fires as</th><th>Dishes</th></tr></thead><tbody>
          ${D.categories.map((c) => `<tr class="${selRow('category', c.id)}" data-act="admin-sel" data-kind="category" data-id="${c.id}">
            <td>${c.sort}</td><td class="name"><b>${esc(c.name)}</b></td><td>${COURSE_LABEL[c.default_course]}</td><td>${c.item_count}</td></tr>`).join('')}</tbody></table></div>`;
    }
    if (A.section === 'floor') {
      return head('Floor & tables', `${D.areas.length} areas · ${D.tables.filter((t) => t.active).length} tables on the floor`, 'table',
        `<button type="button" class="btn" data-act="admin-new" data-kind="area">+ Add area</button>`)
        + D.areas.map((a) => `<div class="area" style="padding-top:8px">
            <h3 style="display:flex;align-items:baseline;gap:8px">${esc(a.name)}<small>${a.table_count} tables</small>
              <button type="button" class="link-red" data-act="admin-sel" data-kind="area" data-id="${a.id}">Edit area</button></h3>
            <div class="grid4">${D.tables.filter((t) => t.area_id === a.id).map((t) => `
              <button type="button" class="tcard ${t.active ? 'free' : 'dining'} ${selRow('table', t.id) ? 'ordering' : ''}" style="min-height:96px" data-act="admin-sel" data-kind="table" data-id="${t.id}">
                <div class="row1"><span class="code" style="font-size:24px">${esc(t.code)}</span><span class="seats">${t.seats} seats</span></div>
                <span class="st">${t.active ? (t.busy ? 'Open order' : 'On floor') : 'Hidden'}</span></button>`).join('')}
              <button type="button" class="tcard" style="min-height:96px;justify-content:center;color:var(--red-ink);font-weight:700" data-act="admin-new" data-kind="table" data-area="${a.id}">+ Add table</button>
            </div></div>`).join('') + '<div style="height:28px"></div>';
    }
    if (A.section === 'stations') {
      return head('Kitchen stations', 'Each station gets its own KOT and its own column filter on the Kitchen screen', 'station')
        + `<div class="htable-wrap"><table class="htable"><thead><tr><th>Sort</th><th>Code</th><th>Station</th><th>Printer</th><th>Dishes</th></tr></thead><tbody>
          ${D.stations.map((s) => `<tr class="${selRow('station', s.id)}" data-act="admin-sel" data-kind="station" data-id="${s.id}">
            <td>${s.sort}</td><td><b>${esc(s.code)}</b></td><td class="name">${esc(s.name)}</td><td>${esc(s.printer)}</td><td>${s.item_count}</td></tr>`).join('')}</tbody></table></div>`;
    }
    if (A.section === 'printers') return printersList();
    if (SECTION_FEATURE[A.section] && !can(SECTION_FEATURE[A.section])) return upgradeView(SECTION_FEATURE[A.section], false);
    if (A.section === 'plan') return planView();
    if (A.section === 'audit') return auditList();
    if (A.section === 'integrations') return integrationsList();
    if (A.section === 'settings') {
      const st = D.settings;
      const p = (f) => +(f * 100).toFixed(3);
      return `<div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Admin</div><h1 class="title">Settings</h1>
          <div class="muted">Shown in the header, on bills and on kitchen tickets. Saved for every terminal.</div></div></div>
        <form id="settings-form" class="settings-form" autocomplete="off">
          <div class="two">${field('Restaurant name', inp('restaurant', st.restaurant, 'required maxlength="40"'))}
            ${field('Terminal name', inp('terminal', st.terminal, 'required maxlength="40" placeholder="Asian Cuisine"'), 'Shown under the restaurant name, e.g. Asian Cuisine.')}</div>
          <div class="two">${field('Currency symbol', inp('currency', st.currency.trim(), 'maxlength="6"'), 'e.g. Rs, LKR, ₹, $')}
            ${field('Late ticket after (minutes)', inp('lateMinutes', st.lateMinutes, 'inputmode="numeric"'))}</div>
          <div class="two">${field('Tax label', inp('taxLabel', st.taxLabel, 'required maxlength="20"'))}
            ${field('Tax rate (%)', inp('taxRate', p(st.taxRate), 'inputmode="decimal"'))}</div>
          <div class="two">${field('Service charge (%)', inp('serviceRate', p(st.serviceRate), 'inputmode="decimal"'))}<div></div></div>
          <h3 style="margin:18px 0 4px">Restaurant details on bills</h3>
          <div class="muted" style="margin-bottom:12px">Printed at the top of every bill, receipt and refund slip, under the logo.</div>
          <div class="two">${field('Address', `<textarea name="address" rows="3" maxlength="160" placeholder="No. 12, Main Street&#10;Trincomalee">${esc(st.address)}</textarea>`, 'Up to 3 lines.')}
            <div>${field('Phone', inp('phone', st.phone, 'maxlength="60" placeholder="+94 26 222 3344"'))}${field('Email', inp('email', st.email, 'maxlength="80" type="email"'))}</div></div>
          <div class="two">${field('Website', inp('website', st.website, 'maxlength="80" placeholder="www.example.lk"'))}
            ${field('VAT / business reg. no.', inp('regNo', st.regNo, 'maxlength="60"'), 'Printed as "Reg. No".')}</div>
          ${field('Bill footer message', inp('billFooter', st.billFooter, 'maxlength="120" placeholder="Thank you! Come again."'))}
          ${field('Menu opens on', `<select name="defaultCategory"><option value="">${esc(`Automatic (${(S.menu.categories.find((c) => /sri\s*lankan/i.test(c.name)) || S.menu.categories[0] || {}).name || 'first category'})`)}</option>${(S.admin.data?.categories || []).map((c) => `<option value="${c.id}" ${String(st.defaultCategory || '') === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`, 'The menu category the order screen shows first. Cashiers go straight to it when they sign in.')}
          <h3 style="margin:22px 0 6px">Bills in Tamil &amp; Sinhala</h3>
          <div class="muted" style="margin-bottom:12px">Staff can print each bill in English, Tamil or Sinhala from the Bill screen. Dish names come from each dish's Tamil and Sinhala names (Admin → Menu items). Leave a field empty to use the English wording.</div>
          ${field('Default bill language', `<select name="billLang">${[['en', 'English'], ['ta', 'தமிழ் (Tamil)'], ['si', 'සිංහල (Sinhala)']].map(([v, t]) => `<option value="${v}" ${(st.billLang || 'en') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
          <div class="two lang-field">
            <div>${field('Restaurant name in Tamil', inp('restaurantTa', st.restaurantTa || '', 'maxlength="60" lang="ta"'))}
              ${field('Address in Tamil', `<textarea name="addressTa" rows="3" maxlength="200" lang="ta">${esc(st.addressTa || '')}</textarea>`)}
              ${field('Footer message in Tamil', inp('billFooterTa', st.billFooterTa || '', `maxlength="120" lang="ta" placeholder="${esc(BT('ta').footer || '')}"`))}</div>
            <div>${field('Restaurant name in Sinhala', inp('restaurantSi', st.restaurantSi || '', 'maxlength="60" lang="si"'))}
              ${field('Address in Sinhala', `<textarea name="addressSi" rows="3" maxlength="200" lang="si">${esc(st.addressSi || '')}</textarea>`)}
              ${field('Footer message in Sinhala', inp('billFooterSi', st.billFooterSi || '', `maxlength="120" lang="si" placeholder="${esc(BT('si').footer || '')}"`))}</div>
          </div>
          <button type="submit" class="btn red" style="min-width:200px;text-align:center">Save settings</button>
        </form>
        <div class="settings-form" style="margin-top:8px;border-top:1px solid var(--line);padding-top:22px">
          <h3 style="margin:0 0 6px">Restaurant logo</h3>
          <div class="muted" style="margin-bottom:12px">Shown in the header and on the login screen, and printed at the top of bills. A simple dark logo on a white or transparent background prints best on thermal printers.</div>
          <div class="img-edit" style="margin-bottom:10px">
            <div class="img-box logo-box">${S.cfg.logo ? `<img src="${esc(S.cfg.logo)}" alt="">` : '<span>No logo</span>'}</div>
            <div class="img-box logo-box print-prev" title="How it prints on a thermal printer">${S.admin.logoPreview ? `<img src="${S.admin.logoPreview}" alt="">` : S.cfg.logo ? `<img class="mono" src="${esc(S.cfg.logo)}" alt="">` : '<span>Print preview</span>'}</div>
            <div class="img-actions"><label class="btn" style="cursor:pointer">${S.cfg.logo ? 'Change logo' : 'Upload logo'}<input type="file" id="logo-file" accept="image/*" hidden></label>
              ${S.cfg.logo ? '<button type="button" class="link-red" data-act="logo-remove">Remove logo</button>' : ''}
              <small class="muted">Left: on screen. Right: on the printer (black & white).</small></div></div>
          <div class="bill-preview">${billHeaderHtml(st)}<div class="c muted" style="margin-top:6px">… bill items …</div>${st.billFooter ? `<div class="c" style="margin-top:6px">${esc(st.billFooter)}</div>` : ''}</div>
        </div>
        <div class="settings-form" style="margin-top:8px;border-top:1px solid var(--line);padding-top:22px">
          ${syncPanel()}
          <h3 style="margin:0 0 6px">Login screen background</h3>
          <div class="muted" style="margin-bottom:12px">A photo of your restaurant behind the PIN pad. It's resized to 1920 px and faded slightly so the keypad stays easy to read.</div>
          <div class="img-edit" style="margin-bottom:26px"><div class="img-box bg-box"><img src="${esc(S.cfg.loginBg)}" alt=""></div>
            <div class="img-actions"><label class="btn" style="cursor:pointer">Choose photo<input type="file" id="login-bg-file" accept="image/*" hidden></label>
              ${S.cfg.loginBg.startsWith('/login-bg') ? '<button type="button" class="link-red" data-act="login-bg-reset">Use the default background</button>' : '<small class="muted">Showing the built-in background.</small>'}</div></div>
          <h3 style="margin:0 0 6px">Sample menu</h3>
          <div class="muted" style="margin-bottom:12px">Replace the menu with Short Eats, Sri Lankan, Indian, Chinese, Thai, Japanese, Korean, Desserts and Drinks.</div>
          <button type="button" class="btn" data-act="admin-sample-menu">Load Asian menu</button>
        </div>`;
    }
    return head('Staff', `${D.staff.filter((s) => s.active).length} active · sign in with a PIN`, 'staff')
      + `<div class="htable-wrap"><table class="htable"><thead><tr><th></th><th>Name</th><th>Role</th><th>Status</th></tr></thead><tbody>
        ${D.staff.map((s) => `<tr class="${selRow('staff', s.id)}" data-act="admin-sel" data-kind="staff" data-id="${s.id}">
          <td style="width:52px"><span class="avatar" style="display:inline-grid">${esc(s.initials)}</span></td><td class="name"><b>${esc(s.name)}</b>${s.id === S.user.id ? ' <span class="muted">(you)</span>' : ''}</td>
          <td>${esc(s.role)}</td><td><span class="s ${s.active ? 'paid' : 'void'}">${s.active ? 'Active' : 'Disabled'}</span></td></tr>`).join('')}</tbody></table></div>`;
  }

  function syncPanel() {
    const y = S.sync; const mode = S.cfg.mode;
    const row = (l, v) => `<div class="r"><span>${l}</span><span>${v}</span></div>`;
    let body;
    if (mode === 'local') {
      body = !y?.configured ? '<p class="muted">This is the shop server, but no cloud copy is set. Add CLOUD_URL and SYNC_TOKEN to keep an off-site copy and remote reports.</p>'
        : row('Cloud copy', esc(y.cloud)) + row('Internet', y.online === false ? '<b class="note-red">Not reachable. The POS keeps working.</b>' : y.online ? 'Connected' : 'Checking…')
          + row('Waiting to sync', `${y.pending} change${y.pending === 1 ? '' : 's'}${y.oldest_pending ? ` (oldest ${ago(y.oldest_pending)})` : ''}`)
          + row('Last successful sync', ago(y.last_ok_at)) + (y.snapshot ? row('Status', esc(y.snapshot)) : '')
          + (y.last_error && y.online === false ? row('Last problem', `<span class="muted">${esc(y.last_error)}</span>`) : '');
    } else if (mode === 'mirror') {
      body = row('This server', 'Cloud copy (read-only)') + row('Last update from the shop', ago(y?.last_ingest_at));
    } else if (mode === 'cloud') {
      body = row('This server', 'Main POS (cloud)') + row('Shop PC copy', y?.shop_seen_at ? `Last in touch ${ago(y.shop_seen_at)}` : '<b class="note-red">Not connected yet</b>')
        + row('Last upload from the shop PC', ago(y?.last_ingest_at))
        + '<p class="muted" style="margin:8px 0 0">When the internet drops, staff open the shop PC\'s <b>/start</b> page and carry on there. Offline sales upload here when the internet is back.</p>';
    } else if (mode === 'standby') {
      body = !y?.configured ? '<p class="muted">Shop PC for the cloud POS, but no cloud address is set. Add CLOUD_URL and SYNC_TOKEN.</p>'
        : row('This server', 'Shop PC (takes over when the internet drops)') + row('Cloud POS', esc(y.cloud))
          + row('Copy', !y.ready ? esc(y.snapshot || 'Downloading…') : y.current ? 'Up to date' : `Last download ${ago(y.last_pull_at)}`)
          + row('Internet', y.online === false ? '<b class="note-red">Not reachable. Staff can work here.</b>' : y.online ? 'Connected' : 'Checking…')
          + row('Waiting to upload', `${y.pending} change${y.pending === 1 ? '' : 's'}${y.oldest_pending ? ` (oldest ${ago(y.oldest_pending)})` : ''}`)
          + (y.last_error && y.online ? row('Problem', `<span class="note-red">${esc(y.last_error)}</span>`) : '');
    } else {
      body = `<p class="muted">Single server mode. To keep taking orders when the internet is down, run the POS on a PC in the shop and turn this server into a read-only cloud copy. See <b>SHOP-SERVER.md</b> in the project.</p>`;
    }
    return `<h3 style="margin:0 0 6px">Shop server &amp; cloud sync</h3><div class="sync-box">${body}</div>`;
  }

  function integFormBody() {
    const f = $('#integ-form'); const fd = new FormData(f);
    return { url: fd.get('url'), email: fd.get('email'), variance_limit: fd.get('variance_limit'), events: fd.getAll('events') };
  }
  // The log refreshes itself while the Integrations page is open
  async function integRefreshSoon() { await loadIntegrations(); render(); setTimeout(() => integTick(), 1500); }
  async function integTick() {
    if (S.tab !== 'admin' || S.admin.section !== 'integrations' || S.modal || document.activeElement?.closest('#integ-form')) return;
    try { await loadIntegrations(); const y = $('#admin-list')?.scrollTop; render(); const l = $('#admin-list'); if (l && y) l.scrollTop = y; } catch { /* ignore */ }
  }
  setInterval(integTick, 5000);

  function adminView() {
    if (!isManager()) return '<section class="start"><h1 class="title">Managers only</h1><div class="muted">Sign in with a Manager PIN to open Admin.</div></section>';
    if (!S.admin.data) return '<section class="hist"><div class="empty">Loading…</div></section>';
    return `<section class="admin">
      <aside class="cats scroll"><div class="label">ADMIN</div>
        ${ADMIN_SECTIONS.filter(([id]) => !(S.cfg.demo && id === 'plan')).map(([id, label]) => `<button type="button" class="cat ${S.admin.section === id ? 'on' : ''}" data-act="admin-section" data-id="${id}">${esc(label)}${SECTION_FEATURE[id] ? lockTag(SECTION_FEATURE[id]) : ''}</button>`).join('')}
      </aside>
      <div class="scroll" id="admin-list">${adminList()}</div>
      <aside class="hdetail scroll admin-form">${S.admin.sel?.kind === 'printer' ? printerForm()
        : S.admin.section === 'audit' ? '<div class="empty" style="padding:28px 20px">The audit log is read-only. Entries cannot be edited or deleted.</div>'
        : S.admin.section === 'printers' ? `<div class="empty" style="padding:28px 20px">
            <b>How printing works</b><br><br>1. Add each thermal printer with its IP address (most LAN printers use port 9100).<br><br>
            2. Choose which printer gets bills and which station prints where.<br><br>
            3. Run the print bridge on any PC on the same network. It stays connected and prints jobs within a second.<br><br>
            If no printer is set, the app falls back to the browser print dialog.</div>`
        : S.admin.section === 'integrations' ? `<div class="empty" style="padding:28px 20px">
            <b>Setting up email reports</b><br><br>1. Click <b>Download n8n workflow</b> and import it in n8n (Workflows → Import from file).<br><br>
            2. In n8n, add your SMTP or Gmail login to the <b>Send email</b> node, and paste the signing secret into <b>Check signature</b>.<br><br>
            3. Activate the workflow, copy its <b>Production URL</b> and paste it here. Add the owner's email and save.<br><br>
            4. Click <b>Send test event</b>. The owner should get a test email within a few seconds.<br><br>
            From then on, closing a shift emails the Z-report automatically.</div>`
        : S.admin.section === 'settings'
        ? '<div class="empty" style="padding:28px 20px">Changes apply to every terminal straight away. Tax and service charge changes apply to open and new orders; paid orders keep their totals.</div>'
        : adminForm()}</aside>
    </section>`;
  }

  function readAdminForm() {
    const f = $('#admin-form');
    const fd = new FormData(f);
    const body = Object.fromEntries([...fd.entries()].filter(([k]) => !['has_spice', 'active', 'send_kot'].includes(k)));
    if (f.querySelector('[name="has_spice"]')) body.has_spice = fd.has('has_spice');
    if (f.querySelector('[name="active"]')) body.active = fd.has('active');
    if (f.querySelector('[name="send_kot"]')) body.send_kot = fd.has('send_kot');
    if (S.admin.sel.kind === 'item') {
      body.addons = [...f.querySelectorAll('#addons .addon-row')].map((r) => ({ name: r.querySelector('[data-f="name"]').value, price: r.querySelector('[data-f="price"]').value || 0,
        unit: r.querySelector('[data-f="unit"]').value, max_qty: r.querySelector('[data-f="max"]').value }));
    }
    return body;
  }
  async function adminSave() {
    const s = S.admin.sel;
    const body = readAdminForm();
    const path = `/admin/${ADMIN_PATH[s.kind]}${s.id ? '/' + s.id : ''}`;
    const out = await api(path, { method: s.id ? 'PATCH' : 'POST', body });
    if (s.kind === 'item') {
      const id = s.id || out.id;
      if (S.admin.img) await uploadImage(id, S.admin.img.blob);
      else if (S.admin.imgRemove && s.id) await api(`/admin/items/${id}/image`, { method: 'DELETE' });
      resetImg();
    }
    toast(`${s.id ? 'Saved' : 'Added'} ${body.name || body.code || ADMIN_NOUN[s.kind]}`);
    await afterAdminChange(s.id ? s : null);
  }
  async function afterAdminChange(keepSel) {
    await Promise.all([loadAdmin(), loadFloor(), api('/menu').then((m) => { S.menu = m; })]);
    if (!S.menu.categories.some((c) => c.id === S.cat)) S.cat = S.menu.categories[0]?.id;
    S.admin.sel = keepSel;
    if (S.admin.sel?.kind === 'staff' && S.admin.sel.id === S.user.id) S.user = await api('/me');
    render();
  }

  // ---------- approval / form modal ----------
  // Generic form modal. needPin shows a manager/cashier PIN box when the signed-in role can't approve alone.
  const VOID_REASONS = ['Customer changed mind', 'Wrong item entered', 'Kitchen mistake', 'Out of stock', 'Long wait'];
  const REFUND_REASONS = ['Food quality', 'Wrong order', 'Overcharged', 'Long wait', 'Item not delivered'];
  const CASH_REASONS = { out: ['Supplier payment', 'Bought ingredients', 'Petty cash', 'Bank deposit'], in: ['Extra change', 'Owner top-up', 'Float correction'] };
  const canApprove = (roles) => roles.includes(S.user.role);
  function formModal({ eyebrow = 'Confirm', title, body = '', reasons, roles, submit, onSubmit, wide }) {
    const needPin = roles && !canApprove(roles);
    S.modal = { kind: 'form', eyebrow, title, wide, onSubmit, html: body
      + (reasons ? `<label>Reason</label><div class="chips" style="margin-bottom:8px">${reasons.map((r) => `<button type="button" class="chip" data-act="fill-reason" data-v="${esc(r)}">${esc(r)}</button>`).join('')}</div>
          <input name="reason" maxlength="200" placeholder="Or type a reason" required>` : '')
      + (needPin ? `<label>${roles.join(' or ')} PIN</label><input name="approval_pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off" required placeholder="Ask a ${roles[0].toLowerCase()} to enter their PIN">
          <small class="muted" style="display:block;margin-top:4px">Your role (${esc(S.user.role)}) needs approval for this.</small>` : ''),
      submit };
    renderModal();
  }
  const eq = (i) => i.qty - (i.void_qty || 0);

  // ---------- shift ----------
  async function loadShift() {
    const [cur, list] = await Promise.all([api('/shift'), api('/shifts')]);
    S.shift = cur; S.shifts = list.shifts;
    if (S.shiftSel) S.shiftDetail = await api('/shifts/' + S.shiftSel).catch(() => null);
  }
  const drawerRow = (l, v, cls = '') => `<div class="r ${cls}"><span>${l}</span><span>${v}</span></div>`;
  function shiftCard(sum) {
    const sh = sum.shift;
    const v = sh.counted_cents != null ? sh.counted_cents - sum.expected_cents : null;
    return `<div class="shift-grid">
      <div class="shift-box"><div class="lbl">SALES</div>
        ${drawerRow('Orders paid', sum.sales.orders)}${drawerRow('Covers', sum.sales.covers)}
        ${drawerRow('Gross sales', `<b>${money(sum.sales.gross_cents)}</b>`)}
        ${drawerRow('Discounts', '−' + money(sum.sales.discount_cents))}${drawerRow('Service charge', money(sum.sales.service_cents))}
        ${drawerRow(esc(S.cfg.taxLabel), money(sum.sales.tax_cents))}${drawerRow('Tips', money(sum.sales.tip_cents))}
        ${drawerRow('Refunds', '−' + money(sum.refunds.total_cents))}
        ${drawerRow('Net sales', `<b>${money(sum.sales.gross_cents - sum.refunds.total_cents)}</b>`, 'tot')}</div>
      <div class="shift-box"><div class="lbl">PAYMENTS (after refunds)</div>
        ${['cash', 'card', 'wallet'].map((m) => drawerRow(m[0].toUpperCase() + m.slice(1), money(sum.payments[m] - sum.refunds[m]))).join('')}
        ${(sum.card_brands || []).length ? `<div class="lbl" style="margin-top:12px">CARD BY TYPE <span class="muted">(match with the card machine)</span></div>
          ${sum.card_brands.map((b) => drawerRow(`${esc(b.brand)} <span class="muted">× ${b.n}</span>`, money(b.v))).join('')}` : ''}
        <div class="lbl" style="margin-top:16px">VOIDS</div>
        ${drawerRow(`Items voided (${sum.voids.count})`, money(sum.voids.amount_cents))}${drawerRow('Orders voided', sum.voids.orders)}</div>
      <div class="shift-box drawer"><div class="lbl">CASH DRAWER</div>
        ${drawerRow('Opening float', money(sh.float_cents))}${drawerRow('Cash sales', money(sum.payments.cash))}
        ${drawerRow('Cash refunds', '−' + money(sum.refunds.cash))}${drawerRow('Cash in', money(sum.cash.in_cents))}${drawerRow('Cash out', '−' + money(sum.cash.out_cents))}
        ${drawerRow('Expected in drawer', `<b>${money(sum.expected_cents)}</b>`, 'tot')}
        ${v != null ? drawerRow('Counted', `<b>${money(sh.counted_cents)}</b>`) + drawerRow(v === 0 ? 'Balanced' : v > 0 ? 'Over' : 'Short', `<b>${money(Math.abs(v))}</b>`, v === 0 ? '' : 'bad') : ''}</div>
    </div>
    ${sum.cash.movements.length ? `<div class="shift-box" style="margin-top:12px"><div class="lbl">CASH IN / OUT</div>
      ${sum.cash.movements.map((m) => drawerRow(`${clock(m.created_at)} · ${m.kind === 'in' ? 'In' : 'Out'} · ${esc(m.reason)} <span class="muted">(${esc(m.staff_name || '')})</span>`, (m.kind === 'in' ? '' : '−') + money(m.amount_cents))).join('')}</div>` : ''}
    ${sum.refund_list.length ? `<div class="shift-box" style="margin-top:12px"><div class="lbl">REFUNDS</div>
      ${sum.refund_list.map((r) => drawerRow(`${clock(r.created_at)} · #${r.order_no} · ${esc(r.reason)} <span class="muted">(${r.method})</span>`, '−' + money(r.amount_cents))).join('')}</div>` : ''}`;
  }
  function shiftView() {
    if (!S.shift) return '<section class="hist"><div class="empty">Loading…</div></section>';
    const cur = S.shift.shift ? S.shift : null;
    const d = S.shiftDetail;
    return `<section class="hist">
      <div class="scroll">
        <div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Cash drawer</div><h1 class="title">Shift</h1>
          <div class="muted">${cur ? `Shift ${shiftNo(cur.shift.id)} open since ${clock(cur.shift.opened_at)} · opened by ${esc(cur.shift.opened_by_name || '')}` : 'No shift is open. Open one before taking payments.'}</div></div>
          ${cur ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn" data-act="cash-move" data-kind="in">Cash in</button>
              <button type="button" class="btn" data-act="cash-move" data-kind="out">Cash out</button>
              <button type="button" class="btn" data-act="shift-print" data-id="${cur.shift.id}">Print X report</button>
              <button type="button" class="btn red" data-act="shift-close">Close shift</button></div>` : ''}</div>
        <div style="padding:0 28px 28px">
          ${cur ? `${cur.open_orders ? `<div class="warn" style="margin-top:0">${cur.open_orders} order${cur.open_orders > 1 ? 's are' : ' is'} still open. You can close the shift, but those bills will be taken in the next shift.</div>` : ''}${shiftCard(cur)}`
            : `<form id="shift-open-form" class="shift-open"><div class="field"><label>Opening float (cash in the drawer)</label>
                <input name="float" inputmode="decimal" placeholder="0.00" required></div>
                <button type="submit" class="btn red">Open shift</button></form>`}
          <h3 style="margin:28px 0 8px">Past shifts</h3>
          <table class="htable"><thead><tr><th>Shift</th><th>Opened</th><th>Closed</th><th>Orders</th><th>Gross</th><th>Expected</th><th>Counted</th><th>Variance</th></tr></thead><tbody>
            ${S.shifts.filter((x) => x.status === 'closed').map((x) => { const v = x.counted_cents - x.expected_cents; return `<tr class="${S.shiftSel === x.id ? 'sel' : ''}" data-act="shift-sel" data-id="${x.id}">
              <td><b>#${x.id}</b></td><td>${new Date(x.opened_at).toLocaleString('en-GB', { timeZone: S.cfg.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}<div class="muted" style="font-size:12.5px">${esc(x.opened_by_name || '')}</div></td>
              <td>${clock(x.closed_at)}<div class="muted" style="font-size:12.5px">${esc(x.closed_by_name || '')}</div></td><td>${x.orders}</td><td>${money(x.gross_cents)}</td>
              <td>${money(x.expected_cents)}</td><td>${money(x.counted_cents)}</td><td><span class="s ${v === 0 ? 'paid' : 'ready'}">${v === 0 ? 'Balanced' : (v > 0 ? 'Over ' : 'Short ') + money(Math.abs(v))}</span></td></tr>`; }).join('')
              || '<tr><td colspan="8" class="muted">No closed shifts yet.</td></tr>'}</tbody></table>
        </div>
      </div>
      <aside class="hdetail scroll">${d ? `<div class="hd"><div class="eyebrow">Z report · shift ${shiftNo(d.shift.id)}</div><h2>${money(d.sales.gross_cents - d.refunds.total_cents)}</h2>
          <div class="muted">${esc(d.shift.opened_by_name || '')} → ${esc(d.shift.closed_by_name || '')}${d.shift.note ? ` · ${esc(d.shift.note)}` : ''}</div>
          <button type="button" class="btn" style="margin-top:12px" data-act="shift-print" data-id="${d.shift.id}">Reprint Z report</button></div>
          <div class="sec compact">${shiftCard(d)}</div>`
        : '<div class="empty" style="padding:28px 20px">Select a past shift to see its Z report.</div>'}</aside>
    </section>`;
  }
  function zReportPrint(sum) {
    const P = $('#print'); const sh = sum.shift;
    const r = (a, b) => `<div class="r"><span>${a}</span><span>${b}</span></div>`;
    const v = sh.counted_cents != null ? sh.counted_cents - sum.expected_cents : null;
    P.innerHTML = `${S.cfg.logo ? `<div class="c"><img class="bill-logo" src="${esc(S.cfg.logo)}" alt=""></div>` : ''}<h3>${esc(S.cfg.restaurant)}</h3><div class="c">${sh.status === 'closed' ? 'Z REPORT · SHIFT CLOSE' : 'X REPORT · SHIFT SO FAR'}</div><hr>
      ${r('Shift', '#' + sh.id)}${r('Opened', clock(sh.opened_at) + ' · ' + esc(sh.opened_by_name || ''))}${sh.closed_at ? r('Closed', clock(sh.closed_at) + ' · ' + esc(sh.closed_by_name || '')) : ''}<hr>
      ${r('Orders paid', sum.sales.orders)}${r('Gross sales', money(sum.sales.gross_cents))}${r('Discounts', '-' + money(sum.sales.discount_cents))}
      ${r('Service', money(sum.sales.service_cents))}${r(esc(S.cfg.taxLabel), money(sum.sales.tax_cents))}${r('Tips', money(sum.sales.tip_cents))}
      ${r('Refunds', '-' + money(sum.refunds.total_cents))}<b>${r('Net sales', money(sum.sales.gross_cents - sum.refunds.total_cents))}</b><hr>
      ${['cash', 'card', 'wallet'].map((m) => r(m, money(sum.payments[m] - sum.refunds[m]))).join('')}
      ${(sum.card_brands || []).map((b) => r(`&nbsp;&nbsp;${esc(b.brand)} (${b.n})`, money(b.v))).join('')}<hr>
      ${r('Float', money(sh.float_cents))}${r('Cash sales', money(sum.payments.cash))}${r('Cash refunds', '-' + money(sum.refunds.cash))}
      ${r('Cash in', money(sum.cash.in_cents))}${r('Cash out', '-' + money(sum.cash.out_cents))}<b>${r('Expected', money(sum.expected_cents))}</b>
      ${v != null ? r('Counted', money(sh.counted_cents)) + `<b>${r(v === 0 ? 'Balanced' : v > 0 ? 'Over' : 'Short', money(Math.abs(v)))}</b>` : ''}<hr>
      ${r(`Voided items (${sum.voids.count})`, money(sum.voids.amount_cents))}${r('Voided orders', sum.voids.orders)}
      <br><div>Signature: ____________</div>`;
    window.print();
  }
  // Sri Lankan note/coin counter for closing the drawer
  const DENOMS = [5000, 2000, 1000, 500, 100, 50, 20, 10, 5, 2, 1];

  // ---------- reports ----------
  const isoDay = (d) => d.toLocaleDateString('en-CA', { timeZone: S.cfg.timezone });
  function rangeFor(preset) {
    const now = new Date(); const day = 86400000;
    const today = isoDay(now);
    if (preset === 'today') return [today, today];
    if (preset === 'yesterday') { const y = isoDay(new Date(now - day)); return [y, y]; }
    if (preset === '7d') return [isoDay(new Date(now - 6 * day)), today];
    if (preset === '30d') return [isoDay(new Date(now - 29 * day)), today];
    if (preset === 'month') return [today.slice(0, 8) + '01', today];
    return [S.rep.from, S.rep.to];
  }
  async function loadReport() {
    const [from, to] = rangeFor(S.rep.preset);
    S.rep.from = from; S.rep.to = to;
    S.rep.data = await api(`/reports?from=${from}&to=${to}`);
  }
  function barChart(points, { label, valueFmt = money, height = 180, tickEvery = 1 }) {
    // single-series bar chart, inline SVG; hover shows a tooltip via <title> plus a custom tip
    const max = Math.max(1, ...points.map((p) => p.v));
    const n = points.length; const W = 760; const H = height; const pad = { l: 4, r: 4, t: 10, b: 24 };
    const bw = (W - pad.l - pad.r) / n; const gap = Math.min(6, Math.max(2, bw * 0.25));
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
    const bars = points.map((p, i) => {
      const w = Math.max(1, Math.min(44, bw - gap)); const x = pad.l + i * bw + (bw - w) / 2; const top = y(p.v); const h = H - pad.b - top;
      const r = Math.min(4, w / 2, h);
      const path = h > 0 ? `M${x},${H - pad.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${H - pad.b} Z` : '';
      return `<g class="bar" data-tip="${esc(p.label)}: ${esc(valueFmt(p.v))}${p.extra ? ' · ' + esc(p.extra) : ''}">
        <rect x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" fill="transparent"/>
        ${path ? `<path d="${path}" class="bar-fill"/>` : ''}
        ${i % tickEvery === 0 ? `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle" class="tick">${esc(p.tick)}</text>` : ''}</g>`;
    }).join('');
    const maxLabel = valueFmt(max);
    return `<div class="chart" role="img" aria-label="${esc(label)}"><div class="chart-max muted">Peak ${esc(maxLabel)}</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="bars">
        <line x1="0" x2="${W}" y1="${H - pad.b}" y2="${H - pad.b}" class="axis"/>${bars}</svg><div class="chart-tip hidden"></div></div>`;
  }
  const kpi = (label, value, sub = '') => `<div class="kpi"><div class="lbl">${label}</div><div class="v">${value}</div>${sub ? `<div class="muted sub">${sub}</div>` : ''}</div>`;
  const meterTable = (rows, cols, valueKey = 'cents') => {
    const max = Math.max(1, ...rows.map((r) => r[valueKey]));
    return `<table class="htable rep"><thead><tr>${cols.map((c) => `<th style="${c.right ? 'text-align:right' : ''}">${c.h}</th>`).join('')}</tr></thead><tbody>
      ${rows.map((r) => `<tr>${cols.map((c) => `<td style="${c.right ? 'text-align:right' : ''}" class="${c.meter ? 'meter-cell' : ''}">${c.meter ? `<div class="meter"><i style="width:${(r[valueKey] / max) * 100}%"></i></div>` : ''}${c.f(r)}</td>`).join('')}</tr>`).join('')
      || `<tr><td colspan="${cols.length}" class="muted">Nothing in this period.</td></tr>`}</tbody></table>`;
  };
  function reportsView() {
    if (!isManager()) return '<section class="start"><h1 class="title">Managers only</h1></section>';
    const R = S.rep; const d = R.data;
    const presets = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['custom', 'Custom']];
    const head = `<div class="page-head rep-head" style="border-bottom:0"><div><div class="eyebrow">Reports</div><h1 class="title">Sales</h1>
        <div class="muted">${d ? (d.from === d.to ? d.from : `${d.from} → ${d.to}`) : ''}</div></div>
      <div class="rep-controls no-print">
        <div class="seg">${presets.map(([k, l]) => (['30d', 'month', 'custom'].includes(k) && !can('fullReports')
          ? `<button type="button" class="locked" data-act="upgrade" data-f="fullReports" title="Pro plan">${l} <span class="plan-tag">Pro</span></button>`
          : `<button type="button" class="${R.preset === k ? 'on' : ''}" data-act="rep-preset" data-v="${k}">${l}</button>`)).join('')}</div>
        ${R.preset === 'custom' ? `<form id="rep-range" class="rep-range"><input type="date" name="from" value="${R.from}" required><span>→</span><input type="date" name="to" value="${R.to}" required><button class="btn dark" type="submit">Apply</button></form>` : ''}
        ${can('fullReports') ? '<button type="button" class="btn" data-act="rep-csv">Export CSV</button>' : '<button type="button" class="btn locked" data-act="upgrade" data-f="fullReports">Export CSV <span class="plan-tag">Pro</span></button>'}<button type="button" class="btn" data-act="rep-print">Print / PDF</button>
      </div></div>`;
    if (!d) return `<section class="reports scroll">${head}<div class="empty">Loading…</div></section>`;
    const K = d.kpis;
    const TYPE = (t) => TYPE_LABEL[t] || t;
    const hours = d.by_hour.filter((h, i, a) => a.slice(0, i + 1).some((x) => x.cents) && a.slice(i).some((x) => x.cents));
    return `<section class="reports scroll">${head}
      <div class="rep-body">
        <div class="kpis">
          ${kpi('Net sales', money(K.net_cents), `${money(K.gross_cents)} gross − ${money(K.refunds_cents)} refunds`)}
          ${kpi('Orders', K.orders, `${K.dinein_orders} dine-in · ${K.orders - K.dinein_orders} other`)}
          ${kpi('Average bill', money(K.avg_bill_cents), K.covers ? `${money(K.avg_per_cover_cents)} per cover · ${K.covers} covers` : '')}
          ${kpi('Discounts', money(K.discount_cents), d.discounts.map((x) => `${x.pct}% × ${x.orders}`).join(' · '))}
          ${kpi('Service · ' + esc(S.cfg.taxLabel), money(K.service_cents), `${money(K.tax_cents)} ${esc(S.cfg.taxLabel)} · ${money(K.tip_cents)} tips`)}
          ${kpi('Voids & refunds', money(K.voided_cents + K.refunds_cents), `${K.voided_items} items · ${K.voided_orders} orders voided · ${K.refunds_count} refunds`)}
        </div>
        ${d.days > 1 ? `<div class="rep-card"><h3>Sales by day</h3>${barChart(d.by_day.map((x) => ({ v: x.cents, label: x.day, tick: x.day.slice(8), extra: `${x.orders} orders` })), { label: 'Sales by day', tickEvery: d.days > 16 ? Math.ceil(d.days / 16) : 1 })}</div>` : ''}
        <div class="rep-card"><h3>Busy hours <small class="muted">by order start time</small></h3>${hours.length
          ? barChart(hours.map((h) => ({ v: h.cents, label: `${h.hour}:00–${h.hour + 1}:00`, tick: `${(h.hour % 12) || 12}${h.hour < 12 ? 'a' : 'p'}`, extra: `${h.orders} orders` })), { label: 'Sales by hour', height: 150 })
          : '<div class="muted">No sales in this period.</div>'}</div>
        ${d.stock.has_recipes && can('stock') ? `<div class="rep-card"><h3>Food cost & stock <small class="muted">ingredients valued at average cost when used</small></h3>
          <div class="kpis inner">
            ${kpi('Food & drink sales', money(d.stock.food_sales_cents), 'after discounts, before service & tax')}
            ${kpi('Cost of ingredients', money(d.stock.cogs_cents), 'from recipes of what was sold')}
            ${kpi('Food cost', d.stock.food_cost_pct === null ? '—' : d.stock.food_cost_pct + '%', 'target is usually 28–35%')}
            ${kpi('Gross profit', money(d.stock.gross_profit_cents), 'sales − ingredient cost')}
            ${kpi('Waste', money(d.stock.waste_cents), d.stock.count_loss_cents || d.stock.count_gain_cents ? `count: −${money(d.stock.count_loss_cents)} / +${money(d.stock.count_gain_cents)}` : 'no count differences')}
            ${kpi('Goods received', money(d.stock.purchases_cents), 'supplier invoices in this period')}
          </div></div>` : ''}
        <div class="rep-grid">
          <div class="rep-card"><h3>By category</h3>${meterTable(d.by_category, [{ h: 'Category', f: (r) => esc(r.category), meter: true }, { h: 'Qty', f: (r) => r.qty, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true }])}</div>
          <div class="rep-card"><h3>Top 10 dishes</h3>${meterTable(d.top_items, [{ h: 'Dish', f: (r) => `${esc(r.name)}<div class="muted" style="font-size:12px">${esc(r.category)}</div>`, meter: true }, { h: 'Qty', f: (r) => r.qty, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true }], 'qty')}</div>
          <div class="rep-card"><h3>Slowest dishes <small class="muted">on the menu</small></h3>${meterTable(d.slow_items, [{ h: 'Dish', f: (r) => `${esc(r.name)}<div class="muted" style="font-size:12px">${esc(r.category)}</div>` }, { h: 'Qty', f: (r) => r.qty, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true }])}</div>
          <div class="rep-card"><h3>Order types</h3>${meterTable(d.by_type, [{ h: 'Type', f: (r) => TYPE(r.type), meter: true }, { h: 'Orders', f: (r) => r.orders, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true }])}
            <h3 style="margin-top:22px">Payments</h3>${meterTable(d.by_payment, [{ h: 'Method', f: (r) => (r.method || '').toUpperCase(), meter: true }, { h: 'Taken', f: (r) => money(r.cents), right: true }, { h: 'Refunded', f: (r) => (r.refund_cents ? '−' + money(r.refund_cents) : '—'), right: true }, { h: 'Net', f: (r) => money(r.cents - r.refund_cents), right: true }])}
            ${d.card_brands.length ? `<h3 style="margin-top:22px">Card payments by type</h3>${meterTable(d.card_brands, [{ h: 'Card', f: (r) => esc(r.brand), meter: true }, { h: 'Payments', f: (r) => r.orders, right: true }, { h: 'Amount', f: (r) => money(r.cents), right: true }])}` : ''}</div>
          <div class="rep-card"><h3>Staff</h3>${meterTable(d.staff, [{ h: 'Name', f: (r) => `${esc(r.name)}<div class="muted" style="font-size:12px">${esc(r.role)}</div>`, meter: true }, { h: 'Orders', f: (r) => r.orders, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true }, { h: 'Avg bill', f: (r) => money(r.avg_cents), right: true }, { h: 'Voids', f: (r) => r.voids, right: true }])}</div>
          <div class="rep-card"><h3>Tables</h3>${meterTable(d.tables, [{ h: 'Table', f: (r) => `${esc(r.code)} <span class="muted">${esc(r.area)}</span>`, meter: true }, { h: 'Turns', f: (r) => r.orders, right: true }, { h: 'Covers', f: (r) => r.covers, right: true }, { h: 'Avg time', f: (r) => `${r.avg_minutes} min`, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true }])}</div>
        </div>
        ${d.stock.has_recipes && can('stock') ? `<div class="rep-grid">
          <div class="rep-card"><h3>Profit by dish <small class="muted">current recipe cost</small></h3>${meterTable(d.dish_profit.slice(0, 15), [
            { h: 'Dish', f: (r) => esc(r.name), meter: true }, { h: 'Qty', f: (r) => r.qty, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true },
            { h: 'Cost', f: (r) => (r.cost_cents === null ? '<span class="muted">no recipe</span>' : money(r.cost_cents)), right: true },
            { h: 'Margin', f: (r) => (r.margin_pct === null ? '—' : `<span class="fc ${r.margin_pct < 65 ? 'high' : ''}">${r.margin_pct}%</span>`), right: true }], 'cents')}</div>
          <div class="rep-card"><h3>Waste</h3>${meterTable(d.waste, [
            { h: 'Time', f: (r) => new Date(r.created_at).toLocaleString('en-GB', { timeZone: S.cfg.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) },
            { h: 'Ingredient', f: (r) => `${fq(r.qty)} ${esc(r.unit)} ${esc(r.name)}` }, { h: 'Reason', f: (r) => esc(r.note || '') }, { h: 'By', f: (r) => esc(r.staff_name || '') },
            { h: 'Value', f: (r) => money(r.value_cents), right: true }], 'value_cents')}</div></div>` : ''}
        <div class="rep-card"><h3>Voided items</h3>${meterTable(d.voids, [{ h: 'Time', f: (r) => new Date(r.created_at).toLocaleString('en-GB', { timeZone: S.cfg.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) }, { h: 'Order', f: (r) => '#' + r.order_no }, { h: 'Item', f: (r) => `${r.qty} × ${esc(r.name)}` }, { h: 'Reason', f: (r) => esc(r.reason) }, { h: 'By', f: (r) => esc(r.staff_name || '') }, { h: 'Approved', f: (r) => esc(r.approved_name || '') }, { h: 'Value', f: (r) => money(r.amount_cents), right: true }], 'amount_cents')}</div>
        <div class="rep-card"><h3>Refunds</h3>${meterTable(d.refunds, [{ h: 'Time', f: (r) => new Date(r.created_at).toLocaleString('en-GB', { timeZone: S.cfg.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) }, { h: 'Order', f: (r) => '#' + r.order_no }, { h: 'Method', f: (r) => r.method }, { h: 'Reason', f: (r) => esc(r.reason) }, { h: 'By', f: (r) => esc(r.staff_name || '') }, { h: 'Approved', f: (r) => esc(r.approved_name || '') }, { h: 'Amount', f: (r) => money(r.amount_cents), right: true }], 'amount_cents')}</div>
      </div></section>`;
  }
  function reportCsv() {
    const d = S.rep.data; if (!d) return;
    const m = (c) => (c / 100).toFixed(2);
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const out = [];
    const sec = (title, header, rows) => { out.push(q(title)); out.push(header.map(q).join(',')); rows.forEach((r) => out.push(r.map(q).join(','))); out.push(''); };
    const K = d.kpis;
    sec(`${S.cfg.restaurant} sales report ${d.from} to ${d.to}`, ['Measure', 'Value'], [
      ['Orders', K.orders], ['Gross sales', m(K.gross_cents)], ['Refunds', m(K.refunds_cents)], ['Net sales', m(K.net_cents)],
      ['Subtotal', m(K.subtotal_cents)], ['Discounts', m(K.discount_cents)], ['Service charge', m(K.service_cents)], [S.cfg.taxLabel, m(K.tax_cents)],
      ['Tips', m(K.tip_cents)], ['Average bill', m(K.avg_bill_cents)], ['Covers', K.covers], ['Voided items', K.voided_items], ['Voided value', m(K.voided_cents)], ['Voided orders', K.voided_orders]]);
    sec('Sales by day', ['Date', 'Orders', 'Sales'], d.by_day.map((x) => [x.day, x.orders, m(x.cents)]));
    sec('Sales by hour', ['Hour', 'Orders', 'Sales'], d.by_hour.map((x) => [`${x.hour}:00`, x.orders, m(x.cents)]));
    sec('By category', ['Category', 'Qty', 'Sales'], d.by_category.map((x) => [x.category, x.qty, m(x.cents)]));
    sec('Dishes sold', ['Dish', 'Category', 'Qty', 'Sales'], d.all_items.map((x) => [x.name, x.category, x.qty, m(x.cents)]));
    sec('Order types', ['Type', 'Orders', 'Sales'], d.by_type.map((x) => [TYPE_LABEL[x.type] || x.type, x.orders, m(x.cents)]));
    sec('Payments', ['Method', 'Orders', 'Taken', 'Refunded', 'Net'], d.by_payment.map((x) => [x.method, x.orders, m(x.cents), m(x.refund_cents), m(x.cents - x.refund_cents)]));
    sec('Card payments by type', ['Card', 'Payments', 'Amount'], d.card_brands.map((x) => [x.brand, x.orders, m(x.cents)]));
    sec('Staff', ['Name', 'Role', 'Orders', 'Sales', 'Avg bill', 'Tips', 'Voids'], d.staff.map((x) => [x.name, x.role, x.orders, m(x.cents), m(x.avg_cents), m(x.tip_cents), x.voids]));
    sec('Tables', ['Table', 'Area', 'Turns', 'Covers', 'Avg minutes', 'Sales'], d.tables.map((x) => [x.code, x.area, x.orders, x.covers, x.avg_minutes, m(x.cents)]));
    if (d.stock.has_recipes) {
      const st = d.stock;
      sec('Food cost', ['Measure', 'Value'], [['Food & drink sales', m(st.food_sales_cents)], ['Cost of ingredients', m(st.cogs_cents)], ['Food cost %', st.food_cost_pct],
        ['Gross profit', m(st.gross_profit_cents)], ['Waste', m(st.waste_cents)], ['Count shortage', m(st.count_loss_cents)], ['Count surplus', m(st.count_gain_cents)], ['Goods received', m(st.purchases_cents)]]);
      sec('Profit by dish', ['Dish', 'Qty', 'Sales', 'Cost', 'Profit', 'Margin %'], d.dish_profit.map((x) => [x.name, x.qty, m(x.cents), x.cost_cents === null ? '' : m(x.cost_cents), x.profit_cents === null ? '' : m(x.profit_cents), x.margin_pct ?? '']));
      sec('Waste', ['Time', 'Ingredient', 'Qty', 'Unit', 'Value', 'Reason', 'By'], d.waste.map((x) => [x.created_at, x.name, x.qty, x.unit, m(x.value_cents), x.note, x.staff_name]));
    }
    sec('Voided items', ['Time', 'Order', 'Item', 'Qty', 'Value', 'Reason', 'By', 'Approved by'], d.voids.map((x) => [x.created_at, x.order_no, x.name, x.qty, m(x.amount_cents), x.reason, x.staff_name, x.approved_name]));
    sec('Refunds', ['Time', 'Order', 'Method', 'Amount', 'Reason', 'By', 'Approved by'], d.refunds.map((x) => [x.created_at, x.order_no, x.method, m(x.amount_cents), x.reason, x.staff_name, x.approved_name]));
    const blob = new Blob(['﻿' + out.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `sales-${d.from}_to_${d.to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- admin: printers + audit ----------
  async function loadPrinting() { S.admin.printing = await api('/admin/printing'); }
  async function loadIntegrations() { S.admin.integ = await api('/admin/integrations'); }
  // n8n: where events go, which events, owner email, cash variance limit, signing secret and the delivery log.
  function integrationsList() {
    const I = S.admin.integ;
    if (!I) return '<div class="empty">Loading…</div>';
    const st = (e) => e.status === 'sent' ? '<span class="s paid">Sent</span>'
      : e.status === 'failed' ? '<span class="s ready">Failed</span>' : `<span class="s kitchen">Waiting</span>`;
    const when = (t) => t ? `${new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${clock(t)}` : '—';
    const label = { 'shift.closed': 'Z-report', 'cash.variance': 'Cash variance', test: 'Test' };
    const health = !I.url ? 'Not set up'
      : I.counts.failed ? `<b class="note-red">${I.counts.failed} failed. Check the log below.</b>`
      : I.counts.pending ? `${I.counts.pending} waiting to send${I.log.find((e) => e.status === 'pending' && e.last_error) ? ' · <span class="note-red">n8n not answering</span>' : ''}`
      : I.counts.last_sent ? `Connected · last sent ${ago(I.counts.last_sent)}` : 'Ready. Send a test event.';
    return `<div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Admin</div><h1 class="title">Integrations</h1>
        <div class="muted">Send POS events to n8n. n8n emails the owner the Z-report when a shift closes, and an alert when the cash count is off.</div></div></div>
      ${I.mode === 'mirror' ? '<div class="warn" style="margin:0 28px 18px"><span>This is the cloud copy. Set up n8n on the shop server: events are sent from there.</span></div>' : ''}
      <form id="integ-form" class="settings-form" autocomplete="off">
        <div class="sync-box"><div class="r"><span>Status</span><span>${health}</span></div></div>
        ${field('n8n webhook URL', inp('url', I.url, 'type="url" placeholder="https://your-n8n.example.com/webhook/pos-events"'), 'Production URL of the Webhook node in the "Restaurant POS → email" workflow.')}
        <div class="two">${field('Owner email', inp('email', I.email, 'placeholder="owner@example.com"'), 'Where n8n sends the reports. Several: separate with commas.')}
          ${field(`Cash variance alert at (${esc(S.cfg.currency.trim())})`, inp('variance_limit', (I.variance_limit_cents / 100).toFixed(2), 'inputmode="decimal"'), 'Alert when counted cash is over or short by at least this much. 0 = any difference.')}</div>
        <div class="field"><label>Events to send</label>
          ${Object.entries(I.available).map(([k, v]) => `<label class="check"><input type="checkbox" name="events" value="${k}" ${I.events.includes(k) ? 'checked' : ''}> <b>${k}</b> <span class="muted">· ${esc(v)}</span></label>`).join('')}</div>
        <div class="field"><label>Signing secret</label>
          <div class="secret-row"><input readonly value="${esc(I.secret || 'Created when you save')}" id="integ-secret">
            ${I.secret ? '<button type="button" class="btn" data-act="integ-copy">Copy</button><button type="button" class="btn" data-act="integ-new-secret">New secret</button>' : ''}</div>
          <small>Paste this into the "Check signature" node in n8n. Every request is signed with it, so n8n ignores anything that isn't from this POS.</small></div>
        <div class="integ-actions"><button type="submit" class="btn red">Save</button>
          ${I.url ? '<button type="button" class="btn" data-act="integ-test">Send test event</button><button type="button" class="btn" data-act="integ-resend">Re-send last Z-report</button>' : ''}
          <a class="btn" href="/n8n/restaurant-pos-email.json" download>Download n8n workflow</a></div>
      </form>
      <div class="page-head" style="border-bottom:0;padding-top:6px"><div><h3 style="margin:0">Delivery log</h3><div class="muted">Events wait here while the internet or n8n is down, and are sent in order when it's back.</div></div>
        ${I.counts.failed || I.counts.pending ? '<button type="button" class="btn" data-act="integ-retry-all">Retry now</button>' : ''}</div>
      <div class="htable-wrap"><table class="htable"><thead><tr><th>#</th><th>Event</th><th>Created</th><th>Status</th><th>Tries</th><th>Result</th><th></th></tr></thead><tbody>
        ${I.log.map((e) => `<tr><td>${e.id}</td><td><b>${esc(label[e.event] || e.event)}</b><div class="muted" style="font-size:12px">${esc(e.event)}</div></td><td>${when(e.created_at)}</td><td>${st(e)}</td><td>${e.attempts}</td>
          <td class="muted" style="max-width:260px;font-size:13px">${e.status === 'sent' ? `${when(e.sent_at)} · HTTP ${e.last_status}` : e.last_error ? esc(e.last_error) + (e.status === 'pending' ? `<br>Next try ${clock(e.next_try_at)}` : '') : 'Sending…'}</td>
          <td>${e.status !== 'sent' ? `<button type="button" class="link-red" data-act="integ-retry" data-id="${e.id}">Retry</button>` : ''}</td></tr>`).join('')
          || '<tr><td colspan="7" class="muted" style="padding:20px">No events yet.</td></tr>'}</tbody></table></div><div style="height:28px"></div>`;
  }
  async function loadAudit() { S.admin.audit = (await api('/admin/audit?action=' + encodeURIComponent(S.admin.auditFilter || ''))).entries; }
  function printersList() {
    const P = S.admin.printing;
    if (!P) return '<div class="empty">Loading…</div>';
    const seen = P.bridge_seen ? (Date.now() - new Date(P.bridge_seen)) / 1000 : null;
    const online = seen !== null && seen < 60;
    const opts = (cur) => `<option value="">— None (print in browser) —</option>${P.printers.map((p) => `<option value="${p.id}" ${p.id === cur ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
    const origin = location.origin;
    return `<div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Admin</div><h1 class="title">Printers</h1>
        <div class="muted">Kitchen tickets, void slips, bills and Z reports print automatically through the print bridge.</div></div>
        <button type="button" class="btn dark" data-act="admin-new" data-kind="printer">+ Add printer</button></div>
      <div style="padding:0 28px 28px">
        ${S.cfg.printDirect ? `<div class="bridge on"><div><b>Printing directly from this shop server</b>
          <div class="muted">No print bridge needed: the POS sends jobs straight to the network printers, with or without internet.${online ? '' : ' (Waiting for the print worker…)'}</div></div></div>` : `
        <div class="bridge ${online ? 'on' : ''}"><div><b>Print bridge: ${online ? 'online' : 'offline'}</b>
          <div class="muted">${seen === null ? 'Never connected yet.' : online ? 'Connected and waiting for jobs.' : `Last seen ${new Date(P.bridge_seen).toLocaleString('en-GB', { timeZone: S.cfg.timezone })}.`}</div></div>
          <a class="btn" href="/bridge/print-bridge.js" download>Download print-bridge.js</a></div>`}
        ${S.cfg.printDirect ? '<div class="muted" style="margin-top:10px">USB printers shared from a Windows PC still need the print bridge on that PC.</div>' : ''}
        <div class="field ${S.cfg.printDirect ? 'hidden' : ''}" style="margin-top:14px"><label>Run this on the PC next to the printers (needs Node.js 18 or newer):</label>
          ${P.bridge_token ? `<div class="cmd"><code id="bridge-cmd">node print-bridge.js --server ${esc(origin)} --token ${esc(P.bridge_token)}</code><button type="button" class="btn" data-act="copy-cmd">Copy</button></div>` : '<div class="muted">Create a bridge token first.</div>'}
          <button type="button" class="link-red" style="margin-top:8px" data-act="bridge-token">${P.bridge_token ? 'Regenerate token (the old one stops working)' : 'Create bridge token'}</button></div>
        <h3 style="margin:22px 0 8px">Printers</h3>
        <table class="htable"><thead><tr><th>Name</th><th>Connection</th><th>Address</th><th>Paper</th><th>Status</th><th></th></tr></thead><tbody>
          ${P.printers.map((p) => `<tr class="${S.admin.sel?.kind === 'printer' && S.admin.sel.id === p.id ? 'sel' : ''}" data-act="admin-sel" data-kind="printer" data-id="${p.id}">
            <td class="name"><b>${esc(p.name)}</b></td><td>${p.conn === 'network' ? 'Network' : 'Shared / USB'}</td><td><code>${esc(p.address)}</code></td>
            <td>${p.width_chars >= 42 ? '80 mm' : '58 mm'}</td><td><span class="s ${p.active ? 'paid' : 'void'}">${p.active ? 'Active' : 'Off'}</span></td>
            <td><button type="button" class="link-red" data-act="printer-test" data-id="${p.id}">Test print</button></td></tr>`).join('')
            || '<tr><td colspan="6" class="muted">No printers yet. Add one to start printing automatically.</td></tr>'}</tbody></table>
        <h3 style="margin:26px 0 8px">What prints where</h3>
        <form id="routing-form" class="routing">
          <div class="two">${field('Bills, receipts, refunds & Z reports', `<select name="bill_printer_id">${opts(P.bill_printer_id)}</select>`)}
            ${field('Kitchen tickets (default)', `<select name="kitchen_printer_id">${opts(P.kitchen_printer_id)}</select>`, 'Used for single tickets and stations without their own printer.')}</div>
          <div class="station-routing">${P.stations.map((s) => field(`${esc(s.name)} station`, `<select name="st_${s.id}">${opts(s.printer_id).replace('— None (print in browser) —', '— Use default kitchen printer —')}</select>`)).join('')}</div>
          <button type="submit" class="btn red" style="min-width:180px;text-align:center">Save routing</button>
        </form>
        <h3 style="margin:26px 0 8px">Recent print jobs</h3>
        <table class="htable"><thead><tr><th>Job</th><th>What</th><th>Printer</th><th>Status</th><th>Time</th><th></th></tr></thead><tbody>
          ${P.jobs.map((j) => `<tr><td>#${j.id}</td><td class="name">${esc(j.title)}${j.error ? `<div class="note-red">${esc(j.error)}</div>` : ''}</td><td>${esc(j.printer_name)}</td>
            <td><span class="s ${j.status === 'done' ? 'paid' : j.status === 'failed' ? 'ready' : 'void'}">${({ pending: 'Waiting', sent: 'Printing', done: 'Printed', failed: 'Failed' })[j.status]}</span></td>
            <td>${clock(j.created_at)}</td><td>${j.status === 'failed' || j.status === 'pending' ? `<button type="button" class="link-red" data-act="job-retry" data-id="${j.id}">Retry</button>` : ''}</td></tr>`).join('')
            || '<tr><td colspan="6" class="muted">No print jobs yet.</td></tr>'}</tbody></table>
      </div>`;
  }
  function printerForm() {
    const s = S.admin.sel; const P = S.admin.printing;
    const rec = (s.id && P.printers.find((p) => p.id === s.id)) || { name: '', conn: 'network', address: '', width_chars: 48, active: true };
    return `<form id="printer-form" autocomplete="off">
      <div class="hd"><div class="eyebrow">${s.id ? 'Edit' : 'New'} printer</div><h2>${esc(s.id ? rec.name : 'Add printer')}</h2></div>
      <div class="form-body">
        ${field('Name', inp('name', rec.name, 'required maxlength="40" placeholder="Kitchen XP80"'))}
        ${field('Connection', sel('conn', [['network', 'Network (LAN / Wi-Fi)'], ['share', 'Windows shared or USB device']], rec.conn))}
        ${field('Address', inp('address', rec.address, 'required maxlength="200" placeholder="192.168.1.50:9100"'), 'Network: IP:port (port 9100 by default). Windows shared printer: \\\\localhost\\XP80. Linux USB: /dev/usb/lp0')}
        ${field('Paper width', sel('width_chars', [[48, '80 mm (48 characters)'], [42, '80 mm, large font (42)'], [32, '58 mm (32 characters)']], rec.width_chars))}
        <div class="field">${check('active', rec.active, 'Printer is on')}</div>
      </div>
      <div class="form-foot">
        ${s.id ? '<button type="button" class="btn" data-act="printer-delete">Delete</button>' : '<span></span>'}
        <button type="button" class="btn" data-act="admin-cancel">Cancel</button>
        <button type="submit" class="btn red">Save</button></div></form>`;
  }
  const AUDIT_FILTERS = [['', 'Everything'], ['item.void', 'Item voids'], ['order.void', 'Order voids'], ['order.refund', 'Refunds'], ['order.discount', 'Discounts'], ['item.no_kot', 'Served without KOT'],
    ['bill.', 'Bills & reprints'], ['shift.', 'Shifts'], ['cash.', 'Cash in / out'], ['login', 'Sign-ins'], ['admin.', 'Admin changes']];
  function auditList() {
    const A = S.admin;
    if (!A.audit) return '<div class="empty">Loading…</div>';
    return `<div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Admin</div><h1 class="title">Audit log</h1>
        <div class="muted">Every void, refund, discount, reprint, shift, cash movement, sign-in and admin change. Latest 300.</div></div>
        <select id="audit-filter" class="admin-select" style="width:220px">${AUDIT_FILTERS.map(([v, l]) => `<option value="${v}" ${v === (A.auditFilter || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="htable-wrap"><table class="htable"><thead><tr><th>Time</th><th>What</th><th>Details</th><th>By</th><th>Approved by</th></tr></thead><tbody>
        ${A.audit.map((e) => `<tr><td>${new Date(e.created_at).toLocaleString('en-GB', { timeZone: S.cfg.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}</td>
          <td><span class="s ${/void|refund|failed/.test(e.action) ? 'ready' : 'paid'}">${esc(e.action)}</span></td><td class="name">${esc(e.summary)}</td>
          <td>${esc(e.staff_name || '—')}</td><td>${esc(e.approved_name || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing logged yet.</td></tr>'}
      </tbody></table></div>`;
  }

  // ---------- stock / inventory ----------
  const STOCK_SECTIONS = [['stock', 'Stock levels'], ['recipes', 'Recipes & cost'], ['purchases', 'Receive goods'], ['suppliers', 'Suppliers'], ['reorder', 'Reorder list'], ['count', 'Stock count']];
  const PAY_LABEL = { credit: 'On credit (pay later)', drawer: 'Cash from the drawer', cash: 'Cash (not from drawer)', bank: 'Bank transfer', card: 'Card', cheque: 'Cheque' };
  const fq = (n) => (n === null || n === undefined ? '—' : (+(+n).toFixed(3)).toLocaleString('en-US', { maximumFractionDigits: 3 }));
  const unitCost = (c) => money(Math.round(c));
  const STATUS_TXT = { ok: 'OK', low: 'Low', out: 'Out', hidden: 'Hidden' };
  async function loadInv(what = S.inv.section) {
    const jobs = [api('/inventory').then((d) => { S.inv.data = d; })];
    if (what === 'recipes') jobs.push(api('/inventory/recipes').then((d) => { S.inv.recipes = d.items; }));
    if (what === 'purchases') jobs.push(api('/inventory/purchases').then((d) => { S.inv.purchases = d.purchases; }));
    if (what === 'reorder') jobs.push(api('/inventory/reorder').then((d) => { S.inv.reorder = d.groups; }));
    await Promise.all(jobs);
    const sel = S.inv.sel;
    if (sel?.kind === 'ingredient' && sel.id) S.inv.moves = (await api(`/inventory/ingredients/${sel.id}/moves`)).moves;
    if (sel?.kind === 'supplier' && sel.id) S.inv.supDetail = await api(`/inventory/suppliers/${sel.id}`);
    if (sel?.kind === 'purchase-view') S.inv.purDetail = await api(`/inventory/purchases/${sel.id}`);
  }
  const ingOptions = (cur, blank = 'Pick ingredient') => `<option value="">${blank}</option>` + S.inv.data.ingredients.filter((g) => g.active || g.id === cur)
    .map((g) => `<option value="${g.id}" data-unit="${esc(g.unit)}" data-cost="${g.cost_cents}" ${g.id === cur ? 'selected' : ''}>${esc(g.name)} (${esc(g.unit)})</option>`).join('');
  const supOptions = (cur, blank = '— None —') => `<option value="">${blank}</option>` + S.inv.data.suppliers.filter((x) => x.active || x.id === cur)
    .map((x) => `<option value="${x.id}" ${x.id === cur ? 'selected' : ''}>${esc(x.name)}</option>`).join('');

  function stockHead(title, sub, actions = '') {
    return `<div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Stock</div><h1 class="title">${title}</h1><div class="muted">${sub}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${actions}</div></div>`;
  }
  function stockList() {
    const I = S.inv; const D = I.data;
    if (!D) return '<div class="empty">Loading…</div>';
    const selCls = (kind, id) => (I.sel?.kind === kind && I.sel?.id === id ? 'sel' : '');
    if (I.section === 'stock') {
      if (!D.ingredients.length) {
        return stockHead('Stock levels', 'No ingredients yet.') + `<div class="empty-card"><h3>Start your stock list</h3>
          <p class="muted">Add ingredients one by one, or load a sample set for the Asian menu: 36 ingredients with opening stock, 4 suppliers and recipes for 32 dishes. You can edit or delete all of it afterwards.</p>
          <div style="display:flex;gap:8px"><button type="button" class="btn red" data-act="inv-sample">Load sample ingredients & recipes</button>
          <button type="button" class="btn" data-act="inv-new" data-kind="ingredient">+ Add ingredient</button></div></div>`;
      }
      const q = I.q.trim().toLowerCase();
      const list = D.ingredients.filter((g) => (I.filter === 'all' ? g.active : I.filter === 'hidden' ? !g.active : g.status === I.filter) && (!q || g.name.toLowerCase().includes(q)));
      return stockHead('Stock levels', `${D.stats.count} ingredients · stock worth ${money(D.stats.value_cents)} · ${D.stats.low} low · ${D.stats.out} out${D.stats.owed_cents ? ` · ${money(D.stats.owed_cents)} owed to suppliers` : ''}`,
        `<input id="inv-q" class="admin-search" type="search" placeholder="Search ingredients..." value="${esc(I.q)}">
         <div class="seg">${[['all', 'All'], ['low', `Low (${D.stats.low})`], ['out', `Out (${D.stats.out})`], ['hidden', 'Hidden']].map(([k, l]) => `<button type="button" class="${I.filter === k ? 'on' : ''}" data-act="inv-filter" data-v="${k}">${l}</button>`).join('')}</div>
         <button type="button" class="btn dark" data-act="inv-new" data-kind="ingredient">+ Add ingredient</button>`)
        + `<div class="htable-wrap"><table class="htable"><thead><tr><th>Ingredient</th><th style="text-align:right">In stock</th><th style="text-align:right">Reorder at</th><th style="text-align:right">Avg cost</th><th style="text-align:right">Value</th><th>Status</th></tr></thead><tbody>
          ${list.map((g) => `<tr class="${selCls('ingredient', g.id)}" data-act="inv-sel" data-kind="ingredient" data-id="${g.id}">
            <td class="name"><b>${esc(g.name)}</b><div class="muted" style="font-size:12px">${[g.supplier_name, g.used_in ? `${g.used_in} recipe${g.used_in > 1 ? 's' : ''}` : ''].filter(Boolean).map(esc).join(' · ')}</div></td>
            <td style="text-align:right"><b class="${g.stock <= 0 ? 'note-red' : ''}">${fq(g.stock)}</b> ${esc(g.unit)}</td><td style="text-align:right">${fq(g.reorder_level)} ${esc(g.unit)}</td>
            <td style="text-align:right">${unitCost(g.cost_cents)}/${esc(g.unit)}</td><td style="text-align:right">${money(g.value_cents)}</td>
            <td><span class="stk ${g.status}">${STATUS_TXT[g.status]}</span></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing here.</td></tr>'}
          </tbody></table></div>`;
    }
    if (I.section === 'recipes') {
      if (!I.recipes) return '<div class="empty">Loading…</div>';
      const list = I.recipes.filter((m) => (I.rfilter === 'missing' ? !m.lines.length && m.active : I.rfilter === 'high' ? m.food_cost_pct > 35 : m.active));
      const withR = I.recipes.filter((m) => m.active && m.lines.length);
      const avg = withR.length ? withR.reduce((t, m) => t + m.food_cost_pct, 0) / withR.length : 0;
      return stockHead('Recipes & cost', `${withR.length} of ${I.recipes.filter((m) => m.active).length} dishes have a recipe · average food cost ${avg.toFixed(1)}%`,
        `<div class="seg">${[['all', 'All dishes'], ['missing', 'No recipe'], ['high', 'Food cost over 35%']].map(([k, l]) => `<button type="button" class="${(I.rfilter || 'all') === k ? 'on' : ''}" data-act="inv-rfilter" data-v="${k}">${l}</button>`).join('')}</div>`)
        + `<div class="htable-wrap"><table class="htable"><thead><tr><th>Dish</th><th>Category</th><th style="text-align:right">Price</th><th style="text-align:right">Cost</th><th style="text-align:right">Food cost</th><th style="text-align:right">Can make</th></tr></thead><tbody>
          ${list.map((m) => `<tr class="${selCls('recipe', m.id)}" data-act="inv-sel" data-kind="recipe" data-id="${m.id}">
            <td class="name"><b>${esc(m.name)}</b>${m.stock_out ? ' <span class="stk out">Out</span>' : ''}</td><td>${esc(m.category)}</td>
            <td style="text-align:right">${money(m.price_cents)}</td><td style="text-align:right">${m.lines.length ? money(m.cost_cents) : '—'}</td>
            <td style="text-align:right">${m.food_cost_pct === null ? '<span class="muted">No recipe</span>' : `<span class="fc ${m.food_cost_pct > 35 ? 'high' : ''}">${m.food_cost_pct}%</span>`}</td>
            <td style="text-align:right">${m.can_make === null ? '—' : m.can_make}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing here.</td></tr>'}
          </tbody></table></div>`;
    }
    if (I.section === 'purchases') {
      if (!I.purchases) return '<div class="empty">Loading…</div>';
      return stockHead('Receive goods', 'Record supplier deliveries. Stock and average costs update when you save.',
        `<button type="button" class="btn dark" data-act="inv-new" data-kind="purchase">+ Receive goods</button>`)
        + `<div class="htable-wrap"><table class="htable"><thead><tr><th>Date</th><th>Supplier</th><th>Invoice</th><th style="text-align:right">Items</th><th style="text-align:right">Total</th><th style="text-align:right">Paid</th><th>Status</th></tr></thead><tbody>
          ${I.purchases.map((p) => { const due = p.total_cents - p.paid_cents; return `<tr class="${selCls('purchase-view', p.id)}" data-act="inv-sel" data-kind="purchase-view" data-id="${p.id}">
            <td>${esc(String(p.invoice_date).slice(0, 10))}</td><td class="name"><b>${esc(p.supplier_name || '—')}</b></td><td>${esc(p.invoice_no || '—')}</td>
            <td style="text-align:right">${p.lines}</td><td style="text-align:right"><b>${money(p.total_cents)}</b></td><td style="text-align:right">${money(p.paid_cents)}</td>
            <td><span class="stk ${due <= 0 ? 'ok' : 'low'}">${due <= 0 ? 'Paid' : `Owes ${money(due)}`}</span></td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">No deliveries recorded yet.</td></tr>'}
          </tbody></table></div>`;
    }
    if (I.section === 'suppliers') {
      return stockHead('Suppliers', `${D.suppliers.filter((x) => x.active).length} suppliers · ${money(D.stats.owed_cents)} owed`,
        `<button type="button" class="btn dark" data-act="inv-new" data-kind="supplier">+ Add supplier</button>`)
        + `<div class="htable-wrap"><table class="htable"><thead><tr><th>Supplier</th><th>Phone</th><th style="text-align:right">Bought</th><th style="text-align:right">Paid</th><th style="text-align:right">Balance</th><th>Last delivery</th></tr></thead><tbody>
          ${D.suppliers.map((x) => `<tr class="${selCls('supplier', x.id)}" data-act="inv-sel" data-kind="supplier" data-id="${x.id}">
            <td class="name"><b>${esc(x.name)}</b>${x.active ? '' : ' <span class="muted">(hidden)</span>'}</td><td>${esc(x.phone || '—')}</td>
            <td style="text-align:right">${money(x.purchased_cents)}</td><td style="text-align:right">${money(x.paid_cents)}</td>
            <td style="text-align:right"><b class="${x.balance_cents > 0 ? 'note-red' : ''}">${money(x.balance_cents)}</b></td><td>${x.last_purchase ? esc(String(x.last_purchase).slice(0, 10)) : '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No suppliers yet.</td></tr>'}
          </tbody></table></div>`;
    }
    if (I.section === 'reorder') {
      if (!I.reorder) return '<div class="empty">Loading…</div>';
      const total = I.reorder.reduce((t, g) => t + g.est_cents, 0);
      return stockHead('Reorder list', I.reorder.length ? `Ingredients at or below their reorder level · estimated ${money(total)}` : 'Nothing is low right now.',
        I.reorder.length ? `<button type="button" class="btn" data-act="inv-reorder-print">Print list</button>` : '')
        + `<div style="padding:0 28px 28px">${I.reorder.map((g) => `<div class="rep-card"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
            <h3 style="margin:0">${esc(g.supplier_name)} ${g.supplier_phone ? `<small class="muted">${esc(g.supplier_phone)}</small>` : ''}</h3>
            <div style="display:flex;gap:10px;align-items:center"><span class="muted">≈ ${money(g.est_cents)}</span>
            ${g.supplier_id ? `<button type="button" class="btn dark" data-act="inv-reorder-receive" data-id="${g.supplier_id}">Receive this order</button>` : ''}</div></div>
          <table class="htable rep" style="margin-top:10px"><thead><tr><th>Ingredient</th><th style="text-align:right">In stock</th><th style="text-align:right">Reorder at</th><th style="text-align:right">Order up to</th><th style="text-align:right">Suggested</th><th style="text-align:right">≈ Cost</th></tr></thead><tbody>
          ${g.items.map((i) => `<tr><td><b>${esc(i.name)}</b></td><td style="text-align:right" class="${i.stock <= 0 ? 'note-red' : ''}">${fq(i.stock)} ${esc(i.unit)}</td><td style="text-align:right">${fq(i.reorder_level)}</td>
            <td style="text-align:right">${i.par_level ? fq(i.par_level) : '—'}</td><td style="text-align:right"><b>${fq(i.suggest)} ${esc(i.unit)}</b></td><td style="text-align:right">${money(i.est_cents)}</td></tr>`).join('')}</tbody></table></div>`).join('')
          || '<div class="empty-card"><h3>All stocked up</h3><p class="muted">Ingredients appear here when their stock falls to the reorder level.</p></div>'}</div>`;
    }
    // stock count
    const act = D.ingredients.filter((g) => g.active);
    return stockHead('Stock count', 'Count what is on the shelves. Only the rows you fill in are changed; differences are recorded with their value.',
      `<button type="button" class="btn" data-act="inv-count-print">Print count sheet</button>`)
      + `<form id="count-form" style="padding:0 28px 28px"><table class="htable"><thead><tr><th>Ingredient</th><th style="text-align:right">System says</th><th style="width:150px">Counted</th><th style="text-align:right">Difference</th><th style="text-align:right">Value</th></tr></thead><tbody>
        ${act.map((g) => `<tr><td class="name"><b>${esc(g.name)}</b></td><td style="text-align:right">${fq(g.stock)} ${esc(g.unit)}</td>
          <td><div class="count-in"><input name="c_${g.id}" data-count="${g.id}" data-stock="${g.stock}" data-cost="${g.cost_cents}" data-unit="${esc(g.unit)}" inputmode="decimal" placeholder="—"><span>${esc(g.unit)}</span></div></td>
          <td style="text-align:right" id="cd_${g.id}" class="muted">—</td><td style="text-align:right" id="cv_${g.id}" class="muted">—</td></tr>`).join('')}
        </tbody></table>
        <div class="count-foot"><input name="note" class="admin-search" style="width:320px" placeholder="Note, e.g. Weekly count Sunday night" maxlength="200">
          <span id="count-sum" class="muted">No counts entered</span><button type="submit" class="btn red">Save count</button></div></form>`;
  }

  // ---------- stock: right-hand panel ----------
  function moveLabel(m) {
    return { sale: m.order_no ? `Sold · order #${m.order_no}` : 'Sold', purchase: `Received${m.invoice_no ? ' · ' + esc(m.invoice_no) : ''}`, waste: `Waste · ${esc(m.note || '')}`,
      count: `Count · ${esc(m.note || '')}`, adjust: `Adjusted · ${esc(m.note || '')}`, opening: 'Opening stock' }[m.kind];
  }
  function recipeRow(l = {}) {
    return `<div class="rec-row"><select data-f="ing">${ingOptions(l.ingredient_id)}</select>
      <input data-f="qty" inputmode="decimal" placeholder="Qty" value="${l.qty != null ? +(+l.qty).toFixed(4) : ''}"><span class="rec-unit">${esc(l.unit || '')}</span>
      <span class="rec-cost muted"></span><button type="button" data-act="rec-del" title="Remove">✕</button></div>`;
  }
  function purchaseRow(l = {}) {
    return `<div class="pur-row"><div class="pr1"><select data-f="ing">${ingOptions(l.ingredient_id)}</select><button type="button" data-act="rec-del" title="Remove">✕</button></div>
      <div class="pr2"><label><span>Qty <i class="rec-unit">${esc(l.unit || '')}</i></span><input data-f="qty" inputmode="decimal" placeholder="0" value="${l.qty ?? ''}"></label>
        <label><span>Unit cost</span><input data-f="unit" inputmode="decimal" placeholder="0.00" value="${l.unit_cost ?? ''}"></label>
        <label><span>Line total</span><input data-f="total" inputmode="decimal" placeholder="0.00" value="${l.line_total ?? ''}"></label></div></div>`;
  }
  function stockPanel() {
    const I = S.inv; const s = I.sel; const D = I.data;
    if (!D) return '';
    if (!s) {
      const hints = {
        stock: 'Select an ingredient to edit it, record waste, or see its stock history.',
        recipes: 'Select a dish to set what goes into one portion. Stock comes off automatically when the bill is paid.',
        purchases: 'Select a delivery to see its lines and payments, or receive new goods.',
        suppliers: 'Select a supplier to see deliveries and record payments.',
        reorder: '"Receive this order" opens a delivery form filled in with the suggested amounts. Adjust it to what actually arrived.',
        count: 'Tip: print the count sheet, count in the store room, then enter the figures here.',
      };
      return `<div class="empty" style="padding:28px 20px">${hints[I.section] || ''}</div>`;
    }
    const foot = (del = '') => `<div class="form-foot">${del || '<span></span>'}<button type="button" class="btn" data-act="inv-cancel">Cancel</button><button type="submit" class="btn red">Save</button></div>`;
    if (s.kind === 'ingredient') {
      const g = (s.id && D.ingredients.find((x) => x.id === s.id)) || { name: '', unit: 'kg', reorder_level: 0, par_level: 0, cost_cents: 0, supplier_id: null, active: true, stock: 0 };
      return `<form id="ing-form" autocomplete="off"><div class="hd"><div class="eyebrow">${s.id ? 'Ingredient' : 'New ingredient'}</div><h2>${esc(s.id ? g.name : 'Add ingredient')}</h2>
          ${s.id ? `<div class="muted">${fq(g.stock)} ${esc(g.unit)} in stock · worth ${money(g.value_cents)}</div>
            <div style="display:flex;gap:8px;margin-top:10px"><button type="button" class="btn" data-act="inv-adjust" data-kind="waste">Record waste</button><button type="button" class="btn" data-act="inv-adjust" data-kind="adjust">Adjust</button></div>` : ''}</div>
        <div class="form-body">
          ${field('Name', inp('name', g.name, 'required maxlength="60"'))}
          <div class="two">${field('Unit', sel('unit', D.units.map((u) => [u, u]), g.unit), s.id ? 'Changing the unit does not convert existing quantities.' : '')}
            ${field('Cost per unit', inp('cost', (g.cost_cents / 100).toFixed(2), 'inputmode="decimal"'), 'Updated automatically when goods are received.')}</div>
          <div class="two">${field('Reorder at', inp('reorder_level', g.reorder_level, 'inputmode="decimal"'), 'Shows as Low at or below this.')}
            ${field('Order up to', inp('par_level', g.par_level, 'inputmode="decimal"'), 'Used for the suggested order.')}</div>
          ${field('Usual supplier', `<select name="supplier_id">${supOptions(g.supplier_id)}</select>`)}
          ${s.id ? '' : field('Opening stock', inp('opening_stock', '', 'inputmode="decimal" placeholder="0"'), 'What you have right now.')}
          <div class="field">${check('active', g.active, 'Active')}</div>
          ${s.id && I.moves ? `<div class="field"><label>Recent stock history</label><div class="moves">${I.moves.map((m) => `<div class="mv">
              <span>${new Date(m.created_at).toLocaleString('en-GB', { timeZone: S.cfg.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}</span>
              <span class="what">${moveLabel(m)}${m.staff_name ? ` <span class="muted">· ${esc(m.staff_name)}</span>` : ''}</span>
              <b class="${m.change < 0 ? 'note-red' : ''}">${m.change > 0 ? '+' : ''}${fq(m.change)}</b><span class="muted">${fq(m.stock_after)}</span></div>`).join('') || '<div class="muted">No movements yet.</div>'}</div></div>` : ''}
        </div>${foot()}</form>`;
    }
    if (s.kind === 'recipe') {
      const m = I.recipes.find((x) => x.id === s.id);
      if (!m) return '';
      return `<form id="recipe-form" autocomplete="off"><div class="hd"><div class="eyebrow">Recipe · one portion</div><h2>${esc(m.name)}</h2>
          <div class="muted">${esc(m.category)} · sells for ${money(m.price_cents)}</div></div>
        <div class="form-body">
          ${D.ingredients.length ? `<div id="rec-rows">${(m.lines.length ? m.lines : [{}]).map(recipeRow).join('')}</div>
          <button type="button" class="link-red" data-act="rec-add">+ Add ingredient</button>
          <div class="rec-total" id="rec-total" data-price="${m.price_cents}"></div>
          <small class="muted" style="display:block;margin-top:8px">Quantities are in each ingredient's unit, e.g. 0.12 kg chicken, 2 pcs roti.
            Add-ons are not deducted from stock.</small>` : '<div class="muted">Add ingredients in Stock levels first.</div>'}
        </div>${foot()}</form>`;
    }
    if (s.kind === 'purchase') {
      const pre = s.prefill || {};
      const today = isoDay(new Date());
      return `<form id="purchase-form" autocomplete="off"><div class="hd"><div class="eyebrow">Receive goods</div><h2>New delivery</h2></div>
        <div class="form-body">
          ${field('Supplier', `<select name="supplier_id" required>${supOptions(pre.supplier_id, 'Pick supplier')}</select>`)}
          <div class="two">${field('Invoice no.', inp('invoice_no', '', 'maxlength="40"'))}${field('Invoice date', `<input name="invoice_date" type="date" value="${today}">`)}</div>
          <div class="field"><label>Items received</label>
            <div id="pur-rows">${(pre.lines && pre.lines.length ? pre.lines : [{}, {}]).map(purchaseRow).join('')}</div>
            <button type="button" class="link-red" data-act="pur-add">+ Add line</button>
            <div class="rec-total" id="pur-total"></div></div>
          <div class="two">${field('Payment', sel('pay_method', Object.entries(PAY_LABEL), 'credit'))}${field('Amount paid now', inp('pay_amount', '', 'inputmode="decimal" placeholder="0.00"'))}</div>
          <div class="two">${field('Payment reference', inp('pay_reference', '', 'maxlength="80" placeholder="Cheque / transfer no."'))}${field('Pay by (due date)', '<input name="due_date" type="date">')}</div>
          ${field('Notes', inp('notes', '', 'maxlength="300"'))}
        </div>${foot()}</form>`;
    }
    if (s.kind === 'purchase-view') {
      const p = I.purDetail;
      if (!p) return '<div class="empty">Loading…</div>';
      const due = p.total_cents - p.paid_cents;
      return `<div class="hd"><div class="eyebrow">Delivery · ${esc(String(p.invoice_date).slice(0, 10))}</div><h2>${esc(p.supplier_name || '')}</h2>
          <div class="muted">${p.invoice_no ? 'Invoice ' + esc(p.invoice_no) + ' · ' : ''}received by ${esc(p.staff_name || '')}${p.due_date ? ' · due ' + esc(String(p.due_date).slice(0, 10)) : ''}</div>
          ${due > 0 ? `<button type="button" class="btn dark" style="margin-top:10px" data-act="sup-pay" data-id="${p.supplier_id}" data-purchase="${p.id}" data-due="${due}">Pay ${money(due)}</button>` : ''}</div>
        <div class="sec"><div class="lbl">ITEMS</div>${p.items.map((i) => `<div class="r3"><span>${fq(i.qty)} ${esc(i.unit)}</span><span>${esc(i.name)} <span class="muted">@ ${unitCost(i.unit_cost_cents)}</span></span><span>${money(i.line_cents)}</span></div>`).join('')}
          <div class="r3 tot"><span></span><span>Total</span><span>${money(p.total_cents)}</span></div></div>
        <div class="sec"><div class="lbl">PAYMENTS</div>${p.payments.map((x) => `<div class="r3"><span>${esc(String(x.paid_at).slice(0, 10))}</span><span>${esc(PAY_LABEL[x.method] || x.method)}${x.reference ? ' · ' + esc(x.reference) : ''}</span><span>${money(x.amount_cents)}</span></div>`).join('') || '<div class="muted">Not paid yet.</div>'}
          ${due > 0 ? `<div class="r3 tot"><span></span><span>Still owed</span><span class="note-red">${money(due)}</span></div>` : ''}</div>
        ${p.notes ? `<div class="sec"><div class="lbl">NOTES</div>${esc(p.notes)}</div>` : ''}`;
    }
    if (s.kind === 'supplier') {
      const x = (s.id && D.suppliers.find((y) => y.id === s.id)) || { name: '', phone: '', email: '', address: '', notes: '', active: true, balance_cents: 0 };
      const det = I.supDetail;
      return `<form id="supplier-form" autocomplete="off"><div class="hd"><div class="eyebrow">${s.id ? 'Supplier' : 'New supplier'}</div><h2>${esc(s.id ? x.name : 'Add supplier')}</h2>
          ${s.id ? `<div class="muted">Balance ${money(x.balance_cents)}</div>${x.balance_cents > 0 ? `<button type="button" class="btn dark" style="margin-top:10px" data-act="sup-pay" data-id="${x.id}" data-due="${x.balance_cents}">Record payment</button>` : ''}` : ''}</div>
        <div class="form-body">
          ${field('Name', inp('name', x.name, 'required maxlength="80"'))}
          <div class="two">${field('Phone', inp('phone', x.phone, 'maxlength="30" placeholder="+94 "'))}${field('Email', inp('email', x.email, 'maxlength="80"'))}</div>
          ${field('Address', inp('address', x.address, 'maxlength="200"'))}${field('Notes', inp('notes', x.notes, 'maxlength="300" placeholder="Delivery days, credit terms…"'))}
          <div class="field">${check('active', x.active, 'Active')}</div>
          ${s.id && det ? `<div class="field"><label>Recent deliveries</label>${det.purchases.map((p) => `<div class="r3"><span>${esc(String(p.invoice_date).slice(0, 10))}</span><span>${esc(p.invoice_no || '—')}</span><span>${money(p.total_cents)}</span></div>`).join('') || '<div class="muted">None</div>'}</div>
            <div class="field"><label>Payments</label>${det.payments.map((p) => `<div class="r3"><span>${esc(String(p.paid_at).slice(0, 10))}</span><span>${esc(PAY_LABEL[p.method] || p.method)}${p.reference ? ' · ' + esc(p.reference) : ''}</span><span>${money(p.amount_cents)}</span></div>`).join('') || '<div class="muted">None</div>'}</div>` : ''}
        </div>${foot()}</form>`;
    }
    return '';
  }
  function stockView() {
    if (!isManager()) return '<section class="start"><h1 class="title">Managers only</h1></section>';
    if (!can('stock')) return upgradeView('stock');
    return `<section class="admin">
      <aside class="cats scroll"><div class="label">STOCK</div>
        ${STOCK_SECTIONS.map(([id, label]) => `<button type="button" class="cat ${S.inv.section === id ? 'on' : ''}" data-act="inv-section" data-id="${id}">${label}${id === 'reorder' && S.floor?.stats?.stock_alerts ? `<small class="note-red">${S.floor.stats.stock_alerts}</small>` : ''}</button>`).join('')}
      </aside>
      <div class="scroll" id="inv-list">${stockList()}</div>
      <aside class="hdetail scroll admin-form">${stockPanel()}</aside>
    </section>`;
  }
  // live sums in the recipe / purchase / count forms
  function updateRecipeTotal() {
    const box = $('#rec-total'); if (!box) return;
    let total = 0;
    document.querySelectorAll('#rec-rows .rec-row').forEach((r) => {
      const o = r.querySelector('select').selectedOptions[0];
      const qty = parseFloat(r.querySelector('[data-f="qty"]').value);
      const cost = o && o.value ? +o.dataset.cost : 0;
      r.querySelector('.rec-unit').textContent = o && o.value ? o.dataset.unit : '';
      const line = Number.isFinite(qty) ? qty * cost : 0;
      r.querySelector('.rec-cost').textContent = line ? money(Math.round(line)) : '';
      total += line;
    });
    const price = +box.dataset.price;
    const pct = price ? (total / price) * 100 : 0;
    box.innerHTML = `<span>Cost per portion <b>${money(Math.round(total))}</b></span><span>Food cost <b class="fc ${pct > 35 ? 'high' : ''}">${pct.toFixed(1)}%</b></span><span>Profit <b>${money(Math.round(price - total))}</b></span>`;
  }
  function updatePurchaseTotal(changed) {
    const box = $('#pur-total'); if (!box) return;
    let total = 0;
    document.querySelectorAll('#pur-rows .pur-row').forEach((r) => {
      const o = r.querySelector('select').selectedOptions[0];
      r.querySelector('.rec-unit').textContent = o && o.value ? o.dataset.unit : '';
      const qty = parseFloat(r.querySelector('[data-f="qty"]').value);
      const u = r.querySelector('[data-f="unit"]'); const t = r.querySelector('[data-f="total"]');
      if (changed && r.contains(changed) && Number.isFinite(qty) && qty > 0) {
        if (changed === u && u.value !== '') t.value = (parseFloat(u.value) * qty).toFixed(2);
        else if (changed === t && t.value !== '') u.value = (parseFloat(t.value) / qty).toFixed(2);
        else if (changed.dataset.f === 'qty' && u.value !== '') t.value = (parseFloat(u.value) * qty).toFixed(2);
      }
      if (changed && changed.tagName === 'SELECT' && r.contains(changed) && o && o.value && u.value === '') u.value = (+o.dataset.cost / 100).toFixed(2);
      const lt = parseFloat(t.value);
      if (Number.isFinite(lt)) total += lt;
    });
    box.innerHTML = `<span>Invoice total <b>${money(Math.round(total * 100))}</b></span>`;
  }
  function updateCount() {
    let n = 0; let loss = 0; let gain = 0;
    document.querySelectorAll('[data-count]').forEach((x) => {
      const id = x.dataset.count; const dEl = $('#cd_' + id); const vEl = $('#cv_' + id);
      if (x.value === '') { dEl.textContent = '—'; vEl.textContent = '—'; dEl.className = vEl.className = 'muted'; return; }
      const diff = parseFloat(x.value) - parseFloat(x.dataset.stock);
      if (!Number.isFinite(diff)) return;
      n++;
      const val = Math.round(Math.abs(diff) * +x.dataset.cost);
      if (diff < 0) loss += val; else gain += val;
      dEl.textContent = `${diff > 0 ? '+' : ''}${fq(diff)} ${x.dataset.unit}`;
      vEl.textContent = diff ? (diff < 0 ? '−' : '+') + money(val) : '';
      dEl.className = vEl.className = diff < 0 ? 'note-red' : diff > 0 ? '' : 'muted';
    });
    const sum = $('#count-sum');
    if (sum) sum.textContent = n ? `${n} counted · short ${money(loss)} · over ${money(gain)}` : 'No counts entered';
  }
  function printSimple(title, rowsHtml) {
    $('#print').innerHTML = `<h3>${esc(S.cfg.restaurant)}</h3><div class="c">${esc(title)}</div><div class="c">${new Date().toLocaleString('en-GB', { timeZone: S.cfg.timezone })}</div><hr>${rowsHtml}`;
    window.print();
  }

  // ---------- modals ----------
  function renderModal() {
    const m = S.modal;
    if (!m) { modalEl.innerHTML = ''; return; }
    let html = '';
    if (m.kind === 'options') {
      const i = m.item;
      const price = (i.price_cents + i.addons.reduce((s, a) => s + a.price_cents * (m.addons.get(a.id) || 0), 0)) * m.qty;
      html = `<div class="modal">
        <div class="modal-head"><div><div class="eyebrow">${esc(m.catName)} · ${esc(i.station_name)} station · ${money(i.price_cents)}</div><h2>${esc(i.name)}</h2></div></div>
        <div class="modal-body">
          ${i.has_spice ? `<div class="msec"><div class="hd"><b>Spice level</b><small>Prints on the ticket</small></div>
            <div class="chips">${SPICE.map(([n, d]) => `<button type="button" class="chip ${m.spice === n ? 'on' : ''}" data-act="opt-spice" data-v="${n}">${n}<small>${d}</small></button>`).join('')}</div></div>` : ''}
          ${i.addons.length ? `<div class="msec"><div class="hd"><b>Add-ons</b><small>Quantity per dish${m.qty > 1 ? ` · ×${m.qty} dishes` : ''}</small></div>
            <div class="aq-list">${i.addons.map((a) => { const n = m.addons.get(a.id) || 0; const max = a.max_qty || 5;
              return `<div class="aq ${n ? 'on' : ''}">
                <button type="button" class="aq-name" data-act="opt-addon" data-id="${a.id}"><b>${esc(a.name)}</b><small>${money(a.price_cents)}${a.unit ? ' per ' + esc(a.unit) : ''}</small></button>
                <div class="stepper sm"><button type="button" data-act="opt-aq" data-id="${a.id}" data-d="-1" ${n ? '' : 'disabled'} aria-label="Less ${esc(a.name)}">−</button><span>${n}</span><button type="button" data-act="opt-aq" data-id="${a.id}" data-d="1" ${n >= max ? 'disabled' : ''} aria-label="More ${esc(a.name)}">+</button></div>
                <span class="aq-tot">${n ? '+' + money(n * a.price_cents) : ''}</span></div>`; }).join('')}</div></div>` : ''}
          <div class="msec"><div class="hd"><b>Course</b><small>Mains and desserts can be held until fired</small></div>
            <div class="chips">${COURSES.map((c) => `<button type="button" class="chip ${m.course === c ? 'on' : ''}" data-act="opt-course" data-v="${c}">${COURSE_LABEL[c]}${c === m.defCourse ? '<small>Default</small>' : ''}</button>`).join('')}</div></div>
          <div class="msec"><div class="hd"><b>Kitchen ticket</b><small>${m.item.no_kot ? 'This dish is ready-made by default' : 'Untick if it is already cooked'}</small></div>
            <div class="chips"><button type="button" class="chip ${m.sendKot ? 'on' : ''}" data-act="opt-kot" data-v="1">Send to kitchen<small>Prints a KOT</small></button>
              <button type="button" class="chip ${!m.sendKot ? 'on' : ''}" data-act="opt-kot" data-v="0">Already prepared<small>Served now, no KOT</small></button></div></div>
          <div class="msec" style="border-bottom:0"><div class="hd"><b>Kitchen note</b><small>Allergies, no onion, etc.</small></div>
            <textarea id="opt-note" rows="2" maxlength="200" placeholder="e.g. No peanuts">${esc(m.note)}</textarea></div>
        </div>
        <div class="modal-foot">
          <div class="stepper"><button type="button" data-act="opt-qty" data-d="-1">−</button><span>${m.qty}</span><button type="button" data-act="opt-qty" data-d="1">+</button></div>
          <div class="grow"></div>
          <button type="button" class="btn" data-act="close-modal">Cancel</button>
          <button type="button" class="btn red" data-act="opt-add"><span>Add to order</span><span>${money(price)}</span></button>
        </div></div>`;
    } else if (m.kind === 'kot') {
      const tickets = kotGroups(m.mode, m.hold);
      const o = S.order;
      html = `<div class="modal wide">
        <div class="modal-head"><div><div class="eyebrow">Review before sending</div><h2>${tickets.length} ticket${tickets.length > 1 ? 's' : ''} for ${esc(orderTitle(o))}</h2></div>
          <div class="seg"><button type="button" class="${m.mode === 'station' ? 'on' : ''}" data-act="kot-mode" data-v="station">Per station</button><button type="button" class="${m.mode === 'single' ? 'on' : ''}" data-act="kot-mode" data-v="single">Single ticket</button></div></div>
        <div class="modal-body kot-preview">${tickets.map((t) => `
          <div class="kot"><div class="kh"><div class="a"><span>KOT · NEW</span><span>${esc((t.station?.name || 'ALL').toUpperCase())}</span></div>
            <h4>${esc(orderTitle(o))}</h4><div class="muted" style="font-size:13px">${clock(Date.now())} · ${esc(S.user.name)}${o.type === 'dinein' ? ` · ${o.guests} guests` : ''}</div>
            ${o.kots.length ? '<span class="flag">ADD-ON</span>' : ''}${t.held ? '<span class="flag hold">HOLD</span>' : ''}</div>
            ${t.items.map((i) => `<div class="ki"><span>${i.qty}</span><span>${esc(i.name)}${modsHtml(i) ? `<small>${modsHtml(i)}</small>` : ''}</span></div>`).join('')}
            <div class="kf">→ ${esc(t.station?.printer || 'Expo printer')}</div></div>`).join('')}
        </div>
        <div class="modal-foot">
          <button type="button" class="chip ${m.hold ? 'on' : ''}" data-act="kot-hold">Hold mains & desserts</button>
          <span class="muted grow">${m.hold ? 'Mains and desserts wait on hold until the kitchen fires them.' : 'All tickets fire immediately.'}</span>
          <button type="button" class="btn" data-act="close-modal">Keep editing</button>
          <button type="button" class="btn red" data-act="kot-send"><span>Send ${tickets.length} ticket${tickets.length > 1 ? 's' : ''}</span></button>
        </div></div>`;
    } else if (m.kind === 'customer') {
      html = `<div class="modal"><div class="modal-head"><div><div class="eyebrow">New order</div><h2>${TYPE_LABEL[m.type]}</h2></div></div>
        <div class="modal-body"><div class="msec" style="border-bottom:0">
          <label>Customer name</label><input id="c-name" maxlength="80" autocomplete="off">
          <label>Phone</label><input id="c-phone" maxlength="20" inputmode="tel" placeholder="+94 ">
          ${m.type === 'delivery' ? '<label>Delivery address</label><textarea id="c-addr" rows="3" maxlength="300"></textarea>' : ''}
        </div></div>
        <div class="modal-foot"><div class="grow"></div><button type="button" class="btn" data-act="close-modal">Cancel</button>
          <button type="button" class="btn red" data-act="customer-go"><span>Start order</span></button></div></div>`;
    } else if (m.kind === 'form') {
      html = `<form class="modal ${m.wide ? 'wide' : ''}" id="modal-form" style="width:min(${m.wide ? 640 : 520}px,100%)" autocomplete="off">
        <div class="modal-head"><div><div class="eyebrow">${esc(m.eyebrow)}</div><h2 style="font-size:24px">${esc(m.title)}</h2></div></div>
        <div class="modal-body"><div class="msec form-modal" style="border-bottom:0">${m.html}</div></div>
        <div class="modal-foot"><div class="grow"></div><button type="button" class="btn" data-act="close-modal">Back</button>
          <button type="submit" class="btn red"><span>${esc(m.submit)}</span></button></div></form>`;
    } else if (m.kind === 'confirm') {
      html = `<div class="modal" style="width:min(460px,100%)"><div class="modal-head"><div><div class="eyebrow">${esc(m.eyebrow || 'Confirm')}</div><h2 style="font-size:24px">${esc(m.title)}</h2></div></div>
        <div class="modal-body"><div class="msec" style="border-bottom:0">${esc(m.text)}</div></div>
        <div class="modal-foot"><div class="grow"></div><button type="button" class="btn" data-act="close-modal">Back</button>
          <button type="button" class="btn red" data-act="confirm-yes"><span>${esc(m.yes)}</span></button></div></div>`;
    }
    modalEl.innerHTML = `<div class="overlay" data-act="overlay">${html}</div>`;
    if (m.kind === 'customer') setTimeout(() => $('#c-name')?.focus(), 30);
    if (m.kind === 'form') setTimeout(() => $('#modal-form input:not([type=hidden])')?.focus(), 30);
  }

  function kotGroups(mode, hold) {
    const pending = S.order.items.filter(isPending);
    const groups = new Map();
    for (const it of pending) {
      const held = hold && (it.course === 'main' || it.course === 'dessert');
      const key = `${mode === 'single' ? 'all' : it.station_id}|${held}`;
      if (!groups.has(key)) groups.set(key, { station: mode === 'single' ? null : S.menu.stations.find((s) => s.id === it.station_id), held, items: [] });
      groups.get(key).items.push(it);
    }
    return [...groups.values()];
  }

  // ---------- bill language (English / Tamil / Sinhala) ----------
  const BILL_LANGS = ['en', 'ta', 'si'];
  const billLang = () => (BILL_LANGS.includes(S.billLang) ? S.billLang : (S.cfg.billLang || 'en'));
  const BT = (l = billLang()) => (S.cfg.billText && S.cfg.billText[l]) || (S.cfg.billText && S.cfg.billText.en) || {};
  const billLangButtons = () => BILL_LANGS.map((l) => `<button type="button" class="${billLang() === l ? 'on' : ''}" data-act="bill-lang" data-v="${l}" aria-pressed="${billLang() === l}">${esc(BT(l).langName || l)}</button>`).join('');
  const localName = (i, l) => (l === 'ta' && i.name_ta) || (l === 'si' && i.name_si) || i.name;
  const localCfg = (key, l, c = S.cfg) => (l === 'ta' && c[key + 'Ta']) || (l === 'si' && c[key + 'Si']) || c[key];

  // One bill line: the dish at its own price, then each add-on with its price (they add up to the subtotal)
  const billLinesHtml = (r, l = 'en') => (i) => {
    const q = eq(i); const L = BT(l);
    return r(`${q} x ${esc(localName(i, l))}`, money(q * i.unit_price_cents))
      + (i.spice ? `<div class="mod">&nbsp;&nbsp;&nbsp;&nbsp;${esc(L.spice || 'Spice')}: ${esc((L.spiceLevels || {})[i.spice] || i.spice)}</div>` : '')
      + (i.addons || []).map((a) => { const n = q * aq(a);
        return r(`&nbsp;&nbsp;&nbsp;&nbsp;+ ${esc(l === 'en' ? addonLabel(a, n) : `${a.name}${n > 1 ? ` × ${n}` : ''}`)}`, money(n * a.price_cents)); }).join('');
  };

  // Header for browser-printed bills (and the preview in Settings)
  function billHeaderHtml(c = S.cfg, l = 'en') {
    const L = BT(l);
    const lines = String(localCfg('address', l, c) || '').split('\n').filter(Boolean);
    return `${S.cfg.logo ? `<div class="c"><img class="bill-logo" src="${esc(S.cfg.logo)}" alt=""></div>` : ''}
      <h3>${esc(localCfg('restaurant', l, c))}</h3>${lines.map((x) => `<div class="c">${esc(x)}</div>`).join('')}
      ${c.phone ? `<div class="c">${esc(L.tel || 'Tel')}: ${esc(c.phone)}</div>` : ''}${c.email || c.website ? `<div class="c">${[c.email, c.website].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
      ${c.regNo ? `<div class="c">${esc(L.regNo || 'Reg. No')}: ${esc(c.regNo)}</div>` : ''}${c.terminal ? `<div class="c">${esc(c.terminal)}</div>` : ''}`;
  }
  // Turn an uploaded logo into (1) a PNG for the screen and (2) a dithered 1-bit raster for thermal printers.
  async function processLogo(file) {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file');
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => { throw new Error('Could not read that image'); });
    // screen copy: max 600 px, PNG keeps transparency
    const k1 = Math.min(1, 600 / Math.max(bmp.width, bmp.height));
    const c1 = document.createElement('canvas'); c1.width = Math.round(bmp.width * k1); c1.height = Math.round(bmp.height * k1);
    c1.getContext('2d').drawImage(bmp, 0, 0, c1.width, c1.height);
    const image = c1.toDataURL('image/png');
    // print copy: fits 384 × 160 dots (works on 58 mm and 80 mm), width a multiple of 8
    const k2 = Math.min(384 / bmp.width, 160 / bmp.height, 1.5);
    const w = Math.max(8, Math.round((bmp.width * k2) / 8) * 8); const h = Math.max(1, Math.round(bmp.height * k2));
    const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
    const g = c2.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h);
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = 0.299 * px.data[i * 4] + 0.587 * px.data[i * 4 + 1] + 0.114 * px.data[i * 4 + 2];
    const bits = new Uint8Array((w / 8) * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) { // Floyd–Steinberg dithering
        const i = y * w + x; const old = lum[i]; const black = old < 128; const err = old - (black ? 0 : 255);
        if (black) bits[y * (w / 8) + (x >> 3)] |= 0x80 >> (x & 7);
        if (x + 1 < w) lum[i + 1] += err * 7 / 16;
        if (y + 1 < h) { if (x > 0) lum[i + w - 1] += err * 3 / 16; lum[i + w] += err * 5 / 16; if (x + 1 < w) lum[i + w + 1] += err / 16; }
      }
    }
    // preview of the printed result
    const out = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const on = bits[y * (w / 8) + (x >> 3)] & (0x80 >> (x & 7)); const j = (y * w + x) * 4;
      out.data[j] = out.data[j + 1] = out.data[j + 2] = on ? 0 : 255; out.data[j + 3] = 255;
    }
    g.putImageData(out, 0, 0);
    let bin = ''; for (const b of bits) bin += String.fromCharCode(b);
    return { image, raster: { w, h, data: btoa(bin) }, preview: c2.toDataURL('image/png') };
  }

  // ---------- print ----------
  async function printBill(o, l = billLang(), label = 'bill') {
    const P = $('#print'); const L = BT(l); const en = l === 'en';
    const r = (a, b) => `<div class="r"><span>${a}</span><span>${b}</span></div>`;
    const head = o.type === 'dinein' ? `${L.table} ${o.table_code}` : `${(L.types || {})[o.type] || o.type} #${o.order_no}`;
    const footer = en ? S.cfg.billFooter : (localCfg('billFooter', l) !== S.cfg.billFooter ? localCfg('billFooter', l) : L.footer);
    P.className = en ? '' : 'local';
    P.innerHTML = `${billHeaderHtml(S.cfg, l)}<hr>
      ${label !== 'bill' ? `<div class="c"><b>*** ${esc(L[label] || label)} ***</b></div>` : ''}
      <div>${esc(head)} · ${esc(L.order)} #${o.order_no}</div><div>${new Date().toLocaleString('en-GB', { timeZone: S.cfg.timezone })}</div>
      <div>${esc(L.server)}: ${esc(o.staff_name || '')}${o.type === 'dinein' ? ` · ${esc(L.guests)}: ${o.guests}` : ''}</div>
      ${o.customer_name ? `<div>${esc(L.customer)}: ${esc(o.customer_name)}</div>` : ''}${o.phone ? `<div>${esc(L.contact)}: ${esc(o.phone)}</div>` : ''}
      ${o.type === 'delivery' && o.address ? `<div>${esc(L.deliverTo)}: ${esc(o.address)}</div>` : ''}<hr>
      ${o.items.filter((i) => eq(i) > 0).map(billLinesHtml(r, l)).join('')}<hr>
      ${r(esc(L.subtotal), money(o.subtotal_cents))}
      ${o.discount_cents ? r(`${esc(L.discount)} ${o.discount_pct}%`, '-' + money(o.discount_cents)) : ''}
      ${o.service_on ? r(`${esc(L.service)} ${pct(S.cfg.serviceRate)}`, money(o.service_cents)) : ''}
      ${r(`${esc(S.cfg.taxLabel)} ${pct(S.cfg.taxRate)}`, money(o.tax_cents))}
      ${o.tip_cents ? r(`${esc(L.tip)} ${o.tip_pct}%`, money(o.tip_cents)) : ''}<hr>
      <b>${r(esc(L.total), money(o.total_cents))}</b>
      ${o.split_ways > 1 ? r(`${esc(L.perPerson)} (${o.split_ways})`, money(Math.ceil(o.total_cents / o.split_ways))) : ''}
      ${o.status === 'paid' ? r(esc(L.paidBy), esc((L.methods || {})[o.payment_method] || (o.payment_method || '').toUpperCase())) : ''}
      ${o.status === 'paid' && o.payment_method === 'card' && o.card_last4 ? r(esc(L.card), `${esc(o.card_brand || '')} **** ${esc(o.card_last4)}`) + (o.card_auth ? r(esc(L.approval), esc(o.card_auth)) : '') : ''}
      ${o.status === 'paid' && o.payment_method === 'cash' && o.cash_received_cents != null ? r(esc(L.cashReceived), money(o.cash_received_cents)) + r(esc(L.change), money(o.change_cents || 0)) : ''}
      ${label !== 'bill' ? (o.refunds || []).map((x) => r(`${esc(L.refund)} (${esc((L.methods || {})[x.method] || x.method)})`, '-' + money(x.amount_cents))).join('') : ''}
      <hr>${footer ? `<div class="c">${esc(footer)}</div>` : ''}`;
    // wait for the Tamil / Sinhala font before the print dialog opens
    if (!en && document.fonts) { try { await document.fonts.load(`12px "${l === 'ta' ? 'Noto Sans Tamil' : 'Noto Sans Sinhala'}"`, P.textContent); await document.fonts.ready; } catch { /* print anyway */ } }
    window.print();
  }

  // ---------- render ----------
  function render() {
    if (!S.user) return renderLogin();
    let view = '';
    if (S.tab === 'floor') view = floorView();
    else if (S.tab === 'order') view = orderView();
    else if (S.tab === 'kitchen') view = kitchenView();
    else if (S.tab === 'bill') view = billView();
    else if (S.tab === 'history') view = historyView();
    else if (S.tab === 'admin') view = adminView();
    else if (S.tab === 'shift') view = shiftView();
    else if (S.tab === 'reports') view = reportsView();
    else if (S.tab === 'stock') view = stockView();
    // preserve focus/caret in search box across re-renders
    const active = document.activeElement?.id;
    const caret = active === 'search' ? document.activeElement.selectionStart : null;
    const scrolls = [...root.querySelectorAll('.scroll, .ticket-lines, .kcol-b')].map((e) => e.scrollTop);
    const mirrorBar = S.cfg.mode === 'mirror' ? `<div class="mirror-bar"><b>Cloud copy, read-only.</b> Orders, payments and changes are made on the POS in the shop and appear here automatically${S.sync?.last_ingest_at ? ` (last update ${ago(S.sync.last_ingest_at)})` : ''}.</div>` : '';
    root.innerHTML = `<div class="app">${header()}${mirrorBar}${standbyBar()}${licenceBar()}${demoBar()}<main>${view}</main></div>`;
    [...root.querySelectorAll('.scroll, .ticket-lines, .kcol-b')].forEach((e, i) => { if (scrolls[i]) e.scrollTop = scrolls[i]; });
    if (active === 'search') { const s = $('#search'); s.focus(); if (caret !== null) s.setSelectionRange(caret, caret); }
    if ($('#rec-total')) updateRecipeTotal();
    if ($('#pur-total')) updatePurchaseTotal();
    renderModal();
  }

  // ---------- actions ----------
  async function openOrder(id, tab = 'order') {
    if (S.order?.id !== +id) { S.payCard = { brand: '', last4: '', auth: '' }; S.cashIn = ''; }
    await loadOrder(id);
    S.tab = tab; S.search = '';
    render();
  }

  // Orders can only start while a shift is open
  // The menu category the order screen opens on: Admin → Settings, else "Sri Lankan", else the first
  function defaultCat() {
    const cats = S.menu?.categories || [];
    const set = cats.find((c) => String(c.id) === String(S.cfg.defaultCategory || ''));
    return (set || cats.find((c) => /sri\s*lankan/i.test(c.name)) || cats[0])?.id;
  }
  // Cashiers start on the menu with a new counter sale; everyone else on the floor plan
  const isCashier = () => S.user?.role === 'Cashier';
  function goHome() {
    S.order = null; S.search = ''; S.cat = defaultCat();
    if (isCashier()) { S.tab = 'order'; S.draft = true; } else { S.tab = 'floor'; S.draft = false; }
  }
  // A counter sale that only exists once the first dish is added (so no empty orders are left open)
  async function ensureOrder() {
    if (S.order) return true;
    if (!S.draft || needShift()) return false;
    S.order = await api('/orders', { body: { type: 'counter' } });
    S.draft = false; S.payMethod = 'card'; S.payCard = { brand: '', last4: '', auth: '' }; S.cashIn = '';
    loadFloor().catch(() => {});
    return true;
  }

  function needShift() {
    if (S.shift?.shift) return false;
    S.modal = { kind: 'confirm', title: 'Open a shift first',
      text: 'New orders can only be started while a shift is open, so every sale is counted in a cash drawer. Open the shift with the opening float, then take orders.',
      yes: 'Go to Shift', run: async () => { S.modal = null; await setTab('shift'); } };
    renderModal();
    return true;
  }
  const shiftBanner = () => (S.shift && !S.shift.shift ? `<div class="shift-banner"><span><b>No shift is open.</b> Open a shift to start taking orders.</span>
    <button type="button" class="btn red" data-act="tab" data-tab="shift">Open shift</button></div>` : '');

  async function createOrder(body) {
    const o = await api('/orders', { body });
    S.order = o; S.tab = 'order'; S.search = ''; S.modal = null; S.draft = false; S.cat = defaultCat();
    S.payMethod = 'card'; S.payCard = { brand: '', last4: '', auth: '' }; S.cashIn = '';
    await loadFloor();
    render();
  }

  async function setTab(tab) {
    S.tab = tab;
    if (tab === 'kitchen') await loadKitchen();
    if (tab === 'history') await loadHistory();
    if (tab === 'admin' && isManager()) await loadAdmin();
    if (tab === 'shift') await loadShift();
    if (tab === 'reports' && isManager()) await loadReport();
    if (tab === 'stock' && isManager() && can('stock')) await loadInv();
    if ((tab === 'order' || tab === 'bill') && S.order) await loadOrder();
    render();
  }

  const ACT = {
    pin: (d) => pinKey(d.k),
    'demo-login': (d) => { pin = d.pin; pinKey('ok'); },
    'demo-reset': () => {
      S.modal = { kind: 'confirm', eyebrow: 'Live demo', title: 'Reset the demo?', text: 'Everything goes back to the starting restaurant, for everyone using the demo right now.', yes: 'Reset demo',
        run: async () => { await api('/demo/reset', { body: {} }); S.modal = null; renderModal(); toast('Demo reset'); S.order = null; await setTab('floor'); } };
      renderModal();
    },
    tab: (d) => setTab(d.tab),
    logout: () => { S.modal = { kind: 'confirm', title: `Sign out ${S.user.name}?`, text: 'The next person can sign in with their own PIN.', yes: 'Sign out',
      run: async () => { await api('/logout', { body: {} }); S.user = null; S.order = null; S.modal = null; renderLogin(); } }; renderModal(); },
    area: (d) => { S.areaFilter = d.id; render(); },
    table: async (d) => {
      const t = S.floor.areas.flatMap((a) => a.tables).find((x) => String(x.id) === d.id);
      if (t.order) return openOrder(t.order.id);
      if (needShift()) return;
      return createOrder({ type: 'dinein', table_id: t.id, guests: Math.min(2, t.seats) });
    },
    'new-order': (d) => {
      if (d.type === 'dinein') { S.tab = 'floor'; return render(); }
      if (needShift()) return;
      if (d.type === 'counter') return createOrder({ type: 'counter' });
      S.modal = { kind: 'customer', type: d.type }; renderModal();
    },
    'customer-go': () => createOrder({ type: S.modal.type, customer_name: $('#c-name').value.trim(), phone: $('#c-phone').value.trim(), address: $('#c-addr')?.value.trim() }),
    'open-order': (d) => openOrder(d.id),
    'new-order-other': () => { S.draft = false; S.order = null; S.tab = 'order'; render(); },
    cat: (d) => { S.cat = +d.id; S.search = ''; render(); },
    'quick-add': async (d) => {
      const item = S.menu.categories.flatMap((c) => c.items).find((i) => String(i.id) === d.id);
      if (!(await ensureOrder())) return;
      S.order = await api(`/orders/${S.order.id}/items`, { body: { menu_item_id: item.id, qty: 1 } });
      render();
    },
    options: (d) => {
      const cat = S.menu.categories.find((c) => c.items.some((i) => String(i.id) === d.id));
      const item = cat.items.find((i) => String(i.id) === d.id);
      S.modal = { kind: 'options', item, catName: cat.name, defCourse: cat.default_course, course: cat.default_course, spice: 'Standard', addons: new Map(), note: '', qty: 1, sendKot: !item.no_kot };
      renderModal();
    },
    'opt-spice': (d) => { S.modal.spice = d.v; keepNote(); renderModal(); },
    'opt-addon': (d) => { const id = +d.id; S.modal.addons.has(id) ? S.modal.addons.delete(id) : S.modal.addons.set(id, 1); keepNote(); renderModal(); },
    'opt-aq': (d) => {
      const id = +d.id; const a = S.modal.item.addons.find((x) => x.id === id);
      const n = Math.min(a?.max_qty || 5, Math.max(0, (S.modal.addons.get(id) || 0) + +d.d));
      n ? S.modal.addons.set(id, n) : S.modal.addons.delete(id); keepNote(); renderModal();
    },
    'opt-course': (d) => { S.modal.course = d.v; keepNote(); renderModal(); },
    'opt-kot': (d) => { S.modal.sendKot = d.v === '1'; keepNote(); renderModal(); },
    'opt-qty': (d) => { S.modal.qty = Math.max(1, S.modal.qty + +d.d); keepNote(); renderModal(); },
    'opt-add': async () => {
      keepNote();
      const m = S.modal;
      if (!(await ensureOrder())) return;
      S.order = await api(`/orders/${S.order.id}/items`, { body: { menu_item_id: m.item.id, qty: m.qty, spice: m.spice, addons: [...m.addons].map(([id, qty]) => ({ id, qty })), course: m.course, note: m.note.trim(), no_kot: !m.sendKot } });
      S.modal = null; render();
    },
    qty: async (d) => { S.order = await api('/items/' + d.id, { method: 'PATCH', body: { qty: +d.q } }); render(); },
    'no-kot': async (d) => {
      const i = S.order.items.find((x) => String(x.id) === d.id);
      S.order = await api('/items/' + d.id, { method: 'PATCH', body: { served_direct: true } });
      toast(`${i.qty} × ${i.name} served without a kitchen ticket`); render();
    },
    guests: async (d) => { S.order = await api('/orders/' + S.order.id, { method: 'PATCH', body: { guests: Math.max(1, S.order.guests + +d.d) } }); render(); },
    void: () => {
      const o = S.order;
      if (o.kots.length || o.items.some((i) => i.served_direct)) {
        return formModal({ eyebrow: 'Void order', title: `Void ${orderTitle(o)}?`, roles: ['Manager'], submit: 'Void order', reasons: VOID_REASONS,
          body: `<p class="muted" style="margin-top:0">Everything on this order is cancelled and the kitchen gets a VOID slip for tickets still cooking. ${money(o.total_cents)} will not be charged.</p>`,
          onSubmit: async (v) => {
            await api(`/orders/${o.id}/void`, { body: v });
            toast(`${orderTitle(o)} voided`); S.modal = null; goHome(); await loadFloor(); render();
          } });
      }
      S.modal = { kind: 'confirm', title: `Cancel ${orderTitle(S.order)}?`, text: 'Nothing has been sent to the kitchen. The order will be voided.', yes: 'Cancel order',
      run: async () => { await api(`/orders/${S.order.id}/void`, { body: {} }); S.modal = null; goHome(); await loadFloor(); render(); } }; renderModal(); },
    'review-kot': () => { S.modal = { kind: 'kot', mode: 'station', hold: false }; renderModal(); },
    'kot-mode': (d) => { S.modal.mode = d.v; renderModal(); },
    'kot-hold': () => { S.modal.hold = !S.modal.hold; renderModal(); },
    'kot-send': async () => {
      const r = await api(`/orders/${S.order.id}/kots`, { body: { mode: S.modal.mode, hold_later: S.modal.hold } });
      S.order = r.order; S.modal = null;
      toast(`Sent ${r.kots.length} ticket${r.kots.length > 1 ? 's' : ''} to the kitchen`);
      if (S.order.type === 'counter') S.tab = 'bill';
      await loadFloor(); render();
    },
    station: (d) => { S.station = d.id; render(); },
    advance: async (d) => { await api(`/kots/${d.id}/advance`, { body: {} }); await loadKitchen(); await loadFloor(); render(); },
    tick: async (d) => { await api(`/items/${d.id}/toggle-done`, { body: {} }); await loadKitchen(); render(); },
    'bill-set': async (d) => {
      const v = d.k === 'service_on' ? d.v === 'true' : +d.v;
      S.order = await api('/orders/' + S.order.id, { method: 'PATCH', body: { [d.k]: v } }); render();
    },
    'pay-method': (d) => { S.payMethod = d.v; render(); if (d.v === 'card' && !S.payCard.brand) $('.card-chips .chip')?.focus(); },
    'card-brand': (d) => { S.payCard.brand = d.v; render(); $('#card-last4')?.focus(); },
    'bill-lang': (d) => { S.billLang = d.v; render(); },
    'print-bill': async () => {
      S.order = await api(`/orders/${S.order.id}/print-bill`, { body: { lang: billLang() } }); render();
      if (S.order.printed_to_printer) toast(`Bill sent to the printer (${BT().langName})`); else printBill(S.order);
    },
    charge: () => {
      const o = S.order;
      const pending = o.items.filter(isPending).length;
      if (!S.shift?.shift) {
        S.modal = { kind: 'confirm', title: 'Open a shift first', text: 'Payments are recorded against the open shift so the cash drawer can be balanced at the end of the day.', yes: 'Go to Shift',
          run: async () => { S.modal = null; await setTab('shift'); } };
        return renderModal();
      }
      const card = S.payMethod === 'card' ? { card_brand: S.payCard.brand, card_last4: S.payCard.last4, card_auth: S.payCard.auth } : {};
      if (S.payMethod === 'card') {
        if (!S.payCard.brand) { toast('Pick the card type (Visa, Mastercard…)', true); return; }
        if (!/^\d{4}$/.test(S.payCard.last4)) { toast('Enter the last 4 digits of the card', true); $('#card-last4')?.focus(); return; }
      }
      let cash = {};
      if (S.payMethod === 'cash') {
        const st = cashState(o);
        const err = st.got === null ? 'Enter the cash received' : Number.isNaN(st.got) ? 'Cash received is not a valid amount'
          : st.short ? `Cash received is less than the total. Short by ${money(o.total_cents - st.got)}.` : '';
        if (err) { toast(err, true); const f = $('#cash-in'); if (f) { f.classList.add('short'); f.focus(); f.select(); } return; }
        cash = { cash_received_cents: st.got };
      }
      const doIt = async () => {
        const paid = await api(`/orders/${o.id}/pay`, { body: { payment_method: S.payMethod, ...card, ...cash } });
        toast(`Paid ${money(paid.total_cents)} · ${orderTitle(paid)}${paid.change_cents ? ` · give change ${money(paid.change_cents)}` : ''}`);
        S.cashIn = '';
        S.modal = null; goHome(); await loadFloor(); render();
      };
      S.modal = { kind: 'confirm', title: `Charge ${money(o.total_cents)} by ${S.payMethod === 'card' ? `${S.payCard.brand} •••• ${S.payCard.last4}` : S.payMethod}?${cash.cash_received_cents != null ? ` Received ${money(cash.cash_received_cents)}, change ${money(cash.cash_received_cents - o.total_cents)}.` : ''}`,
        text: pending ? `${pending} item${pending > 1 ? 's have' : ' has'} not been sent yet. ${pending > 1 ? 'They' : 'It'} will be sent to the kitchen now and included in this bill.` : `This closes ${orderTitle(o)}${o.type === 'dinein' ? ' and frees the table' : ''}.`,
        yes: 'Charge', run: doIt };
      renderModal();
    },
    'hist-filter': (d) => { S.histFilter = d.v; render(); },
    'hist-sel': async (d) => { S.histSel = +d.id; S.histOrder = await api('/orders/' + d.id); render(); },
    'admin-section': async (d) => {
      resetImg(); S.admin.section = d.id; S.admin.sel = null;
      if (d.id === 'printers') await loadPrinting();
      if (d.id === 'audit' && can('audit')) await loadAudit();
      if (d.id === 'integrations' && can('emails')) await loadIntegrations();
      if (d.id === 'plan') await loadPlan();
      render();
    },
    'go-plan': async () => { S.modal = null; renderModal(); S.admin.section = 'plan'; S.admin.sel = null; await setTab('admin'); await loadPlan(); render(); },
    upgrade: (d) => askUpgrade(d.f),
    'device-remove': (d) => {
      S.modal = { kind: 'confirm', title: 'Remove this device?', text: 'It is signed out now. It can sign in again later while your plan has room for another device.', yes: 'Remove device',
        run: async () => { S.admin.plan = await api('/admin/devices/' + encodeURIComponent(d.id), { method: 'DELETE' }); S.modal = null; renderModal(); render(); toast('Device removed'); } };
      renderModal();
    },
    'integ-test': async () => { await api('/admin/integrations/test', { body: {} }); toast('Test event queued'); await integRefreshSoon(); },
    'integ-resend': async () => { const r = await api('/admin/integrations/resend-last-shift', { body: {} }); toast(`Z-report for shift ${shiftNo(r.shift_id)} queued`); await integRefreshSoon(); },
    'integ-retry': async (d) => { await api(`/admin/integrations/events/${d.id}/retry`, { body: {} }); await integRefreshSoon(); },
    'integ-retry-all': async () => { const r = await api('/admin/integrations/retry-all', { body: {} }); toast(`Retrying ${r.retried} event${r.retried === 1 ? '' : 's'}`); await integRefreshSoon(); },
    'integ-copy': async () => { try { await navigator.clipboard.writeText(S.admin.integ.secret); toast('Secret copied'); } catch { $('#integ-secret').select(); toast('Press Ctrl+C to copy'); } },
    'integ-new-secret': () => {
      S.modal = { kind: 'confirm', title: 'Create a new signing secret?', text: 'n8n will reject events until you paste the new secret into its "Check signature" node.', yes: 'Create new secret',
        run: async () => { const body = { ...integFormBody(), new_secret: true }; S.modal = null; renderModal(); await api('/admin/integrations', { method: 'PATCH', body }); await loadIntegrations(); toast('New secret created. Update it in n8n.'); render(); } };
      renderModal();
    },
    'admin-sel': (d) => { resetImg(); S.admin.sel = { kind: d.kind, id: +d.id }; render(); },
    'admin-img-remove': () => {
      resetImg(); S.admin.imgRemove = true;
      $('#img-box').innerHTML = imgPreview(null); $('#img-file').value = '';
    },
    'admin-new': (d) => {
      resetImg();
      S.admin.sel = { kind: d.kind, id: null }; render();
      if (d.area) { const a = $('#admin-form [name="area_id"]'); if (a) a.value = d.area; }
      $('#admin-form input')?.focus();
    },
    'admin-sample-menu': () => {
      S.modal = { kind: 'confirm', title: 'Load the Asian menu?',
        text: 'This replaces the current categories and dishes. Dishes that appear on past orders are kept but hidden, so history stays correct. You can edit everything afterwards.',
        yes: 'Load menu',
        run: async () => {
          S.modal = null; renderModal();
          const r = await api('/admin/sample-menu', { body: {} });
          S.cfg = await fetch('/api/config').then((x) => x.json());
          S.admin.section = 'items'; S.admin.cat = 'all';
          toast(`Loaded ${r.items} dishes in ${r.categories} categories`);
          await afterAdminChange(null);
        } };
      renderModal();
    },
    'logo-remove': async () => {
      await api('/admin/logo', { method: 'DELETE' }); S.admin.logoPreview = null;
      S.cfg = await fetch('/api/config').then((x) => x.json()); toast('Logo removed'); render();
    },
    'login-bg-reset': async () => {
      await api('/admin/login-bg', { method: 'DELETE' });
      S.cfg = await fetch('/api/config').then((x) => x.json());
      toast('Back to the default background'); render();
    },
    'admin-cancel': () => { resetImg(); S.admin.sel = null; render(); },
    'admin-addon-add': () => { $('#addons').insertAdjacentHTML('beforeend', addonRow()); $('#addons .addon-row:last-child input').focus(); },
    'admin-addon-del': (d, el) => el.closest('.addon-row').remove(),
    'admin-delete': () => {
      const s = S.admin.sel;
      S.modal = { kind: 'confirm', title: `Delete this ${ADMIN_NOUN[s.kind]}?`, text: 'This cannot be undone.', yes: 'Delete',
        run: async () => { S.modal = null; renderModal(); await api(`/admin/${ADMIN_PATH[s.kind]}/${s.id}`, { method: 'DELETE' }); toast('Deleted'); await afterAdminChange(null); } };
      renderModal();
    },
    'void-item': (d) => {
      const i = S.order.items.find((x) => String(x.id) === d.id);
      const left = eq(i);
      formModal({ eyebrow: 'Void item', title: `Void ${i.name}`, roles: ['Manager'], submit: 'Void', reasons: VOID_REASONS,
        body: `<p class="muted" style="margin-top:0">${i.served_direct ? 'Already served without a kitchen ticket.' : `Already sent on KOT #${i.kot_no}. The kitchen will get a VOID slip.`}</p>
          ${left > 1 ? `<label>How many to void (of ${left})</label><input name="qty" type="number" min="1" max="${left}" value="${left}" required>` : '<input type="hidden" name="qty" value="1">'}`,
        onSubmit: async (v) => { S.order = await api(`/items/${i.id}/void`, { body: v }); S.modal = null; toast(`Voided ${v.qty} × ${i.name}`); render(); } });
    },
    refund: (d) => {
      const o = S.histOrder;
      const left = o.total_cents - o.refunded_cents;
      formModal({ eyebrow: 'Refund', title: `Refund #${o.order_no}`, roles: ['Manager'], submit: 'Refund', reasons: REFUND_REASONS,
        body: `<p class="muted" style="margin-top:0">Paid ${money(o.total_cents)} by ${esc(o.payment_method)}${o.refunded_cents ? `, already refunded ${money(o.refunded_cents)}` : ''}. Up to ${money(left)} can be refunded.</p>
          <div class="two"><div><label>Amount</label><input name="amount" inputmode="decimal" value="${(left / 100).toFixed(2)}" required></div>
          <div><label>Refund as</label><select name="method">${['cash', 'card', 'wallet'].map((m) => `<option value="${m}" ${m === o.payment_method ? 'selected' : ''}>${m[0].toUpperCase() + m.slice(1)}</option>`).join('')}</select></div></div>`,
        onSubmit: async (v) => {
          S.histOrder = await api(`/orders/${o.id}/refund`, { body: v }); S.modal = null;
          toast(`Refunded ${money(Math.round(v.amount * 100))}`); await loadHistory(); render();
        } });
    },
    reprint: async (d) => {
      const o = await api(`/orders/${d.id}/reprint`, { body: { lang: billLang() } });
      if (o.printed_to_printer) toast(`Sent to the bill printer (${BT().langName})`); else printBill(o, billLang(), o.status === 'paid' ? 'receiptCopy' : 'billCopy');
    },
    'kot-reprint': async (d) => { await api(`/kots/${d.id}/reprint`, { body: {} }); toast('Ticket sent to the kitchen printer'); },
    'fill-reason': (d) => { const r = $('#modal-form [name="reason"]'); if (r) { r.value = d.v; r.focus(); } },
    'shift-sel': async (d) => { S.shiftSel = +d.id; S.shiftDetail = await api('/shifts/' + d.id); render(); },
    'shift-print': async (d) => {
      const r = await api(`/shifts/${d.id}/print`, { body: {} });
      if (r.printed_to_printer) toast('Report sent to the printer');
      else zReportPrint(+d.id === S.shift?.shift?.id ? S.shift : await api('/shifts/' + d.id));
    },
    'cash-move': (d) => {
      const isIn = d.kind === 'in';
      formModal({ eyebrow: 'Cash drawer', title: isIn ? 'Cash in' : 'Cash out (paid out)', roles: ['Manager', 'Cashier'], submit: isIn ? 'Add cash' : 'Take cash out', reasons: CASH_REASONS[d.kind],
        body: `<label>Amount</label><input name="amount" inputmode="decimal" placeholder="0.00" required><input type="hidden" name="kind" value="${d.kind}">`,
        onSubmit: async (v) => { S.shift = await api('/shift/cash', { body: v }); S.modal = null; toast(`Cash ${v.kind} ${money(Math.round(v.amount * 100))} recorded`); await loadShift(); render(); } });
    },
    'shift-close': () => {
      const cur = S.shift;
      formModal({ eyebrow: `Close shift ${shiftNo(cur.shift.id)}`, title: `Expected in drawer: ${money(cur.expected_cents)}`, roles: ['Manager', 'Cashier'], submit: 'Close shift & print Z report', wide: true,
        body: `<label>Count the drawer <small class="muted">(optional helper: notes and coins)</small></label>
          <div class="denoms">${DENOMS.map((n) => `<label class="denom"><span>${n}</span><input data-denom="${n}" type="number" min="0" inputmode="numeric" placeholder="0"></label>`).join('')}</div>
          <div class="two" style="margin-top:12px"><div><label>Counted cash</label><input name="counted" id="counted" inputmode="decimal" placeholder="0.00" required></div>
          <div><label>Difference</label><div id="variance" class="variance muted">Enter the count</div></div></div>
          <label>Note (optional)</label><input name="note" maxlength="300" placeholder="e.g. short 100, coins given as change">`,
        onSubmit: async (v) => {
          const r = await api('/shift/close', { body: v });
          S.modal = null; S.shiftSel = r.shift.id;
          toast(r.printed_to_printer ? 'Shift closed. Z report sent to the printer.' : 'Shift closed');
          await loadFloor(); await loadShift(); render();
          if (!r.printed_to_printer) zReportPrint(r);
        } });
    },
    'rep-preset': async (d) => { S.rep.preset = d.v; if (d.v !== 'custom') { S.rep.data = null; render(); await loadReport(); } render(); },
    'rep-csv': () => reportCsv(),
    'rep-print': () => { document.body.classList.add('print-report'); window.print(); },
    'printer-test': async (d, el) => { await api(`/admin/printing/printers/${d.id}/test`, { body: {} }); toast('Test page queued'); await loadPrinting(); render(); },
    'printer-delete': () => {
      const s = S.admin.sel;
      S.modal = { kind: 'confirm', title: 'Delete this printer?', text: 'Stations using it will fall back to the default kitchen printer.', yes: 'Delete',
        run: async () => { S.modal = null; renderModal(); await api(`/admin/printing/printers/${s.id}`, { method: 'DELETE' }); S.admin.sel = null; await loadPrinting(); render(); } };
      renderModal();
    },
    'bridge-token': async () => {
      await api('/admin/printing/token', { body: {} }); await loadPrinting(); render(); toast('New bridge token created. Restart the bridge with the new command.');
    },
    'copy-cmd': async () => { try { await navigator.clipboard.writeText($('#bridge-cmd').textContent); toast('Command copied'); } catch { toast('Select the command and copy it', true); } },
    'job-retry': async (d) => { await api(`/admin/printing/jobs/${d.id}/retry`, { body: {} }); await loadPrinting(); render(); },
    'inv-section': async (d) => { S.inv.section = d.id; S.inv.sel = null; await loadInv(d.id); render(); },
    'inv-filter': (d) => { S.inv.filter = d.v; render(); },
    'inv-rfilter': (d) => { S.inv.rfilter = d.v; render(); },
    'inv-sel': async (d) => {
      S.inv.sel = { kind: d.kind, id: +d.id }; S.inv.moves = null; S.inv.supDetail = null; S.inv.purDetail = null;
      render(); await loadInv(); render();
    },
    'inv-new': (d) => {
      S.inv.sel = { kind: d.kind, id: null };
      if (d.kind === 'purchase' && S.inv.section !== 'purchases') { S.inv.section = 'purchases'; }
      render(); if (d.kind === 'purchase' && !S.inv.purchases) loadInv('purchases').then(render);
      $('.admin-form form input, .admin-form form select')?.focus();
    },
    'inv-cancel': () => { S.inv.sel = null; render(); },
    'inv-sample': async () => { const r = await api('/inventory/sample', { body: {} }); toast(`Loaded ${r.ingredients} ingredients, ${r.suppliers} suppliers and ${r.recipes} recipes`); await loadFloor(); await loadInv(); render(); },
    'inv-adjust': (d) => {
      const g = S.inv.data.ingredients.find((x) => x.id === S.inv.sel.id);
      const waste = d.kind === 'waste';
      formModal({ eyebrow: waste ? 'Record waste' : 'Adjust stock', title: `${g.name} · ${fq(g.stock)} ${g.unit} in stock`, submit: waste ? 'Record waste' : 'Save adjustment',
        body: `${waste ? '' : `<label>Direction</label><select name="direction"><option value="remove">Remove from stock</option><option value="add">Add to stock</option></select>`}
          <label>Quantity (${esc(g.unit)})</label><input name="qty" inputmode="decimal" required placeholder="0">
          <label>Reason</label><div class="chips" style="margin-bottom:8px">${(waste ? ['Spoiled', 'Expired', 'Dropped', 'Burnt', 'Returned dish'] : ['Found extra', 'Staff meal', 'Moved to other branch', 'Correction'])
            .map((r) => `<button type="button" class="chip" data-act="fill-note" data-v="${r}">${r}</button>`).join('')}</div>
          <input name="note" maxlength="200" required placeholder="Or type a reason">`,
        onSubmit: async (v) => {
          await api(`/inventory/ingredients/${g.id}/adjust`, { body: { ...v, kind: waste ? 'waste' : 'adjust' } });
          S.modal = null; toast(waste ? `Waste recorded: ${v.qty} ${g.unit} ${g.name}` : 'Stock adjusted'); await loadFloor(); await loadInv(); render();
        } });
    },
    'fill-note': (d) => { const r = $('#modal-form [name="note"]'); if (r) { r.value = d.v; r.focus(); } },
    'rec-add': () => { $('#rec-rows').insertAdjacentHTML('beforeend', recipeRow()); updateRecipeTotal(); },
    'pur-add': () => { $('#pur-rows').insertAdjacentHTML('beforeend', purchaseRow()); },
    'rec-del': (d, el) => { el.parentElement.remove(); updateRecipeTotal(); updatePurchaseTotal(); },
    'sup-pay': (d) => {
      const x = S.inv.data.suppliers.find((y) => y.id === +d.id);
      formModal({ eyebrow: 'Supplier payment', title: `Pay ${x.name}`, submit: 'Record payment',
        body: `<p class="muted" style="margin-top:0">Owed ${money(+d.due)}.</p>
          <div class="two"><div><label>Amount</label><input name="amount" inputmode="decimal" required value="${(+d.due / 100).toFixed(2)}"></div>
          <div><label>Paid by</label><select name="method">${Object.entries(PAY_LABEL).filter(([k]) => k !== 'credit').map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div></div>
          <label>Reference</label><input name="reference" maxlength="80" placeholder="Cheque / transfer no.">
          ${d.purchase ? `<input type="hidden" name="purchase_id" value="${d.purchase}">` : ''}`,
        onSubmit: async (v) => {
          await api(`/inventory/suppliers/${x.id}/payments`, { body: v });
          S.modal = null; toast(`Payment of ${money(Math.round(v.amount * 100))} recorded${v.method === 'drawer' ? ' and taken from the cash drawer' : ''}`);
          await loadInv(); render();
        } });
    },
    'inv-reorder-receive': async (d) => {
      const g = S.inv.reorder.find((x) => String(x.supplier_id) === d.id);
      S.inv.section = 'purchases'; await loadInv('purchases');
      S.inv.sel = { kind: 'purchase', id: null, prefill: { supplier_id: g.supplier_id,
        lines: g.items.map((i) => ({ ingredient_id: i.id, unit: i.unit, qty: i.suggest, unit_cost: (i.cost_cents / 100).toFixed(2), line_total: (i.suggest * i.cost_cents / 100).toFixed(2) })) } };
      render();
    },
    'inv-reorder-print': () => printSimple('REORDER LIST', S.inv.reorder.map((g) => `<b>${esc(g.supplier_name)}</b>${g.supplier_phone ? ' · ' + esc(g.supplier_phone) : ''}
      ${g.items.map((i) => `<div class="r"><span>${esc(i.name)}</span><span>${fq(i.suggest)} ${esc(i.unit)}</span></div>`).join('')}
      <div class="r"><span>≈ cost</span><span>${money(g.est_cents)}</span></div><hr>`).join('')),
    'inv-count-print': () => printSimple('STOCK COUNT SHEET', S.inv.data.ingredients.filter((g) => g.active)
      .map((g) => `<div class="r"><span>${esc(g.name)} (${esc(g.unit)})</span><span>______</span></div>`).join('') + '<br><div>Counted by: ____________</div>'),
    'confirm-yes': () => S.modal.run(),
    'close-modal': () => { S.modal = null; renderModal(); },
    overlay: () => {},
  };
  function keepNote() { const n = $('#opt-note'); if (n && S.modal) S.modal.note = n.value; }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    if (el.dataset.act === 'overlay') { if (e.target === el) { S.modal = null; renderModal(); } return; }
    const fn = ACT[el.dataset.act];
    if (fn) run(fn)(el.dataset, el);
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'admin-form') { e.preventDefault(); run(adminSave)(); }
    if (e.target.id === 'modal-form') {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      const btn = e.target.querySelector('[type=submit]'); btn.disabled = true;
      run(async () => { try { await S.modal.onSubmit(v); } finally { if (btn.isConnected) btn.disabled = false; } })();
    }
    if (e.target.id === 'ing-form' || e.target.id === 'supplier-form') {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = { ...Object.fromEntries(f.entries()), active: f.has('active') };
      const s0 = S.inv.sel; const path = e.target.id === 'ing-form' ? 'ingredients' : 'suppliers';
      run(async () => {
        const out = await api(`/inventory/${path}${s0.id ? '/' + s0.id : ''}`, { method: s0.id ? 'PATCH' : 'POST', body });
        toast(s0.id ? 'Saved' : 'Added'); S.inv.sel = { kind: s0.kind, id: s0.id || out.id }; await loadFloor(); await loadInv(); render();
      })();
    }
    if (e.target.id === 'recipe-form') {
      e.preventDefault();
      const lines = [...document.querySelectorAll('#rec-rows .rec-row')].map((r) => ({ ingredient_id: r.querySelector('select').value, qty: r.querySelector('[data-f="qty"]').value }))
        .filter((l) => l.ingredient_id && l.qty);
      run(async () => { await api(`/inventory/recipes/${S.inv.sel.id}`, { method: 'PUT', body: { lines } }); toast('Recipe saved'); await loadInv(); render(); })();
    }
    if (e.target.id === 'purchase-form') {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target).entries());
      const lines = [...document.querySelectorAll('#pur-rows .pur-row')].map((r) => ({ ingredient_id: r.querySelector('select').value, qty: r.querySelector('[data-f="qty"]').value,
        unit_cost: r.querySelector('[data-f="unit"]').value, line_total: r.querySelector('[data-f="total"]').value })).filter((l) => l.ingredient_id && l.qty);
      if (f.pay_method === 'credit') { f.pay_amount = ''; }
      run(async () => {
        const out = await api('/inventory/purchases', { body: { ...f, lines } });
        toast('Goods received. Stock updated.'); S.inv.sel = { kind: 'purchase-view', id: out.id }; await loadFloor(); await loadInv(); render();
      })();
    }
    if (e.target.id === 'count-form') {
      e.preventDefault();
      const counts = [...document.querySelectorAll('[data-count]')].filter((x) => x.value !== '').map((x) => ({ ingredient_id: x.dataset.count, counted: x.value }));
      const note = e.target.querySelector('[name="note"]').value;
      run(async () => {
        const r = await api('/inventory/stocktake', { body: { counts, note } });
        toast(`Count saved: ${r.changed} changed · short ${money(r.loss_cents)} · over ${money(r.gain_cents)}`); await loadFloor(); await loadInv(); render();
      })();
    }
    if (e.target.id === 'shift-open-form') {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      run(async () => { await api('/shift/open', { body: v }); toast('Shift opened'); await loadFloor(); await loadShift(); render(); })();
    }
    if (e.target.id === 'printer-form') {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = { ...Object.fromEntries(f.entries()), active: f.has('active') };
      const s = S.admin.sel;
      run(async () => {
        const out = await api(`/admin/printing/printers${s.id ? '/' + s.id : ''}`, { method: s.id ? 'PATCH' : 'POST', body });
        toast(s.id ? 'Printer saved' : 'Printer added'); S.admin.sel = { kind: 'printer', id: s.id || out.id }; await loadPrinting(); render();
      })();
    }
    if (e.target.id === 'routing-form') {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target).entries());
      const stations = Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('st_')).map(([k, v]) => [k.slice(3), v || null]));
      run(async () => {
        await api('/admin/printing/routing', { method: 'PATCH', body: { bill_printer_id: f.bill_printer_id || null, kitchen_printer_id: f.kitchen_printer_id || null, stations } });
        toast('Printer routing saved'); await loadPrinting(); render();
      })();
    }
    if (e.target.id === 'license-form') {
      e.preventDefault();
      const key = new FormData(e.target).get('key');
      (async () => {
        try {
          S.admin.plan = await api('/admin/license', { body: { key } });
          S.cfg = await fetch('/api/config').then((x) => x.json());
          toast(`Licence saved: ${S.admin.plan.license.planName} plan until ${S.admin.plan.license.expires}`); render();
        } catch (err) { toast(err.message); }
      })();
    }
    if (e.target.id === 'rep-range') {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target).entries());
      S.rep.from = f.from; S.rep.to = f.to;
      run(async () => { await loadReport(); render(); })();
    }
    if (e.target.id === 'integ-form') {
      e.preventDefault();
      run(async () => { await api('/admin/integrations', { method: 'PATCH', body: integFormBody() }); await loadIntegrations(); toast('Integration saved'); render(); })();
    }
    if (e.target.id === 'settings-form') {
      e.preventDefault();
      run(async () => {
        await api('/admin/settings', { method: 'PATCH', body: Object.fromEntries(new FormData(e.target).entries()) });
        S.cfg = await fetch('/api/config').then((x) => x.json());
        toast('Settings saved');
        await afterAdminChange(null);
      })();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.dataset.cust && S.order) {
      const k = e.target.dataset.cust; const v = e.target.value.trim();
      if ((S.order[k] || '') !== v) run(async () => { S.order = await api('/orders/' + S.order.id, { method: 'PATCH', body: { [k]: v } }); toast('Customer details saved'); render(); })();
    }
    if (e.target.id === 'logo-file' && e.target.files[0]) {
      run(async () => {
        const out = await processLogo(e.target.files[0]);
        const res = await fetch('/api/admin/logo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ image: out.image, raster: out.raster }) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
        S.admin.logoPreview = out.preview;
        S.cfg = await fetch('/api/config').then((x) => x.json());
        toast('Logo saved'); await loadAdmin(); render();
      })();
    }
    if (e.target.closest('#rec-rows')) updateRecipeTotal();
    if (e.target.closest('#pur-rows') && e.target.tagName === 'SELECT') updatePurchaseTotal(e.target);
    if (e.target.id === 'login-bg-file' && e.target.files[0]) {
      run(async () => {
        const blob = await resizeImage(e.target.files[0], 1920);
        const res = await fetch('/api/admin/login-bg', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob, credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
        S.cfg = await fetch('/api/config').then((x) => x.json());
        toast('Login background updated'); render();
      })();
    }
    if (e.target.id === 'audit-filter') { S.admin.auditFilter = e.target.value; run(async () => { await loadAudit(); render(); })(); }
    if (e.target.id === 'img-file' && e.target.files[0]) {
      run(async () => {
        const blob = await resizeImage(e.target.files[0]);
        resetImg();
        S.admin.img = { blob, url: URL.createObjectURL(blob) };
        $('#img-box').innerHTML = imgPreview(null);
      })();
    }
    if (e.target.id === 'admin-cat') { S.admin.cat = e.target.value; $('#admin-list').innerHTML = adminList(); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'card-last4') { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); S.payCard.last4 = e.target.value; }
    if (e.target.id === 'card-auth') { S.payCard.auth = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); }
    if (e.target.id === 'inv-q') {
      S.inv.q = e.target.value; const pos = e.target.selectionStart;
      $('#inv-list').innerHTML = stockList(); const q = $('#inv-q'); q.focus(); q.setSelectionRange(pos, pos);
    }
    if (e.target.closest('#rec-rows')) updateRecipeTotal();
    if (e.target.closest('#pur-rows')) updatePurchaseTotal(e.target);
    if (e.target.dataset.count !== undefined) updateCount();
    if (e.target.dataset.denom !== undefined || e.target.id === 'counted') {
      if (e.target.dataset.denom !== undefined) {
        const sum = [...document.querySelectorAll('[data-denom]')].reduce((t, x) => t + (+x.dataset.denom) * (parseInt(x.value, 10) || 0), 0);
        $('#counted').value = sum ? sum.toFixed(2) : '';
      }
      const c = Math.round(parseFloat($('#counted').value || '') * 100);
      const vEl = $('#variance');
      if (!Number.isFinite(c)) { vEl.textContent = 'Enter the count'; vEl.className = 'variance muted'; }
      else {
        const v = c - S.shift.expected_cents;
        vEl.textContent = v === 0 ? 'Balanced' : `${v > 0 ? 'Over' : 'Short'} by ${money(Math.abs(v))}`;
        vEl.className = 'variance ' + (v === 0 ? 'ok' : 'bad');
      }
    }
    if (e.target.id === 'admin-q') {
      S.admin.q = e.target.value;
      const pos = e.target.selectionStart;
      $('#admin-list').innerHTML = adminList();
      const q = $('#admin-q'); q.focus(); q.setSelectionRange(pos, pos);
    }
    if (e.target.id === 'search') {
      S.search = e.target.value;
      $('#dish-area').innerHTML = dishAreaHtml();
      document.querySelectorAll('.cat').forEach((b) => b.classList.toggle('on', !S.search && +b.dataset.id === S.cat));
    }
    if (e.target.id === 'cash-in') {
      S.cashIn = e.target.value;
      const st = cashState(S.order);
      $('#change').innerHTML = st.msg;
      $('#change').classList.toggle('short', st.short); e.target.classList.toggle('short', st.short);
    }
  });
  // chart hover tooltips
  document.addEventListener('mouseover', (e) => {
    const bar = e.target.closest('.bar');
    const chart = e.target.closest('.chart');
    if (!chart) return;
    const tip = chart.querySelector('.chart-tip');
    chart.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
    if (!bar) { tip.classList.add('hidden'); return; }
    bar.classList.add('hover');
    tip.textContent = bar.dataset.tip;
    const cr = chart.getBoundingClientRect(); const br = bar.getBoundingClientRect();
    tip.classList.remove('hidden');
    tip.style.left = `${Math.min(cr.width - tip.offsetWidth, Math.max(0, br.left - cr.left + br.width / 2 - tip.offsetWidth / 2))}px`;
  });
  document.addEventListener('mouseleave', (e) => { if (e.target.classList?.contains('chart')) e.target.querySelector('.chart-tip').classList.add('hidden'); }, true);
  window.addEventListener('afterprint', () => document.body.classList.remove('print-report'));
  document.addEventListener('keydown', (e) => {
    if (!S.user && /^[0-9]$/.test(e.key)) pinKey(e.key);
    else if (!S.user && e.key === 'Backspace') pinKey('back');
    else if (!S.user && e.key === 'Enter') pinKey('ok');
    else if (e.key === 'Escape' && S.modal) { S.modal = null; renderModal(); }
  });

  // tick: clock every 15s, full re-render each minute for ages (skip while a modal or input is active)
  setInterval(() => { const c = $('#clock'); if (c && S.cfg) c.textContent = clock(Date.now()); }, 15000);
  const refreshSync = () => loadSync().then(() => {
    const p = $('#sync-pill'); if (p) p.innerHTML = syncPill();
    const b = $('#standby-bar'); if (b) b.outerHTML = standbyBar();
  });
  setInterval(() => { if (S.user && S.cfg?.mode && !['standalone', 'standby'].includes(S.cfg.mode)) refreshSync(); }, 10000);
  setInterval(() => { if (S.user && S.cfg?.mode === 'standby') refreshSync(); }, 3000);
  setInterval(() => { if (S.user && !S.modal && !['admin', 'reports', 'shift', 'stock'].includes(S.tab) && document.activeElement?.tagName !== 'INPUT') render(); }, 60000);

  // ---------- boot ----------
  async function boot() {
    S.cfg = S.cfg || await fetch('/api/config').then((r) => r.json());
    document.title = `${S.cfg.restaurant} · POS`;
    try { S.user = await api('/me'); } catch { return renderLogin(); }
    [S.menu] = await Promise.all([api('/menu'), loadFloor()]);
    if (!S.es) { S.es = true; connectEvents(); }
    if (S.cfg.mode === 'mirror' && S.tab === 'floor') { S.tab = isManager() ? 'reports' : 'history'; await setTab(S.tab); return; }
    if (!S.booted) { S.booted = true; if (S.cfg.mode !== 'mirror') goHome(); }
    render();
  }
  run(boot)();
})();

// n8n Code node: "Check & build email"
// Input: the Webhook item plus `expected` (HMAC from the "Check signature" node).
// Output: { send, code, to, subject, html, text } — send=false means respond with `code` and don't email.
const item = $input.first().json;
const h = item.headers || {};
const body = item.body || {};

// 1. Is it really from the POS? Signature must match, and be fresh (stops replays).
const sig = String(h['x-pos-signature'] || '').replace(/^sha256=/, '');
const ts = Number(h['x-pos-timestamp'] || 0);
const fresh = Math.abs(Date.now() / 1000 - ts) < 600;
if (!sig || sig !== item.expected || !fresh) {
  return [{ json: { send: false, code: 401, error: !fresh && sig === item.expected ? 'Request too old' : 'Bad signature. Check the secret in "Check signature".' } }];
}

// 2. Who gets it
const to = (body.recipients && body.recipients.email) || '';
if (!to) return [{ json: { send: false, code: 422, error: 'No owner email set. Add it in POS Admin → Integrations.' } }];

// 3. Helpers
const src = body.source || {};
const cur = src.currency || 'Rs';
const tz = src.timezone || 'Asia/Colombo';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (c) => `${cur} ${((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (c) => (c > 0 ? '+' : c < 0 ? '−' : '') + money(Math.abs(c || 0));
const when = (t, opts = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) => {
  if (!t) return '—';
  try { return new Date(t).toLocaleString('en-GB', { timeZone: tz, ...opts }); } catch (e) { return new Date(t).toISOString(); }
};
const day = (t) => when(t, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

const INK = '#1a1a1a', MUTED = '#6b6b6b', LINE = '#e4e2de', RED = '#b3220f';
const row = (l, r, o = {}) => `<tr><td style="padding:7px 0;border-bottom:1px solid ${LINE};color:${o.muted ? MUTED : INK}">${l}</td>`
  + `<td style="padding:7px 0;border-bottom:1px solid ${LINE};text-align:right;white-space:nowrap;font-weight:${o.bold ? 700 : 400};color:${o.red ? RED : INK}">${r}</td></tr>`;
const section = (title, rows) => `<h3 style="margin:26px 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${MUTED}">${title}</h3>`
  + `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:15px">${rows}</table>`;
const kpi = (label, value) => `<td style="padding:12px 12px;border:1px solid ${LINE};background:#faf9f7;width:25%"><div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.06em">${label}</div><div style="font-size:17px;font-weight:700;margin-top:4px;color:${INK};white-space:nowrap">${value}</div></td>`;
const wrap = (eyebrow, title, sub, inner) => `<!doctype html><html><body style="margin:0;background:#f1efeb;font-family:Arial,Helvetica,sans-serif;color:${INK}">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-top:4px solid ${RED}"><tr><td style="padding:28px 30px">
<div style="font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${RED}">${eyebrow}</div>
<h1 style="margin:6px 0 4px;font-size:26px">${title}</h1><div style="color:${MUTED};font-size:14px">${sub}</div>
${inner}
<p style="margin:30px 0 0;color:${MUTED};font-size:12px">Sent automatically by ${esc(src.restaurant || 'the POS')} · ${esc(src.terminal || '')}</p>
</td></tr></table></td></tr></table></body></html>`;

const d = body.data || {};
let subject, html, text;

if (body.event === 'shift.closed') {
  const s = d.sales || {}, c = d.cash || {}, p = d.payments || {}, rf = d.refunds || {}, v = d.voids || {};
  const avg = s.orders ? Math.round(s.gross_cents / s.orders) : 0;
  const varLabel = c.variance_cents === 0 ? 'Balanced' : c.variance_cents > 0 ? `Over ${money(c.variance_cents)}` : `Short ${money(-c.variance_cents)}`;
  subject = `Z-report · ${src.restaurant || 'POS'} · ${day(d.shift.closed_at)} · ${money(s.net_cents)}${c.variance_cents ? ` · cash ${c.variance_cents > 0 ? 'over' : 'short'}` : ''}`;
  html = wrap(`Z-report · Shift ${d.shift.label || `#${d.shift.id}`}`, esc(src.restaurant || 'Daily report'),
    `${when(d.shift.opened_at)} → ${when(d.shift.closed_at)} · opened by ${esc(d.shift.opened_by)}, closed by ${esc(d.shift.closed_by)}`,
    `<table width="100%" cellpadding="0" cellspacing="6" style="margin-top:18px;border-collapse:separate"><tr>${kpi('Net sales', money(s.net_cents))}${kpi('Orders', s.orders || 0)}${kpi('Covers', s.covers || 0)}${kpi('Avg order', money(avg))}</tr></table>`
    + (c.variance_cents ? `<div style="margin-top:14px;padding:12px 14px;background:#fdecea;border-left:4px solid ${RED};color:${RED};font-weight:700">Cash ${c.variance_cents > 0 ? 'over' : 'short'} by ${money(Math.abs(c.variance_cents))}</div>` : '')
    + section('Sales', row('Gross sales', money(s.gross_cents)) + row('Discounts', money(s.discount_cents), { muted: true })
      + row('Service charge', money(s.service_cents), { muted: true }) + row('Tax', money(s.tax_cents), { muted: true })
      + row('Tips', money(s.tip_cents), { muted: true }) + row('Refunds', `−${money(rf.total_cents)}`, { muted: true }) + row('<b>Net sales</b>', money(s.net_cents), { bold: true }))
    + section('Payments', row('Cash', money(p.cash_cents)) + row('Card', money(p.card_cents)) + row('Wallet', money(p.wallet_cents))
      + (d.card_brands || []).map((b) => row(`&nbsp;&nbsp;&nbsp;${esc(b.brand)} · ${b.count}`, money(b.total_cents), { muted: true })).join(''))
    + section('Cash drawer', row('Opening float', money(c.float_cents)) + row('Cash sales', `+${money(c.cash_sales_cents)}`) + row('Cash refunds', `−${money(c.cash_refunds_cents)}`)
      + row('Paid in', `+${money(c.paid_in_cents)}`) + row('Paid out', `−${money(c.paid_out_cents)}`) + row('<b>Expected</b>', money(c.expected_cents), { bold: true })
      + row('<b>Counted</b>', money(c.counted_cents), { bold: true }) + row('<b>Difference</b>', c.variance_cents ? varLabel : 'Balanced', { bold: true, red: !!c.variance_cents }))
    + section('Voids &amp; refunds', row('Voided items', `${v.items || 0} · ${money(v.amount_cents)}`) + row('Voided orders', v.orders || 0) + row('Refunds', `${rf.count || 0} · ${money(rf.total_cents)}`))
    + ((d.top_items || []).length ? section('Top dishes', d.top_items.map((t, i) => row(`${i + 1}. ${esc(t.name)} <span style="color:${MUTED}">× ${t.qty}</span>`, money(t.sales_cents))).join('')) : '')
    + (d.shift.note ? section('Closing note', `<tr><td style="padding:8px 0">${esc(d.shift.note)}</td></tr>`) : ''));
  text = `Z-report, shift ${d.shift.label || `#${d.shift.id}`} (${when(d.shift.opened_at)} to ${when(d.shift.closed_at)})\nNet sales ${money(s.net_cents)} · ${s.orders} orders\nCash ${money(p.cash_cents)} · Card ${money(p.card_cents)} · Wallet ${money(p.wallet_cents)}\nCash expected ${money(c.expected_cents)}, counted ${money(c.counted_cents)}: ${varLabel}`;
} else if (body.event === 'cash.variance') {
  const short = d.variance_cents < 0;
  subject = `Cash ${short ? 'SHORT' : 'over'} ${money(Math.abs(d.variance_cents))} · ${src.restaurant || 'POS'} · shift ${d.shift.label || `#${d.shift.id}`}`;
  html = wrap('Cash count alert', `Cash ${short ? 'short' : 'over'} by ${money(Math.abs(d.variance_cents))}`,
    `Shift ${d.shift.label || `#${d.shift.id}`} · closed ${when(d.shift.closed_at)} by ${esc(d.shift.closed_by)}`,
    `<div style="margin-top:18px;padding:12px 14px;background:#fdecea;border-left:4px solid ${RED};color:${RED};font-weight:700">The counted cash ${short ? 'is less than' : 'is more than'} the system expected.</div>`
    + section('Drawer', row('Expected', money(d.expected_cents)) + row('Counted', money(d.counted_cents)) + row('<b>Difference</b>', signed(d.variance_cents), { bold: true, red: true })
      + row('Alert limit', money(d.limit_cents), { muted: true }))
    + (d.shift.note ? section('Closing note', `<tr><td style="padding:8px 0">${esc(d.shift.note)}</td></tr>`) : ''));
  text = `Cash ${short ? 'short' : 'over'} by ${money(Math.abs(d.variance_cents))} on shift ${d.shift.label || `#${d.shift.id}`}. Expected ${money(d.expected_cents)}, counted ${money(d.counted_cents)}. Closed by ${d.shift.closed_by}.`;
} else if (body.event === 'test') {
  subject = `Test from ${src.restaurant || 'Restaurant POS'}`;
  html = wrap('Connection test', 'It works', `Sent by ${esc(d.sent_by)} · ${when(body.created_at)}`,
    `<p style="margin:18px 0 0;font-size:15px">${esc(d.message)}</p><p style="font-size:15px">You'll get the Z-report here every time a shift is closed.</p>`);
  text = d.message;
} else {
  // An event this workflow doesn't email (yet). Accept it so the POS doesn't keep retrying.
  return [{ json: { send: false, code: 200, error: null, skipped: body.event } }];
}

return [{ json: { send: true, code: 200, to, subject, html, text, event: body.event, event_id: body.id, restaurant: src.restaurant || 'Restaurant' } }];

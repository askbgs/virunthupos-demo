// Draw a print document as a 1-bit picture, for text the printer's built-in fonts can't show (Tamil, Sinhala).
// The result uses the same { t:'image' } line the logo uses, so the print bridge and direct printing
// need no changes: they already send images with the ESC/POS "GS v 0" raster command.
const path = require('path');
let canvasLib = null;
function lib() {
  if (canvasLib) return canvasLib;
  canvasLib = require('@napi-rs/canvas');
  const dir = path.join(__dirname, 'fonts');
  // Each weight gets its own family name, so "Medium" and "Bold" are picked exactly
  for (const [file, family] of [
    ['NotoSans_500Medium', 'PosLatin'], ['NotoSans_700Bold', 'PosLatin Bold'],
    ['NotoSansTamil_500Medium', 'PosTamil'], ['NotoSansTamil_700Bold', 'PosTamil Bold'],
    ['NotoSansSinhala_500Medium', 'PosSinhala'], ['NotoSansSinhala_700Bold', 'PosSinhala Bold'],
  ]) canvasLib.GlobalFonts.registerFromPath(path.join(dir, `${file}.ttf`), family);
  return canvasLib;
}

const DRAWN = new Set(['text', 'row', 'hr', 'image', 'feed']);

/**
 * Turn the drawable lines of a document into one picture line. Commands the printer runs itself
 * (cut, drawer…) and the feed before the cut are kept as they are.
 * widthChars: the printer's characters per line (48 = 80 mm, 32 = 58 mm); the picture is 12 dots per character.
 */
function rasterizeDoc(doc, widthChars = 48) {
  // trailing feeds/cut stay as printer commands
  let end = doc.length;
  while (end > 0 && !['text', 'row', 'hr', 'image'].includes(doc[end - 1].t)) end--;
  const body = doc.slice(0, end).filter((l) => DRAWN.has(l.t));
  const tail = doc.slice(end);
  const passThrough = doc.slice(0, end).filter((l) => !DRAWN.has(l.t)); // e.g. a drawer kick inside the body
  return [...passThrough, drawLines(body, widthChars), ...tail];
}

function drawLines(lines, widthChars) {
  const { createCanvas } = lib();
  const W = Math.max(256, Math.round((widthChars * 12) / 8) * 8);
  const k = W / 576;
  const PAD = Math.round(6 * k);
  const base = Math.round(23 * k);
  const font = (size, bold) => `${Math.round(size === 2 ? base * 1.45 : base)}px ${bold ? '"PosLatin Bold", "PosTamil Bold", "PosSinhala Bold"' : 'PosLatin, PosTamil, PosSinhala'}`;
  const lineH = (size) => Math.round((size === 2 ? base * 1.45 : base) * 1.5);

  const cv = createCanvas(W, 8000);
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, 8000);
  g.fillStyle = '#000'; g.strokeStyle = '#000'; g.textBaseline = 'alphabetic';

  // wrap text to a width, keeping leading spaces as an indent on every wrapped line
  const wrap = (s, maxW) => {
    const lead = (String(s).match(/^ */)[0] || '').length;
    const indent = ' '.repeat(lead); const words = String(s).slice(lead).split(/\s+/).filter(Boolean);
    const out = []; let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (g.measureText(indent + t).width <= maxW || !cur) cur = t; else { out.push(indent + cur); cur = w; }
    }
    out.push(indent + cur);
    return out;
  };

  let y = 0;
  for (const l of lines) {
    if (l.t === 'feed') { y += lineH(1) * (l.n || 1); continue; }
    if (l.t === 'hr') {
      const mid = y + Math.round(lineH(1) / 2);
      g.lineWidth = Math.max(2, Math.round(2 * k)); g.setLineDash([Math.round(8 * k), Math.round(6 * k)]);
      g.beginPath(); g.moveTo(PAD, mid); g.lineTo(W - PAD, mid); g.stroke(); g.setLineDash([]);
      y += lineH(1); continue;
    }
    if (l.t === 'image') {
      const iw = l.w; const ih = l.h; const bytes = Buffer.from(l.data, 'base64'); const rowB = iw / 8;
      const x0 = l.align === 'left' ? PAD : Math.max(0, Math.round((W - iw) / 2));
      const img = g.createImageData(iw, ih);
      for (let r = 0; r < ih; r++) for (let c = 0; c < iw; c++) {
        const on = bytes[r * rowB + (c >> 3)] & (0x80 >> (c & 7)); const j = (r * iw + c) * 4;
        img.data[j] = img.data[j + 1] = img.data[j + 2] = on ? 0 : 255; img.data[j + 3] = 255;
      }
      g.putImageData(img, x0, y + 4); y += ih + 12; continue;
    }
    const size = l.size === 2 ? 2 : 1; g.font = font(size, !!l.bold); const h = lineH(size);
    const asc = Math.round(h * 0.72);
    if (l.t === 'text') {
      for (const ln of wrap(l.s || '', W - PAD * 2)) {
        const tw = g.measureText(ln).width;
        const x = l.align === 'center' ? (W - tw) / 2 : l.align === 'right' ? W - PAD - tw : PAD;
        g.fillText(ln, x, y + asc); y += h;
      }
      continue;
    }
    if (l.t === 'row') {
      const r = String(l.r ?? ''); const rw = g.measureText(r).width;
      const leftW = Math.max(W * 0.35, W - PAD * 2 - rw - Math.round(16 * k));
      const parts = wrap(l.l || '', leftW);
      parts.forEach((ln, i) => {
        g.fillText(ln, PAD, y + asc);
        if (i === 0 && r) g.fillText(r, W - PAD - rw, y + asc);
        y += h;
      });
    }
  }
  const H = Math.max(1, Math.ceil(y + 4));
  // 1-bit, MSB first, rows of W/8 bytes (same layout as the logo raster)
  const px = g.getImageData(0, 0, W, H).data; const rowB = W / 8; const bits = Buffer.alloc(rowB * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const j = (r * W + c) * 4; const lum = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
    if (lum < 150) bits[r * rowB + (c >> 3)] |= 0x80 >> (c & 7);
  }
  return { t: 'image', w: W, h: H, data: bits.toString('base64'), align: 'left' };
}

module.exports = { rasterizeDoc };

// Builds the printable QR test sheet as PDFs: editor/print-test-letter.pdf and
// editor/print-test-a4.pdf. A PDF has a fixed physical size; web pages don't
// (iOS printed the HTML version about 9% too big even at "100%").
// Hand-written PDF: built-in Helvetica (nothing embedded), the QR code drawn
// once and reused at each size, compressed streams. Stays well under 100 KiB.
//   node scripts/make-print-test.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import { qrMatrix } from '../editor/qr.js';

// A real link (owned by the deploy key) that opens permapath.link, as long as
// every PermaPath code, so the density matches what people print.
export const TEST_URL = 'https://arweave.net/u3gO3Oo3P-loxIOdLUlnUgflSqEovH6YIkrJBLLRfhE?l=8NiAUY8SAUDkrHw7VCmjVc8M708VTCkmNmBbtyidhRc';
const QUIET = 4; // white border in modules (the QR minimum)
const IN = 72, MM = 72 / 25.4;

// ---------- text metrics (Helvetica AFM widths, 1/1000 em) ----------
const W = {};
' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'.split('').forEach((c, i) => {
  W[c] = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611,
    722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584][i];
});
Object.assign(W, { '€': 556, '£': 556, '¥': 556, '¢': 556, '×': 584, '·': 278, '–': 556, '’': 222, '“': 333, '”': 333 });
const width = (text, size, bold) => [...text].reduce((n, c) => n + (W[c] ?? 556), 0) * size / 1000 * (bold ? 1.06 : 1);

// WinAnsi bytes for the few non-ASCII characters used.
const WIN = { '€': 0x80, '£': 0xa3, '¥': 0xa5, '¢': 0xa2, '×': 0xd7, '·': 0xb7, '–': 0x96, '’': 0x92, '“': 0x93, '”': 0x94 };
const pdfString = (text) => `(${[...text].map((c) => {
  if (WIN[c]) return `\\${WIN[c].toString(8)}`;
  return c === '(' || c === ')' || c === '\\' ? `\\${c}` : c;
}).join('')})`;

// ---------- page drawing, in points from the top-left ----------
class Page {
  constructor(w, h) { this.w = w; this.h = h; this.ops = []; }
  text(x, y, str, { size = 10, bold = false, gray = 0, align = 'left' } = {}) {
    const dx = align === 'center' ? -width(str, size, bold) / 2 : align === 'right' ? -width(str, size, bold) : 0;
    this.ops.push(`${gray} g BT /${bold ? 'F2' : 'F1'} ${size} Tf ${(x + dx).toFixed(2)} ${(this.h - y).toFixed(2)} Td ${pdfString(str)} Tj ET`);
  }
  // Rich line: [[text, {bold}], ...] left-aligned.
  runs(x, y, parts, size = 10, gray = 0) {
    for (const [str, o = {}] of parts) { this.text(x, y, str, { size, gray, ...o }); x += width(str, size, o.bold); }
  }
  // Wraps plain text to maxW; returns the y after the last line.
  para(x, y, str, maxW, { size = 10, gray = 0, lead = 1.35, bold = false } = {}) {
    let line = '';
    for (const word of str.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (width(next, size, bold) > maxW && line) { this.text(x, y, line, { size, gray, bold }); y += size * lead; line = word; } else line = next;
    }
    if (line) { this.text(x, y, line, { size, gray, bold }); y += size * lead; }
    return y;
  }
  line(x1, y1, x2, y2, w = 0.5) { this.ops.push(`${w} w 0 G ${x1.toFixed(2)} ${(this.h - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.h - y2).toFixed(2)} l S`); }
  circle(cx, cy, r, w = 0.8) {
    const k = 0.5523 * r, Y = this.h - cy;
    const p = (a, b) => `${a.toFixed(2)} ${b.toFixed(2)}`;
    this.ops.push(`${w} w 0 G ${p(cx + r, Y)} m ${p(cx + r, Y + k)} ${p(cx + k, Y + r)} ${p(cx, Y + r)} c ${p(cx - k, Y + r)} ${p(cx - r, Y + k)} ${p(cx - r, Y)} c `
      + `${p(cx - r, Y - k)} ${p(cx - k, Y - r)} ${p(cx, Y - r)} c ${p(cx + k, Y - r)} ${p(cx + r, Y - k)} ${p(cx + r, Y)} c S`);
  }
  roundRect(x, y, w, h, r, lw = 0.8) {
    const k = 0.5523 * r, X = x, Y = this.h - y - h, p = (a, b) => `${a.toFixed(2)} ${b.toFixed(2)}`;
    this.ops.push(`${lw} w 0 G ${p(X + r, Y)} m ${p(X + w - r, Y)} l ${p(X + w - r + k, Y)} ${p(X + w, Y + r - k)} ${p(X + w, Y + r)} c `
      + `${p(X + w, Y + h - r)} l ${p(X + w, Y + h - r + k)} ${p(X + w - r + k, Y + h)} ${p(X + w - r, Y + h)} c ${p(X + r, Y + h)} l `
      + `${p(X + r - k, Y + h)} ${p(X, Y + h - r + k)} ${p(X, Y + h - r)} c ${p(X, Y + r)} l ${p(X, Y + r - k)} ${p(X + r - k, Y)} ${p(X + r, Y)} c S`);
  }
  // A QR code whose black square is `size` points, top-left of the white border at (x, y).
  qr(x, y, size, n) {
    const s = size / n, full = s * (n + QUIET * 2);
    this.ops.push(`q 1 g ${x.toFixed(2)} ${(this.h - y - full).toFixed(2)} ${full.toFixed(2)} ${full.toFixed(2)} re f Q`);
    this.ops.push(`q ${s.toFixed(5)} 0 0 ${(-s).toFixed(5)} ${(x + QUIET * s).toFixed(3)} ${(this.h - y - QUIET * s).toFixed(3)} cm /QR Do Q`);
    return full;
  }
}

// ---------- the sheet ----------
function sheet(pw, ph) {
  const { n, dark } = qrMatrix(TEST_URL);
  const M = 0.5 * IN, CW = pw - 2 * M; // margins and content width
  const pages = [];
  const label = (p, cx, y, inches) => {
    p.text(cx, y, `${inches} in · ${(inches * 2.54).toFixed(1).replace(/\.0$/, '')} cm`, { size: 8, bold: true, align: 'center' });
    const d = inches * 10;
    p.text(cx, y + 10, 'scans from', { size: 7, gray: 0.35, align: 'center' });
    p.text(cx, y + 19, `~${d < 24 ? `${d} in / ${Math.round(d * 2.54)} cm` : `${+(d / 12).toFixed(1)} ft / ${+(d * 0.0254).toFixed(1)} m`}`, { size: 7, gray: 0.35, align: 'center' });
  };
  const full = (inches) => inches * IN * (n + QUIET * 2) / n;

  // Page 1: scale check and small codes.
  let p = new Page(pw, ph);
  let y = M + 14;
  p.text(M, y, 'PermaPath QR code print test', { size: 17, bold: true });
  y = p.para(M, y + 18, 'Print at 100% (“Actual size”, not “Fit to page”). A real credit card should cover the card outline exactly, and real coins the circles. If they don’t match, check the scale setting and print again.', CW, { size: 10 });
  p.text(M, y + 10, 'Scale check', { size: 11, bold: true });
  y += 22;
  const cardW = 85.6 * MM, cardH = 53.98 * MM;
  p.roundRect(M, y, cardW, cardH, 3.18 * MM);
  p.runs(M + 10, y + 16, [['Credit card ', { bold: true }], ['85.6 × 54 mm (3.37 × 2.13 in)']], 8);
  p.roundRect(M + 10, y + 50, 11 * MM, 8.5 * MM, 1.5 * MM, 0.6);
  p.text(M + 10, y + cardH - 10, 'Any bank, ID or gift card is this size.', { size: 7, gray: 0.35 });
  const COINS = [['US quarter', 24.26], ['Euro €1', 23.25], ['UK £1', 23.43], ['Canada 25¢', 23.88], ['Japan ¥100', 22.6], ['Australia $1', 25]];
  const colW = (CW - cardW - 18) / 3;
  COINS.forEach(([name, mm], i) => {
    const cx = M + cardW + 18 + colW * (i % 3) + colW / 2, top = y + (i < 3 ? 0 : 92), r = mm * MM / 2;
    p.circle(cx, top + 36, r);
    p.text(cx, top + 36 + 25 * MM / 2 + 10, name, { size: 7.5, align: 'center' });
    p.text(cx, top + 36 + 25 * MM / 2 + 19, `${mm} mm`, { size: 7, gray: 0.35, align: 'center' });
  });
  y += Math.max(cardH, 184) + 12;
  // Ruler: 6 in on top (quarter-inch ticks), 15 cm below (mm ticks).
  const rw = 6.1 * IN, rh = 0.6 * IN;
  p.roundRect(M, y, rw, rh, 0.01, 0.6);
  for (let q = 0; q <= 24; q++) {
    const x = M + q * IN / 4;
    p.line(x, y, x, y + (q % 4 === 0 ? 11 : q % 2 === 0 ? 7 : 4), 0.5);
    if (q % 4 === 0 && q) p.text(x - 2, y + 19, `${q / 4} in`, { size: 7, align: 'right' });
  }
  for (let mm = 0; mm <= 150; mm++) {
    const x = M + mm * MM;
    p.line(x, y + rh, x, y + rh - (mm % 10 === 0 ? 11 : mm % 5 === 0 ? 7 : 3.5), 0.35);
    if (mm % 10 === 0 && mm) p.text(x - 2, y + rh - 13, `${mm / 10} cm`, { size: 7, align: 'right' });
  }
  y += rh + 26;
  p.text(M, y, 'How small can it be?', { size: 11, bold: true });
  y = p.para(M, y + 16, 'Scan each code with your phone. They all open permapath.link and work like any PermaPath code. The size is the black square; the white border is part of the code, so keep it when you cut or place a code.', CW, { size: 10 });
  const small = [0.5, 0.75, 1, 1.25, 1.5];
  const widths = small.map(full), gap = (CW - widths.reduce((a, b) => a + b, 0)) / (small.length - 1);
  const rowBottom = y + 6 + Math.max(...widths);
  let x = M;
  small.forEach((s, i) => {
    p.qr(x, rowBottom - widths[i], s * IN, n);
    label(p, x + widths[i] / 2, rowBottom + 10, s);
    x += widths[i] + gap;
  });
  y = rowBottom + 52;
  const mod = (inches) => ((inches * 25.4) / n).toFixed(2);
  p.para(M, y, `Each code is ${n} × ${n} squares (PermaPath codes hold about 110 characters). At 0.5 in a square is only ${mod(0.5)} mm, so older phones may struggle; from 0.75 in (${mod(0.75)} mm) up, most phones scan easily.`, CW, { size: 8.5, gray: 0.35 });
  pages.push(p);

  // Page 2: bigger codes.
  p = new Page(pw, ph);
  y = M + 14;
  p.text(M, y, 'Bigger: signs and posters', { size: 11, bold: true });
  const [w2, w3] = [full(2), full(3)];
  const g = 0.5 * IN, startX = M + (CW - w2 - w3 - g) / 2, base = y + 14 + w3;
  p.qr(startX, base - w2, 2 * IN, n); label(p, startX + w2 / 2, base + 10, 2);
  p.qr(startX + w2 + g, base - w3, 3 * IN, n); label(p, startX + w2 + g + w3 / 2, base + 10, 3);
  const w4 = full(4), top4 = base + 44;
  p.qr(M + (CW - w4) / 2, top4, 4 * IN, n); label(p, M + CW / 2, top4 + w4 + 10, 4);
  pages.push(p);

  // Page 3: full page.
  p = new Page(pw, ph);
  const w6 = full(6);
  p.text(pw / 2, M + 16, 'Full page', { size: 16, bold: true, align: 'center' });
  p.qr((pw - w6) / 2, M + 30, 6 * IN, n);
  p.text(pw / 2, M + 30 + w6 + 14, '6 in · 15.2 cm · scans from ~5 ft / 1.5 m, across a room', { size: 9, bold: true, align: 'center' });
  p.text(pw / 2, M + 30 + w6 + 28, 'PermaPath codes never need reprinting: change where they go at any time. Make yours at permapath.link.', { size: 8.5, gray: 0.35, align: 'center' });
  pages.push(p);

  // The QR code once, in module units (1 unit = 1 module), merged into runs.
  let qr = '0 g\n';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!dark(r, c)) continue;
      let e = c;
      while (e + 1 < n && dark(r, e + 1)) e++;
      qr += `${c} ${r} ${e - c + 1} 1 re\n`;
      c = e;
    }
  }
  qr += 'f';
  return { pages, qr, n };
}

// ---------- PDF file ----------
export function pdf(pw, ph) {
  const { pages, qr, n } = sheet(pw, ph);
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const stream = (dict, text) => {
    const data = zlib.deflateSync(Buffer.from(text, 'latin1'), { level: 9 });
    return Buffer.concat([Buffer.from(`<< ${dict} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
  };
  const catalog = add(null), pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const qrObj = add(stream(`/Type /XObject /Subtype /Form /BBox [0 0 ${n} ${n}]`, qr));
  const kids = pages.map((p) => {
    // Latin-1 so the octal escapes for €, £ and friends stay single bytes.
    const content = add(stream('', p.ops.join('\n')));
    return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${pw} ${ph}] /Contents ${content} 0 R `
      + `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> /XObject << /QR ${qrObj} 0 R >> >> >>`);
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R /ViewerPreferences << /PrintScaling /None >> >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let at = parts[0].length;
  objs.forEach((body, i) => {
    const buf = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n')]);
    offsets.push(at);
    at += buf.length;
    parts.push(buf);
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
    + `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info << /Title (PermaPath QR code print test) >> >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [name, w, h] of [['letter', 612, 792], ['a4', 595.28, 841.89]]) {
    const out = new URL(`../editor/print-test-${name}.pdf`, import.meta.url);
    const bytes = pdf(w, h);
    fs.writeFileSync(out, bytes);
    console.log(`${out.pathname.split('/').pop()}: ${(bytes.length / 1024).toFixed(1)} KiB`);
  }
}

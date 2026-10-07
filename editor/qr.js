// QR codes: the module matrix, plus designed rendering (colors, square or
// rounded modules, a center logo, a label underneath) to SVG or to a
// canvas. Shared by the editor, the history page and the CLI (no DOM needed
// for SVG).
import qrcode from './vendor/qrcode.mjs';

// ec: error correction. 'M' (15%) normally; 'H' (30%) for a logo or the
// sturdy option, which makes the code denser (45 → 57 squares for our URLs).
export function qrMatrix(text, ec = 'M') {
  const qr = qrcode(0, ec);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return { n, dark: (r, c) => qr.isDark(r, c) };
}

// ---------- designs ----------
// Saved per link in its record (the Design tag), so every device and download
// matches. All fields optional:
//   fg, bg       '#rrggbb' (default black on white)
//   transparent  no background (for stickers, engraving, print shops)
//   style        'square' | 'rounded' (dots were dropped 2026-10-07: they read
//                worse than squares or rounded, especially with a logo; old
//                'dots' designs show as rounded)
//   label        short text under the code, e.g. 'Scan for the menu'
//   logo         'https://arweave.net/<id>' image shown in the middle
//   sturdy       extra error correction (outdoors, scratches)

export const LABEL_MAX = 40;
const HEX = /^#[0-9a-f]{6}$/i;

export function cleanDesign(d = {}) {
  const out = {};
  if (HEX.test(d.fg || '') && d.fg.toLowerCase() !== '#000000') out.fg = d.fg.toLowerCase();
  if (HEX.test(d.bg || '') && d.bg.toLowerCase() !== '#ffffff') out.bg = d.bg.toLowerCase();
  if (d.transparent) out.transparent = true;
  if (d.style === 'rounded' || d.style === 'dots') out.style = 'rounded';
  const label = String(d.label || '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
  if (label) out.label = label;
  if (/^https:\/\/arweave\.net\/[A-Za-z0-9_-]{43}$/.test(d.logo || '')) out.logo = d.logo;
  if (d.sturdy) out.sturdy = true;
  return out;
}

export const isPlain = (d) => !d || Object.keys(cleanDesign(d)).length === 0;
export const ecFor = (d = {}) => (d.logo || d.sturdy ? 'H' : 'M');

// WCAG relative luminance and contrast ratio, to keep codes scannable.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(fg = '#000000', bg = '#ffffff') {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Problems with a design: { error } blocks saving, { warnings } are advice.
export function checkDesign(d = {}) {
  const fg = d.fg || '#000000', bg = d.bg || '#ffffff';
  const warnings = [];
  if (!d.transparent && contrast(fg, bg) < 3) return { error: 'The code and background colors are too close to scan reliably. Make the code darker or the background lighter.', warnings };
  if (!d.transparent && luminance(fg) > luminance(bg)) warnings.push('Light on dark: some phones can’t read inverted codes. Dark on light is safest.');
  if (d.transparent && luminance(fg) > 0.4) warnings.push('With a transparent background, print this light code on something dark, and test it first.');
  if (d.style === 'rounded' || d.logo || d.sturdy) warnings.push('Customized designs may need to be printed larger than plain codes.');
  return { error: null, warnings };
}

// ---------- geometry ----------

const QUIET = 4; // white border, in modules

// Alignment pattern centres per QR version (spec table, versions 2-20). The
// rounded style draws these solid, like the corner squares, so they stay
// easy for scanners to find.
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]];

// Everything to draw, in module units: background, modules, finder patterns,
// logo box and label band. Renderers turn this into SVG or canvas calls.
function layout(text, design = {}, margin = QUIET, { label = true } = {}) {
  const d = cleanDesign(design);
  const { n, dark } = qrMatrix(text, ecFor(d));
  const size = n + margin * 2;
  const band = label && d.label ? Math.round(size * 0.17) : 0;
  const fancy = d.style === 'rounded';
  const finders = [[0, 0], [0, n - 7], [n - 7, 0]];
  const inFinder = (r, c) => finders.some(([fr, fc]) => r >= fr && r < fr + 7 && c >= fc && c < fc + 7);
  // Logo: about 22% of the code's width (odd, so it's centred), cleared with one module of padding.
  let logo = null;
  if (d.logo) {
    let s = Math.round(n * 0.22);
    if (s % 2 === 0) s += 1;
    const at = (n - s) / 2;
    logo = { at: at + margin, size: s, clear: [at - 1, at + s + 1] };
  }
  const cleared = (r, c) => logo && r >= logo.clear[0] && r < logo.clear[1] && c >= logo.clear[0] && c < logo.clear[1];
  const centres = ALIGN[(n - 17) / 4] || [];
  const aligns = fancy ? centres.flatMap((r) => centres.map((c) => [r, c]))
    .filter(([r, c]) => !inFinder(r, c) && ![[r - 2, c - 2], [r + 2, c + 2], [r - 2, c + 2], [r + 2, c - 2]].some(([y, x]) => cleared(y, x))) : [];
  const inAlign = (r, c) => aligns.some(([ar, ac]) => Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2);
  const modules = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!dark(r, c) || cleared(r, c) || (fancy && (inFinder(r, c) || inAlign(r, c)))) continue;
      modules.push([r, c]);
    }
  }
  return {
    d, n, size, width: size, height: size + band, margin, band, modules, logo,
    finders: fancy ? finders.map(([r, c]) => [r + margin, c + margin]) : [],
    aligns: aligns.map(([r, c]) => [r - 2 + margin, c - 2 + margin]), // top-left corners of the 5×5 patterns
    fg: d.fg || '#000000', bg: d.bg || '#ffffff',
  };
}

const r2 = (v) => Math.round(v * 1000) / 1000;

// Rounded-rectangle path (SVG syntax) at x, y with size w × h and radius rad.
function roundRectPath(x, y, w, h, rad) {
  return `M${r2(x + rad)} ${r2(y)}h${r2(w - 2 * rad)}a${rad} ${rad} 0 0 1 ${rad} ${rad}v${r2(h - 2 * rad)}a${rad} ${rad} 0 0 1 ${-rad} ${rad}`
    + `h${r2(-(w - 2 * rad))}a${rad} ${rad} 0 0 1 ${-rad} ${-rad}v${r2(-(h - 2 * rad))}a${rad} ${rad} 0 0 1 ${rad} ${-rad}z`;
}

let uses = 0;
const escapeXml = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';

// SVG markup. logoData: the logo as a data: URL (SVG files must embed it to be
// self-contained); without it, the logo area is left blank. label: false
// leaves the label off (thumbnails).
export function qrSvg(text, margin = QUIET, design = {}, { logoData = '', label = true } = {}) {
  const L = layout(text, design, margin, { label });
  const { d, fg, bg, margin: m } = L;
  const parts = [];
  if (!d.transparent) parts.push(`<rect width="${L.width}" height="${L.height}" fill="${bg}"/>`);
  let path = '';
  if (d.style === 'rounded') {
    // One rounded square, reused (ids are per drawing: several codes share a page).
    const id = `pp-m${++uses}`;
    parts.push(`<defs><rect id="${id}" x=".05" y=".05" width=".9" height=".9" rx=".3" fill="${fg}"/></defs>`);
    for (const [r, c] of L.modules) parts.push(`<use href="#${id}" x="${c + m}" y="${r + m}"/>`);
  } else {
    for (const [r, c] of L.modules) path += `M${c + m} ${r + m}h1v1h-1z`;
  }
  for (const [r, c] of L.finders) {
    // Ring (outer minus inner, by the even-odd rule) plus the centre square.
    path += roundRectPath(c, r, 7, 7, 1.6) + roundRectPath(c + 1, r + 1, 5, 5, 1.1) + roundRectPath(c + 2, r + 2, 3, 3, 0.8);
  }
  for (const [r, c] of L.aligns) {
    path += roundRectPath(c, r, 5, 5, 1.2) + roundRectPath(c + 1, r + 1, 3, 3, 0.7) + roundRectPath(c + 2, r + 2, 1, 1, 0.3);
  }
  if (path) parts.push(`<path d="${path}" fill="${fg}" fill-rule="evenodd"/>`);
  if (L.logo) {
    const { at, size } = L.logo;
    if (!d.transparent) parts.push(`<rect x="${at - 0.5}" y="${at - 0.5}" width="${size + 1}" height="${size + 1}" rx="1" fill="${bg}"/>`);
    if (logoData) parts.push(`<image href="${escapeXml(logoData)}" x="${at}" y="${at}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`);
  }
  if (L.band) {
    const fs = r2(L.band * 0.5);
    parts.push(`<text x="${L.width / 2}" y="${r2(L.size + L.band * 0.42)}" text-anchor="middle" dominant-baseline="middle" font-family="${FONT}" font-weight="700" font-size="${fs}" fill="${fg}">${escapeXml(d.label)}</text>`);
  }
  const fancy = d.style === 'rounded';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}"${fancy ? '' : ' shape-rendering="crispEdges"'}>${parts.join('')}</svg>`;
}

// Draws onto a 2D canvas context at `scale` pixels per module. logoImage: an
// already-loaded image (drawing must stay synchronous for iOS's share sheet).
// Returns { width, height } in pixels; call qrCanvasSize first to size the canvas.
export function qrCanvasSize(text, scale, design = {}, margin = QUIET) {
  const L = layout(text, design, margin);
  return { width: L.width * scale, height: L.height * scale };
}

export function drawQr(ctx, text, scale, design = {}, { logoImage = null, margin = QUIET } = {}) {
  const L = layout(text, design, margin);
  const { d, fg, bg, margin: m } = L;
  const s = scale;
  ctx.save();
  if (!d.transparent) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, L.width * s, L.height * s);
  }
  ctx.fillStyle = fg;
  const rounded = (x, y, w, h, rad) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, rad);
    else ctx.rect(x, y, w, h);
    ctx.fill();
  };
  for (const [r, c] of L.modules) {
    const x = (c + m) * s, y = (r + m) * s;
    if (d.style === 'rounded') {
      rounded(x + s * 0.05, y + s * 0.05, s * 0.9, s * 0.9, s * 0.3);
    } else {
      ctx.fillRect(x, y, s, s);
    }
  }
  for (const [r, c] of L.finders) {
    const x = c * s, y = r * s;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, 7 * s, 7 * s, 1.6 * s);
      ctx.roundRect(x + s, y + s, 5 * s, 5 * s, 1.1 * s);
    } else {
      ctx.rect(x, y, 7 * s, 7 * s);
      ctx.rect(x + s, y + s, 5 * s, 5 * s);
    }
    ctx.fill('evenodd');
    rounded(x + 2 * s, y + 2 * s, 3 * s, 3 * s, 0.8 * s);
  }
  for (const [r, c] of L.aligns) {
    const x = c * s, y = r * s;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, 5 * s, 5 * s, 1.2 * s);
      ctx.roundRect(x + s, y + s, 3 * s, 3 * s, 0.7 * s);
    } else {
      ctx.rect(x, y, 5 * s, 5 * s);
      ctx.rect(x + s, y + s, 3 * s, 3 * s);
    }
    ctx.fill('evenodd');
    rounded(x + 2 * s, y + 2 * s, s, s, 0.3 * s);
  }
  if (L.logo) {
    const { at, size } = L.logo;
    if (!d.transparent) {
      ctx.fillStyle = bg;
      rounded((at - 0.5) * s, (at - 0.5) * s, (size + 1) * s, (size + 1) * s, s);
    }
    if (logoImage) {
      const iw = logoImage.naturalWidth || logoImage.width, ih = logoImage.naturalHeight || logoImage.height;
      const k = Math.min(size / iw, size / ih);
      ctx.drawImage(logoImage, (at + (size - iw * k) / 2) * s, (at + (size - ih * k) / 2) * s, iw * k * s, ih * k * s);
    }
  }
  if (L.band) {
    ctx.fillStyle = fg;
    ctx.font = `700 ${L.band * 0.5 * s}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(d.label, (L.width / 2) * s, (L.size + L.band * 0.42) * s, (L.width - 2) * s);
  }
  ctx.restore();
  return { width: L.width * s, height: L.height * s };
}

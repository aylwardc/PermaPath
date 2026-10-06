// Print test page: real PermaPath codes at exact physical sizes, plus a credit
// card, coins and a ruler to check the printer's scale. No network needed.
import { qrMatrix } from './qr.js';

// A real link (owned by the deploy key) that opens permapath.link. Same length
// as every PermaPath code, so the density matches what people will print.
const TEST_URL = 'https://arweave.net/u3gO3Oo3P-loxIOdLUlnUgflSqEovH6YIkrJBLLRfhE?l=8NiAUY8SAUDkrHw7VCmjVc8M708VTCkmNmBbtyidhRc';
const QUIET = 4; // white border, in modules (the QR standard's minimum)

const { n, dark } = qrMatrix(TEST_URL);
const $ = (id) => document.getElementById(id);

// sizeIn is the black square; the white border is added around it.
function codeSvg(sizeIn) {
  const total = n + QUIET * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
  const w = (sizeIn * total) / n;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}in" height="${w}in" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

const cm = (inches) => (inches * 2.54).toFixed(1).replace(/\.0$/, '');
// Rule of thumb: a code scans from about 10 times its width.
function distance(inches) {
  const d = inches * 10;
  return d < 24 ? `${d} in / ${Math.round(d * 2.54)} cm` : `${+(d / 12).toFixed(1)} ft / ${+(d * 0.0254).toFixed(1)} m`;
}

const card = (s) => `<div class="code">${codeSvg(s)}<b>${s} in</b> · ${cm(s)} cm<br><span class="muted">scans from<br>~${distance(s)}</span></div>`;
$('codes-small').innerHTML = [0.5, 0.75, 1, 1.25, 1.5].map(card).join('');
$('codes-large').innerHTML = `<div class="codes">${[2, 3].map(card).join('')}</div>${card(4)}`;

const module = (inches) => ((inches * 25.4) / n).toFixed(2);
$('density').textContent = `Each code is ${n} × ${n} squares (PermaPath codes hold about 110 characters). At 0.5 in a square is only ${module(0.5)} mm, `
  + `so older phones may struggle; from 0.75 in (${module(0.75)} mm) up, most phones scan easily. Print on matte paper with dark ink, and keep the white border.`;

const FULL = 6;
$('full').innerHTML = `<h1>Full page</h1>${codeSvg(FULL)}<p><b>${FULL} in</b> · ${cm(FULL)} cm · scans from ~${distance(FULL)}, across a room or from a passing car.</p>`
  + '<p class="muted">PermaPath codes never need reprinting: the owner can change where they go at any time. Make yours at permapath.link.</p>';

// Coins, by diameter in mm. The UK £1 has 12 sides; the circle is across its corners.
const COINS = [['US quarter', 24.26], ['Euro €1', 23.25], ['UK £1', 23.43], ['Canada 25¢', 23.88], ['Japan ¥100', 22.6], ['Australia $1', 25]];
$('coins').innerHTML = COINS.map(([name, mm]) => `<div class="coin"><div class="disc" style="width:${mm}mm;height:${mm}mm"></div>${name}<br><span class="muted">${mm} mm</span></div>`).join('');

// Ruler: 6 inches on top (quarter-inch ticks), 15 cm below (millimetre ticks).
(function ruler() {
  const W = 6.1, H = 0.6; // inches
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}in" height="${H}in" viewBox="0 0 ${W * 96} ${H * 96}" font-size="9" font-family="system-ui, sans-serif">`;
  s += `<rect x="0.5" y="0.5" width="${W * 96 - 1}" height="${H * 96 - 1}" fill="none" stroke="#000" stroke-width="1"/>`;
  for (let q = 0; q <= 24; q++) {
    const x = q * 24 + 0.5, len = q % 4 === 0 ? 14 : q % 2 === 0 ? 9 : 5;
    s += `<line x1="${x}" y1="0" x2="${x}" y2="${len}" stroke="#000"/>`;
    if (q % 4 === 0 && q) s += `<text x="${x - 2}" y="24" text-anchor="end">${q / 4} in</text>`;
  }
  const pxPerMm = 96 / 25.4;
  for (let mm = 0; mm <= 150; mm++) {
    const x = mm * pxPerMm + 0.5, len = mm % 10 === 0 ? 14 : mm % 5 === 0 ? 9 : 4;
    s += `<line x1="${x}" y1="${H * 96}" x2="${x}" y2="${H * 96 - len}" stroke="#000" stroke-width="0.6"/>`;
    if (mm % 10 === 0 && mm) s += `<text x="${x - 2}" y="${H * 96 - 16}" text-anchor="end">${mm / 10} cm</text>`;
  }
  $('ruler').innerHTML = `${s}</svg>`;
}());

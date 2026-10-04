// Renders editor/og.png (1200x630 link preview) and editor/apple-touch-icon.png
// (180x180) from HTML. Run when the branding changes: node scripts/make-images.mjs
import { chromium } from 'playwright';
import { qrSvg } from '../editor/qr.js';

const qr = qrSvg('https://permapath.link', 2);
const og = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;width:1200px;height:630px;background:#0b6bcb;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center}
  .text{flex:1;padding:0 0 0 80px}
  h1{font-size:92px;margin:0 0 18px;letter-spacing:-1px}
  .a{font-size:52px;font-weight:700;margin:0 0 10px}
  .b{white-space:nowrap;font-size:32px;font-weight:600;margin:0 0 34px;opacity:.85}
  .c{font-size:28px;margin:0;opacity:.85}
  .qr{width:290px;height:290px;background:#fff;border-radius:28px;padding:22px;margin-right:80px}
  .qr svg{width:100%;height:100%;display:block}
</style><div class="text"><h1>PermaPath</h1><p class="a">Links that never die.</p><p class="b">QR codes you never have to reprint.</p><p class="c">permapath.link · free · no account</p></div><div class="qr">${qr}</div>`;
const icon = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;width:180px;height:180px;background:#0b6bcb;display:flex;align-items:center;justify-content:center}
  svg{width:124px;height:124px}
</style><svg viewBox="0 0 16 16"><path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM10 10h3v3h-3z" fill="#fff"/></svg>`;

const browser = await chromium.launch();
for (const [html, w, h, file] of [[og, 1200, 630, 'editor/og.png'], [icon, 180, 180, 'editor/apple-touch-icon.png']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(html);
  await page.screenshot({ path: file, type: 'png' });
  await page.close();
}
await browser.close();
console.log('wrote editor/og.png and editor/apple-touch-icon.png');

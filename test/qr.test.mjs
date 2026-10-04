// The editor draws QR codes itself from the module matrix; make sure a real
// decoder reads back exactly the link URL, at the same scale/margin as the PNG.
import test from 'node:test';
import assert from 'node:assert/strict';
import qrcode from '../editor/vendor/qrcode.mjs';

test('QR matrix decodes to the link URL', async (t) => {
  let jsQR;
  try { jsQR = (await import('jsqr')).default; } catch { return t.skip('npm i --no-save jsqr to run'); }
  const url = 'https://arweave.net/' + 'R'.repeat(43) + '?l=' + 'L'.repeat(43);
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount(), scale = 8, margin = 4, size = (n + margin * 2) * scale;
  const px = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c))
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const i = (((r + margin) * scale + y) * size + (c + margin) * scale + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  assert.equal(jsQR(px, size, size)?.data, url);
  t.diagnostic(`QR version ${(n - 17) / 4} (${n}x${n} modules)`);
});

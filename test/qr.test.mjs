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

test('QR designs: cleaned, stored on links, checked for contrast', async () => {
  const { cleanDesign, checkDesign, ecFor, qrSvg, qrMatrix } = await import('../editor/qr.js');
  const { linkTags, buildLinks, carry } = await import('../editor/links.js');
  assert.deepEqual(cleanDesign({ fg: '#000000', bg: '#FFFFFF', style: 'square', label: '  Scan   me  ', logo: 'https://evil.example/x.png', extra: 1 }), { label: 'Scan me' });
  const design = { fg: '#1d3557', style: 'rounded', label: 'Scan for the menu', logo: `https://arweave.net/${'L'.repeat(43)}`, sturdy: true };
  assert.equal(ecFor(design), 'H');
  const url = 'https://arweave.net/u3gO3Oo3P-loxIOdLUlnUgflSqEovH6YIkrJBLLRfhE?l=8NiAUY8SAUDkrHw7VCmjVc8M708VTCkmNmBbtyidhRc';
  assert.equal(qrMatrix(url, 'H').n, 57);

  const tags = linkTags({ destination: 'https://a.example/', seq: 1, design });
  assert.equal(JSON.parse(tags.find((t) => t.name === 'Design').value).style, 'rounded');
  assert.equal(cleanDesign({ style: 'dots' }).style, 'rounded', 'old dot designs show as rounded');
  assert.ok(!linkTags({ destination: 'https://a.example/', seq: 1, design: {} }).some((t) => t.name === 'Design'), 'plain codes add no tag');
  const [link] = buildLinks([{ id: 'L1', owner: 'o', tags: Object.fromEntries(tags.map((t) => [t.name, t.value])) }]);
  assert.deepEqual(carry(link).design, cleanDesign(design));

  assert.match(checkDesign({ fg: '#bbbbbb' }).error, /too close/);
  assert.equal(checkDesign({ fg: '#1d3557' }).error, null);
  assert.match(checkDesign({ fg: '#ffffff', bg: '#111111' }).warnings.join(), /inverted/);
  assert.match(checkDesign({ style: 'rounded' }).warnings.join(), /printed larger/);

  const svg = qrSvg(url, 4, design, { logoData: 'data:image/png;base64,AAAA' });
  assert.match(svg, /fill="#1d3557"/);
  assert.match(svg, />Scan for the menu<\/text>/);
  assert.match(svg, /<image href="data:image\/png;base64,AAAA"/);
  assert.doesNotMatch(qrSvg(url, 2, design, { label: false }), /<text/);
  assert.doesNotMatch(qrSvg(url, 4, { label: '<b>"&' }), /<b>/);
});

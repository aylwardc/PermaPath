// The printable test sheet PDFs: up to date with their generator, small enough
// to upload for free, and the right physical size.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pdf } from '../scripts/make-print-test.mjs';

for (const [name, w, h] of [['letter', 612, 792], ['a4', 595.28, 841.89]]) {
  test(`print-test-${name}.pdf matches scripts/make-print-test.mjs`, () => {
    const file = fs.readFileSync(new URL(`../editor/print-test-${name}.pdf`, import.meta.url));
    assert.ok(file.equals(pdf(w, h)), 'run: node scripts/make-print-test.mjs');
    assert.ok(file.length < 100 * 1024, `${file.length} bytes`);
    assert.match(file.toString('latin1'), new RegExp(`/MediaBox \\[0 0 ${w} ${h}\\]`));
  });
}

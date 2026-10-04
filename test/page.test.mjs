import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPageHtml, parsePageHtml, renderText, pageBytes, PAGE_MAX_BYTES } from '../editor/page.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

test('page round-trips title, text and photo', () => {
  const page = { title: 'Our <menu> & "specials"', text: 'Line one\nline two\n\nSee https://example.com/menu.\n</script><b>x</b>', image: PNG };
  const html = buildPageHtml(page);
  assert.deepEqual(parsePageHtml(html), { ...page, title: page.title.trim() });
  assert.ok(pageBytes(html) < PAGE_MAX_BYTES);
});

test('page HTML escapes user content and only links http(s)', () => {
  const html = buildPageHtml({ title: '<img src=x onerror=alert(1)>', text: 'javascript:alert(1) and <script>alert(2)</script>' });
  assert.ok(!/<img src=x/.test(html));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!/href="javascript/.test(html));
  // The embedded source can't break out of its script tag.
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
});

test('renderText makes paragraphs, line breaks and links', () => {
  assert.equal(renderText('a\nb\n\nc'), '<p>a<br>b</p>\n<p>c</p>');
  assert.equal(renderText('Go to https://x.example/p?a=1&b=2.'),
    '<p>Go to <a href="https://x.example/p?a=1&amp;b=2" rel="noopener">https://x.example/p?a=1&amp;b=2</a>.</p>');
});

test('buildPageHtml validates input; parsePageHtml rejects other pages', () => {
  assert.throws(() => buildPageHtml({ title: '  ' }), /title/);
  assert.throws(() => buildPageHtml({ title: 'x', image: 'data:text/html;base64,AAAA' }), /image/);
  assert.equal(parsePageHtml('<html><body>hello</body></html>'), null);
});

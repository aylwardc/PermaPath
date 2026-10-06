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

test('contact cards: buttons, vCard, and round trip', async () => {
  const { buildPageHtml, parsePageHtml, buildVcard, cleanContact } = await import('../editor/page.js');
  const contact = { name: 'Sam Q. Rivera', role: 'Owner, Rivera Bikes', phone: '+1 (555) 010-0100', email: 'sam@example.com', website: 'example.com', address: '12 Main St; Springfield' };
  const vcardUrl = `https://arweave.net/${'V'.repeat(43)}`;
  const html = buildPageHtml({ text: 'Found my bike?', contact, vcardUrl });
  assert.match(html, /<h1>Sam Q\. Rivera<\/h1>/);
  assert.match(html, /href="tel:\+15550100100"/);
  assert.match(html, /href="sms:\+15550100100"/);
  assert.match(html, /href="mailto:sam@example\.com"/);
  assert.match(html, new RegExp(`href="${vcardUrl}" class="save" download="Sam-Q-Rivera\\.vcf"`));
  assert.match(html, /google\.com\/maps\/search\/\?api=1&amp;query=12%20Main%20St%3B%20Springfield/);
  const back = parsePageHtml(html);
  assert.deepEqual(back.contact, cleanContact(contact));
  assert.equal(back.vcardUrl, vcardUrl);
  assert.equal(back.text, 'Found my bike?');

  const v = buildVcard(contact, 'Note, with; specials\nand lines');
  assert.match(v, /^BEGIN:VCARD\r\nVERSION:3\.0\r\nFN:Sam Q\. Rivera\r\nN:Rivera;Sam Q\.;;;\r\n/);
  assert.match(v, /TITLE:Owner\\, Rivera Bikes\r\n/);
  assert.match(v, /ADR;TYPE=HOME:;;12 Main St\\; Springfield;;;;\r\n/);
  assert.match(v, /NOTE:Note\\, with\\; specials\\nand lines\r\n/);
  assert.match(buildVcard({ name: 'Cher' }), /N:;Cher;;;/);

  // Only the name is required; fields are checked.
  assert.throws(() => cleanContact({ phone: '555' }), /Add a name/);
  assert.throws(() => cleanContact({ name: 'x', phone: 'call me' }), /phone/);
  assert.throws(() => cleanContact({ name: 'x', email: 'nope' }), /email/);
  assert.throws(() => buildPageHtml({ contact: { name: 'x' }, vcardUrl: 'https://evil.example/x.vcf' }), /contact file/);
  // Script-looking text stays text.
  assert.doesNotMatch(buildPageHtml({ contact: { name: '<script>alert(1)</script>' } }), /<script>alert/);
});

test('event pages: when, where, calendar file and round trip', async () => {
  const { buildPageHtml, parsePageHtml, buildIcs, eventWhen, cleanEvent } = await import('../editor/page.js');
  const event = { name: 'Fall Bike Swap', start: Date.parse('2026-11-01T02:00:00Z'), end: Date.parse('2026-11-01T04:00:00Z'), tz: 'America/Los_Angeles', location: '12 Main St, Springfield' };
  assert.equal(eventWhen(event), 'Saturday, October 31, 2026 · 7:00 PM – 9:00 PM PDT');
  assert.equal(eventWhen({ ...event, end: Date.parse('2026-11-02T04:00:00Z') }), 'Saturday, October 31, 2026, 7:00 PM – Sunday, November 1, 2026, 8:00 PM PST');
  const icsUrl = `https://arweave.net/${'E'.repeat(43)}`;
  const html = buildPageHtml({ text: 'Bring your bike.', event, icsUrl });
  assert.match(html, /<h1>Fall Bike Swap<\/h1>/);
  assert.match(html, /class="when">Saturday, October 31, 2026 · 7:00 PM – 9:00 PM PDT</);
  assert.match(html, new RegExp(`href="${icsUrl}" class="save" download="Fall-Bike-Swap\\.ics" rel="noopener">Add to calendar`));
  assert.match(html, /calendar\.google\.com\/calendar\/render\?action=TEMPLATE&amp;text=Fall%20Bike%20Swap&amp;dates=20261101T020000Z\/20261101T040000Z/);
  const back = parsePageHtml(html);
  assert.deepEqual(back.event, cleanEvent(event));
  assert.equal(back.icsUrl, icsUrl);

  const ics = buildIcs({ ...event, end: 0 }, 'x'.repeat(200));
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
  assert.match(ics, /DTSTART:20261101T020000Z\r\nDTEND:20261101T030000Z\r\n/, 'an hour long when there is no end');
  assert.ok(ics.split('\r\n').every((line) => new TextEncoder().encode(line).length <= 75), 'long lines are folded');
  assert.throws(() => cleanEvent({ name: 'x' }), /starts/);
  assert.throws(() => cleanEvent({ name: 'x', start: 10, end: 5 }), /end after/);
  assert.throws(() => buildPageHtml({ event, icsUrl: 'https://evil.example/x.ics' }), /calendar file/);
});

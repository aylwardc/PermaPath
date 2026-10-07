// End-to-end browser checks against real Arweave (network + real uploads).
// Run: node test/browser.mjs [resolver|editor|history]   (needs test/fixtures.json for resolver)
//   Editor tests use an in-memory fake Arweave (test/fake-arweave.mjs): fast, free,
//   no uploads. LIVE=1 runs them against the real network (uploads cost Turbo
//   credits or wait for the free fallback); do that before a release.
//   BROWSER=webkit node test/browser.mjs   → same tests on WebKit (Safari's engine)
//   WORKER=1 node test/browser.mjs editor  → serve the editor through worker/src/index.js
//   (real fetch to Arweave) instead of from the local editor/ folder.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, webkit, devices } from 'playwright';
import worker from '../worker/src/index.js';
import { createFakeArweave } from './fake-arweave.mjs';
import { fetchLinkHistory } from '../editor/links.js';
import { RESOLVER_TX } from '../editor/config.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const which = process.argv[2] || 'all';
const TYPES = { '.txt': 'text/plain', '.xml': 'application/xml', '.png': 'image/png', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

function serve(dir) {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!file.startsWith(dir) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// Runs the Cloudflare Worker's fetch handler behind a local HTTP server.
function serveWorker() {
  const server = http.createServer(async (req, res) => {
    const response = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// BROWSER=webkit runs everything on Safari's engine (iOS browsers all use WebKit).
const browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch();
// While `fake` is set, every new browser context (and Node's fetch) talks to it instead of Arweave.
let fake = null;
const newContext = browser.newContext.bind(browser);
browser.newContext = async (options) => {
  const context = await newContext(options);
  if (fake) await fake.install(context);
  return context;
};
console.log(`(engine: ${process.env.BROWSER === 'webkit' ? 'webkit' : 'chromium'})`);
let failures = 0;
async function check(name, fn) {
  const context = await browser.newContext({ permissions: process.env.BROWSER === 'webkit' ? [] : ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  const page = await context.newPage();
  // Never actually leave for destination sites; record where we would have gone.
  await page.route(/^https:\/\/example\.(com|org)\//, (route) => route.fulfill({ contentType: 'text/html', body: 'landed' }));
  try {
    await fn(page);
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${err.message.split('\n').slice(0, 6).join('\n     ')}`);
    await page.screenshot({ path: `/tmp/claude-1000/pp-fail-${name.replace(/\W+/g, '-')}.png` }).catch(() => {});
  }
  // Let fake responses still in flight finish quietly instead of crashing the run.
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await context.close();
}

if (which === 'all' || which === 'resolver') {
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures.json'), 'utf8'));
  const { server, base } = await serve(path.join(root, 'resolver'));
  await check('resolver: plain link redirects', async (page) => {
    await page.goto(`${base}/?l=${fx.plain}`);
    await page.waitForURL('https://example.com/?pp=plain', { timeout: 30_000 });
  });
  await check('resolver: owner update wins, forged update ignored', async (page) => {
    await page.goto(`${base}/?l=${fx.updated}`);
    await page.waitForURL(/example\.(com|org)/, { timeout: 30_000 });
    assert.equal(page.url(), 'https://example.com/?pp=v1');
  });
  await check('resolver: disabled link shows message', async (page) => {
    await page.goto(`${base}/?l=${fx.disabled}`);
    await page.getByText('This link is turned off').waitFor({ timeout: 30_000 });
  });
  await check('resolver: future App-Version update ignored', async (page) => {
    await page.goto(`${base}/?l=${fx.future}`);
    await page.waitForURL(/example\.(com|org)/, { timeout: 30_000 });
    assert.equal(page.url(), 'https://example.com/?pp=future-v1');
  });
  await check('resolver: hands off to newer resolver', async (page) => {
    await page.goto(`${base}/?l=${fx.handoff}`);
    await page.waitForURL(`${base}/${'H'.repeat(43)}?l=${fx.handoff}&h=1`, { timeout: 30_000 });
  });
  await check('resolver v3: device rule sends iPhones elsewhere', async (page) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }));
    await page.goto(`${base}/?l=${fx.routed}`);
    await page.waitForURL(/example\.com/, { timeout: 30_000 });
    assert.equal(page.url(), 'https://example.com/?pp=ios');
  });
  await check('resolver v3: everyone else gets the main destination', async (page) => {
    await page.goto(`${base}/?l=${fx.routed}`);
    await page.waitForURL(/example\.com/, { timeout: 30_000 });
    assert.equal(page.url(), 'https://example.com/?pp=default');
  });
  await check('resolver v3: past Off-At shows the owner’s message', async (page) => {
    await page.goto(`${base}/?l=${fx.ended}`);
    await page.getByText('This event has ended. See you next year!').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('#title').textContent(), 'This link is turned off');
  });
  await check('resolver v3: counts the scan without delaying the redirect', async (page) => {
    const pings = [];
    await page.route('https://permapath.link/api/scan**', (route) => { pings.push(route.request()); return route.fulfill({ status: 204 }); });
    await page.goto(`${base}/?l=${fx.counted}`);
    await page.waitForURL('https://example.com/?pp=counted', { timeout: 30_000 });
    await page.waitForTimeout(500);
    assert.equal(pings.length, 1);
    assert.equal(pings[0].method(), 'POST');
    assert.equal(new URL(pings[0].url()).searchParams.get('l'), fx.counted);
  });
  await check('resolver v3: no scan ping for links without Count', async (page) => {
    const pings = [];
    await page.route('https://permapath.link/api/scan**', (route) => { pings.push(route.request()); return route.fulfill({ status: 204 }); });
    await page.goto(`${base}/?l=${fx.plain}`);
    await page.waitForURL('https://example.com/?pp=plain', { timeout: 30_000 });
    await page.waitForTimeout(500);
    assert.equal(pings.length, 0);
  });
  await check('resolver v3: a Resolver tag naming this page is not followed', async (page) => {
    const html = fs.readFileSync(path.join(root, 'resolver/index.html'), 'utf8');
    await page.route(`${base}/${'S'.repeat(43)}?**`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(`${base}/${'S'.repeat(43)}?l=${fx.self}`);
    await page.waitForURL(/example\.com/, { timeout: 30_000 });
    assert.equal(page.url(), 'https://example.com/?pp=self-v1');
  });
  await check('resolver v3: the same tag is followed from another resolver', async (page) => {
    await page.goto(`${base}/?l=${fx.self}`);
    await page.waitForURL(`${base}/${'S'.repeat(43)}?l=${fx.self}&h=1`, { timeout: 30_000 });
  });
  await check('resolver: handoff stops at hop limit', async (page) => {
    await page.goto(`${base}/?l=${fx.handoff}&h=3`);
    await page.getByText('This link can’t be opened').waitFor({ timeout: 30_000 });
  });
  await check('resolver: forged update with the real owner but a bad signature is ignored', async (page) => {
    // Lower endpoints pass real data through but append a forged update that
    // copies the real owner's address and key. Only the signature check can catch it.
    await page.route(/(goldsky|permagate|frostor).*graphql/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const edges = body.data?.transactions?.edges || [];
      if (body.data?.transactions?.pageInfo && edges.length) {
        const real = edges[0].node;
        edges.push({ cursor: 'forged', node: { ...real, id: 'F'.repeat(43), signature: 'A'.repeat(86), tags: real.tags.map((t) =>
          t.name === 'Destination' ? { ...t, value: 'https://example.org/?pp=hijacked' } : t.name === 'Seq' ? { ...t, value: '9999999999999999' } : t) } });
      }
      await route.fulfill({ response: res, body: JSON.stringify(body) });
    });
    await page.goto(`${base}/?l=${fx.updated}`);
    await page.waitForURL(/example\.(com|org)/, { timeout: 30_000 });
    assert.equal(page.url(), 'https://example.com/?pp=v1');
  });
  await check('resolver: fresher valid update from a lower endpoint wins', async (page) => {
    // arweave.net "hasn't seen" the update yet; another endpoint has.
    await page.route(/arweave\.net\/graphql/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (body.data?.transactions?.pageInfo) body.data.transactions.edges = [];
      await route.fulfill({ response: res, body: JSON.stringify(body) });
    });
    await page.goto(`${base}/?l=${fx.updated}`);
    await page.waitForURL(/example\.(com|org)/, { timeout: 30_000 });
    assert.equal(page.url(), 'https://example.com/?pp=v1');
  });
  await check('resolver: old-style record with a body verifies via download', async (page) => {
    await page.goto(`${base}/?l=${fx.withBody}`);
    await page.waitForURL('https://example.com/?pp=with-body', { timeout: 30_000 });
  });
  await check('resolver: browsers without Ed25519 fall back to endpoint priority', async (page) => {
    await page.addInitScript(() => {
      const real = crypto.subtle.importKey.bind(crypto.subtle);
      crypto.subtle.importKey = (format, key, alg, ...rest) =>
        (alg?.name || alg) === 'Ed25519' ? Promise.reject(new DOMException('nope', 'NotSupportedError')) : real(format, key, alg, ...rest);
    });
    const fake = { data: { transactions: { pageInfo: { hasNextPage: false }, edges: [{ cursor: 'x', node: { id: fx.plain, signature: 'x', owner: { address: 'evil', key: 'x' }, data: { size: '0' }, tags: [
      { name: 'App-Name', value: 'PermaPath' }, { name: 'App-Version', value: '1' }, { name: 'Type', value: 'link' },
      { name: 'Destination', value: 'https://example.org/?pp=hijacked' }, { name: 'Seq', value: '9999999999999999' },
    ] } }] } } };
    await page.route(/(goldsky|permagate|frostor).*graphql/, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(fake) }));
    await page.goto(`${base}/?l=${fx.plain}`);
    await page.waitForURL(/example\.(com|org)/, { timeout: 30_000 });
    assert.equal(page.url(), 'https://example.com/?pp=plain');
  });
  await check('resolver: falls back when arweave.net is down', async (page) => {
    await page.route(/arweave\.net\/graphql/, (route) => route.abort());
    await page.goto(`${base}/?l=${fx.plain}`);
    await page.waitForURL('https://example.com/?pp=plain', { timeout: 30_000 });
  });
  await check('resolver: a broken copy answering first does not poison good copies', async (page) => {
    // frostor.xyz really returns signature "<not-found>" for older records. Make
    // it answer first (fast, from arweave.net, then broken) and the others late.
    await page.route(/frostor\.xyz\/graphql/, async (route) => {
      try {
        const res = await route.fetch({ url: 'https://arweave.net/graphql' });
        const body = await res.json();
        for (const e of body.data?.transactions?.edges || []) e.node.signature = '<not-found>';
        await route.fulfill({ response: res, body: JSON.stringify(body) });
      } catch { /* page already redirected and closed */ }
    });
    await page.route(/(arweave\.net|goldsky\.com|permagate\.io)\/graphql/, async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      await route.continue().catch(() => {});
    });
    await page.goto(`${base}/?l=${fx.plain}`);
    await page.waitForURL('https://example.com/?pp=plain', { timeout: 40_000 });
  });
  await check('resolver: unknown link', async (page) => {
    await page.goto(`${base}/?l=${'A'.repeat(43)}`);
    await page.getByText('Link not found').waitFor({ timeout: 30_000 });
  });
  await check('resolver: malformed id', async (page) => {
    await page.goto(`${base}/?l=nope`);
    await page.getByText('No link here').waitFor();
  });
  await check('resolver: network down', async (page) => {
    await page.route(/graphql/, (route) => route.abort());
    await page.goto(`${base}/?l=${fx.plain}`);
    await page.getByText('Couldn’t look up this link').waitFor({ timeout: 30_000 });
  });
  server.close();
}

// Creating a link no longer opens the QR pop-up: wait for its card, then tap it.
// A just-uploaded file from whichever gateway has it first (up to 5 minutes).
async function fetchFresh(id, mustInclude) {
  for (let i = 0; i < 30; i++) {
    for (const gateway of ['https://turbo-gateway.com', 'https://ardrive.net', 'https://arweave.net']) {
      const text = await fetch(`${gateway}/${id}`).then((r) => (r.ok ? r.text() : ''), () => '');
      if (text.includes(mustInclude)) return text;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return 'Not found';
}

async function openCreated(page, name) {
  const card = page.locator('.link-item', { hasText: name }).first();
  await card.waitFor({ timeout: 60_000 });
  assert.equal(await page.locator('#qr-dialog').isVisible(), false, 'no pop-up after creating');
  await card.locator('h3').click();
  await page.locator('#qr-dialog').waitFor({ state: 'visible', timeout: 30_000 });
}

if (which === 'all' || which === 'editor') {
  let restoreFetch = () => {};
  if (!process.env.LIVE) {
    fake = createFakeArweave();
    restoreFetch = fake.installNode();
    console.log('(editor tests use a fake Arweave; LIVE=1 for the real network)');
  }
  const { server, base } = process.env.WORKER ? await serveWorker() : await serve(path.join(root, 'editor'));
  if (process.env.WORKER) console.log(`(editor served through the Worker at ${base})`);
  let keyText;
  await check('editor: create key, link, QR, edit, turn off, sign back in', async (page) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.getByRole('button', { name: 'Create a key' }).click();
    keyText = await page.locator('#newkey-key').inputValue();
    assert.ok(keyText.length >= 40, 'key generated');
    await page.getByLabel('I’ve saved this key somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('No links yet').waitFor({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Your key' }).click();
    if (process.env.BROWSER !== 'webkit') {
      await page.getByRole('button', { name: 'Copy key' }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), keyText, 'Copy key copies the key');
    }
    await page.getByRole('button', { name: 'Show recovery phrase' }).click();
    const phrase = (await page.locator('#key-phrase li').evaluateAll((els) => els.map((el) => el.lastChild.textContent))).join(' ');
    assert.equal(phrase.split(' ').length, 24, 'recovery phrase shown');
    await page.locator('#key-dialog').getByRole('button', { name: 'Done' }).click();
    await page.locator('#create-dest').fill('example.com/?pp=editor-v0');
    await page.locator('#create-name').fill('Browser test');
    await page.getByRole('button', { name: 'Create link' }).click();
    await openCreated(page, 'Browser test');
    const dialog = page.locator('#qr-dialog');
    const url = await page.locator('#qr-url').textContent();
    assert.match(url, /^https:\/\/arweave\.net\/.+\?l=[A-Za-z0-9_-]{43}$/);
    assert.ok(await dialog.locator('svg path').count() === 1, 'QR rendered');
    const [png] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PNG' }).click()]);
    assert.match(png.suggestedFilename(), /^permapath-browser-test\.png$/);
    const pngBytes = fs.readFileSync(await png.path());
    const pngWidth = pngBytes.readUInt32BE(16); // IHDR width
    assert.ok(pngWidth >= 2400 && pngWidth < 2600, `PNG is ${pngWidth}px wide`);
    // Share falls back to copying the QR image where there's no share sheet (like here).
    const shareBtn = page.locator('#qr-share');
    if ((await shareBtn.textContent()) === 'Copy QR') {
      await shareBtn.click();
      await page.locator('#qr-share', { hasText: /Copied|Downloaded/ }).waitFor();
      if (process.env.BROWSER !== 'webkit') {
        const types = await page.evaluate(async () => (await navigator.clipboard.read())[0].types);
        assert.ok(types.includes('image/png'), 'QR image copied to the clipboard');
      }
    }
    await page.getByRole('button', { name: 'Done' }).click();

    const card = page.locator('.link-item').first();
    await card.locator('.chip').filter({ hasText: /^(New|Live)$/ }).waitFor(); // often Live already: frostor indexes in seconds
    await card.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#edit-dest').fill('https://example.com/?pp=editor-v1');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden', timeout: 30_000 });
    await card.getByText('https://example.com/?pp=editor-v1').waitFor();

    await card.getByRole('button', { name: 'Turn off' }).click();
    await card.getByRole('button', { name: 'Turn on' }).waitFor({ timeout: 30_000 });
    await card.getByText('Turned off').waitFor();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.locator('#login-key').fill(keyText);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Browser test').waitFor({ timeout: 30_000 });

    // The recovery phrase signs in as the same key (first four letters are enough).
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Sign in with a recovery phrase instead' }).click();
    await page.locator('#phrase-input').fill(phrase.split(' ').map((w) => w.slice(0, 4)).join(' '));
    await page.locator('#phrase-form').getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Browser test').waitFor({ timeout: 30_000 });
    assert.deepEqual(errors, []);
  });
  await check('editor: batch-create links, export CSV, set a destination', async (page) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.getByRole('button', { name: 'Create a key' }).click();
    await page.getByLabel('I’ve saved this key somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('No links yet').waitFor({ timeout: 30_000 });

    await page.getByText('Create several links at once').click();
    await page.locator('#batch-count').fill('3');
    await page.locator('#batch-prefix').fill('Batch test');
    await page.getByRole('button', { name: 'Create links' }).click();
    await page.getByText('Created 3 links.').waitFor({ timeout: 60_000 });
    const [csvDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV of these links' }).click()]);
    const rows = fs.readFileSync(await csvDl.path(), 'utf8').trimEnd().split('\r\n');
    assert.equal(rows.length, 4, 'header + 3 rows');
    assert.match(rows[1], /^Batch test 1,https:\/\/arweave\.net\/[A-Za-z0-9_-]{43}\?l=[A-Za-z0-9_-]{43},[A-Za-z0-9_-]{43},,not set up,/);
    assert.match(rows[3], /^Batch test 3,/);

    const cards = page.locator('.link-item');
    await cards.nth(2).waitFor();
    assert.equal(await cards.count(), 3);
    await cards.first().getByText('Batch test 1').waitFor();
    await cards.first().getByText('No destination yet').waitFor();
    await cards.first().locator('h3').click(); // tapping the card opens its QR code
    await page.locator('#qr-dialog').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Done' }).click();
    await cards.first().getByRole('button', { name: 'Set destination' }).click(); // buttons don't
    assert.equal(await page.locator('#qr-dialog').isVisible(), false);
    await page.locator('#edit-title').filter({ hasText: 'Set destination' }).waitFor();
    await page.locator('#edit-dest').fill('example.com/?pp=batch-set');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden', timeout: 30_000 });
    const first = page.locator('.link-item', { hasText: 'Batch test 1' });
    await first.getByText('https://example.com/?pp=batch-set').waitFor({ timeout: 30_000 });
    await first.getByRole('button', { name: 'Turn off' }).waitFor();

    const [allDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    const all = fs.readFileSync(await allDl.path(), 'utf8');
    assert.match(all, /Batch test 1,[^\n]*,https:\/\/example\.com\/\?pp=batch-set,live,/);
    assert.deepEqual(errors, []);
  });
  await check('editor: hosted page create, load for edit, update, switch back to URL', async (page) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Pretend arweave.net already serves new pages (real latency is 1-5 min; measured separately).
    await page.route(/^https:\/\/arweave\.net\/[A-Za-z0-9_-]{43}\?check=/, (route) => route.fulfill({ status: 200, body: 'ok' }));
    // A large, noisy PNG so the photo has to be compressed hard.
    const photoPage = await page.context().newPage();
    await photoPage.setViewportSize({ width: 1600, height: 1200 });
    await photoPage.setContent('<canvas id=c width=1600 height=1200></canvas><script>const x=c.getContext("2d");for(let i=0;i<40000;i++){x.fillStyle=`hsl(${Math.random()*360},80%,50%)`;x.fillRect(Math.random()*1600,Math.random()*1200,12,12)}</script>');
    const photo = await photoPage.screenshot({ type: 'png' });
    await photoPage.close();

    await page.goto(base);
    await page.getByRole('button', { name: 'Create a key' }).click();
    await page.getByLabel('I’ve saved this key somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('No links yet').waitFor({ timeout: 30_000 });

    await page.locator('#create-form').getByText('A page you write').click();
    await page.locator('#create-page-title').fill('Test café menu');
    await page.locator('#create-page-text').fill('Soup of the day\nBread\n\nMore at https://example.com/menu.');
    await page.locator('#create-page-photo').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: photo });
    await page.locator('#create-page-preview').waitFor({ timeout: 20_000 });
    assert.match(await page.locator('#create-page-size').textContent(), /Page size: \d+ KB of 95 KB/);
    await page.getByRole('button', { name: 'Create link' }).click();
    await openCreated(page, 'Test café menu');
    await page.getByRole('button', { name: 'Done' }).click();

    const card = page.locator('.link-item', { hasText: 'Test café menu' });
    const destText = await card.locator('.dest').first().textContent();
    const pageId = destText.match(/Page · https:\/\/arweave\.net\/([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(pageId, `card shows the page destination (got "${destText}")`);
    // The published page itself. Fresh uploads usually appear on turbo-gateway
    // within seconds, but some days take minutes, so try every gateway for 5 minutes.
    const html = await fetchFresh(pageId, 'Test café menu');
    assert.match(html, /<h1>Test café menu<\/h1>/);
    assert.match(html, /<p>Soup of the day<br>Bread<\/p>/);
    assert.match(html, /<img id="pp-photo" src="data:image\/jpeg;base64,/);
    assert.ok(Buffer.byteLength(html) <= 95 * 1024, `page is ${Buffer.byteLength(html)} bytes`);

    await card.getByRole('button', { name: 'Edit' }).click();
    await page.waitForFunction(() => document.getElementById('edit-page-title').value === 'Test café menu', null, { timeout: 30_000 });
    assert.equal(await page.locator('#edit-page-preview').isVisible(), true, 'photo loaded back');
    await page.locator('#edit-page-text').fill('Soup of the day\nBread\nPie');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden', timeout: 60_000 });
    await card.locator('.dest.pending').waitFor({ timeout: 30_000 }).catch(() => {});
    const newDest = (await card.locator('.dest').last().textContent()).match(/arweave\.net\/([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(newDest && newDest !== pageId, 'edit published a new page version');

    await card.getByRole('button', { name: 'Edit' }).click();
    await page.waitForFunction(() => document.getElementById('edit-page-title').value === 'Test café menu', null, { timeout: 30_000 });
    await page.locator('#edit-dialog').getByText('A web address').click();
    await page.locator('#edit-dest').fill('example.com/?pp=page-to-url');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden', timeout: 60_000 });
    await card.getByText('https://example.com/?pp=page-to-url').waitFor({ timeout: 30_000 });
    assert.deepEqual(errors, []);
  });
  await check('editor: import CSV creates and updates links; llms.txt is served', async (page) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const llms = await (await fetch(`${base}/llms.txt`)).text();
    assert.match(llms, /^# PermaPath/);
    assert.match(llms, /Import CSV/);
    await page.goto(base);
    await page.getByRole('button', { name: 'Create a key' }).click();
    await page.getByLabel('I’ve saved this key somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('No links yet').waitFor({ timeout: 30_000 });
    await page.locator('#create-dest').fill('example.com/?pp=imp-orig');
    await page.locator('#create-name').fill('Original');
    await page.getByRole('button', { name: 'Create link' }).click();
    await openCreated(page, 'Original');
    const origId = (await page.locator('#qr-url').textContent()).split('?l=')[1];
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: 'Import CSV' }).click();
    await page.locator('#import-text').fill(`\`\`\`csv\nname,destination,link_id\nImport A,example.com/?pp=imp-a,\nImport B,,\n,https://example.com/?pp=imp-updated,${origId}\nBad,javascript:alert(1),\n\`\`\``);
    await page.getByText('Will create 2 and update 1').waitFor();
    await page.getByText('1 with problems (skipped)').waitFor();
    await page.getByRole('button', { name: 'Import 3 links' }).click();
    await page.getByText('Imported 3 of 3.').waitFor({ timeout: 60_000 });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV with QR links' }).click()]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    assert.match(csv, /Import A,https:\/\/arweave\.net\/[^,]+,[A-Za-z0-9_-]{43},https:\/\/example\.com\/\?pp=imp-a,live,/);
    assert.match(csv, /Import B,[^\n]*,,not set up,/);
    await page.getByRole('button', { name: 'Close' }).click();
    await page.locator('.link-item', { hasText: 'Original' }).getByText('https://example.com/?pp=imp-updated').waitFor({ timeout: 30_000 });
    await page.locator('.link-item', { hasText: 'Import B' }).getByText('Not set up').waitFor({ timeout: 90_000 });
    assert.deepEqual(errors, []);
  });
  await check('editor: password protect a link, unlock it, edit keeping the password, unlock', async (page) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(/^https:\/\/arweave\.net\/[A-Za-z0-9_-]{43}\?check=/, (route) => route.fulfill({ status: 200, body: 'ok' }));
    const fetchGate = async (url) => {
      const html = await fetchFresh(url.match(/arweave\.net\/([A-Za-z0-9_-]{43})/)[1], 'permapath-locked');
      if (!html.includes('permapath-locked')) throw new Error('locked page never appeared');
      return html;
    };
    // Serve a locked page from the local origin so we can type into it.
    const visit = async (html) => {
      const v = await page.context().newPage();
      await v.route(`${base}/__gate.html`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
      await v.route(/^https:\/\/example\.com\//, (r) => r.fulfill({ contentType: 'text/html', body: '<p>landed</p>' }));
      await v.goto(`${base}/__gate.html`);
      return v;
    };
    const { fetchLinkHistory } = await import('../editor/links.js');
    const destinationOf = async (id, not) => {
      for (let i = 0; i < 24; i++) {
        const link = await fetchLinkHistory(id).catch(() => null);
        if (link && link.current.destination && link.current.destination !== not) return link.current.destination;
        await page.waitForTimeout(2500);
      }
      throw new Error('link state never updated');
    };
    const destOf = async (card) => {
      // locked links get a lock badge; the owner's editor reveals the real destination
      await card.locator('.chip.locked').waitFor({ timeout: 30_000 });
    };

    await page.goto(base);
    await page.getByRole('button', { name: 'Create a key' }).click();
    await page.getByLabel('I’ve saved this key somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('No links yet').waitFor({ timeout: 30_000 });

    await page.locator('#create-dest').fill('example.com/?pp=secret-v1');
    await page.locator('#create-name').fill('Family info');
    await page.locator('#create-lock').check();
    await page.locator('#create-password').fill('blue');
    await page.locator('#create-password-hint').getByText(/Short passwords/).waitFor(); // advised, not enforced
    await page.getByRole('button', { name: 'Create link' }).click();
    await openCreated(page, 'Family info');
    const lockedId = (await page.locator('#qr-url').textContent()).split('?l=')[1];
    await page.getByRole('button', { name: 'Done' }).click();
    const card = page.locator('.link-item', { hasText: 'Family info' });
    await destOf(card);
    const gateUrl = await destinationOf(lockedId);
    await card.getByText('https://example.com/?pp=secret-v1').waitFor({ timeout: 60_000 }); // revealed to the owner
    const gate1 = await fetchGate(gateUrl);
    assert.ok(!gate1.includes('secret-v1'), 'destination hidden in locked page');

    let v = await visit(gate1);
    await v.locator('#pw').fill('wrong');
    await v.getByRole('button', { name: 'Open' }).click();
    await v.getByText('That password didn’t work.').waitFor({ timeout: 30_000 });
    await v.locator('#pw').fill('blue');
    await v.locator('#remember').check();
    await v.getByRole('button', { name: 'Open' }).click();
    await v.waitForURL('https://example.com/?pp=secret-v1', { timeout: 30_000 });
    await v.goto(`${base}/__gate.html`); // remembered: opens without typing
    await v.waitForURL('https://example.com/?pp=secret-v1', { timeout: 30_000 });
    await v.close();

    // Owner edits: the editor opens the locked link with the owner's key.
    await card.getByRole('button', { name: 'Edit' }).click();
    await page.waitForFunction(() => document.getElementById('edit-dest').value === 'https://example.com/?pp=secret-v1', null, { timeout: 30_000 });
    assert.equal(await page.locator('#edit-lock').isChecked(), true);
    assert.match(await page.locator('#edit-password').getAttribute('placeholder'), /keep the current password/);
    await page.locator('#edit-dest').fill('example.com/?pp=secret-v2');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden', timeout: 60_000 });
    const gate2Url = await destinationOf(lockedId, gateUrl);
    assert.notEqual(gate2Url, gateUrl);
    v = await visit(await fetchGate(gate2Url));
    await v.locator('#pw').fill('blue'); // same password, kept without retyping
    await v.getByRole('button', { name: 'Open' }).click();
    await v.waitForURL('https://example.com/?pp=secret-v2', { timeout: 30_000 });
    await v.close();

    // Switch to a locked page, then turn protection off.
    await card.getByRole('button', { name: 'Edit' }).click();
    await page.waitForFunction(() => document.getElementById('edit-dest').value === 'https://example.com/?pp=secret-v2', null, { timeout: 30_000 });
    await page.locator('#edit-dialog').getByText('A page you write').click();
    await page.locator('#edit-page-title').fill('Emergency contacts');
    await page.locator('#edit-page-text').fill('Call Alex first.');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden', timeout: 60_000 });
    const gate3Url = await destinationOf(lockedId, gate2Url);
    v = await visit(await fetchGate(gate3Url));
    await v.locator('#pw').fill('blue');
    await v.getByRole('button', { name: 'Open' }).click();
    await v.locator('h1', { hasText: 'Emergency contacts' }).waitFor({ timeout: 30_000 });
    await v.close();

    await card.getByRole('button', { name: 'Edit' }).click();
    await page.waitForFunction(() => document.getElementById('edit-page-title').value === 'Emergency contacts', null, { timeout: 30_000 });
    await page.locator('#edit-dialog').getByText('A web address').click();
    await page.locator('#edit-lock').uncheck();
    await page.locator('#edit-dest').fill('example.com/?pp=now-public');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden', timeout: 60_000 });
    await card.getByText('https://example.com/?pp=now-public').waitFor({ timeout: 30_000 });
    assert.deepEqual(errors, []);
  });
  await check('site: landing is readable without JavaScript; SEO files exist', async (page) => {
    const ctx = await page.context().browser().newContext({ javaScriptEnabled: false });
    const p = await ctx.newPage();
    try {
      await p.goto(base);
      assert.ok(await p.getByRole('heading', { name: 'Stop reprinting' }).isVisible(), 'landing text visible without JS');
      assert.equal(await p.locator('#login-form').isVisible(), true, 'sign-in form shows at once');
      assert.equal(await p.getByRole('button', { name: 'Sign in', exact: true }).isDisabled(), true, 'but its buttons wait for JS');
      for (const f of ['robots.txt', 'sitemap.xml', 'og.png', 'apple-touch-icon.png', 'compare.html', 'uses.html']) {
        assert.equal((await fetch(`${base}/${f}`)).status, 200, f);
      }
      const html = await (await fetch(base + '/')).text();
      assert.match(html, /<meta property="og:image" content="https:\/\/permapath\.link\/og\.png">/);
      assert.match(html, /<link rel="canonical" href="https:\/\/permapath\.link\/">/);
      JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
      JSON.parse((await (await fetch(`${base}/compare.html`)).text()).match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
    } finally {
      await ctx.close();
    }
  });
  await check('editor: more options (scan count, end date, device and time rules) save and reload', async (page) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.getByRole('button', { name: 'Create a key' }).click();
    await page.getByLabel('I’ve saved this key somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('No links yet').waitFor({ timeout: 30_000 });

    await page.locator('#create-dest').fill('example.com/?pp=options');
    await page.locator('#create-name').fill('Options test');
    await page.locator('#create-options summary').click();
    assert.equal(await page.locator('#create-options-count').isChecked(), true, 'counting is on by default');
    await page.locator('#create-options-off-on').check();
    await page.locator('#create-options-off-at').fill('2030-01-01T09:00');
    await page.locator('#create-options-message').fill('All done, thanks!');
    await page.locator('#create-options-ios').fill('apps.apple.com/app/x');
    await page.getByRole('button', { name: /certain days or times/ }).click();
    const rule = page.locator('.time-rule').first();
    await rule.getByLabel('From').fill('11:00');
    await rule.getByLabel('Until').fill('15:00');
    await rule.getByLabel('Send people to').fill('example.com/?pp=lunch');
    await page.getByRole('button', { name: 'Create link' }).click();
    const card = page.locator('.link-item', { hasText: 'Options test' });
    await card.getByText(/Turns off .*2 other destinations by device or time/).waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('#create-options-count').isChecked(), true, 'form resets to counting on');

    const id = await card.getAttribute('data-id');
    let link;
    for (let i = 0; i < 30 && !link; i++) {
      link = await fetchLinkHistory(id).catch(() => null);
      if (!link) await new Promise((r) => setTimeout(r, 3000));
    }
    assert.ok(link, 'link indexed');
    const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(link.current.count, true);
    assert.equal(link.current.message, 'All done, thanks!');
    assert.equal(link.current.offAt, await page.evaluate(() => new Date('2030-01-01T09:00').getTime()));
    assert.deepEqual(link.current.routes, [
      { to: 'https://apps.apple.com/app/x', os: 'ios' },
      { to: 'https://example.com/?pp=lunch', days: '12345', from: '11:00', until: '15:00' },
    ]);
    assert.equal(link.current.tz, zone);

    // Edit: the options load back; turn counting off and drop the iPhone rule.
    await card.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#edit-options summary').click();
    assert.equal(await page.locator('#edit-options-ios').inputValue(), 'https://apps.apple.com/app/x');
    assert.equal(await page.locator('.time-rule').getByLabel('From').inputValue(), '11:00');
    assert.equal(await page.locator('#edit-options-message').inputValue(), 'All done, thanks!');
    await page.locator('#edit-options-count').uncheck();
    await page.locator('#edit-options-ios').fill('');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden', timeout: 30_000 });
    await card.getByText(/1 other destination by device or time/).waitFor({ timeout: 30_000 });
    for (let i = 0; i < 30; i++) {
      link = await fetchLinkHistory(id).catch(() => null);
      if (link?.history.length === 2) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    assert.equal(link.history.length, 2);
    assert.equal(link.current.count, false);
    assert.equal(link.current.routes.length, 1);
    assert.equal(link.current.resolver, RESOLVER_TX, 'updates using v3 tags name the current resolver');
    assert.deepEqual(errors, []);
  });
  await check('editor: table view sorts, remembers the choice, and keeps its actions', async (page) => {
    await page.goto(base);
    await page.getByRole('button', { name: 'Create a key' }).click();
    await page.getByLabel('I’ve saved this key somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('No links yet').waitFor({ timeout: 30_000 });
    for (const [name, dest] of [['Banana', 'example.com/b'], ['Apple', 'example.com/a'], ['Cherry', 'example.com/c']]) {
      await page.locator('#create-dest').fill(dest);
      await page.locator('#create-name').fill(name);
      await page.getByRole('button', { name: 'Create link' }).click();
      await page.locator('.link-item', { hasText: name }).waitFor();
    }
    assert.equal(await page.getByRole('link', { name: 'Printing tips' }).getAttribute('href'), 'print.html');
    await page.locator('.view-toggle').getByText('Table').click();
    const names = () => page.locator('.links-table td.name').allTextContents();
    assert.deepEqual(await names(), ['Cherry', 'Apple', 'Banana'], 'newest first by default');
    await page.locator('.links-table th button', { hasText: 'Name' }).click();
    assert.deepEqual(await names(), ['Apple', 'Banana', 'Cherry']);
    await page.locator('.links-table th button', { hasText: 'Name' }).click();
    assert.deepEqual(await names(), ['Cherry', 'Banana', 'Apple']);
    await page.reload();
    await page.getByRole('button', { name: 'Create a key' }).waitFor(); // signed out by reload; the view choice is kept
    assert.equal(await page.evaluate(() => localStorage.getItem('permapath:view')), '"table"');
  });
  await check('editor: says so when an upload goes through the slow backup uploader', async (page) => {
    await page.route('https://upload.ardrive.io/**', (route) => route.fulfill({ status: 402, body: 'payment required' }));
    await page.goto(base);
    await page.getByRole('button', { name: 'Create a key' }).click();
    await page.getByLabel('I’ve saved this key somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('No links yet').waitFor({ timeout: 30_000 });
    await page.locator('#create-dest').fill('example.com/?pp=slow');
    await page.locator('#create-name').fill('Slow one');
    await page.getByRole('button', { name: 'Create link' }).click();
    await page.locator('.link-item', { hasText: 'Slow one' }).getByText(/backup uploader/).waitFor({ timeout: 10_000 });
  });
  await check('editor: event page with an Add to calendar file; edit loads it back', async (page) => {
    await page.goto(base);
    await page.getByRole('button', { name: 'Create a key' }).click();
    await page.getByLabel('I’ve saved this key somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('No links yet').waitFor({ timeout: 30_000 });
    await page.locator('#create-form').getByText('An event').click();
    await page.locator('#create-event-name').fill('Bike swap');
    await page.locator('#create-event-start').fill('2030-05-04T10:00');
    await page.locator('#create-event-end').fill('2030-05-04T14:00');
    await page.locator('#create-event-location').fill('12 Main St');
    await page.locator('#create-page-text').fill('Bring a bike to trade.');
    await page.getByRole('button', { name: 'Create link' }).click();
    const card = page.locator('.link-item', { hasText: 'Bike swap' });
    const dest = await card.locator('.dest').first().textContent({ timeout: 30_000 });
    assert.match(dest, /^Event · https:\/\/arweave\.net\//);
    const pageId = dest.match(/arweave\.net\/([A-Za-z0-9_-]{43})/)[1];
    const html = await fetchFresh(pageId, 'Add to calendar');
    assert.match(html, /<p class="when">Saturday, May 4, 2030 · 10:00 AM – 2:00 PM/);
    const icsId = html.match(/href="https:\/\/arweave\.net\/([A-Za-z0-9_-]{43})" class="save"/)[1];
    const ics = await fetch(`https://arweave.net/${icsId}`);
    assert.equal(ics.headers.get('content-type'), 'text/calendar');
    assert.match(await ics.text(), /SUMMARY:Bike swap/);
    await card.getByRole('button', { name: 'Edit' }).click();
    await page.waitForFunction(() => document.getElementById('edit-event-name').value === 'Bike swap', null, { timeout: 30_000 });
    assert.equal(await page.locator('#edit-event-start').inputValue(), '2030-05-04T10:00');
    assert.equal(await page.locator('input[name=edit-kind]:checked').getAttribute('value'), 'event');
  });
  await check('QR designs all scan (every style, colors, label, logo, sturdy, small sizes)', async (page) => {
    await page.goto(base);
    await page.addScriptTag({ path: path.join(root, 'node_modules/jsqr/dist/jsQR.js') });
    const url = 'https://arweave.net/u3gO3Oo3P-loxIOdLUlnUgflSqEovH6YIkrJBLLRfhE?l=8NiAUY8SAUDkrHw7VCmjVc8M708VTCkmNmBbtyidhRc';
    const results = await page.evaluate(async (url) => {
      const { drawQr, qrCanvasSize } = await import('./qr.js');
      // A stand-in logo: a colored square with a letter.
      const logo = document.createElement('canvas');
      logo.width = logo.height = 120;
      const lc = logo.getContext('2d');
      lc.fillStyle = '#e63946'; lc.fillRect(0, 0, 120, 120); lc.fillStyle = '#fff'; lc.font = 'bold 90px sans-serif'; lc.fillText('P', 30, 95);
      const designs = [
        {}, { style: 'rounded' }, { style: 'dots' }, { fg: '#1d3557', bg: '#f1faee' }, { label: 'Scan for the menu' },
        { logo: 'https://arweave.net/' + 'L'.repeat(43) }, { style: 'dots', logo: 'https://arweave.net/' + 'L'.repeat(43), fg: '#264653' },
        { sturdy: true, style: 'rounded' }, { transparent: true, style: 'dots' },
      ];
      const out = [];
      for (const d of designs) {
        for (const scale of [3, 10]) { // ~0.75 in and ~2.5 in at phone-camera resolution
          const size = qrCanvasSize(url, scale, d);
          const c = document.createElement('canvas');
          c.width = size.width; c.height = size.height;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); // what transparent codes get printed on
          drawQr(ctx, url, scale, d, { logoImage: d.logo ? logo : null });
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const found = window.jsQR(img.data, img.width, img.height);
          out.push({ d: JSON.stringify(d), scale, ok: found?.data === url });
        }
      }
      return out;
    }, url);
    const failed = results.filter((r) => !r.ok);
    assert.deepEqual(failed, [], `designs that didn't decode: ${failed.map((f) => `${f.d}@${f.scale}`).join(', ')}`);
  });
  await check('editor: customize a QR design, save it, and it comes back', async (page) => {
    await page.goto(base);
    await page.getByRole('button', { name: 'Create a key' }).click();
    await page.getByLabel('I’ve saved this key somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('No links yet').waitFor({ timeout: 30_000 });
    await page.locator('#create-dest').fill('example.com/?pp=design');
    await page.locator('#create-name').fill('Designed');
    await page.getByRole('button', { name: 'Create link' }).click();
    await openCreated(page, 'Designed');
    await page.locator('#design-box summary').click();
    await page.locator('#design-label').fill('Scan for the menu');
    await page.locator('#design-box').getByText('Dots').click();
    await page.locator('#design-fg').fill('#cccccc');
    await page.locator('#design-error').getByText(/too close/).waitFor();
    assert.equal(await page.locator('#design-save').isDisabled(), true, 'faint colors cannot be saved');
    await page.locator('#design-fg').fill('#1d3557');
    await page.locator('#design-logo').setInputFiles(path.join(root, 'editor/apple-touch-icon.png'));
    await page.locator('#qr-big image').waitFor();
    assert.match(await page.locator('#qr-big').innerHTML(), />Scan for the menu</);
    const [svg] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download SVG' }).click()]);
    assert.match(fs.readFileSync(await svg.path(), 'utf8'), /<image href="data:image\/jpeg;base64,/, 'SVG download embeds the logo');
    await page.getByRole('button', { name: 'Save design' }).click();
    await page.locator('#design-save', { hasText: 'Saved' }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Done' }).click();
    // The design comes back from the link's record once the update is indexed.
    const card = page.locator('.link-item', { hasText: 'Designed' });
    for (let i = 0; i < 30; i++) {
      await page.getByRole('button', { name: 'Refresh' }).click();
      await page.waitForTimeout(1000);
      if (!(await card.locator('.chip', { hasText: /Updating|New/ }).count())) break;
    }
    await card.locator('h3').click();
    await page.locator('#qr-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#design-label').inputValue(), 'Scan for the menu');
    assert.equal(await page.locator('input[name=design-style]:checked').getAttribute('value'), 'dots');
    assert.equal(await page.locator('#design-fg').inputValue(), '#1d3557');
    await page.locator('#qr-big image').waitFor({ timeout: 30_000 }); // logo loaded from Arweave (fake)
  });
  await check('editor: rejects a bad key', async (page) => {
    await page.goto(base);
    await page.locator('#login-key').fill('definitely not a key');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('#login-error').waitFor();
  });
  await check('editor: rejects a bad destination', async (page) => {
    await page.goto(base);
    await page.getByRole('button', { name: 'Create a key' }).click();
    await page.getByLabel('I’ve saved this key somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.locator('#create-dest').fill('javascript:alert(1)');
    await page.getByRole('button', { name: 'Create link' }).click();
    await page.locator('#create-error').waitFor();
  });
  await check('editor: no screen is wider than a phone (mobile emulation)', async (page) => {
    // isMobile honours the viewport meta and zooms out on overflow, like a real phone.
    const ctx = await page.context().browser().newContext({ ...devices['iPhone SE'] });
    const p = await ctx.newPage();
    const wide = async (where) => {
      const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
      assert.ok(r.sw <= r.vw, `${where}: page is ${r.sw}px wide on a ${r.vw}px screen`);
    };
    try {
      await p.goto(base);
      await p.locator('#signin').waitFor();
      await wide('signed out');
      await p.getByRole('button', { name: 'Create a key' }).click();
      await wide('new key');
      await p.getByLabel('I’ve saved this key somewhere safe').check();
      await p.getByRole('button', { name: 'Continue' }).click();
      await p.getByText('No links yet').waitFor({ timeout: 30_000 });
      await wide('signed in');
      await p.locator('#create-form').getByText('A page you write').click();
      await wide('page form');
      await p.getByText('Create several links at once').click();
      await wide('batch open');
      const small = await p.evaluate(() => [...document.querySelectorAll('input, textarea')]
        .filter((el) => el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'file' && parseFloat(getComputedStyle(el).fontSize) < 16)
        .map((el) => `#${el.id} ${getComputedStyle(el).fontSize}`));
      assert.deepEqual(small, [], 'fields under 16px make iOS zoom in on focus');
      await p.goto(`${base}/history.html`);
      await p.locator('#lookup').waitFor();
      await wide('history');
      assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById('lookup-input')).fontSize), '16px');
      await p.goto(`${base}/uses.html`);
      await p.getByText('Luggage and bag tags').waitFor();
      await wide('ideas page');
      await p.goto(`${base}/compare.html`);
      await p.getByText('Questions').waitFor();
      await wide('compare page');
    } finally {
      await ctx.close();
    }
  });
  server.close();
  restoreFetch();
  if (fake) console.log(`(fake Arweave: ${fake.items.size} uploads kept in memory; let through: ${[...fake.passedThrough].join(', ') || 'nothing'})`);
  fake = null;
}

if (which === 'all' || which === 'history') {
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures.json'), 'utf8'));
  const { server, base } = await serve(path.join(root, 'editor'));
  await check('history: shows verified current state and changes, not forgeries', async (page) => {
    await page.goto(`${base}/history.html?l=${fx.updated}`);
    await page.locator('#result').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('#now a').textContent(), 'https://example.com/?pp=v1');
    assert.equal(await page.locator('#timeline li').count(), 2);
    assert.equal(await page.getByText('example.org').count(), 0, 'forged destination must not appear');
    await page.locator('#timeline li').first().getByText('Destination changed').waitFor();
    await page.locator('#timeline li').last().getByText('Created').waitFor();
  });
  await check('history: lookup accepts a full QR link; unknown IDs say so', async (page) => {
    await page.goto(`${base}/history.html`);
    await page.locator('#lookup-input').fill(`https://arweave.net/whatever?l=${fx.disabled}`);
    await page.getByRole('button', { name: 'Show history' }).click();
    await page.locator('#chip').getByText('Off').waitFor({ timeout: 30_000 });
    assert.match(page.url(), new RegExp(`\\?l=${fx.disabled}$`));
    await page.locator('#lookup-input').fill('A'.repeat(43));
    await page.getByRole('button', { name: 'Show history' }).click();
    await page.getByText('No PermaPath link with that ID was found').waitFor({ timeout: 30_000 });
    await page.locator('#lookup-input').fill('nonsense');
    await page.getByRole('button', { name: 'Show history' }).click();
    await page.locator('#lookup-error').waitFor();
  });
  server.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);

import { qrMatrix, qrSvg } from './qr.js';
import { generateKeyText, loadKey, createDataItem, upload } from './arweave.js';
import { normalizeDestination, linkTags, updateTags, fetchLinks, overlayPending, linkStatus, linksToCsv, planImport, carry, isOffNow } from './links.js';
import { optionsFields } from './options.js';
import { RESOLVER_BASE } from './config.js';
import { buildPageHtml, parsePageHtml, pageBytes, compressImage, PAGE_MAX_BYTES, LOCKED_PAGE_MAX } from './page.js';
import { buildLockedHtml, parseLockedHtml, openLocked, passwordAdvice, suggestPassphrase } from './lock.js';
import { APP_NAME } from './arweave.js';
import { keyToPhrase, phraseToKey } from './phrase.js';

const $ = (id) => document.getElementById(id);
const PENDING_SLOW_MS = 30 * 60_000;

let key = null; // { privateKey, publicKey, owners }
let keyText = ''; // kept in memory only, for "Copy key"
let links = [];
let pollTimer = null;

// ---------- small helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function showError(el, err) {
  el.textContent = err ? (err.message || String(err)) : '';
  el.hidden = !err;
}

async function busy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function copy(text, button) {
  await navigator.clipboard.writeText(text);
  const label = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = label; }, 1500);
}

const linkUrl = (id) => `${RESOLVER_BASE}?l=${id}`;
const show = (id) => ['signin', 'newkey', 'app'].forEach((s) => { $(s).hidden = s !== id; });

// ---------- pending writes (localStorage; purely a display convenience) ----------

const pendingKey = () => `permapath:pending:${key.owners[1]}`;

function readPending() {
  try {
    return JSON.parse(localStorage.getItem(pendingKey()) || '[]');
  } catch {
    return [];
  }
}

function writePending(list) {
  try {
    localStorage.setItem(pendingKey(), JSON.stringify(list));
  } catch { /* storage unavailable; pending state just won't survive a reload */ }
}

function addPending(state) {
  writePending([...readPending().filter((p) => p.id !== state.id || p.seq > state.seq), { ...state, postedAt: Date.now() }]);
}

// ---------- QR ----------

// ~2400px wide: sharp in print up to ~8 in (20 cm) at 300 dpi. Whole-pixel
// modules keep the edges crisp.
// Synchronous on purpose: iOS only opens the share sheet if share() is called
// straight from the tap, with no awaiting first.
function qrPngBlobSync(text, minWidth = 2400, margin = 4) {
  const { n, dark } = qrMatrix(text);
  const scale = Math.ceil(minWidth / (n + margin * 2));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = (n + margin * 2) * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
  const bin = atob(canvas.toDataURL('image/png').split(',')[1]);
  return new Blob([Uint8Array.from(bin, (ch) => ch.charCodeAt(0))], { type: 'image/png' });
}
const qrPngBlob = async (text) => qrPngBlobSync(text);

// Share the QR image (phones: the system share sheet, which also has Copy and
// Save Image). Where sharing files isn't supported, copy the image instead.
const canShareFiles = (() => {
  try { return !!navigator.canShare?.({ files: [new File([''], 'x.png', { type: 'image/png' })] }); } catch { return false; }
})();
const shareLabel = canShareFiles ? 'Share' : 'Copy QR';

function shareQr(link, button) {
  const url = linkUrl(link.id);
  const blob = qrPngBlobSync(url);
  if (canShareFiles) {
    const file = new File([blob], `${fileBase(link)}.png`, { type: 'image/png' });
    navigator.share({ files: [file], title: link.name || 'QR code', url }).catch((err) => {
      if (err.name !== 'AbortError') download(blob, file.name); // cancelled is fine
    });
    return;
  }
  const done = (text) => { const label = button.textContent; button.textContent = text; setTimeout(() => { button.textContent = label; }, 1500); };
  if (window.ClipboardItem && navigator.clipboard?.write) {
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => done('Copied'), () => { download(blob, `${fileBase(link)}.png`); done('Downloaded'); });
  } else {
    download(blob, `${fileBase(link)}.png`);
    done('Downloaded');
  }
}

function download(blob, filename) {
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const fileBase = (link) => `permapath-${(link.name || link.id.slice(0, 8)).replace(/[^\w-]+/g, '-').toLowerCase()}`;

let qrLink = null;
function openQr(link) {
  qrLink = link;
  const url = linkUrl(link.id);
  $('qr-title').textContent = link.name || 'Your QR code';
  $('qr-big').innerHTML = qrSvg(url);
  $('qr-url').href = url;
  $('qr-url').textContent = url;
  $('qr-history').href = `history.html?l=${link.id}`;
  $('qr-dialog').showModal();
}

$('qr-png').addEventListener('click', async () => download(await qrPngBlob(linkUrl(qrLink.id)), `${fileBase(qrLink)}.png`));
$('qr-svg').addEventListener('click', () => download(new Blob([qrSvg(linkUrl(qrLink.id))], { type: 'image/svg+xml' }), `${fileBase(qrLink)}.svg`));
$('qr-copy').addEventListener('click', (e) => copy(linkUrl(qrLink.id), e.currentTarget));
$('qr-share').textContent = shareLabel;
$('qr-share').addEventListener('click', (e) => shareQr(qrLink, e.currentTarget));

// ---------- sign in / new key ----------

async function signIn(text) {
  key = await loadKey(text);
  keyText = text.trim();
  // The public ID (derived from the key, safe to show), not the secret key itself.
  $('account').textContent = `ID ${key.owners[0].slice(0, 6)}…${key.owners[0].slice(-4)}`;
  $('account').title = 'Your public ID. It’s safe to share and appears on every link you make. Your key is the secret; use Copy key.';
  show('app');
  // Let password managers notice the "navigation" and offer to save.
  history.pushState({}, '', location.pathname + location.search + '#links');
  await refresh();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError($('login-error'), null);
  try {
    await signIn($('login-key').value);
  } catch (err) {
    showError($('login-error'), err);
  }
});

$('new-key').addEventListener('click', () => {
  $('newkey-key').value = generateKeyText();
  $('newkey-key').type = 'password';
  keyToPhrase($('newkey-key').value).then((phrase) => fillPhrase($('newkey-phrase'), phrase));
  $('newkey-show').textContent = 'Show';
  show('newkey');
});
$('newkey-show').addEventListener('click', () => {
  const field = $('newkey-key');
  field.type = field.type === 'password' ? 'text' : 'password';
  $('newkey-show').textContent = field.type === 'password' ? 'Show' : 'Hide';
});
$('newkey-copy').addEventListener('click', (e) => copy($('newkey-key').value, e.currentTarget));
$('newkey-cancel').addEventListener('click', () => show('signin'));

$('use-phrase').addEventListener('click', () => {
  $('phrase-form').hidden = false;
  $('phrase-row').hidden = true;
  $('phrase-input').focus();
});
$('phrase-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError($('phrase-error'), null);
  try {
    await signIn(await phraseToKey($('phrase-input').value));
    $('phrase-input').value = '';
  } catch (err) {
    showError($('phrase-error'), err);
  }
});

// ---------- recovery phrase (the same key as 24 words) ----------

const fillPhrase = (list, phrase) => list.replaceChildren(...phrase.split(' ').map((w) => h('li', {}, w)));

// Prints a sheet with the phrase and key, hiding the rest of the page.
async function printSheet(text) {
  const k = await loadKey(text);
  fillPhrase($('sheet-phrase'), await keyToPhrase(text));
  $('sheet-key').textContent = text.trim();
  $('sheet-id').textContent = k.owners[0];
  $('sheet-date').textContent = new Date().toLocaleDateString(undefined, { dateStyle: 'long' });
  document.body.classList.add('print-sheet');
  // Dialogs sit in the top layer and would print over the sheet.
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  window.print();
  // Leave the sheet's contents in place only for the print.
  setTimeout(() => {
    document.body.classList.remove('print-sheet');
    for (const id of ['sheet-phrase', 'sheet-key', 'sheet-id']) $(id).replaceChildren();
  }, 1000);
}

$('newkey-print').addEventListener('click', () => printSheet($('newkey-key').value));
$('your-key').addEventListener('click', () => {
  $('key-phrase-box').hidden = true;
  $('show-phrase').hidden = false;
  $('key-phrase').replaceChildren();
  $('key-dialog').showModal();
});
$('show-phrase').addEventListener('click', async () => {
  fillPhrase($('key-phrase'), await keyToPhrase(keyText));
  $('key-phrase-box').hidden = false;
  $('show-phrase').hidden = true;
});
$('key-print').addEventListener('click', () => printSheet(keyText));
$('newkey-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await signIn($('newkey-key').value);
});

$('copy-key').addEventListener('click', (e) => copy(keyText, e.currentTarget));

$('signout').addEventListener('click', () => {
  key = null;
  location.replace(location.pathname + location.search);
});

// ---------- list ----------

async function refresh() {
  clearTimeout(pollTimer);
  if (!links.length) $('list-status').textContent = 'Loading…'; // quiet when refreshing a list already shown
  let fetched;
  try {
    fetched = await fetchLinks(key);
  } catch (err) {
    $('list-status').textContent = err.message;
    fetched = null;
  }
  const previous = links.filter((l) => !l.unindexed).map(({ pending, ...l }) => l);
  const { links: merged, outstanding } = overlayPending(fetched || previous, readPending());
  if (fetched) writePending(outstanding);
  links = merged;
  render();
  if (fetched) loadScanCounts();
  if (fetched) $('list-status').textContent = links.length ? '' : 'No links yet. Create one above.';
  if (outstanding.length) pollTimer = setTimeout(refresh, 15_000);
}

// Feedback while it checks Arweave, then a brief "Up to date".
$('refresh').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Refreshing…';
  await refresh();
  button.disabled = false;
  button.textContent = /Couldn’t/.test($('list-status').textContent) ? 'Refresh' : 'Up to date';
  setTimeout(() => { button.textContent = 'Refresh'; }, 1500);
});

// New page links are created right away, but scans only show the page once
// arweave.net serves it (seconds to ~15 minutes). Tracked while this tab is open.
const publishingPages = new Set();

// Page and locked-link destinations arweave.net has been seen serving, kept
// across reloads so "Live" only shows once scans actually work.
const SERVED_KEY = 'permapath:served';
const served = new Set((() => { try { return JSON.parse(localStorage.getItem(SERVED_KEY) || '[]'); } catch { return []; } })());
function markServed(url) {
  served.add(url);
  try { localStorage.setItem(SERVED_KEY, JSON.stringify([...served].slice(-500))); } catch { /* fine */ }
}

function trackPublishing(url) {
  if (publishingPages.has(url) || served.has(url)) return;
  publishingPages.add(url);
  waitUntilServed(url, () => {}).then(() => markServed(url), () => {}).finally(() => {
    publishingPages.delete(url);
    render();
  });
}

// For uploads we didn't just make: check once quietly, and only show
// "Publishing" if arweave.net isn't serving it yet.
const checking = new Set();
async function checkServed(url) {
  if (served.has(url) || publishingPages.has(url) || checking.has(url)) return;
  checking.add(url);
  try {
    const res = await fetch(`${url}?check=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (res.ok) { markServed(url); return; }
  } catch { /* not yet */ } finally {
    checking.delete(url);
  }
  trackPublishing(url);
  render();
}

// The owner's editor can open its own locked links, so show where they go.
const revealed = new Map(); // locked page URL -> text, or null while loading
async function reveal(url) {
  if (revealed.has(url)) return;
  revealed.set(url, null);
  try {
    const env = parseLockedHtml((await loadArweaveHtml(url)) || '');
    const { payload } = await openLocked(env, key.lockKey);
    revealed.set(url, payload.type === 'url' ? payload.url : `Page · ${parsePageHtml(payload.html)?.title || 'untitled'}`);
  } catch {
    revealed.delete(url); // try again on the next refresh
    return;
  }
  render();
}

function statusChip(link) {
  const view = link.pending || link;
  if (publishingPages.has(view.destination)) {
    return h('span', { class: 'chip pending', title: 'Arweave is still publishing this; scans will work once it’s done' }, 'Publishing');
  }
  if (link.pending) {
    const slow = Date.now() - link.pending.postedAt > PENDING_SLOW_MS;
    const text = link.unindexed ? 'New' : 'Updating';
    return h('span', { class: 'chip pending', title: slow ? 'Taking longer than usual' : 'Usually live within a minute' }, slow ? `${text} (slow)` : text);
  }
  const status = linkStatus(link);
  if (status === 'not set up') return h('span', { class: 'chip off' }, 'Not set up');
  return status === 'off' ? h('span', { class: 'chip off' }, 'Off') : h('span', { class: 'chip live' }, 'Live');
}

const when = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// One line under the destination: scan count, end date, extra destinations.
function extras(state, id) {
  const parts = [];
  if (state.count && scanCounts.has(id)) parts.push(`${scanCounts.get(id).toLocaleString()} scan${scanCounts.get(id) === 1 ? '' : 's'}`);
  else if (state.count) parts.push('Counting scans');
  if (state.offAt && !isOffNow(state)) parts.push(`Turns off ${when(state.offAt)}`);
  const n = state.routes?.length || 0;
  if (n && !isOffNow(state)) parts.push(`${n} other destination${n === 1 ? '' : 's'} by device or time`);
  return parts.join(' · ');
}

// ---------- scan counts (permapath.link/api/scans; public) ----------

const SCANS_API = 'https://permapath.link/api/scans';
const scanCounts = new Map();
async function loadScanCounts() {
  const ids = links.filter((l) => (l.pending || l).count && !l.unindexed).map((l) => l.id);
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const res = await fetch(`${SCANS_API}?l=${ids.slice(i, i + 100).join(',')}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      for (const [id, n] of Object.entries((await res.json()).counts)) scanCounts.set(id, n);
    }
  } catch { return; /* counts are a nice-to-have */ }
  render();
}

function describe(state) {
  if (!state.destination) return 'No destination yet';
  if (isOffNow(state)) return state.disabled ? 'Turned off' : `Turned off automatically ${when(state.offAt)}`;
  if (state.kind === 'locked') return revealed.get(state.destination) || 'Password protected';
  return state.kind === 'page' ? `Page · ${state.destination}` : state.destination;
}

function render() {
  $('links').replaceChildren(...links.map((link) => {
    const view = link.pending || link;
    if ((view.kind === 'page' || view.kind === 'locked') && view.destination) checkServed(view.destination);
    if (view.kind === 'locked' && view.destination) reveal(view.destination);
    const lockChip = view.kind === 'locked' ? h('span', { class: 'chip locked', title: 'Password protected' }, '🔒 Locked') : null;
    const thumb = h('button', { class: 'qr-thumb', type: 'button', title: 'Show QR code', 'aria-label': 'Show QR code', onclick: () => openQr(view) });
    thumb.innerHTML = qrSvg(linkUrl(link.id), 2);
    const dest = [];
    if (link.pending && !link.unindexed && describe(link.pending) !== describe(link)) {
      dest.push(h('p', { class: 'dest old' }, describe(link)));
      dest.push(h('p', { class: 'dest pending' }, `→ ${describe(link.pending)} (going live…)`));
    } else if (publishingPages.has(view.destination)) {
      dest.push(h('p', { class: 'dest' }, describe(view)));
      dest.push(h('p', { class: 'muted dest note' }, `Arweave is publishing your ${view.kind === 'locked' ? 'locked link' : 'page'}. Scans will reach it within a few minutes (occasionally up to 15). The QR code is ready to print.`));
    } else if (link.unindexed) {
      dest.push(h('p', { class: 'dest' }, describe(view)));
      dest.push(h('p', { class: 'muted dest note' }, 'Just created. Usually live within a minute.'));
    } else {
      dest.push(h('p', { class: 'dest' }, describe(view)));
    }
    const extra = extras(view, link.id);
    if (extra) dest.push(h('p', { class: 'muted small extras' }, extra));
    // Tapping anywhere on the card (except its buttons) opens the QR code.
    const openFromCard = (e) => { if (!e.target.closest('button, a, input')) openQr(view); };
    return h('li', { class: 'card link-item clickable', onclick: openFromCard, title: 'Show QR code', 'data-id': link.id },
      thumb,
      h('div', {},
        h('h3', {}, view.name || 'Untitled link', statusChip(link), lockChip),
        dest,
        h('div', { class: 'row' },
          h('button', { type: 'button', onclick: (e) => shareQr(view, e.currentTarget) }, shareLabel),
          view.destination
            ? [
              h('button', { type: 'button', onclick: () => openEdit(link) }, 'Edit'),
              h('button', { type: 'button', onclick: (e) => setDisabled(link, !isOffNow(view), e.currentTarget) }, isOffNow(view) ? 'Turn on' : 'Turn off'),
            ]
            : h('button', { type: 'button', onclick: () => openEdit(link) }, 'Set destination'),
        ),
      ),
    );
  }));
}

// ---------- writes ----------

async function publish(tags) {
  // Empty body: lets anyone verify the signature from GraphQL fields alone.
  const item = await createDataItem(key, tags, '');
  await upload(item);
  return item.id;
}

// ---------- hosted pages ----------

const PAGE_URL = /^https:\/\/arweave\.net\/([A-Za-z0-9_-]{43})$/;
// Fresh uploads show up on these gateways within seconds; arweave.net can take minutes.
const PAGE_READ_GATEWAYS = ['https://turbo-gateway.com', 'https://ardrive.net', 'https://arweave.net'];

async function publishPage(page) {
  const html = buildPageHtml(page);
  if (pageBytes(html) > PAGE_MAX_BYTES) throw new Error('This page is too large. Shorten the text or remove the photo.');
  const item = await createDataItem(key, [
    { name: 'Content-Type', value: 'text/html' },
    { name: 'App-Name', value: APP_NAME },
    { name: 'App-Version', value: '1' },
    { name: 'Type', value: 'page' },
  ], html);
  await upload(item);
  return `https://arweave.net/${item.id}`;
}

async function loadArweaveHtml(url) {
  const id = url.match(PAGE_URL)?.[1];
  if (!id) return null;
  for (const gateway of PAGE_READ_GATEWAYS) {
    try {
      const res = await fetch(`${gateway}/${id}`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return await res.text();
    } catch { /* try the next gateway */ }
  }
  return null;
}

async function loadPage(url) {
  const html = await loadArweaveHtml(url);
  return html ? parsePageHtml(html) : null;
}


// Publishes whatever a destination form describes: a web address, a page,
// or either one behind a password. Returns { destination, kind, title, published }.
async function publishDestination(fields, onProgress = () => {}) {
  const k = fields.kind();
  if (!fields.locked()) {
    if (k !== 'page') return { destination: normalizeDestination(fields.url()), kind: '' };
    const page = fields.page();
    buildPageHtml(page); // validate before uploading anything
    onProgress('Saving your page…');
    return { destination: await publishPage(page), kind: 'page', title: page.title, published: true };
  }
  let payload, title = '';
  if (k === 'page') {
    const page = fields.page();
    const html = buildPageHtml(page);
    if (pageBytes(html) > LOCKED_PAGE_MAX) throw new Error('This page is too large to lock. Shorten the text or remove the photo.');
    payload = { type: 'page', html };
    title = page.title;
  } else {
    payload = { type: 'url', url: normalizeDestination(fields.url()) };
  }
  const password = fields.password();
  if (!password && !fields.keep()) throw new Error('Enter a password, or turn off Password protect.');
  onProgress('Locking and saving…');
  const html = await buildLockedHtml({ payload, password, keep: password ? null : fields.keep(), lockKey: key.lockKey });
  if (pageBytes(html) > PAGE_MAX_BYTES) throw new Error('This is too large to lock. Shorten the text or remove the photo.');
  const item = await createDataItem(key, [
    { name: 'Content-Type', value: 'text/html' },
    { name: 'App-Name', value: APP_NAME },
    { name: 'App-Version', value: '1' },
    { name: 'Type', value: 'locked' },
  ], html);
  await upload(item);
  return { destination: `https://arweave.net/${item.id}`, kind: 'locked', title, published: true };
}

// Scans go to arweave.net, so don't repoint a working link until it serves the page.
async function waitUntilServed(url, onWait) {
  const start = Date.now();
  while (Date.now() - start < 15 * 60_000) {
    try {
      const res = await fetch(`${url}?check=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (res.ok) return;
    } catch { /* not yet */ }
    onWait(Math.round((Date.now() - start) / 1000));
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Arweave is taking unusually long to publish the page. Try saving again in a few minutes.');
}

// The "web address or page" fields shared by the create form and edit dialog.
function destinationFields(prefix) {
  const root = $(`${prefix}-destination`);
  const radios = root.querySelectorAll(`input[name="${prefix}-kind"]`);
  const title = $(`${prefix}-page-title`), text = $(`${prefix}-page-text`), photo = $(`${prefix}-page-photo`);
  const preview = $(`${prefix}-page-preview`), size = $(`${prefix}-page-size`);
  const lock = $(`${prefix}-lock`), lockFields = $(`${prefix}-lock-fields`), password = $(`${prefix}-password`);
  const hint = $(`${prefix}-password-hint`), hintDefault = hint.textContent;
  let image = '';
  let keep = null; // current password, kept when editing a locked link without retyping it
  const pageLimit = () => (lock.checked ? LOCKED_PAGE_MAX : PAGE_MAX_BYTES);

  const kind = () => [...radios].find((r) => r.checked).value;
  const page = () => ({ title: title.value.trim(), text: text.value, image });
  function updateSize() {
    try {
      const bytes = pageBytes(buildPageHtml({ ...page(), title: page().title || 'x' }));
      size.textContent = `Page size: ${Math.ceil(bytes / 1024)} KB of ${Math.floor(pageLimit() / 1024)} KB`;
    } catch (err) {
      size.textContent = err.message;
    }
  }
  function setKind(k) {
    for (const r of radios) r.checked = r.value === k;
    for (const el of root.querySelectorAll('[data-kind]')) el.hidden = el.dataset.kind !== k;
    const name = $(`${prefix}-name`);
    name.placeholder = k === 'page' ? 'Defaults to the page title' : (prefix === 'create' ? 'Restaurant menu' : '');
    if (k === 'page') updateSize();
  }
  function setImage(dataUrl) {
    image = dataUrl;
    preview.hidden = !image;
    preview.querySelector('img').src = image || '';
    photo.value = '';
    updateSize();
  }
  for (const r of radios) r.addEventListener('change', () => setKind(kind()));
  text.addEventListener('input', updateSize);
  photo.addEventListener('change', async () => {
    const file = photo.files[0];
    if (!file) return;
    size.textContent = 'Preparing photo…';
    try {
      const without = pageBytes(buildPageHtml({ ...page(), title: page().title || 'x', image: '' }));
      setImage(await compressImage(file, pageLimit() - without - 512));
    } catch (err) {
      photo.value = '';
      size.textContent = err.message;
    }
  });
  $(`${prefix}-page-remove`).addEventListener('click', () => setImage(''));
  function setLocked(on, kept = null) {
    lock.checked = on;
    lockFields.hidden = !on;
    keep = kept;
    password.value = '';
    password.placeholder = keep ? 'Leave blank to keep the current password' : 'Password for this link';
    hint.textContent = hintDefault;
    if (kind() === 'page') updateSize();
  }
  lock.addEventListener('change', () => setLocked(lock.checked, keep));
  password.addEventListener('input', () => { hint.textContent = passwordAdvice(password.value) || hintDefault; });
  $(`${prefix}-suggest`).addEventListener('click', () => {
    password.value = suggestPassphrase();
    hint.textContent = 'Strong. Write it down or save it somewhere: people will need it to open the link.';
  });

  return {
    kind,
    setKind,
    url: () => $(`${prefix}-dest`).value,
    setUrl: (v) => { $(`${prefix}-dest`).value = v; },
    page,
    loadPage(p) { title.value = p.title; text.value = p.text; setImage(p.image); },
    locked: () => lock.checked,
    setLocked,
    password: () => password.value,
    keep: () => keep,
    reset() { title.value = ''; text.value = ''; setImage(''); $(`${prefix}-dest`).value = ''; setKind('url'); setLocked(false); },
  };
}

const createFields = destinationFields('create');
const editFields = destinationFields('edit');
const createOptions = optionsFields($('create-options'));
const editOptions = optionsFields($('edit-options'));
const NEW_LINK_OPTIONS = { count: true }; // scan counting is on unless turned off
createOptions.set(NEW_LINK_OPTIONS);
$('create-lock').addEventListener('change', () => createOptions.setLocked($('create-lock').checked));
$('edit-lock').addEventListener('change', () => editOptions.setLocked($('edit-lock').checked));

const nextSeq = (link) => Math.max(Date.now(), (link.pending?.seq ?? link.seq) + 1);

async function saveUpdate(link, changes) {
  const state = { id: link.id, created: link.created, ...carry(link.pending || link), ...changes, seq: nextSeq(link) };
  await publish(updateTags({ linkId: link.id, ...state }));
  addPending(state);
  await refresh();
}

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError($('create-error'), null);
  const button = e.submitter || e.target.querySelector('button[type=submit]');
  await busy(button, async () => {
    try {
      const options = createOptions.read({ locked: createFields.locked() });
      const { destination, kind, title, published } = await publishDestination(createFields);
      const name = $('create-name').value.trim() || title || '';
      const seq = Date.now();
      const id = await publish(linkTags({ destination, name, kind, seq, ...options }));
      const state = { id, created: seq, seq, destination, name, kind, disabled: false, ...options };
      addPending(state);
      if (published) trackPublishing(destination);
      e.target.reset();
      createFields.reset();
      createOptions.set(NEW_LINK_OPTIONS);
      // Show the new link right away (no pop-up); tap it for the QR code.
      links = overlayPending(links.filter((l) => !l.unindexed).map(({ pending, ...l }) => l), readPending()).links;
      render();
      refresh(); // reconcile with Arweave in the background
    } catch (err) {
      showError($('create-error'), err);
    }
  });
});

let editing = null;
async function openEdit(link) {
  editing = link;
  const view = link.pending || link;
  editFields.reset();
  $('edit-name').value = view.name;
  $('edit-title').textContent = view.destination ? 'Edit link' : 'Set destination';
  $('edit-progress').textContent = '';
  showError($('edit-error'), null);
  editOptions.set(carry(view), { locked: view.kind === 'locked' });
  $('edit-dialog').showModal();
  if (view.kind === 'locked') {
    editFields.setLocked(true);
    $('edit-progress').textContent = 'Opening your locked link…';
    let opened = null;
    try {
      const env = parseLockedHtml((await loadArweaveHtml(view.destination)) || '');
      if (env) opened = await openLocked(env, key.lockKey);
    } catch { /* fall through */ }
    if (editing !== link) return;
    $('edit-progress').textContent = '';
    if (!opened) {
      showError($('edit-error'), new Error('Couldn’t open this locked link for editing. You can still set a new destination and password.'));
      return;
    }
    editFields.setLocked(true, opened.keep);
    if (opened.payload.type === 'page') {
      editFields.setKind('page');
      const page = parsePageHtml(opened.payload.html);
      if (page) editFields.loadPage(page);
    } else {
      editFields.setUrl(opened.payload.url);
    }
  } else if (view.kind === 'page') {
    editFields.setKind('page');
    $('edit-progress').textContent = 'Loading your page…';
    const page = await loadPage(view.destination);
    if (editing !== link) return;
    $('edit-progress').textContent = '';
    if (page) editFields.loadPage(page);
    else showError($('edit-error'), new Error('Couldn’t load this page for editing. You can still write a new one.'));
  } else {
    editFields.setUrl(view.destination);
  }
}
$('edit-cancel').addEventListener('click', () => $('edit-dialog').close());
$('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError($('edit-error'), null);
  await busy(e.submitter, async () => {
    try {
      const link = editing;
      const view = link.pending || link;
      const options = editOptions.read({ locked: editFields.locked() });
      const { destination, kind, title, published } = await publishDestination(editFields, (t) => { $('edit-progress').textContent = t; });
      const name = $('edit-name').value.trim() || title || '';
      if (published) {
        if (!view.destination || view.disabled) {
          trackPublishing(destination); // nobody reaches it yet; just show progress
        } else {
          await waitUntilServed(destination, (s) => {
            $('edit-progress').textContent = `Publishing on Arweave (usually 1–5 minutes, ${s}s so far). Keep this open; your link switches over when it’s ready.`;
          });
        }
      }
      await saveUpdate(link, {
        destination,
        name,
        kind,
        disabled: view.destination ? view.disabled : false, // setting a first destination turns the link on
        ...options,
      });
      $('edit-progress').textContent = '';
      $('edit-dialog').close();
    } catch (err) {
      showError($('edit-error'), err);
    }
  });
});

async function setDisabled(link, disabled, button) {
  await busy(button, async () => {
    try {
      const view = link.pending || link;
      // Turning on a link that switched itself off also clears its end date.
      await saveUpdate(link, disabled ? { disabled } : { disabled, ...(view.offAt && view.offAt <= Date.now() ? { offAt: 0 } : {}) });
    } catch (err) {
      $('list-status').textContent = err.message;
    }
  });
}

// ---------- batch creation and CSV ----------

const BATCH_MAX = 100;
const BATCH_PARALLEL = 4;

function downloadCsv(list, filename) {
  download(new Blob([linksToCsv(list, linkUrl)], { type: 'text/csv' }), filename);
}

$('export-csv').addEventListener('click', () => downloadCsv(links.map((l) => l.pending || l), 'permapath-links.csv'));

$('batch-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError($('batch-error'), null);
  $('batch-result').hidden = true;
  const count = Number($('batch-count').value);
  if (!Number.isInteger(count) || count < 1 || count > BATCH_MAX) {
    showError($('batch-error'), new Error(`Enter a number from 1 to ${BATCH_MAX}.`));
    return;
  }
  const prefix = $('batch-prefix').value.trim();
  const button = e.submitter || e.target.querySelector('button[type=submit]');
  const base = Date.now();
  const width = String(count).length;
  const made = [];
  let failed = 0, next = 0;
  await busy(button, async () => {
    const progress = () => { $('batch-progress').textContent = `Created ${made.length} of ${count}…`; };
    progress();
    // Number 1 gets the newest timestamp so the batch lists in order, 1 first.
    const one = async (i) => {
      const name = prefix ? `${prefix} ${String(i + 1).padStart(width, '0')}` : '';
      const seq = base + (count - 1 - i);
      try {
        const id = await publish(linkTags({ name, seq, count: true }));
        const state = { id, created: seq, seq, destination: '', name, disabled: true, count: true };
        addPending(state);
        made.push({ i, state });
      } catch {
        failed++;
      }
      progress();
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_PARALLEL, count) }, async () => {
      while (next < count) await one(next++);
    }));
  });
  await refresh();
  $('batch-progress').textContent = '';
  const batch = made.sort((a, b) => a.i - b.i).map((m) => m.state);
  $('batch-summary').textContent = failed
    ? `Created ${batch.length} of ${count} links (${failed} failed; try creating the rest again).`
    : `Created ${batch.length} links.`;
  $('batch-download').onclick = () => downloadCsv(batch, `permapath-batch-${new Date(base).toISOString().slice(0, 10)}.csv`);
  $('batch-result').hidden = batch.length === 0;
  if (!batch.length) showError($('batch-error'), new Error('No links were created. Check your connection and try again.'));
});

// ---------- CSV import ----------

let importPlan = null;

function renderImportPlan() {
  const text = $('import-text').value;
  importPlan = text.trim() ? planImport(text, links) : null;
  const preview = $('import-preview');
  showError($('import-error'), importPlan?.error ? new Error(importPlan.error) : null);
  if (!importPlan || !importPlan.rows.length) {
    preview.replaceChildren();
    $('import-submit').disabled = true;
    $('import-submit').textContent = 'Import';
    return;
  }
  const parts = [];
  if (importPlan.creates) parts.push(`create ${importPlan.creates}`);
  if (importPlan.updates) parts.push(`update ${importPlan.updates}`);
  const label = { create: 'New', update: 'Update', skip: 'Skip', error: 'Problem' };
  preview.replaceChildren(
    h('p', { class: 'small' }, `${parts.length ? `Will ${parts.join(' and ')}` : 'Nothing to import'}`
      + `${importPlan.skips ? ` · ${importPlan.skips} unchanged` : ''}${importPlan.errors ? ` · ${importPlan.errors} with problems (skipped)` : ''}.`),
    h('ul', { class: 'import-rows' }, importPlan.rows.slice(0, 200).map((r) => h('li', { class: `import-${r.action}` },
      h('span', { class: 'chip' }, label[r.action]),
      ` Row ${r.line}: ${r.name || (r.action === 'create' ? 'Untitled' : '')}`,
      r.action === 'error' || r.action === 'skip' ? h('span', { class: 'muted' }, ` · ${r.message}`)
        : h('span', { class: 'muted' }, ` → ${r.destination || 'not set up'}`)))),
  );
  const actionable = importPlan.creates + importPlan.updates;
  $('import-submit').disabled = !actionable || !!importPlan.error;
  $('import-submit').textContent = actionable ? `Import ${actionable} link${actionable === 1 ? '' : 's'}` : 'Import';
}

$('import-open').addEventListener('click', () => {
  $('import-progress').textContent = '';
  renderImportPlan();
  $('import-dialog').showModal();
});
$('import-cancel').addEventListener('click', () => $('import-dialog').close());
$('import-text').addEventListener('input', renderImportPlan);
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0];
  if (!file) return;
  $('import-text').value = await file.text();
  $('import-file').value = '';
  renderImportPlan();
});

$('import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!importPlan || importPlan.error) return;
  const jobs = importPlan.rows.filter((r) => r.action === 'create' || r.action === 'update');
  const base = Date.now();
  const done = [];
  let failed = 0, next = 0;
  await busy($('import-submit'), async () => {
    const progress = () => { $('import-progress').textContent = `Imported ${done.length} of ${jobs.length}…`; };
    progress();
    const one = async (job, i) => {
      try {
        if (job.action === 'create') {
          const seq = base + (jobs.length - 1 - i); // first row lists first
          const id = await publish(linkTags({ destination: job.destination, name: job.name, seq, count: true }));
          const state = { id, created: seq, seq, destination: job.destination, name: job.name, kind: '', disabled: !job.destination, count: true };
          addPending(state);
          done.push({ i, state });
        } else {
          const link = links.find((l) => l.id === job.linkId);
          const state = { id: link.id, created: link.created, ...carry(link.pending || link), ...job.changes, seq: nextSeq(link) };
          await publish(updateTags({ linkId: link.id, ...state }));
          addPending(state);
          done.push({ i, state });
        }
      } catch {
        failed++;
      }
      progress();
    };
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (next < jobs.length) { const i = next++; await one(jobs[i], i); }
    }));
  });
  await refresh();
  const results = done.sort((a, b) => a.i - b.i).map((d) => d.state);
  $('import-progress').replaceChildren(
    `Imported ${results.length} of ${jobs.length}${failed ? ` (${failed} failed; import again to retry them)` : ''}. `,
    results.length ? h('button', { type: 'button', class: 'link', onclick: () => downloadCsv(results, 'permapath-import.csv') }, 'Download CSV with QR links') : '',
  );
  $('import-text').value = '';
  importPlan = null;
  $('import-preview').replaceChildren();
  $('import-submit').disabled = true;
  $('import-submit').textContent = 'Import';
});

$('ai-tip-copy').addEventListener('click', (e) => copy(
  'Read https://permapath.link/llms.txt, then help me make PermaPath links. Here is what I need: ',
  e.currentTarget,
));

// Ready: enable the sign-in buttons (shown, but disabled, until now).
for (const b of document.querySelectorAll('[data-needs-js]')) b.disabled = false;
show('signin');

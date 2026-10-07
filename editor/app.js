import { qrSvg, drawQr, qrCanvasSize, cleanDesign, checkDesign, ICONS, CENTER_DEFAULT } from './qr.js';
import { loadLogo, loadedLogo, remember, imageFromDataUrl } from './logos.js';
import { generateKeyText, loadKey, createDataItem, upload } from './arweave.js';
import { normalizeDestination, linkTags, updateTags, fetchLinks, overlayPending, linkStatus, linksToCsv, planImport, carry, isOffNow, findableById } from './links.js';
import { optionsFields } from './options.js';
import { RESOLVER_BASE } from './config.js';
import { buildPageHtml, parsePageHtml, pageBytes, compressImage, buildVcard, buildIcs, PAGE_MAX_BYTES, LOCKED_PAGE_MAX, CONTACT_FIELDS } from './page.js';
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
  const slow = Date.now() - slowUploadAt < 60_000;
  writePending([...readPending().filter((p) => p.id !== state.id || p.seq > state.seq), { ...state, postedAt: Date.now(), ...(slow ? { slow } : {}) }]);
}

// ---------- QR ----------

// A link's QR code as SVG, with its design (and logo, once loaded).
const logoWaits = new Map(); // logo url -> when we last started loading it
function logoFor(design) {
  if (!design.logo) return null;
  if (design.logo === draftLogo?.url) return draftLogo;
  const logo = loadedLogo(design.logo);
  if (!logo && !(Date.now() - (logoWaits.get(design.logo) || 0) < 60_000)) {
    logoWaits.set(design.logo, Date.now());
    loadLogo(design.logo).then((l) => { if (l) { render(); showQr(); if (designLink && $('design-dialog').open) previewDesign(); } });
  }
  return logo;
}

function designedSvg(view, margin = 4, design = view.design || {}, { label = true } = {}) {
  const logo = logoFor(design);
  return qrSvg(linkUrl(view.id), margin, design, { logoData: logo?.dataUrl || '', label });
}

// ~2400px wide: sharp in print up to ~8 in (20 cm) at 300 dpi. Whole-pixel
// modules keep the edges crisp.
// Synchronous on purpose: iOS only opens the share sheet if share() is called
// straight from the tap, with no awaiting first. (Logos are preloaded.)
function qrPngBlobSync(view, design = view.design || {}, minWidth = 2400) {
  const text = linkUrl(view.id);
  const unit = qrCanvasSize(text, 1, design);
  const scale = Math.ceil(minWidth / unit.width);
  const canvas = document.createElement('canvas');
  canvas.width = unit.width * scale;
  canvas.height = unit.height * scale;
  const logo = logoFor(design);
  drawQr(canvas.getContext('2d'), text, scale, design, { logoImage: logo?.img || null });
  const bin = atob(canvas.toDataURL('image/png').split(',')[1]);
  return new Blob([Uint8Array.from(bin, (ch) => ch.charCodeAt(0))], { type: 'image/png' });
}

// Share the QR image (phones: the system share sheet, which also has Copy and
// Save Image). Where sharing files isn't supported, copy the image instead.
const canShareFiles = (() => {
  try { return !!navigator.canShare?.({ files: [new File([''], 'x.png', { type: 'image/png' })] }); } catch { return false; }
})();
const shareLabel = canShareFiles ? 'Share' : 'Copy QR';

function shareQr(link, button, design) {
  const url = linkUrl(link.id);
  const blob = qrPngBlobSync(link, design);
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

// ---------- QR dialog (view, share, download the saved design) ----------

let qrLink = null;

function openQr(link) {
  qrLink = link;
  const url = linkUrl(link.id);
  $('qr-title').textContent = link.name || 'Your QR code';
  $('qr-url').href = url;
  $('qr-url').textContent = url;
  $('qr-history').href = `history.html?l=${link.id}`;
  showQr();
  $('qr-dialog').showModal();
}
function showQr() {
  if (!qrLink) return;
  $('qr-big').innerHTML = designedSvg(qrLink, 4, qrLink.design || {});
  $('qr-big').classList.toggle('checker', !!qrLink.design?.transparent);
}

$('qr-png').addEventListener('click', () => download(qrPngBlobSync(qrLink), `${fileBase(qrLink)}.png`));
$('qr-svg').addEventListener('click', () => download(new Blob([designedSvg(qrLink, 4, qrLink.design || {})], { type: 'image/svg+xml' }), `${fileBase(qrLink)}.svg`));
$('qr-copy').addEventListener('click', (e) => copy(linkUrl(qrLink.id), e.currentTarget));
$('qr-share').textContent = shareLabel;
$('qr-share').addEventListener('click', (e) => shareQr(qrLink, e.currentTarget));
$('qr-customize').addEventListener('click', () => { $('qr-dialog').close(); openDesign(qrLink); });

// ---------- Customize QR dialog ----------
// Edits preview live on a draft; downloads use the draft; Save design writes it
// to the link (a logo is uploaded then).

let designLink = null;
let draft = {};
let draftLogo = null; // { url, dataUrl, img } for a logo chosen but not uploaded yet
// Stands in for a chosen logo's address until Save design uploads it.
const PENDING_LOGO = `https://arweave.net/${'_'.repeat(43)}`;

// The icon picker: "None" plus the built-in icons, drawn from the same paths as the codes.
$('design-icons').replaceChildren(
  h('button', { type: 'button', role: 'radio', 'data-icon': '', title: 'No icon', 'aria-label': 'No icon' }, 'None'),
  ...Object.entries(ICONS).map(([key, { label, d }]) => {
    const b = h('button', { type: 'button', role: 'radio', 'data-icon': key, title: label, 'aria-label': label });
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return b;
  }),
);
$('design-icons').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-icon]');
  if (!b) return;
  draft = { ...draft, icon: b.dataset.icon, logo: '' };
  draftLogo = null;
  $('design-logo').value = '';
  previewDesign();
});

function previewDesign() {
  $('design-preview').innerHTML = designedSvg(designLink, 4, draft);
  $('design-preview').classList.toggle('checker', !!draft.transparent);
  const { error, colorWarnings, sizeNote } = checkDesign(draft);
  $('design-color-notes').replaceChildren(...colorWarnings.map((w) => h('p', {}, w)));
  $('design-size-note').textContent = sizeNote;
  showError($('design-error'), error ? new Error(error) : null);
  $('design-save').disabled = !!error;
  const hasCenter = !!(draft.logo || draft.icon);
  $('design-size-row').hidden = !hasCenter;
  $('design-size').value = draft.centerSize || CENTER_DEFAULT;
  $('design-size-value').textContent = `(${draft.centerSize || CENTER_DEFAULT}% of the code’s width)`;
  $('design-logo-row').hidden = !draft.logo;
  for (const b of $('design-icons').children) b.setAttribute('aria-checked', String(!draft.logo && (draft.icon || '') === b.dataset.icon));
  // A logo or icon always uses the extra error correction.
  $('design-sturdy').checked = !!(draft.sturdy || draft.logo || draft.icon);
  $('design-sturdy').disabled = !!(draft.logo || draft.icon);
}

function loadDraft(design) {
  draft = { ...cleanDesign(design) };
  if (draft.logo !== PENDING_LOGO) draftLogo = null;
  $('design-label').value = draft.label || '';
  for (const r of document.querySelectorAll('input[name="design-style"]')) r.checked = r.value === (draft.style || 'square');
  for (const r of document.querySelectorAll('input[name="design-frame"]')) r.checked = r.value === (draft.frame || '');
  $('design-fg').value = draft.fg || '#000000';
  $('design-bg').value = draft.bg || '#ffffff';
  $('design-transparent').checked = !!draft.transparent;
  $('design-sturdy').checked = !!draft.sturdy;
  $('design-logo').value = '';
  $('design-size').value = draft.centerSize || CENTER_DEFAULT;
}

function openDesign(link) {
  designLink = link;
  $('design-for').textContent = link.name || 'Untitled link';
  loadDraft(link.design || {});
  previewDesign();
  $('design-dialog').showModal();
}

function readDraft() {
  draft = {
    ...draft,
    label: $('design-label').value,
    style: document.querySelector('input[name="design-style"]:checked').value,
    frame: document.querySelector('input[name="design-frame"]:checked').value,
    fg: $('design-fg').value,
    bg: $('design-bg').value,
    transparent: $('design-transparent').checked,
    sturdy: $('design-sturdy').checked,
    centerSize: Number($('design-size').value),
  };
  previewDesign();
}
for (const id of ['design-label', 'design-fg', 'design-bg', 'design-transparent', 'design-sturdy', 'design-size']) $(id).addEventListener('input', readDraft);
for (const r of document.querySelectorAll('input[name="design-style"], input[name="design-frame"]')) r.addEventListener('change', readDraft);
$('design-logo').addEventListener('change', async () => {
  const file = $('design-logo').files[0];
  if (!file) return;
  try {
    const dataUrl = await compressImage(file, 30 * 1024);
    draftLogo = { url: PENDING_LOGO, dataUrl, img: await imageFromDataUrl(dataUrl) };
    draft = { ...draft, logo: PENDING_LOGO, icon: '' };
    previewDesign();
  } catch (err) {
    showError($('design-error'), err);
  }
});
$('design-logo-remove').addEventListener('click', () => { draft = { ...draft, logo: '' }; draftLogo = null; $('design-logo').value = ''; previewDesign(); });
$('design-reset').addEventListener('click', () => { loadDraft({}); previewDesign(); });
// Save writes the design and closes, like the Edit dialog. Cancel (and Escape)
// are blocked while a save is running, so nobody closes it thinking it's done.
let designSaving = false;
$('design-cancel').addEventListener('click', () => { if (!designSaving) $('design-dialog').close(); });
$('design-dialog').addEventListener('cancel', (e) => { if (designSaving) e.preventDefault(); });
$('design-save').addEventListener('click', async (e) => {
  const link = links.find((l) => l.id === designLink.id);
  if (!link) return;
  const design0 = cleanDesign(draft);
  if (JSON.stringify(design0) === JSON.stringify(cleanDesign(designLink.design || {}))) {
    $('design-dialog').close(); // nothing changed
    return;
  }
  designSaving = true;
  $('design-cancel').disabled = true;
  await busy(e.currentTarget, async () => {
    try {
      let design = { ...draft };
      if (design.logo === PENDING_LOGO && draftLogo) {
        const bytes = Uint8Array.from(atob(draftLogo.dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
        const type = draftLogo.dataUrl.slice(5, draftLogo.dataUrl.indexOf(';'));
        design.logo = await publishFile(bytes, type, 'logo');
        remember(design.logo, draftLogo);
      }
      design = cleanDesign(design);
      await saveUpdate(link, { design });
      if (qrLink?.id === designLink.id) qrLink = { ...qrLink, design };
      $('design-dialog').close();
    } catch (err) {
      showError($('design-error'), err);
    }
  });
  designSaving = false;
  $('design-cancel').disabled = false;
});
$('design-png').addEventListener('click', () => download(qrPngBlobSync(designLink, draft), `${fileBase(designLink)}.png`));
$('design-svg').addEventListener('click', () => download(new Blob([designedSvg(designLink, 4, draft)], { type: 'image/svg+xml' }), `${fileBase(designLink)}.svg`));

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

const fillPhrase = (list, phrase) => list.replaceChildren(...phrase.split(' ').map((w, i) => h('li', {}, h('span', { class: 'n' }, `${i + 1}.`), w)));

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
  // A new link stays "New" until a scan would find it, not just this list.
  if (fetched) {
    const created = readPending().filter((p) => p.seq === p.created && fetched.some((l) => l.id === p.id));
    const notYet = new Set((await Promise.all(created.map(async (p) => ((await findableById(p.id).catch(() => false)) ? null : p.id)))).filter(Boolean));
    if (notYet.size) fetched = fetched.filter((l) => !notYet.has(l.id));
  }
  const previous = links.filter((l) => !l.unindexed).map(({ pending, ...l }) => l);
  const { links: merged, outstanding } = overlayPending(fetched || previous, readPending());
  if (fetched) writePending(outstanding);
  links = merged;
  render();
  if (fetched) loadScanCounts();
  if (fetched) $('list-status').textContent = links.length ? '' : 'No links yet. Create one above.';
  // Check often right after a change (most go live within seconds), then every 15s.
  const recent = outstanding.some((p) => Date.now() - p.postedAt < 2 * 60_000);
  if (outstanding.length) pollTimer = setTimeout(refresh, recent ? 5_000 : 15_000);
}

// Feedback while it checks Arweave, then a brief "Up to date".
$('refresh').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Refreshing…';
  // Keep "Refreshing…" up long enough to see, even when Arweave answers fast.
  await Promise.all([refresh(), new Promise((r) => setTimeout(r, 800))]);
  button.disabled = false;
  const failed = /Couldn’t/.test($('list-status').textContent);
  button.textContent = failed ? 'Refresh' : 'Up to date';
  if (!failed && links.length) $('list-status').textContent = `Checked ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  setTimeout(() => { button.textContent = 'Refresh'; }, 2500);
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
    const page = payload.type === 'page' ? parsePageHtml(payload.html) : null;
    revealed.set(url, payload.type === 'url' ? payload.url : page?.contact ? `Contact card · ${page.contact.name}` : page?.event ? `Event · ${page.event.name}` : `Page · ${page?.title || 'untitled'}`);
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
function extras(state, id, { scans = true } = {}) {
  const parts = [];
  if (!scans) { /* shown in its own column */ } else if (state.count && scanCounts.has(id)) parts.push(`${scanCounts.get(id).toLocaleString()} scan${scanCounts.get(id) === 1 ? '' : 's'}`);
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
  if (state.kind === 'contact') return `Contact card · ${state.destination}`;
  if (state.kind === 'event') return `Event · ${state.destination}`;
  return state.kind === 'page' ? `Page · ${state.destination}` : state.destination;
}

// What kind of destination a link has: Web address, Page, Contact or Event.
// Locked links only show it once the owner's key has opened them.
const KIND_LABELS = { '': 'Web address', page: 'Page', contact: 'Contact', event: 'Event' };
function kindOf(state) {
  if (!state.destination) return '';
  if (state.kind !== 'locked') return KIND_LABELS[state.kind] ?? '';
  const r = revealed.get(state.destination);
  if (!r) return '';
  return r.startsWith('Contact card · ') ? 'Contact' : r.startsWith('Event · ') ? 'Event' : r.startsWith('Page · ') ? 'Page' : 'Web address';
}
const kindChip = (state) => (kindOf(state) ? h('span', { class: `chip linktype linktype-${kindOf(state).toLowerCase().replace(' ', '-')}` }, kindOf(state)) : null);

// The destination without its type prefix (the type has its own column).
const destinationText = (state) => describe(state).replace(/^(Contact card|Event|Page) · /, '');

// ---------- list or table ----------

const VIEW_KEY = 'permapath:view';
const SORT_KEY = 'permapath:sort';
const stored = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
let viewMode = stored(VIEW_KEY, 'list');
let sort = stored(SORT_KEY, { by: 'created', desc: true });
for (const r of document.querySelectorAll('input[name="links-view"]')) {
  r.checked = r.value === viewMode;
  r.addEventListener('change', () => {
    viewMode = r.value;
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(viewMode)); } catch { /* fine */ }
    render();
  });
}

const STATUS_ORDER = { Publishing: 0, New: 1, Updating: 2, Live: 3, Off: 4, 'Not set up': 5 };
const statusText = (link) => statusChip(link).textContent.replace(/ \(slow\)$/, '');
const COLUMNS = [
  { key: 'name', label: 'Name', value: (l) => (l.pending || l).name.toLowerCase() || '\uffff' },
  { key: 'status', label: 'Status', value: (l) => STATUS_ORDER[statusText(l)] ?? 9 },
  { key: 'kind', label: 'Type', value: (l) => kindOf(l.pending || l) || '\uffff' },
  { key: 'dest', label: 'Destination', value: (l) => destinationText(l.pending || l).toLowerCase() },
  { key: 'scans', label: 'Scans', value: (l) => ((l.pending || l).count ? scanCounts.get(l.id) ?? 0 : -1), num: true },
  { key: 'created', label: 'Created', value: (l) => l.created, num: true },
  { key: 'changed', label: 'Last changed', value: (l) => (l.pending || l).seq, num: true },
];

function sortedLinks() {
  const col = COLUMNS.find((c) => c.key === sort.by) || COLUMNS[4];
  return [...links].sort((a, b) => {
    const x = col.value(a), y = col.value(b);
    return (x < y ? -1 : x > y ? 1 : 0) * (sort.desc ? -1 : 1);
  });
}

function renderTable() {
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const head = h('tr', {}, h('th', {}, h('span', { class: 'pm-only' }, 'QR code')), ...COLUMNS.map((c) => h('th', { class: c.num ? 'num' : '' },
    h('button', {
      type: 'button',
      'aria-sort': sort.by === c.key ? (sort.desc ? 'descending' : 'ascending') : false,
      onclick: () => {
        sort = { by: c.key, desc: sort.by === c.key ? !sort.desc : c.num }; // numbers start biggest first
        try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)); } catch { /* fine */ }
        render();
      },
    }, c.label, sort.by === c.key ? (sort.desc ? ' ↓' : ' ↑') : ''))), h('th', {}, h('span', { class: 'pm-only' }, 'Actions')));
  const rows = sortedLinks().map((link) => {
    const view = link.pending || link;
    const thumb = h('button', { class: 'qr-mini', type: 'button', title: 'Show QR code', 'aria-label': 'Show QR code', onclick: () => openQr(view) });
    thumb.innerHTML = designedSvg(view, 1, view.design, { label: false });
    const scans = view.count ? (scanCounts.get(link.id) ?? '…').toLocaleString() : '—';
    return h('tr', { 'data-id': link.id },
      h('td', {}, thumb),
      h('td', { class: 'name' }, view.name || 'Untitled link', view.kind === 'locked' ? ' 🔒' : ''),
      h('td', {}, statusChip(link)),
      h('td', {}, kindChip(view)),
      h('td', { class: 'dest-cell' }, destinationText(view), extras(view, link.id, { scans: false }) ? h('div', { class: 'muted small' }, extras(view, link.id, { scans: false })) : null),
      h('td', { class: 'num' }, scans),
      h('td', { class: 'num' }, day(link.created)),
      h('td', { class: 'num' }, day(view.seq)),
      h('td', { class: 'actions' }, h('div', { class: 'actions-grid' },
        h('button', { type: 'button', onclick: (e) => shareQr(view, e.currentTarget) }, shareLabel),
        view.destination
          ? [h('button', { type: 'button', onclick: () => openEdit(link) }, 'Edit'),
            h('button', { type: 'button', onclick: () => openDesign(view) }, 'Customize QR'),
            h('button', { type: 'button', onclick: (e) => setDisabled(link, !isOffNow(view), e.currentTarget) }, isOffNow(view) ? 'Turn on' : 'Turn off')]
          : [h('button', { type: 'button', onclick: () => openEdit(link) }, 'Set destination'),
            h('button', { type: 'button', onclick: () => openDesign(view) }, 'Customize QR')])),
    );
  });
  $('links-table').replaceChildren(h('table', { class: 'links-table' }, h('thead', {}, head), h('tbody', {}, rows)));
}

const SLOW_NOTE = 'Arweave’s fast uploader didn’t take this one, so it went through the backup uploader. It can take a few minutes to go live.';

function render() {
  const table = viewMode === 'table' && links.length > 0;
  $('links').hidden = table;
  $('links-table').hidden = !table;
  if (table) {
    for (const link of links) {
      const view = link.pending || link;
      if (['page', 'contact', 'event', 'locked'].includes(view.kind) && view.destination) checkServed(view.destination);
      if (view.kind === 'locked' && view.destination) reveal(view.destination);
    }
    renderTable();
    return;
  }
  $('links').replaceChildren(...links.map((link) => {
    const view = link.pending || link;
    if (['page', 'contact', 'event', 'locked'].includes(view.kind) && view.destination) checkServed(view.destination);
    if (view.kind === 'locked' && view.destination) reveal(view.destination);
    const lockChip = view.kind === 'locked' ? h('span', { class: 'chip locked', title: 'Password protected' }, '🔒 Locked') : null;
    const thumb = h('button', { class: 'qr-thumb', type: 'button', title: 'Show QR code', 'aria-label': 'Show QR code', onclick: () => openQr(view) });
    thumb.innerHTML = designedSvg(view, 2, view.design, { label: false });
    const dest = [];
    if (link.pending && !link.unindexed && describe(link.pending) !== describe(link)) {
      dest.push(h('p', { class: 'dest old' }, describe(link)));
      dest.push(h('p', { class: 'dest pending' }, `→ ${describe(link.pending)} (going live…)`));
      if (link.pending.slow) dest.push(h('p', { class: 'muted dest note' }, SLOW_NOTE));
    } else if (publishingPages.has(view.destination)) {
      dest.push(h('p', { class: 'dest' }, destinationText(view)));
      dest.push(h('p', { class: 'muted dest note' }, `Arweave is publishing your ${view.kind === 'locked' ? 'locked link' : view.kind === 'contact' ? 'contact card' : view.kind === 'event' ? 'event page' : 'page'}. Scans will reach it within a few minutes (occasionally up to 15). The QR code is ready to print.`));
    } else if (link.unindexed) {
      dest.push(h('p', { class: 'dest' }, destinationText(view)));
      dest.push(h('p', { class: 'muted dest note' }, link.pending?.slow ? SLOW_NOTE : 'Just created. Usually live within a minute.'));
    } else {
      dest.push(h('p', { class: 'dest' }, destinationText(view)));
    }
    const extra = extras(view, link.id);
    if (extra) dest.push(h('p', { class: 'muted small extras' }, extra));
    // Tapping anywhere on the card (except its buttons) opens the QR code.
    const openFromCard = (e) => { if (!e.target.closest('button, a, input')) openQr(view); };
    return h('li', { class: 'card link-item clickable', onclick: openFromCard, title: 'Show QR code', 'data-id': link.id },
      thumb,
      h('div', {},
        h('h3', {}, view.name || 'Untitled link', statusChip(link), kindChip(view), lockChip),
        dest,
        h('div', { class: 'row' },
          h('button', { type: 'button', onclick: (e) => shareQr(view, e.currentTarget) }, shareLabel),
          view.destination
            ? [
              h('button', { type: 'button', onclick: () => openEdit(link) }, 'Edit'),
              h('button', { type: 'button', onclick: () => openDesign(view) }, 'Customize QR'),
              h('button', { type: 'button', onclick: (e) => setDisabled(link, !isOffNow(view), e.currentTarget) }, isOffNow(view) ? 'Turn on' : 'Turn off'),
            ]
            : [
              h('button', { type: 'button', onclick: () => openEdit(link) }, 'Set destination'),
              h('button', { type: 'button', onclick: () => openDesign(view) }, 'Customize QR'),
            ],
        ),
      ),
    );
  }));
}

// ---------- writes ----------

// When an upload last went to the slow fallback (Turbo refused it, e.g. this
// device's free allowance is used up), so the list can say it may take a while.
let slowUploadAt = 0;
async function uploadTracked(item) {
  const result = await upload(item);
  if (result.slow) slowUploadAt = Date.now();
  return result;
}

async function publish(tags) {
  // Empty body: lets anyone verify the signature from GraphQL fields alone.
  const item = await createDataItem(key, tags, '');
  await uploadTracked(item);
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
  await uploadTracked(item);
  return `https://arweave.net/${item.id}`;
}

// A contact card's "Save contact" file or an event's "Add to calendar" file:
// its own upload, served with its real type so phones open it straight into
// Contacts or Calendar.
async function publishFile(body, contentType, type) {
  const item = await createDataItem(key, [
    { name: 'Content-Type', value: contentType },
    { name: 'App-Name', value: APP_NAME },
    { name: 'App-Version', value: '1' },
    { name: 'Type', value: type },
  ], body);
  await uploadTracked(item);
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
    if (k === 'url') return { destination: normalizeDestination(fields.url()), kind: '' };
    const page = fields.page();
    buildPageHtml(page); // validate before uploading anything
    if (k === 'contact') {
      onProgress('Saving your contact card…');
      const vcardUrl = await publishFile(buildVcard(page.contact, page.text), 'text/vcard', 'vcard');
      return { destination: await publishPage({ ...page, vcardUrl }), kind: 'contact', title: page.contact.name, published: true };
    }
    if (k === 'event') {
      onProgress('Saving your event…');
      const icsUrl = await publishFile(buildIcs(page.event, page.text), 'text/calendar', 'ics');
      return { destination: await publishPage({ ...page, icsUrl }), kind: 'event', title: page.event.name, published: true };
    }
    onProgress('Saving your page…');
    return { destination: await publishPage(page), kind: 'page', title: page.title, published: true };
  }
  let payload, title = '';
  if (k === 'page' || k === 'contact' || k === 'event') {
    const page = fields.page();
    // Locked: the contact or calendar file goes inside the encrypted page, not in a public upload.
    if (k === 'contact') page.vcardUrl = `data:text/vcard;charset=utf-8,${encodeURIComponent(buildVcard(page.contact, page.text))}`;
    if (k === 'event') page.icsUrl = `data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcs(page.event, page.text))}`;
    const html = buildPageHtml(page);
    if (pageBytes(html) > LOCKED_PAGE_MAX) throw new Error('This page is too large to lock. Shorten the text or remove the photo.');
    payload = { type: 'page', html };
    title = k === 'contact' ? page.contact.name : k === 'event' ? page.event.name : page.title;
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
  await uploadTracked(item);
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
  text.dataset.placeholder = text.placeholder;
  const contactInput = (f) => $(`${prefix}-contact-${f}`);
  const contact = () => Object.fromEntries(CONTACT_FIELDS.map((f) => [f, contactInput(f).value.trim()]));
  // Event times are entered in this device's time zone, and the page shows them in it.
  const eventInput = (f) => $(`${prefix}-event-${f}`);
  const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  const localMs = (v) => (v ? new Date(v).getTime() : 0);
  const pad = (n) => String(n).padStart(2, '0');
  const toLocal = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const event = () => ({
    name: eventInput('name').value.trim(), start: localMs(eventInput('start').value), end: localMs(eventInput('end').value),
    tz: zone, location: eventInput('location').value.trim(),
  });
  eventInput('zone').textContent = `Times are in your time zone (${zone.replace(/_/g, ' ')}), and the page shows them that way.`;
  const page = () => (kind() === 'contact' ? { text: text.value, image, contact: contact() }
    : kind() === 'event' ? { text: text.value, image, event: event() }
      : { title: title.value.trim(), text: text.value, image });
  const isPageKind = (k) => k === 'page' || k === 'contact' || k === 'event';
  function updateSize() {
    try {
      const p = page();
      const bytes = pageBytes(buildPageHtml(p.contact ? { ...p, contact: { ...p.contact, name: p.contact.name || 'x', phone: '', email: '', website: '' } }
        : p.event ? { ...p, event: { ...p.event, name: p.event.name || 'x', start: p.event.start || 1, end: 0 } } : { ...p, title: p.title || 'x' }));
      size.textContent = `Page size: ${Math.ceil(bytes / 1024)} KB of ${Math.floor(pageLimit() / 1024)} KB`;
    } catch (err) {
      size.textContent = err.message;
    }
  }
  function setKind(k) {
    for (const r of radios) r.checked = r.value === k;
    for (const el of root.querySelectorAll('[data-kind]')) el.hidden = !el.dataset.kind.split(' ').includes(k);
    const name = $(`${prefix}-name`);
    name.placeholder = k === 'page' ? 'Defaults to the page title' : k === 'contact' ? 'Defaults to the contact’s name'
      : k === 'event' ? 'Defaults to the event name' : (prefix === 'create' ? 'Restaurant menu' : '');
    text.placeholder = k === 'event' ? 'What to bring, where to park, who to ask for…' : text.dataset.placeholder;
    if (isPageKind(k)) updateSize();
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
    if (isPageKind(kind())) updateSize();
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
    loadPage(p) {
      title.value = p.contact ? '' : p.title;
      text.value = p.text;
      for (const f of CONTACT_FIELDS) contactInput(f).value = p.contact?.[f] || '';
      eventInput('name').value = p.event?.name || '';
      eventInput('start').value = toLocal(p.event?.start);
      eventInput('end').value = toLocal(p.event?.end);
      eventInput('location').value = p.event?.location || '';
      setImage(p.image);
    },
    locked: () => lock.checked,
    setLocked,
    password: () => password.value,
    keep: () => keep,
    reset() {
      title.value = ''; text.value = ''; setImage(''); $(`${prefix}-dest`).value = '';
      for (const f of CONTACT_FIELDS) contactInput(f).value = '';
      for (const f of ['name', 'start', 'end', 'location']) eventInput(f).value = '';
      setKind('url'); setLocked(false);
    },
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
      const page = parsePageHtml(opened.payload.html);
      editFields.setKind(page?.contact ? 'contact' : page?.event ? 'event' : 'page');
      if (page) editFields.loadPage(page);
    } else {
      editFields.setUrl(opened.payload.url);
    }
  } else if (view.kind === 'page' || view.kind === 'contact' || view.kind === 'event') {
    editFields.setKind(view.kind);
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

// The same prompt from the landing page tip and the signed-in tip.
const AI_PROMPT = 'Read https://permapath.link/llms.txt, then help me make PermaPath links. Here is what I need: ';
$('ai-tip-copy').addEventListener('click', (e) => copy(AI_PROMPT, e.currentTarget));
for (const b of document.querySelectorAll('.ai-copy')) b.addEventListener('click', (e) => copy(AI_PROMPT, e.currentTarget));

// Ready: enable the sign-in buttons (shown, but disabled, until now).
for (const b of document.querySelectorAll('[data-needs-js]')) b.disabled = false;
show('signin');

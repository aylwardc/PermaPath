// Public history page: history.html?l=<link-id>. Read-only; no key needed.
import { fetchLinkHistory, linkStatus, isOffNow } from './links.js';
import { qrSvg } from './qr.js';
import { loadLogo } from './logos.js';
import { RESOLVER_BASE } from './config.js';

const $ = (id) => document.getElementById(id);

// iOS browsers opened this page scrolled past the title (restored scroll or
// anchoring as results load in). Start at the top instead.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
const linkUrl = (id) => `${RESOLVER_BASE}?l=${id}`;
const ID = /^[A-Za-z0-9_-]{43}$/;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function safeLink(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') return h('a', { href: u.href, rel: 'noopener noreferrer nofollow' }, u.href);
  } catch { /* fall through */ }
  return h('span', {}, url);
}

function describe(state) {
  if (!state.destination) return h('span', { class: 'muted' }, state.setup ? (state.disabled ? 'Turned off · not set up yet' : 'Not set up yet (scanning opens setup)') : 'No destination yet');
  if (!state.disabled && state.offAt) {
    return h('span', {}, h('span', { class: 'muted' }, `${isOffNow(state) ? 'Turned off' : 'Turns off'} ${when(state.offAt)} · `), describeOn(state));
  }
  return describeOn(state);
}

// Where the link sends people while it's on, plus its other rules.
function describeOn(state) {
  const rules = state.routes?.length && !state.disabled
    ? h('span', { class: 'muted' }, ` · plus ${state.routes.length} other destination${state.routes.length === 1 ? '' : 's'} by device or time: `,
      ...state.routes.flatMap((r, i) => [i ? ', ' : '', safeLink(r.to)]))
    : null;
  return h('span', {}, describeMain(state), rules);
}

function describeMain(state) {
  if (state.kind === 'locked') return h('span', {}, state.disabled ? 'Turned off · was password protected' : 'Password protected');
  if (state.disabled) return h('span', {}, h('span', { class: 'muted' }, 'Turned off · was '), safeLink(state.destination));
  return safeLink(state.destination);
}

async function loadScans(id) {
  $('scans').textContent = '…';
  try {
    const res = await fetch(`https://permapath.link/api/scans/${id}`, { signal: AbortSignal.timeout(10_000) });
    const { total, days } = await res.json();
    const today = new Date().toISOString().slice(0, 10);
    const n = days.find((d) => d.day === today)?.n || 0;
    $('scans').textContent = `${total.toLocaleString()} total · ${n.toLocaleString()} today (days in UTC)`;
  } catch {
    $('scans').textContent = 'Couldn’t load the count right now.';
  }
}

const CHIPS = { live: ['live', 'Live'], off: ['off', 'Off'], 'not set up': ['off', 'Not set up'] };

// Accepts a bare ID or any URL with ?l=<id> (QR URL, history URL, editor link).
function parseId(text) {
  const t = text.trim();
  if (ID.test(t)) return t;
  try {
    const id = new URL(t).searchParams.get('l');
    if (id && ID.test(id)) return id;
  } catch { /* not a URL */ }
  return null;
}

function changeSummary(state, older) {
  if (!older) return 'Created';
  const parts = [];
  if (state.destination !== older.destination) parts.push(older.destination ? 'Destination changed' : 'Destination set');
  if (state.disabled !== older.disabled) parts.push(state.disabled ? 'Turned off' : 'Turned on');
  if (state.name !== older.name) parts.push(state.name ? `Renamed “${state.name}”` : 'Name removed');
  if (state.resolver !== older.resolver) parts.push('Moved to a newer resolver');
  if (state.count !== older.count) parts.push(state.count ? 'Scan counting on' : 'Scan counting off');
  if (state.offAt !== older.offAt) parts.push(state.offAt ? `Set to turn off ${when(state.offAt)}` : 'End date removed');
  if (state.message !== older.message) parts.push(state.message ? 'Off message set' : 'Off message removed');
  if (JSON.stringify(state.routes) !== JSON.stringify(older.routes)) parts.push(state.routes.length ? 'Device or time rules changed' : 'Device and time rules removed');
  return parts.join(' · ') || 'Re-saved with no changes';
}

async function show(id, { scrollTop = false } = {}) {
  $('result').hidden = true;
  $('status').textContent = 'Reading from Arweave…';
  // Only touch the URL when it changes: Safari ties scroll position to history entries.
  if (new URLSearchParams(location.search).get('l') !== id) history.replaceState(null, '', `?l=${id}`);
  let link;
  try {
    link = await fetchLinkHistory(id);
  } catch (err) {
    $('status').textContent = err.message;
    return;
  }
  if (!link) {
    $('status').textContent = 'No PermaPath link with that ID was found. New links can take a minute to appear.';
    return;
  }
  const status = linkStatus(link.current);
  const [chipClass, chipText] = CHIPS[status];
  const design = link.current.design || {};
  $('qr').innerHTML = qrSvg(linkUrl(id), 2, design, { label: false });
  if (design.logo) loadLogo(design.logo).then((logo) => { if (logo) $('qr').innerHTML = qrSvg(linkUrl(id), 2, design, { label: false, logoData: logo.dataUrl }); });
  $('name').textContent = link.current.name || 'Untitled link';
  $('chip').replaceChildren(h('span', { class: `chip ${chipClass}` }, chipText));
  $('now').replaceChildren(describe(link.current));
  $('qr-url').textContent = `QR code: ${linkUrl(id)}`;
  $('created').textContent = when(link.created);
  $('scans-row').hidden = !link.current.count;
  if (link.current.count) loadScans(id);
  $('owner').textContent = link.owner;
  $('count').textContent = `(${link.history.length})`;
  $('timeline').replaceChildren(...link.history.map((state, i) => h('li', {},
    h('div', { class: 'when' }, when(state.seq),
      h('span', { class: 'muted small' }, state.confirmedAt ? ` · confirmed on Arweave ${when(state.confirmedAt)}` : ' · awaiting Arweave confirmation')),
    h('div', { class: 'what' }, changeSummary(state, link.history[i + 1])),
    h('div', { class: 'dest' }, describe(state)),
  )));
  document.title = `${link.current.name || 'Link'} history · PermaPath`;
  $('status').textContent = '';
  $('result').hidden = false;
  if (scrollTop) window.scrollTo(0, 0);
}

$('lookup').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = parseId($('lookup-input').value);
  $('lookup-error').hidden = !!id;
  $('lookup-error').textContent = id ? '' : 'Paste a PermaPath QR link or a 43-character link ID.';
  if (id) show(id);
});

const initial = new URLSearchParams(location.search).get('l');
if (initial && ID.test(initial)) {
  $('lookup-input').value = initial;
  show(initial, { scrollTop: true });
}

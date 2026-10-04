// PermaPath for scripts and servers (Node 22+). Same protocol and code as the
// editor: create links, change where they point, read their history.
//
//   import { loadKey, createLink, updateLink } from './lib/permapath.js';
//   const key = await loadKey(process.env.PERMAPATH_KEY);
//   const { id, url } = await createLink(key, { destination: 'https://example.com/menu', name: 'Menu' });
//   await updateLink(key, id, { destination: 'https://example.com/menu-v2' });
//
// Keys are the same 44-character strings the editor creates. Everything written
// is permanent, and public unless password protected (lockLink); see the README.
import { generateKeyText, loadKey, createDataItem, upload, configureNetwork, GRAPHQL_ENDPOINTS, UPLOAD_URL } from '../editor/arweave.js';
import { linkTags, updateTags, fetchLinks, fetchLinkHistory, normalizeDestination, linkStatus } from '../editor/links.js';
import { qrSvg } from '../editor/qr.js';
import { buildLockedHtml, parseLockedHtml, openLocked } from '../editor/lock.js';
import { buildPageHtml, parsePageHtml, pageBytes, PAGE_MAX_BYTES, LOCKED_PAGE_MAX } from '../editor/page.js';
import { APP_NAME } from '../editor/arweave.js';
import { RESOLVER_BASE } from '../editor/config.js';

export { loadKey, linkStatus, normalizeDestination };

// Talk to permapath.link only (a pass-through to the Arweave services), so AI
// agents running this don't have to approve five unfamiliar domains. Falls
// back to the services directly if permapath.link is unreachable, so nothing
// depends on the domain. PERMAPATH_DIRECT=1 skips the pass-through.
const PROXY = 'https://permapath.link/api';
const direct = typeof process !== 'undefined' && process.env?.PERMAPATH_DIRECT === '1';
const PROXIED_GRAPHQL = ['arweave', 'goldsky', 'permagate', 'frostor'].map((n) => `${PROXY}/graphql/${n}`);
configureNetwork(direct ? {} : { upload: [`${PROXY}/upload`, UPLOAD_URL], raw: `${PROXY}/raw` });

async function withEndpoints(fn) {
  if (direct) return fn(GRAPHQL_ENDPOINTS);
  try {
    return await fn(PROXIED_GRAPHQL);
  } catch {
    return fn(GRAPHQL_ENDPOINTS); // only if every proxied endpoint failed
  }
}
export const generateKey = generateKeyText;

/** The URL a link's QR code encodes. */
export const linkUrl = (linkId) => `${RESOLVER_BASE}?l=${linkId}`;

/** SVG markup of a link's QR code. */
export const linkQrSvg = (linkId) => qrSvg(linkUrl(linkId));

async function publish(key, tags) {
  // Empty body, like the editor: signatures verify from GraphQL fields alone.
  const item = await createDataItem(key, tags, '');
  await upload(item);
  return item.id;
}

/**
 * Creates a link. Omit `destination` for a "not set up" link (created turned off).
 * Pass `password` to create it password protected. Returns { id, url }.
 */
export async function createLink(key, { destination = '', name = '', password = '' } = {}) {
  const dest = destination ? normalizeDestination(destination) : '';
  if (password && !dest) throw new Error('A password-protected link needs a destination.');
  const target = password ? await publishLocked(key, { type: 'url', url: dest }, password) : dest;
  const id = await publish(key, linkTags({ destination: target, name, kind: password ? 'locked' : '', seq: Date.now() }));
  return { id, url: linkUrl(id) };
}

// ---------- password protection and pages (same formats as the editor) ----------

const TX_URL = /^https:\/\/arweave\.net\/([A-Za-z0-9_-]{43})$/;

async function publishHtml(key, html, type) {
  const item = await createDataItem(key, [
    { name: 'Content-Type', value: 'text/html' },
    { name: 'App-Name', value: APP_NAME },
    { name: 'App-Version', value: '1' },
    { name: 'Type', value: type },
  ], html);
  await upload(item);
  return `https://arweave.net/${item.id}`;
}

const publishLocked = async (key, payload, password, keep) =>
  publishHtml(key, await buildLockedHtml({ payload, password, keep, lockKey: key.lockKey }), 'locked');

// Reads a page or locked page we published, via permapath.link first.
async function fetchArweaveHtml(url) {
  const id = url.match(TX_URL)?.[1];
  if (!id) throw new Error(`Not an Arweave page: ${url}`);
  const sources = [...(direct ? [] : [`${PROXY}/raw/${id}`]), `https://turbo-gateway.com/${id}`, `https://arweave.net/${id}`];
  for (const src of sources) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return await res.text();
    } catch { /* next source */ }
  }
  throw new Error('Couldn’t download the current page or locked page. Try again in a minute.');
}

// Scans land on arweave.net, so before repointing a live link at a fresh
// upload, wait until arweave.net serves it (usually 1-5 minutes).
async function waitUntilServed(url, onWait = () => {}) {
  const start = Date.now();
  while (Date.now() - start < 20 * 60_000) {
    try {
      const res = await fetch(`${url}?check=${Date.now()}`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return;
    } catch { /* not yet */ }
    onWait(Math.round((Date.now() - start) / 1000));
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Arweave is taking unusually long to publish. Try again in a few minutes.');
}

async function ownedLink(key, linkId) {
  const link = await getLink(linkId);
  if (!link) throw new Error(`Link ${linkId} not found (new links can take a moment to appear).`);
  if (link.ownerKey !== key.ownerKey) throw new Error('This key does not own that link.');
  return link;
}

async function openOwnLocked(key, link) {
  const env = parseLockedHtml(await fetchArweaveHtml(link.current.destination));
  if (!env) throw new Error('That link’s locked page couldn’t be read.');
  return openLocked(env, key.lockKey); // { payload, keep }
}

/** For the owner: what a locked link unlocks to ({ type: 'url', url } or { type: 'page', html }), or null. */
export async function revealLink(key, linkId) {
  const link = await ownedLink(key, linkId);
  if (link.current.kind !== 'locked') return null;
  return (await openOwnLocked(key, link)).payload;
}

/**
 * A page link's content as { title, text, image, locked }, or null if the link
 * isn't a page. Locked pages need the owner's key.
 */
export async function readPage(linkId, key) {
  const link = await getLink(linkId);
  if (!link) return null;
  if (link.current.kind === 'page') return { ...parsePageHtml(await fetchArweaveHtml(link.current.destination)), locked: false };
  if (link.current.kind === 'locked' && key && key.ownerKey === link.ownerKey) {
    const { payload } = await openOwnLocked(key, link);
    return payload.type === 'page' ? { ...parsePageHtml(payload.html), locked: true } : null;
  }
  return null;
}

function pageHtmlWithin(page, locked) {
  const html = buildPageHtml(page);
  const max = locked ? LOCKED_PAGE_MAX : PAGE_MAX_BYTES;
  const bytes = pageBytes(html);
  if (bytes > max) {
    const over = Math.ceil((bytes - max) / 1024);
    throw new Error(`This page is ${Math.ceil(bytes / 1024)} KB; the limit is ${Math.floor(max / 1024)} KB${locked ? ' when password protected' : ''}. `
      + (page.image ? `Make the photo about ${over} KB smaller (or shorten the text).` : 'Shorten the text.'));
  }
  return html;
}

/**
 * Creates a link to a hosted page. page: { title, text?, image? } where image is a
 * data:image/(jpeg|png|webp);base64 URL that already fits (photos aren't resized
 * here). Pass `password` to lock it. Returns { id, url, pageUrl }.
 */
export async function createPage(key, { title, text = '', image = '', name = '', password = '' }) {
  const html = pageHtmlWithin({ title, text, image }, !!password);
  const pageUrl = password ? await publishLocked(key, { type: 'page', html }, password) : await publishHtml(key, html, 'page');
  const id = await publish(key, linkTags({ destination: pageUrl, name: name || title.trim(), kind: password ? 'locked' : 'page', seq: Date.now() }));
  return { id, url: linkUrl(id), pageUrl };
}

/**
 * Edits a page link (plain or password protected), keeping whatever isn't
 * passed: changes { title?, text?, image? ('' removes the photo) }. A locked
 * page keeps its password. Waits for arweave.net if the link is live.
 */
export async function editPage(key, linkId, changes, { onWait } = {}) {
  const link = await ownedLink(key, linkId);
  let current, keep = null;
  if (link.current.kind === 'page') {
    current = parsePageHtml(await fetchArweaveHtml(link.current.destination));
  } else if (link.current.kind === 'locked') {
    const opened = await openOwnLocked(key, link);
    if (opened.payload.type !== 'page') throw new Error('That locked link goes to a web address, not a page.');
    current = parsePageHtml(opened.payload.html);
    keep = opened.keep;
  } else {
    throw new Error('That link isn’t a page. Use "set" for web addresses.');
  }
  if (!current) throw new Error('Couldn’t read the current page.');
  const page = { ...current, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
  const html = pageHtmlWithin(page, !!keep);
  const destination = keep
    ? await publishHtml(key, await buildLockedHtml({ payload: { type: 'page', html }, keep, lockKey: key.lockKey }), 'locked')
    : await publishHtml(key, html, 'page');
  return repoint(key, link, destination, keep ? 'locked' : 'page', onWait, true);
}

// fresh: destination is an upload we just made (wait for it if the link is live).
async function repoint(key, link, destination, kind, onWait, fresh) {
  const current = link.current;
  if (fresh && current.destination && !current.disabled) await waitUntilServed(destination, onWait);
  const state = {
    linkId: link.id, destination, kind, name: current.name, disabled: current.disabled,
    resolver: current.resolver, seq: Math.max(Date.now(), current.seq + 1),
  };
  const id = await publish(key, updateTags(state));
  return { id, ...state };
}

/**
 * Password-protects a link (or changes its password). Works for web addresses
 * and hosted pages. If the link is live, waits until the locked page is served
 * before switching over, so scans never fail. onWait(seconds) reports progress.
 */
export async function lockLink(key, linkId, { password, onWait } = {}) {
  if (!password) throw new Error('A password is required.');
  const link = await ownedLink(key, linkId);
  const current = link.current;
  if (!current.destination) throw new Error('Set a destination before locking this link.');
  let payload;
  if (current.kind === 'locked') payload = await revealLink(key, linkId);
  else if (current.kind === 'page') payload = { type: 'page', html: await fetchArweaveHtml(current.destination) };
  else payload = { type: 'url', url: current.destination };
  return repoint(key, link, await publishLocked(key, payload, password), 'locked', onWait, true);
}

/** Removes password protection: the link points straight at its web address or page again. */
export async function unlockLink(key, linkId, { onWait } = {}) {
  const link = await ownedLink(key, linkId);
  if (link.current.kind !== 'locked') throw new Error('That link isn’t password protected.');
  const payload = await revealLink(key, linkId);
  if (payload.type === 'url') return repoint(key, link, normalizeDestination(payload.url), '', onWait, false);
  return repoint(key, link, await publishHtml(key, payload.html, 'page'), 'page', onWait, true);
}

/** Creates `count` "not set up" links named `${prefix} 1`, `${prefix} 2`, ... Returns [{ id, url, name }]. */
export async function createBatch(key, { count, prefix = '', parallel = 4 }) {
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('count must be 1 to 1000');
  const base = Date.now();
  const width = String(count).length;
  const out = new Array(count);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, count) }, async () => {
    while (next < count) {
      const i = next++;
      const name = prefix ? `${prefix} ${String(i + 1).padStart(width, '0')}` : '';
      const id = await publish(key, linkTags({ name, seq: base + (count - 1 - i) }));
      out[i] = { id, url: linkUrl(id), name };
    }
  }));
  return out;
}

/** All links owned by `key`, newest first, as { id, created, seq, destination, name, disabled, resolver }. */
export const listLinks = (key) => withEndpoints((endpoints) => fetchLinks(key, endpoints));

/** One link's current state and history (anyone can read it). Null if not found. */
export const getLink = (linkId) => withEndpoints((endpoints) => fetchLinkHistory(linkId, endpoints));

/**
 * Changes a link. `changes` may include destination, name and disabled.
 * Unchanged fields are carried over from the link's current state, as read
 * from the network: right after another change, that state can lag by a few
 * seconds, so wait before chaining updates to the same link.
 */
export async function updateLink(key, linkId, changes) {
  const link = await getLink(linkId);
  if (!link) throw new Error(`Link ${linkId} not found (new links can take a moment to appear).`);
  if (link.ownerKey !== key.ownerKey) throw new Error('This key does not own that link.');
  const current = link.current;
  const destination = changes.destination !== undefined
    ? (changes.destination ? normalizeDestination(changes.destination) : '')
    : current.destination;
  const state = {
    linkId,
    destination,
    name: changes.name !== undefined ? changes.name : current.name,
    // Setting a first destination turns a "not set up" link on.
    disabled: changes.disabled !== undefined ? changes.disabled : (!current.destination && destination ? false : current.disabled),
    resolver: current.resolver,
    // A new web address replaces a hosted page; otherwise keep the page marker.
    kind: changes.destination !== undefined ? '' : current.kind,
    seq: Math.max(Date.now(), current.seq + 1),
  };
  const id = await publish(key, updateTags(state));
  return { id, ...state };
}

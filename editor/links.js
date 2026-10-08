// PermaPath link protocol: building records, reading state back from GraphQL,
// and overlaying local not-yet-indexed writes. No DOM here.
import { APP_NAME, GRAPHQL_ENDPOINTS, gqlAll, verifyNode } from './arweave.js';
import { RESOLVER_TX } from './config.js';
import { cleanDesign, isPlain } from './qr.js';

export const APP_VERSION = '1';
const BASE_TAGS = [
  { name: 'App-Name', value: APP_NAME },
  { name: 'App-Version', value: APP_VERSION },
];

// Accepts "example.com/x" or a full URL; returns a normalized http(s) URL or throws.
export function normalizeDestination(input) {
  let text = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That doesn’t look like a web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https links are supported.');
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') throw new Error('That doesn’t look like a web address.');
  if (url.href.length > 2000) throw new Error('That address is too long (2000 characters max).');
  return url.href;
}

// ---------- v3 features: scan counts, auto-off, messages, routing rules ----------
// Older resolvers ignore these tags, so a record that uses any of them also
// names the current resolver (Resolver tag): older printed codes forward there.
// Codes that already embed it ignore a Resolver naming themselves.

export const MESSAGE_MAX = 200;
export const ROUTES_MAX = 10;
const ROUTES_MAX_BYTES = 3000; // Arweave tag values are capped at 3 KB

export const usesV3 = (s) => !!(s.count || s.message || s.offAt || s.routes?.length);

// Rules as the resolver reads them: { to, os?, after?, before?, days?, from?, until? }.
// Normalizes each "to" and throws a readable error for anything the resolver would skip.
export function checkRoutes(routes = []) {
  if (routes.length > ROUTES_MAX) throw new Error(`Up to ${ROUTES_MAX} rules per link.`);
  const out = routes.map((r) => {
    const rule = { to: normalizeDestination(r.to || '') };
    if (r.os) {
      if (r.os !== 'ios' && r.os !== 'android') throw new Error('Device must be iPhone/iPad or Android.');
      rule.os = r.os;
    }
    for (const k of ['after', 'before']) if (r[k] != null && r[k] !== '') rule[k] = Number(r[k]);
    if (r.days != null && r.days !== '') {
      if (!/^[0-6]{1,7}$/.test(r.days)) throw new Error('Pick at least one day.');
      if (r.days.length < 7) rule.days = [...new Set(r.days)].sort().join('');
    }
    for (const k of ['from', 'until']) {
      if (r[k] == null || r[k] === '') continue;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r[k])) throw new Error('Times look like 09:00 or 17:30.');
      rule[k] = r[k];
    }
    if (rule.after != null && rule.before != null && rule.after >= rule.before) throw new Error('A rule’s end date must be after its start date.');
    if (Object.keys(rule).length === 1) throw new Error('Each rule needs a device, days, times or dates.');
    return rule;
  });
  if (new TextEncoder().encode(JSON.stringify(out)).length > ROUTES_MAX_BYTES) throw new Error('These rules are too long. Use fewer rules or shorter web addresses.');
  return out;
}

const hasClockRules = (routes) => (routes || []).some((r) => r.days || r.from || r.until);

function v3Tags({ count, message, offAt, routes, tz }) {
  if (message && message.length > MESSAGE_MAX) throw new Error(`The message is longer than ${MESSAGE_MAX} characters.`);
  return [
    ...(count ? [{ name: 'Count', value: 'true' }] : []),
    ...(offAt ? [{ name: 'Off-At', value: String(offAt) }] : []),
    ...(message ? [{ name: 'Message', value: message }] : []),
    ...(routes?.length ? [{ name: 'Routes', value: JSON.stringify(routes) }] : []),
    ...(routes?.length && hasClockRules(routes) && tz ? [{ name: 'Time-Zone', value: tz }] : []),
  ];
}

// "Not set up" links made in a batch point at a setup page on permapath.link, so
// scanning one opens the editor to set it up. The address carries the link's
// creation Seq (its ID can't be known before it's signed); the editor matches it
// against the signed-in key's links. Read back, such a link has destination ''
// and `setup` holding the address, so everywhere else it's simply "not set up".
export const SETUP_BASE = 'https://permapath.link/?setup=';
export const setupUrl = (seq) => `${SETUP_BASE}${seq}`;
const isSetupUrl = (d) => /^https:\/\/permapath\.link\/\?setup=\d{1,16}$/.test(d || '');

// The protocol fields of a link state (drops display-only fields like pending).
export const carry = (s) => ({
  name: s.name, destination: s.destination, setup: s.setup || '', disabled: s.disabled, resolver: s.resolver, kind: s.kind,
  count: !!s.count, message: s.message || '', offAt: s.offAt || 0, routes: s.routes || [], tz: s.tz || '',
  design: s.design || {},
});

// The QR code's look (editor-only; resolvers ignore it). See qr.js.
const designTags = (design) => (isPlain(design) ? [] : [{ name: 'Design', value: JSON.stringify(cleanDesign(design)) }]);

// Full state goes in every record, so the newest record alone describes the link.
// A link with no destination yet is either waiting to be set up (`setup`: scans
// open the setup page) or, without one, turned off so scans show the resolver's
// "turned off" message (codes made before setup pages).
// kind: '' for a web address, 'page' for a PermaPath hosted page, 'contact' for a
// contact card (a hosted page with a vCard), 'event' for an event page (with
// an .ics calendar file), 'locked' for a
// password-protected locked page (editor hint only; resolvers ignore it).
export function linkTags({ destination, setup, name, disabled, kind, seq, design, ...v3 }) {
  const to = destination || setup;
  return [
    ...BASE_TAGS,
    { name: 'Type', value: 'link' },
    ...(to ? [{ name: 'Destination', value: to }] : []),
    { name: 'Seq', value: String(seq) },
    ...(name ? [{ name: 'Name', value: name }] : []),
    ...(disabled || !to ? [{ name: 'Disabled', value: 'true' }] : []),
    ...(kind && destination ? [{ name: 'Kind', value: kind }] : []),
    ...v3Tags(v3),
    ...designTags(design),
  ];
}

// `resolver` hands the link off to a newer resolver page; kept on every later update.
export function updateTags({ linkId, destination, setup, name, disabled, resolver, kind, seq, design, ...v3 }) {
  if (usesV3(v3)) resolver = RESOLVER_TX;
  const to = destination || setup;
  return [
    ...BASE_TAGS,
    { name: 'Type', value: 'update' },
    { name: 'Link', value: linkId },
    ...(to ? [{ name: 'Destination', value: to }] : []),
    { name: 'Seq', value: String(seq) },
    ...(name ? [{ name: 'Name', value: name }] : []),
    ...(disabled || !to ? [{ name: 'Disabled', value: 'true' }] : []),
    ...(resolver ? [{ name: 'Resolver', value: resolver }] : []),
    ...(kind && destination ? [{ name: 'Kind', value: kind }] : []),
    ...v3Tags(v3),
    ...designTags(design),
  ];
}


// The same record often comes back from several search services, and a service
// can return a broken copy (frostor.xyz returns signature "<not-found>" for
// older records). Keep, per ID, the first copy whose signature checks out, so a
// bad copy never hides a good one. Prefers copies that carry a confirmation time.
async function validCopies(nodes) {
  const byId = new Map();
  for (const n of nodes) byId.set(n.id, [...(byId.get(n.id) || []), n]);
  const picked = await Promise.all([...byId.values()].map(async (copies) => {
    copies.sort((a, b) => (b.confirmedAt ? 1 : 0) - (a.confirmedAt ? 1 : 0));
    for (const n of copies) if (await verifyNode(n)) return n;
    return null;
  }));
  return picked.filter(Boolean);
}

const usable = (tags, type) => tags['App-Name'] === APP_NAME && tags['App-Version'] === APP_VERSION
  && tags.Type === type && /^\d{1,16}$/.test(tags.Seq || '');

const toState = (id, created, tags) => ({
  id,
  created,
  seq: Number(tags.Seq),
  destination: isSetupUrl(tags.Destination) ? '' : tags.Destination || '',
  setup: isSetupUrl(tags.Destination) ? tags.Destination : '',
  name: tags.Name || '',
  disabled: tags.Disabled === 'true',
  resolver: tags.Resolver || '',
  kind: ['page', 'locked', 'contact', 'event'].includes(tags.Kind) && !isSetupUrl(tags.Destination) ? tags.Kind : '',
  count: tags.Count === 'true',
  message: tags.Message || '',
  offAt: /^\d{1,16}$/.test(tags['Off-At'] || '') ? Number(tags['Off-At']) : 0,
  routes: parseRoutes(tags.Routes),
  tz: tags['Time-Zone'] || '',
  design: parseDesign(tags.Design),
});

function parseDesign(text) {
  try { return cleanDesign(JSON.parse(text || '{}')); } catch { return {}; }
}

function parseRoutes(text) {
  try {
    const r = JSON.parse(text || '[]');
    return Array.isArray(r) ? r.filter((x) => x && typeof x === 'object' && typeof x.to === 'string') : [];
  } catch {
    return [];
  }
}

// Off right now: turned off, or past its Off-At time.
export const isOffNow = (s, now = Date.now()) => s.disabled || (!!s.offAt && now >= s.offAt);

// nodes: [{id, owner, tags}] already filtered to one owner. Returns links, newest first.
export function buildLinks(nodes) {
  const links = new Map();
  for (const n of nodes) {
    if (!usable(n.tags, 'link')) continue;
    links.set(n.id, toState(n.id, Number(n.tags.Seq), n.tags));
  }
  for (const n of nodes) {
    if (!usable(n.tags, 'update')) continue;
    const link = links.get(n.tags.Link);
    if (link && Number(n.tags.Seq) > link.seq) links.set(link.id, toState(link.id, link.created, n.tags));
  }
  return [...links.values()].sort((a, b) => b.created - a.created);
}

// Fetches every link and update owned by `key` from all endpoints, keeps only
// records whose signature checks out against the key, and merges them.
export async function fetchLinks(key, endpoints = GRAPHQL_ENDPOINTS) {
  const { owners, ownerKey } = key;
  const results = await Promise.allSettled(endpoints.map(async (endpoint) => {
    const genesis = await gqlAll(endpoint, {
      params: '$owners: [String!], $app: [String!]!',
      args: 'owners: $owners, tags: [{ name: "App-Name", values: $app }, { name: "Type", values: ["link"] }]',
    }, { owners, app: [APP_NAME] });
    const ids = genesis.map((n) => n.id);
    const updates = [];
    for (let i = 0; i < ids.length; i += 50) {
      updates.push(...await gqlAll(endpoint, {
        params: '$owners: [String!], $app: [String!]!, $links: [String!]!',
        args: 'owners: $owners, tags: [{ name: "App-Name", values: $app }, { name: "Type", values: ["update"] }, { name: "Link", values: $links }]',
      }, { owners, app: [APP_NAME], links: ids.slice(i, i + 50) }));
    }
    return [...genesis, ...updates];
  }));
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw new Error('Couldn’t reach the Arweave network. Try again in a moment.');
  return buildLinks(await validCopies(ok.flatMap((r) => r.value).filter((n) => n.ownerKey === ownerKey)));
}

// pending: local writes not yet seen in GraphQL, as link states with `postedAt`.
// Returns links with `pending` attached where a newer local write exists, plus
// the pending entries that are still outstanding.
export function overlayPending(links, pending) {
  const byId = new Map(links.map((l) => [l.id, { ...l }]));
  const outstanding = [];
  for (const p of pending) {
    const live = byId.get(p.id);
    if (live && live.seq >= p.seq) continue; // indexed — drop it
    outstanding.push(p);
    if (live) live.pending = p;
    else byId.set(p.id, { ...p, unindexed: true, pending: p });
  }
  return {
    links: [...byId.values()].sort((a, b) => b.created - a.created),
    outstanding,
  };
}

// A link waiting for setup can be turned off like any other; older "not set up"
// links (no setup page) are off until they get a destination.
export const linkStatus = (state) => (!state.destination && !state.setup ? 'not set up'
  : isOffNow(state) ? 'off' : !state.destination ? 'not set up' : 'live');

// CSV for spreadsheets and label tools (e.g. Avery's QR-from-spreadsheet import).
// qr_url is what each QR code should encode.
export function linksToCsv(links, linkUrl) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // don't let spreadsheets run it as a formula
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [['name', 'qr_url', 'link_id', 'destination', 'status', 'created']];
  for (const link of links) {
    rows.push([link.name, linkUrl(link.id), link.id, link.destination, linkStatus(link), new Date(link.created).toISOString()]);
  }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// One link's verified state and full change history, from all endpoints.
// Returns null if no endpoint knows a valid PermaPath link with this ID.
// history: newest first, each { id, seq, destination, name, disabled, resolver, confirmedAt }.
// Whether a scan would find this link yet: the resolver starts by looking the
// link up by ID, and a search service can answer the editor's search by owner
// before it answers that (seen 2026-10-06: "Live" in the editor, "Link not
// found" when scanned). True once any service returns a valid copy by ID.
export async function findableById(linkId, endpoints = GRAPHQL_ENDPOINTS) {
  const results = await Promise.allSettled(endpoints.map((endpoint) =>
    gqlAll(endpoint, { params: '$ids: [ID!]', args: 'ids: $ids' }, { ids: [linkId] })));
  const copies = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).filter((n) => n.id === linkId);
  return (await validCopies(copies)).length > 0;
}

export async function fetchLinkHistory(linkId, endpoints = GRAPHQL_ENDPOINTS) {
  const results = await Promise.allSettled(endpoints.map(async (endpoint) => {
    const [genesis] = await gqlAll(endpoint, { params: '$ids: [ID!]', args: 'ids: $ids' }, { ids: [linkId] });
    if (!genesis || !usable(genesis.tags, 'link')) return [];
    const updates = await gqlAll(endpoint, {
      params: '$owners: [String!], $app: [String!]!, $links: [String!]!',
      args: 'owners: $owners, tags: [{ name: "App-Name", values: $app }, { name: "Type", values: ["update"] }, { name: "Link", values: $links }]',
    }, { owners: [genesis.owner], app: [APP_NAME], links: [linkId] });
    return [genesis, ...updates];
  }));
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw new Error('Couldn’t reach the Arweave network. Try again in a moment.');
  const all = ok.flatMap((r) => r.value);
  const [genesis] = await validCopies(all.filter((n) => n.id === linkId));
  if (!genesis) return null;
  const updates = await validCopies(all.filter((n) => n.id !== linkId && n.ownerKey === genesis.ownerKey
    && n.tags.Link === linkId && usable(n.tags, 'update')));
  const records = [genesis, ...updates];
  const history = records.map((n) => ({ ...toState(n.id, Number(n.tags.Seq), n.tags), confirmedAt: n.confirmedAt }))
    .sort((a, b) => b.seq - a.seq);
  return {
    id: linkId,
    owner: genesis.owner,
    ownerKey: genesis.ownerKey,
    created: Number(genesis.tags.Seq),
    current: { ...history[0], id: linkId, created: Number(genesis.tags.Seq) },
    history,
  };
}

// ---------- CSV import ----------

export const IMPORT_MAX = 100;

// RFC 4180-ish: quoted fields, "" escapes, CRLF/LF. Tolerates a BOM and the
// ``` fences chat assistants put around CSV.
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => !/^\s*```/.test(l)).join('\n');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell.trim() === '') { cell = ''; quoted = true; }
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some((v) => v !== ''));
}

// Undo the formula guard linksToCsv adds ("'=...").
const unguard = (v) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

// Plans an import against the user's current links (states keyed by id).
// Columns (header row, any order, case-insensitive): name, destination, link_id.
// Without link_id a row creates a link (no destination = "not set up"); with
// one it updates that link. Empty cells in update rows mean "keep as is".
export function planImport(text, links) {
  const rows = parseCsv(text);
  if (!rows.length) return { error: 'Paste CSV with a header row, like: name,destination', rows: [] };
  const header = rows[0].map((h) => h.toLowerCase().replace(/[\s-]+/g, '_'));
  const col = (name) => header.indexOf(name);
  const iName = col('name'), iDest = col('destination'), iId = col('link_id');
  if (iDest < 0 && iId < 0) return { error: 'The header row needs a "destination" column (and optionally "name" and "link_id").', rows: [] };
  const byId = new Map(links.map((l) => [l.id, l]));
  const seen = new Set();
  const plan = rows.slice(1).map((r, n) => {
    const line = n + 2;
    const name = iName >= 0 ? unguard(r[iName] || '') : '';
    const rawDest = iDest >= 0 ? (r[iDest] || '') : '';
    const linkId = iId >= 0 ? (r[iId] || '') : '';
    let destination = '';
    if (rawDest) {
      try {
        destination = normalizeDestination(rawDest);
      } catch (err) {
        return { line, action: 'error', name, linkId, message: `${rawDest}: ${err.message}` };
      }
    }
    if (name.length > 100) return { line, action: 'error', name: name.slice(0, 40) + '…', message: 'Name is longer than 100 characters.' };
    if (!linkId) return { line, action: 'create', name, destination };
    if (seen.has(linkId)) return { line, action: 'error', name, linkId, message: 'This link appears more than once.' };
    seen.add(linkId);
    const link = byId.get(linkId);
    if (!link) return { line, action: 'error', name, linkId, message: 'Not one of your links (or not loaded yet).' };
    const current = link.pending || link;
    const changes = {};
    if (destination && destination !== current.destination) {
      changes.destination = destination;
      changes.kind = ''; // a web address replaces a hosted page
      if (!current.destination) changes.disabled = false; // first destination turns it on
    }
    if (name && name !== current.name) changes.name = name;
    if (!Object.keys(changes).length) return { line, action: 'skip', name: name || current.name, linkId, message: 'No changes.' };
    return { line, action: 'update', name: changes.name ?? current.name, destination: changes.destination ?? current.destination, linkId, changes };
  });
  const count = (a) => plan.filter((p) => p.action === a).length;
  const actionable = count('create') + count('update');
  return {
    rows: plan,
    creates: count('create'),
    updates: count('update'),
    skips: count('skip'),
    errors: count('error'),
    error: actionable > IMPORT_MAX ? `That’s ${actionable} links; import up to ${IMPORT_MAX} at a time.` : null,
  };
}

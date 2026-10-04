// PermaPath link protocol: building records, reading state back from GraphQL,
// and overlaying local not-yet-indexed writes. No DOM here.
import { APP_NAME, GRAPHQL_ENDPOINTS, gqlAll, verifyNode } from './arweave.js';

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

// Full state goes in every record, so the newest record alone describes the link.
// A link with no destination yet ("not set up", e.g. pre-printed batches) is
// created turned off, so scans show the resolver's "turned off" message.
// kind: '' for a web address, 'page' for a PermaPath hosted page, 'locked' for a
// password-protected locked page (editor hint only; resolvers ignore it).
export function linkTags({ destination, name, disabled, kind, seq }) {
  return [
    ...BASE_TAGS,
    { name: 'Type', value: 'link' },
    ...(destination ? [{ name: 'Destination', value: destination }] : []),
    { name: 'Seq', value: String(seq) },
    ...(name ? [{ name: 'Name', value: name }] : []),
    ...(disabled || !destination ? [{ name: 'Disabled', value: 'true' }] : []),
    ...(kind && destination ? [{ name: 'Kind', value: kind }] : []),
  ];
}

// `resolver` hands the link off to a newer resolver page; kept on every later update.
export function updateTags({ linkId, destination, name, disabled, resolver, kind, seq }) {
  return [
    ...BASE_TAGS,
    { name: 'Type', value: 'update' },
    { name: 'Link', value: linkId },
    ...(destination ? [{ name: 'Destination', value: destination }] : []),
    { name: 'Seq', value: String(seq) },
    ...(name ? [{ name: 'Name', value: name }] : []),
    ...(disabled || !destination ? [{ name: 'Disabled', value: 'true' }] : []),
    ...(resolver ? [{ name: 'Resolver', value: resolver }] : []),
    ...(kind && destination ? [{ name: 'Kind', value: kind }] : []),
  ];
}


const usable = (tags, type) => tags['App-Name'] === APP_NAME && tags['App-Version'] === APP_VERSION
  && tags.Type === type && /^\d{1,16}$/.test(tags.Seq || '');

const toState = (id, created, tags) => ({
  id,
  created,
  seq: Number(tags.Seq),
  destination: tags.Destination || '',
  name: tags.Name || '',
  disabled: tags.Disabled === 'true',
  resolver: tags.Resolver || '',
  kind: tags.Kind === 'page' || tags.Kind === 'locked' ? tags.Kind : '',
});

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
  const byId = new Map();
  for (const r of ok) for (const n of r.value) if (n.ownerKey === ownerKey) byId.set(n.id, n);
  const nodes = [...byId.values()];
  const valid = await Promise.all(nodes.map((n) => verifyNode(n)));
  return buildLinks(nodes.filter((_, i) => valid[i]));
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

export const linkStatus = (state) => (!state.destination ? 'not set up' : state.disabled ? 'off' : 'live');

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
  const byId = new Map();
  for (const r of ok) for (const n of r.value) if (!byId.has(n.id) || n.confirmedAt) byId.set(n.id, n);
  const genesis = byId.get(linkId);
  if (!genesis || !(await verifyNode(genesis))) return null;
  const updates = [...byId.values()].filter((n) => n.id !== linkId && n.ownerKey === genesis.ownerKey
    && n.tags.Link === linkId && usable(n.tags, 'update'));
  const valid = await Promise.all(updates.map((n) => verifyNode(n)));
  const records = [genesis, ...updates.filter((_, i) => valid[i])];
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

// Usage stats from public data: every PermaPath link and change on Arweave,
// plus the Worker's scan totals. Prints a plain-text report.
//   node scripts/stats.mjs            # report
//   node scripts/stats.mjs --json     # numbers only
// Test keys are left out: the test suites point links at example.com and
// example.org, so any key that ever did is treated as a test key, and
// everything it made (pages, batches, edits) is excluded.
import { gqlAll } from '../editor/arweave.js';

const ENDPOINTS = ['https://arweave-search.goldsky.com/graphql', 'https://arweave.net/graphql'];
const DAY = 864e5;

async function allRecords(type) {
  const byId = new Map();
  for (const endpoint of ENDPOINTS) {
    try {
      const nodes = await gqlAll(endpoint, {
        params: '$app: [String!]!, $type: [String!]!',
        args: 'tags: [{ name: "App-Name", values: $app }, { name: "App-Version", values: ["1"] }, { name: "Type", values: $type }]',
      }, { app: ['PermaPath'], type: [type] }, 500);
      for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
    } catch { /* the other endpoint may still answer */ }
  }
  return [...byId.values()];
}

const isTest = (tags) => /^https?:\/\/(www\.)?example\.(com|org)\b/.test(tags.Destination || '')
  || /^(resolver test|PermaPath print test)$/.test(tags.Name || '');

export function summarize({ links, updates, scans, now = Date.now() }) {
  const testKeys = new Set([...links, ...updates].filter((n) => isTest(n.tags)).map((n) => n.ownerKey));
  const real = links.filter((n) => !testKeys.has(n.ownerKey));
  const realUpdates = updates.filter((n) => !testKeys.has(n.ownerKey));
  const tests = { links: links.length - real.length, keys: testKeys.size };
  const at = (n) => Number(n.tags.Seq) || 0;
  const within = (list, days) => list.filter((n) => now - at(n) < days * DAY).length;
  const owners = (list) => new Set(list.map((n) => n.ownerKey)).size;
  const kinds = {};
  for (const n of real) kinds[n.tags.Kind || 'web address'] = (kinds[n.tags.Kind || 'web address'] || 0) + 1;
  const recent = [...real, ...realUpdates].filter((n) => now - at(n) < 30 * DAY);
  return {
    links: { total: real.length, last7: within(real, 7), last30: within(real, 30) },
    tests,
    changes: { total: realUpdates.length, last7: within(realUpdates, 7), last30: within(realUpdates, 30) },
    keys: { total: owners(real), active30: owners(recent) },
    kinds,
    countingScans: real.filter((n) => n.tags.Count === 'true').length,
    scans: scans && {
      total: scans.scans,
      linksScanned: scans.links,
      last7: scans.days.filter((d) => now - Date.parse(`${d.day}T00:00:00Z`) < 7 * DAY).reduce((a, d) => a + d.scans, 0),
    },
  };
}

export function report(s, now = new Date()) {
  const lines = [
    `PermaPath stats, ${now.toISOString().slice(0, 10)}`,
    '',
    `Links created:   ${s.links.total} total · ${s.links.last7} this week · ${s.links.last30} in 30 days`,
    `Changes:         ${s.changes.total} total · ${s.changes.last7} this week · ${s.changes.last30} in 30 days`,
    `Keys:            ${s.keys.total} have made links · ${s.keys.active30} active in 30 days`,
    `Kinds:           ${Object.entries(s.kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none yet'}`,
    `Counting scans:  ${s.countingScans} links`,
    s.scans ? `Scans:           ${s.scans.total} total · ${s.scans.last7} this week · ${s.scans.linksScanned} links scanned` : 'Scans:           (couldn’t reach permapath.link)',
    '',
    `Not counted above: ${s.tests.links} links from ${s.tests.keys} test keys (any key that pointed a link at example.com/.org).`,
    'Some early development keys that never used example.com may still be counted.',
    'Links that were created and then edited count once as a link; edits count as changes.',
    'Site visits aren’t tracked here; see Cloudflare’s dashboard for permapath.link traffic.',
  ];
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [links, updates, scans] = await Promise.all([
    allRecords('link'),
    allRecords('update'),
    fetch('https://permapath.link/api/scans/summary', { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()).catch(() => null),
  ]);
  const s = summarize({ links, updates, scans });
  console.log(process.argv.includes('--json') ? JSON.stringify(s, null, 2) : report(s));
}

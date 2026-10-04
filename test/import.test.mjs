import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, planImport, linksToCsv, IMPORT_MAX } from '../editor/links.js';

test('parseCsv handles quotes, CRLF, BOM, blank lines and chat code fences', () => {
  const text = '﻿```csv\r\nname,destination\r\n"Menu, lunch","https://a.example/?x=1,2"\r\n\r\n"Say ""hi""",b.example\r\n```\r\n';
  assert.deepEqual(parseCsv(text), [['name', 'destination'], ['Menu, lunch', 'https://a.example/?x=1,2'], ['Say "hi"', 'b.example']]);
});

test('planImport creates, updates, skips and flags errors', () => {
  const links = [
    { id: 'L1', name: 'Bike', destination: 'https://old.example/', disabled: false, created: 1, seq: 1 },
    { id: 'L2', name: 'Sticker 1', destination: '', disabled: true, created: 2, seq: 2 },
    { id: 'L3', name: 'Same', destination: 'https://same.example/', disabled: false, created: 3, seq: 3 },
  ];
  const csv = [
    'Name,Destination,Link ID',
    'New one,new.example/page,',
    'Blank,,',
    ',https://new.example/bike,L1',
    'Sticker 1,https://set.example/,L2',
    'Same,https://same.example/,L3',
    'x,javascript:alert(1),',
    'y,https://a.example/,NOPE',
    'z,https://b.example/,L1',
  ].join('\n');
  const plan = planImport(csv, links);
  assert.deepEqual(plan.rows.map((r) => r.action), ['create', 'create', 'update', 'update', 'skip', 'error', 'error', 'error']);
  assert.equal(plan.rows[0].destination, 'https://new.example/page');
  assert.equal(plan.rows[1].destination, '');
  assert.deepEqual(plan.rows[2].changes, { destination: 'https://new.example/bike', kind: '' });
  assert.deepEqual(plan.rows[3].changes, { destination: 'https://set.example/', kind: '', disabled: false });
  assert.match(plan.rows[7].message, /more than once/);
  assert.deepEqual([plan.creates, plan.updates, plan.skips, plan.errors, plan.error], [2, 2, 1, 3, null]);
});

test('an exported CSV re-imports with no changes, and formula guards are undone', () => {
  const links = [{ id: 'L1', name: '=SUM(1)', destination: 'https://a.example/', disabled: false, created: 0, seq: 1 }];
  const plan = planImport(linksToCsv(links, (id) => `https://r.example/?l=${id}`), links);
  assert.deepEqual(plan.rows.map((r) => r.action), ['skip']);
});

test('planImport rejects missing headers and too many rows', () => {
  assert.match(planImport('foo,bar\n1,2', []).error, /destination/);
  assert.match(planImport('', []).error, /header row/);
  const many = ['destination', ...Array.from({ length: IMPORT_MAX + 1 }, (_, i) => `https://e.example/${i}`)].join('\n');
  assert.match(planImport(many, []).error, /up to 100/);
});

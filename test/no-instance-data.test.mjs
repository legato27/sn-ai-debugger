import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// The extension is checked against real instances during development. Nothing from them (host names,
// record sys_ids) may end up in the code that ships: every query is built from the record being traced.
const root = new URL('../', import.meta.url);
const shipped = ['background.js', 'sidepanel.js', 'sidepanel.html', 'manifest.json',
  ...readdirSync(new URL('lib/', root)).filter(f => f.endsWith('.js')).map(f => `lib/${f}`)];
const read = f => readFileSync(new URL(f, root), 'utf8');

test('shipped code names no specific instance host', () => {
  for (const f of shipped) {
    // Wildcard patterns (*.service-now.com) and regexes are fine; a concrete host label is not.
    const hosts = [...read(f).matchAll(/\b[a-z0-9][a-z0-9-]*\.(?:service-now|servicenowservices)\.com\b/gi)].map(m => m[0]);
    assert.deepEqual(hosts, [], `${f} names ${hosts.join(', ')}`);
  }
});

test('shipped code holds no record sys_id', () => {
  for (const f of shipped) {
    // The only allowed literal is the all-zero ID used to probe whether a table exists.
    const ids = [...read(f).matchAll(/\b[0-9a-f]{32}\b/gi)].map(m => m[0]).filter(id => !/^0+$/.test(id));
    assert.deepEqual(ids, [], `${f} contains ${ids.join(', ')}`);
  }
});

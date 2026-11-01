import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, IDS } from './mock-instance.mjs';
import { makeHttpClient } from '../lib/sn-client.js';
import { Collector, parseRelease } from '../lib/collectors.js';
import { runRules } from '../lib/rules.js';
import { compactEvidence } from '../lib/claude.js';

let mock, client;
const NOW = '2026-10-29T06:00:00Z';
before(async () => { mock = await startMock({ port: 0 }); client = () => makeHttpClient(`http://127.0.0.1:${mock.port}`, { token: mock.token, user: { userID: IDS.me, userName: 'alex.admin' } }); });
after(() => mock.server.close());
const ids = r => r.findings.map(f => f.id);

test('release detection from the build tag', () => {
  assert.deepEqual(parseRelease('glide-brazil-12-04-2026__patch5-hotfix1'), { family: 'brazil', patch: 5, rank: 5 });
  assert.equal(parseRelease('glide-australia-08-2026__patch3').family, 'australia');
  assert.equal(parseRelease('').family, null);
});

test('plan trace reads the release and Brazil deny-by-default ACL coverage', async () => {
  const ev = await new Collector(client()).trace(IDS.plan);
  assert.equal(ev.platform.family, 'brazil');
  assert.equal(ev.platform.patch, 5);
  assert.equal(ev.platform.props['sn_aia.kill_switch.mode'], 'enforce');
  const rca = runRules(ev, { now: NOW });
  const gaps = rca.findings.filter(f => f.id === 'AI-ACL-MISSING');
  assert.ok(gaps.some(f => /gen_ai_workflow ACL for workflow "Travel Assessment"/.test(f.title)), gaps.map(f => f.title).join(' | '));
  assert.ok(gaps.some(f => /flow ACL for flow "Travel - Evaluate Policy"/.test(f.title)));
  assert.ok(!gaps.some(f => /agent "Travel Policy Advisor"/.test(f.title)), 'agent has its own gen_ai_agent ACL');
  assert.ok(gaps.every(f => f.severity === 'High'), 'Brazil instance → High');
  assert.equal(rca.rootCause.id, 'TOOL-INPUT-CASE', 'the real cause still wins');
  assert.ok(!ids(rca).includes('RELEASE-UNKNOWN'));
  assert.equal(compactEvidence(ev, rca).data.platform.family, 'brazil');
});

test('agent without its own ACL behind a "Never" wildcard, plus a runaway trigger', async () => {
  const ev = await new Collector(client()).trace(IDS.agent2);
  const rca = runRules(ev, { now: NOW });
  const gap = rca.findings.find(f => f.id === 'AI-ACL-MISSING' && /Mobility Advisor/.test(f.title));
  assert.ok(gap);
  assert.match(gap.detail, /Security Attribute "Never"/);
  const run = rca.findings.find(f => f.id === 'RUNAWAY-TRIGGER');
  assert.ok(run, ids(rca).join(','));
  assert.match(run.title, /6 times/);
  assert.match(run.detail, /Kill switch mode: enforce/);
});

test('workflow trace flags a trigger disabled while the kill switch enforces', async () => {
  const ev = await new Collector(client()).trace(IDS.wf);
  const rca = runRules(ev, { now: NOW });
  assert.ok(ids(rca).includes('TRIGGER-DISABLED'), ids(rca).join(','));
});

test('unreadable release lowers severity and says so', async () => {
  const ev = await new Collector(client()).trace(IDS.plan);
  ev.platform = { family: null, rank: -1, readable: false, props: {} };
  const rca = runRules(ev, { now: NOW });
  assert.ok(ids(rca).includes('RELEASE-UNKNOWN'));
  assert.ok(rca.findings.filter(f => f.id === 'AI-ACL-MISSING').every(f => f.severity === 'Medium'));
});

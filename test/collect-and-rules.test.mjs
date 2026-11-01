import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, IDS } from './mock-instance.mjs';
import { makeHttpClient } from '../lib/sn-client.js';
import { Collector, parseSnUrl } from '../lib/collectors.js';
import { runRules } from '../lib/rules.js';
import { redactEvidence, redactText } from '../lib/redact.js';
import { toMarkdown } from '../lib/report.js';

let mock, client;
const NOW = '2026-10-29T03:00:00Z';
const user = { userID: IDS.me, userName: 'alex.admin', fullName: 'Alex Admin' };

before(async () => {
  mock = await startMock({ port: 0 });
  client = () => makeHttpClient(`http://127.0.0.1:${mock.port}`, { token: mock.token, user });
});
after(() => mock.server.close());

const ids = f => f.findings.map(x => x.id);

test('read-only allowlist blocks non-table paths', async () => {
  const r = await client().get('/api/now/import/sys_user', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /allowlist/);
});

test('URL parsing: classic, Next Experience, workspace', () => {
  assert.deepEqual(parseSnUrl(`https://x.service-now.com/sn_aia_agent.do?sys_id=${IDS.agent}`), { table: 'sn_aia_agent', sysId: IDS.agent });
  assert.deepEqual(parseSnUrl(`https://x.service-now.com/now/nav/ui/classic/params/target/sn_aia_agent.do%3Fsys_id%3D${IDS.agent}`), { table: 'sn_aia_agent', sysId: IDS.agent });
  assert.deepEqual(parseSnUrl(`https://x.service-now.com/now/workspace/record/sn_aia_tool/${IDS.tool1}`), { table: 'sn_aia_tool', sysId: IDS.tool1 });
});

test('trace an execution plan by sys_id: finds the real root cause', async () => {
  const col = new Collector(client(), { windowMinutes: 2 });
  const ev = await col.trace(IDS.plan);
  assert.equal(ev.root.kind, 'plan');
  // Children discovered from the dictionary, not hard-coded
  assert.equal(ev.norm.tasks.length, 1);
  assert.equal(ev.norm.messages.length, 2);
  assert.equal(ev.norm.toolExecs.length, 2);
  assert.equal(ev.norm.agents.length, 1);
  assert.equal(ev.norm.agents[0].tools.length, 2);
  assert.equal(ev.norm.agents[0].runAs.name, 'Travel AI User');
  assert.deepEqual(ev.norm.agents[0].acls[0].roles, ['x_demo_travel.reader']);
  // Window filter excluded the 05:00 syslog row
  assert.equal(ev.norm.syslog.length, 2);
  assert.ok(ev.user.isAdmin);

  const rca = runRules(ev, { now: NOW });
  const got = ids(rca);
  for (const want of ['PLAN-FAIL', 'TASK-FAIL', 'TOOL-ERR', 'TOOL-INPUT-CASE', 'TOOL-EMPTY', 'ACL-ROLEGAP', 'SYSLOG-ACL', 'SYSLOG-TOOL', 'HTTP-ERR', 'FLOW-ERR', 'PLUGIN-INACTIVE', 'ADMIN', 'SUPERVISED-UNATTENDED', 'INSTR-UNBOUND'])
    assert.ok(got.includes(want), `expected ${want}, got ${got.join(', ')}`);
  assert.equal(rca.rootCause.id, 'TOOL-INPUT-CASE');
  assert.match(rca.rootCause.title, /employeeid.*employeeId/);
  assert.equal(rca.findings[0].severity, 'Critical');
  assert.ok(rca.alsoLikely.some(f => f.id === 'TOOL-ERR'), 'independent tool failure should be listed as also likely');
  console.log('  plan findings:', got.join(', '), '| root cause:', rca.rootCause.id, '| api calls:', ev.meta.apiCalls);
});

test('trace a child record walks up to its plan', async () => {
  const ev = await new Collector(client()).trace(IDS.exec2);
  assert.equal(ev.root.kind, 'toolExec');
  assert.equal(ev.norm.plan.id, IDS.plan);
  const ev2 = await new Collector(client()).trace(`https://mock.service-now.com/sn_aia_execution_task.do?sys_id=${IDS.task1}`);
  assert.equal(ev2.root.kind, 'task');
  assert.equal(ev2.norm.plan.id, IDS.plan);
});

test('trace an agent: config, tools, ACLs, recent plans, description overlap', async () => {
  const ev = await new Collector(client()).trace(IDS.agent);
  assert.equal(ev.root.kind, 'agent');
  assert.equal(ev.recentPlans.length, 1);
  const rca = runRules(ev, { now: NOW });
  const got = ids(rca);
  assert.ok(got.includes('DESC-OVERLAP'), got.join(','));
  assert.ok(got.includes('ACL-ROLEGAP'));
  assert.ok(got.includes('INSTR-UNBOUND'));
  const unbound = rca.findings.find(f => f.id === 'INSTR-UNBOUND');
  assert.match(unbound.detail, /Create HR Case/);
  assert.doesNotMatch(unbound.detail, /Get Employee Profile/);
});

test('trace a skill: links Gen AI logs and recognises the resolveModelConfig pattern', async () => {
  const ev = await new Collector(client()).trace(IDS.skill);
  assert.equal(ev.root.kind, 'skill');
  assert.equal(ev.norm.genaiLogs.length, 1);
  const rca = runRules(ev, { now: NOW });
  const g = rca.findings.find(f => f.id === 'GENAI-ERR');
  assert.ok(g);
  assert.match(g.fix, /plugin versions/);
});

test('search by name returns candidates', async () => {
  const ev = await new Collector(client()).trace('Travel');
  const kinds = ev.candidates.map(c => c.kind).sort();
  assert.ok(kinds.includes('agent') && kinds.includes('workflow'), kinds.join(','));
});

test('workflow trace pulls team agents and recent plans', async () => {
  const ev = await new Collector(client()).trace(IDS.wf);
  assert.equal(ev.root.kind, 'workflow');
  assert.equal(ev.norm.agents.length, 1);
  assert.equal(ev.recentPlans.length, 1);
});

test('unknown sys_id produces a warning, not a crash', async () => {
  const ev = await new Collector(client()).trace('f'.repeat(32));
  assert.ok(ev.warnings.some(w => /not found/.test(w)));
});

test('redaction masks PII and drops bodies by default', async () => {
  assert.equal(redactText('mail jane.tan@example.com nric S1234567D'), 'mail [EMAIL] nric [NRIC]');
  const ev = await new Collector(client()).trace(IDS.skill);
  const red = redactEvidence(ev);
  const s = JSON.stringify(red);
  assert.ok(!s.includes('jane.tan@example.com'));
  assert.ok(s.includes('chars omitted'));
  const withBodies = JSON.stringify(redactEvidence(ev, { includeBodies: true }));
  assert.ok(withBodies.includes('[EMAIL]') && !withBodies.includes('jane.tan@'));
  const md = toMarkdown(red, runRules(red, { now: NOW }));
  assert.match(md, /Most likely root cause/);
  assert.ok(!md.includes('jane.tan@example.com'));
});

test('a 401 without the session token gives a clear error', async () => {
  const bad = makeHttpClient(`http://127.0.0.1:${mock.port}`, { token: 'wrong', user });
  await assert.rejects(new Collector(bad).trace(IDS.plan), /rejected the session \(401\)/);
});

test('conversation timeline merges VA transcript, agent messages, tools, LLM calls and errors', async () => {
  const ev = await new Collector(client()).trace(IDS.plan);
  assert.equal(ev.norm.conversation.id, IDS.conv);
  assert.equal(ev.norm.vaMessages.length, 6);
  const kinds = ev.timeline.map(e => e.kind);
  for (const k of ['va-user', 'va-bot', 'agent-msg', 'task', 'tool', 'llm', 'error']) assert.ok(kinds.includes(k), `missing ${k}`);
  assert.equal(ev.timeline[0].kind, 'va-user');
  assert.equal(ev.timeline[0].content, 'Can EMP0001 travel to Atlantis?');
  const sorted = ev.timeline.map(e => e.t).every((t, i, a) => i === 0 || a[i - 1] <= t);
  assert.ok(sorted, 'timeline is in time order');
  const card = ev.timeline.find(e => e.ref?.id === IDS.vm6);
  assert.match(card.content, /Something went wrong · Talk to a live agent/);
  assert.equal(card.ref.table, 'sys_cs_message');
  const rca = runRules(ev, { now: NOW });
  assert.ok(rca.findings.some(f => f.id === 'VA-FAULT'));
  assert.ok(rca.findings.some(f => f.id === 'VA-REASK'));
  assert.equal(rca.rootCause.id, 'TOOL-INPUT-CASE');
  // Exports: text omitted by default, redacted when included
  const red = redactEvidence(ev);
  assert.ok(red.timeline.every(e => !e.content || /chars omitted/.test(e.content)));
  const withBodies = JSON.stringify(redactEvidence(ev, { includeBodies: true }).timeline);
  assert.ok(withBodies.includes('[EMAIL]') && !withBodies.includes('jane.tan@'));
  const md = toMarkdown(red, rca);
  assert.match(md, /## Conversation timeline/);
});

test('tracing the conversation sys_id pulls the transcript and its plan', async () => {
  const ev = await new Collector(client()).trace(IDS.conv);
  assert.equal(ev.root.kind, 'conversation');
  assert.equal(ev.norm.vaMessages.length, 6, 'transcript collected once');
  assert.equal(ev.norm.plan.id, IDS.plan);
});

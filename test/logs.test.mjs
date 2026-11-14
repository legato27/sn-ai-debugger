import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, IDS } from './mock-instance.mjs';
import { makeHttpClient } from '../lib/sn-client.js';
import { Collector } from '../lib/collectors.js';
import { runRules, logLink } from '../lib/rules.js';
import { buildTimeline, summarizeBackground } from '../lib/timeline.js';
import { redactEvidence } from '../lib/redact.js';
import { toMarkdown } from '../lib/report.js';
import { compactEvidence } from '../lib/claude.js';
import { runLogs, filterLogs, countByGroup, logsAsText, levelName, levelGroup, isErrorLevel, recordUrl, logListUrl } from '../lib/logs.js';

let mock, client;
const user = { userID: IDS.me, userName: 'alex.admin', fullName: 'Alex Admin' };
before(async () => {
  mock = await startMock({ port: 0 });
  client = () => makeHttpClient(`http://127.0.0.1:${mock.port}`, { token: mock.token, user });
});
after(() => mock.server.close());

const tracePlan = async () => {
  const ev = await new Collector(client(), { windowMinutes: 2 }).trace(IDS.plan);
  return { ev, rca: runRules(ev, { stuckMinutes: 5 }) };
};

test('level names and groups follow the syslog choices, Fatal counts as an error', () => {
  assert.deepEqual(['3', '2', '1', '0', '-1', '-2'].map(levelName), ['Fatal', 'Error', 'Warning', 'Info', 'Debug', 'Trace']);
  assert.deepEqual(['3', '2', '1', '0', '-1', '-2'].map(levelGroup), ['error', 'error', 'warning', 'info', 'debug', 'debug']);
  assert.ok(isErrorLevel('3') && isErrorLevel(2) && !isErrorLevel('1') && !isErrorLevel('0'));
});

test('a plan trace fetches the run\'s info and debug lines, not other jobs\' ones', async () => {
  const { ev } = await tracePlan();
  assert.deepEqual(ev.norm.runInfo.map(x => x.id).sort(), [IDS.inf1, IDS.inf2].sort(), 'the scheduled job\'s info line is not fetched');
  assert.ok(ev.norm.runInfo.every(x => x.link === 'user'), 'linked through the run-as user\'s session');
  assert.equal(ev.norm.syslog.length, 8, 'warnings and errors unchanged');
  assert.match(ev.meta.runLogQuery, /sys_created_byIN[^^]*travel\.ai\.user/);
  assert.ok(ev.sections.some(s => s.key === 'runInfo' && s.rows.length === 2));
});

test('run logs: every level of the run\'s own lines, oldest first, one row per line', async () => {
  const { ev } = await tracePlan();
  const lines = runLogs(ev.norm);
  assert.deepEqual(lines.map(l => l.id), [IDS.sys2, IDS.inf1, IDS.inf2, IDS.sys4, IDS.sys1]);
  assert.deepEqual(countByGroup(lines), { error: 2, warning: 1, info: 1, debug: 1 });
  assert.ok(!lines.some(l => l.id === IDS.sys5), 'another user\'s denial stays out');
  // Lines without link information (older evidence) are not guessed into the run.
  assert.equal(runLogs({ syslog: [{ id: 'x', level: '2', logText: 'y' }] }).length, 0);
  assert.equal(runLogs({ syslog: [{ id: 'x', link: 'user' }], runInfo: [{ id: 'x', link: 'user' }] }).length, 1);
});

test('run logs filter by level group and by text in message, source or user', async () => {
  const { ev } = await tracePlan();
  const lines = runLogs(ev.norm);
  assert.deepEqual(filterLogs(lines, { groups: new Set(['error']) }).map(l => l.id), [IDS.sys4, IDS.sys1]);
  assert.deepEqual(filterLogs(lines, { text: 'travelpolicyutil' }).map(l => l.id), [IDS.inf1, IDS.inf2, IDS.sys1]);
  assert.deepEqual(filterLogs(lines, { text: 'SN-GAF' }).map(l => l.id), [IDS.sys4]);
  assert.equal(filterLogs(lines, { text: 'travel.ai.user' }).length, lines.length, 'matches the session user');
  assert.equal(filterLogs(lines, { groups: new Set(), text: '' }).length, 0);
});

test('copied logs are plain text with level, source and user, continuation lines indented', async () => {
  const { ev } = await tracePlan();
  const text = logsAsText(runLogs(ev.norm));
  const rows = text.split('\n');
  assert.match(rows[0], /^2026-10-29 02:00:11 Warning sn_aia \[travel\.ai\.user\]: Security restricted/);
  assert.ok(rows.some(r => /^ {4}query: user=travel\.ai\.user$/.test(r)), 'second line of a multi-line message is indented');
  assert.ok(rows.some(r => / Debug +x_demo_travel /.test(r)));
});

test('report and Claude payload carry the run logs', async () => {
  const { ev, rca } = await tracePlan();
  const md = toMarkdown(redactEvidence(ev, { redact: true }), rca, { redact: true });
  assert.match(md, /## Run logs \(5 lines\)/);
  assert.match(md, /TravelPolicyUtil: checking policy for country XX/);
  const c = compactEvidence(ev, rca);
  assert.deepEqual(c.data.runInfoLogs.map(x => x.level).sort(), ['-1', '0']);
});

test('a Fatal line from the run reaches the timeline; one from another job goes to Background', async () => {
  const { ev } = await tracePlan();
  const n = { ...ev.norm, syslog: [...ev.norm.syslog,
    { id: 'f'.repeat(32), created: '2026-10-29 02:00:59', level: '3', source: 'x_demo_travel', logText: 'Fatal: out of memory in TravelPolicyUtil', link: 'user' },
    { id: 'e'.repeat(32), created: '2026-10-29 02:00:59', level: '3', source: 'Discovery', logText: 'Fatal: probe crashed', link: null }] };
  assert.ok(buildTimeline(n).some(e => e.kind === 'error' && /out of memory/.test(e.error)));
  assert.ok(summarizeBackground(n).groups.some(g => /probe crashed/.test(g.text)));
});

test('record links open flow executions in Flow Designer and other records in their form', () => {
  const o = 'https://x.service-now.com';
  assert.equal(recordUrl(o, 'sys_flow_context', IDS.flow1), `${o}/$flow-designer.do?sysparm_nostack=true#/operations/context/${IDS.flow1}`);
  assert.equal(recordUrl(o, 'syslog', IDS.sys1), `${o}/syslog.do?sys_id=${IDS.sys1}`);
  assert.equal(recordUrl(o, 'syslog', ''), null);
});

test('the System Log link reuses the trace\'s filter, all levels, oldest first', async () => {
  const { ev } = await tracePlan();
  const url = new URL(logListUrl('https://x.service-now.com', ev.meta.runLogQuery));
  assert.equal(url.pathname, '/syslog_list.do');
  const q = url.searchParams.get('sysparm_query');
  assert.ok(q.startsWith(ev.meta.runLogQuery) && q.endsWith('^ORDERBYsys_created_on'));
  assert.doesNotMatch(q, /level/, 'no level filter: the list shows every level');
  assert.equal(logListUrl('https://x.service-now.com', null), null);
});

test('a line written as the run\'s user but running as system (async skill work) belongs to the run', () => {
  const ctx = { users: new Set(['travel.ai.user']), ids: new Set(), names: new Set() };
  assert.equal(logLink({ createdBy: 'travel.ai.user', ctxUser: 'system', logText: 'GenAI Preprocess execution' }, ctx), 'user');
  assert.equal(logLink({ createdBy: 'system', ctxUser: 'travel.ai.user', logText: 'x' }, ctx), 'user');
  assert.equal(logLink({ createdBy: 'system', ctxUser: 'system', logText: 'x' }, ctx), null);
});

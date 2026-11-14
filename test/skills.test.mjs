// Skill debugging and the quick wins: skill table from the dictionary, grounded-prompt rules,
// truncation, flow quick mode, Group Action Framework logs, Recent failures, evidence links.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, IDS } from './mock-instance.mjs';
import { makeHttpClient } from '../lib/sn-client.js';
import { Collector } from '../lib/collectors.js';
import { runRules, unfilledPlaceholders, findEmptyGrounding, nonAnswer } from '../lib/rules.js';
import { docTargets, parseSnUrl } from '../lib/collectors.js';
import { toMarkdown, evidenceTable } from '../lib/report.js';
import { redactEvidence, redactText } from '../lib/redact.js';
import { compactEvidence } from '../lib/claude.js';

let mock, client;
const NOW = '2026-10-29T06:00:00Z';
before(async () => {
  mock = await startMock({ port: 0 });
  client = () => makeHttpClient(`http://127.0.0.1:${mock.port}`, { token: mock.token, user: { userID: IDS.me, userName: 'alex.admin' } });
});
after(() => mock.server.close());
const byId = (rca, id) => rca.findings.filter(f => f.id === id);

test('skill table is read from the Gen AI log dictionary, not guessed', async () => {
  const ev = await new Collector(client()).trace(IDS.skill);
  assert.equal(ev.meta.tables.skill, 'x_mock_ai_skill');
  assert.equal(ev.root.kind, 'skill');
  assert.equal(ev.root.table, 'x_mock_ai_skill');
});

test('skill trace: unfilled variables, truncation and flow quick mode, one finding each', async () => {
  const ev = await new Collector(client()).trace(IDS.skill);
  const rca = runRules(ev, { now: NOW });

  const ph = byId(rca, 'SKILL-PLACEHOLDER');
  assert.equal(ph.length, 1, 'grouped per skill');
  assert.match(ph[0].title, /Article Summarizer Demo.*1 of 4 LLM call/);
  assert.match(ph[0].detail, /\{\{kb_knowledge\.short_description\}\}.*\{\{ArticleFetcher\.output\}\}/);
  assert.deepEqual(ph[0].evidence, [{ table: 'genaiLog', id: IDS.log3 }]);

  const tr = byId(rca, 'SKILL-TRUNCATED');
  assert.equal(tr.length, 1);
  assert.match(tr[0].detail, /400 of 400 max tokens \(prompt config "Article summary prompt v2"\)/);

  assert.equal(byId(rca, 'SKILL-QUICKMODE')[0]?.severity, 'Info');
  // The mock is a Brazil instance with no gen_ai_skill ACL, which already led skill traces;
  // the hard LLM error and the new quality problems are listed to check next.
  assert.equal(rca.rootCause.id, 'AI-ACL-MISSING');
  assert.deepEqual(rca.alsoLikely.map(f => f.id).slice(0, 2), ['GENAI-ERR', 'SKILL-PLACEHOLDER']);
  // Timeline shows which model served each call
  assert.ok(ev.timeline.some(e => e.kind === 'llm' && /claude_small/.test(e.who)));
});

test('quick mode is not reported for a plan with no skill involved', async () => {
  const ev = await new Collector(client()).trace(IDS.plan);
  assert.equal(byId(runRules(ev, { now: NOW }), 'SKILL-QUICKMODE').length, 0);
});

test('errors from the run\'s own session are findings (SYSLOG-RUN); background jobs are not', async () => {
  const ev = await new Collector(client()).trace(IDS.plan);
  const run = byId(runRules(ev, { now: NOW }), 'SYSLOG-RUN')[0];
  assert.ok(run, 'SYSLOG-RUN should fire');
  assert.match(run.title, /^1 error in the system log came from this run/);
  assert.match(run.detail, /\[sn-gaf\] Group action failed[\s\S]*Linked by the run's user session/);
  assert.doesNotMatch(run.detail, /Impact Tree Builder|GlideEncrypter/);
});

test('unfilledPlaceholders finds template variables left in the final prompt', () => {
  assert.deepEqual(unfilledPlaceholders('Hi {{ user.name }}, see {{Tool.output}} and {{Tool.output}}'), ['{{ user.name }}', '{{Tool.output}}']);
  assert.deepEqual(unfilledPlaceholders('A JSON example: {"a": {"b": 1}}'), []);
  assert.deepEqual(unfilledPlaceholders(undefined), []);
});

test('findEmptyGrounding: empty labelled fields, not instruction lines', () => {
  const prompt = 'Summarise the knowledge article for a service desk agent.\nTitle: VPN setup for contractors\nDescription:\nResolution notes: []\nFollow these rules:\n- Use plain language\n- Keep it under 80 words';
  assert.deepEqual(findEmptyGrounding(prompt), ['Description', 'Resolution notes']);
  assert.deepEqual(findEmptyGrounding('Title: VPN setup\nBody:\nInstall the client and sign in.'), [], 'value on the next line is not empty');
  assert.deepEqual(findEmptyGrounding('Description:\n\n   The VPN drops every hour.'), [], 'a blank line before the value is fine');
  assert.deepEqual(findEmptyGrounding('Title: VPN\nWork notes:'), ['Work notes'], 'a label at the end of the prompt is empty');
  assert.deepEqual(findEmptyGrounding('Caller: null\nPriority: N/A\nCategory: {}\nGroup: ""\nState: New'), ['Caller', 'Priority', 'Category', 'Group']);
  assert.deepEqual(findEmptyGrounding('Instructions:\nRules:\n- be brief\nOutput format:\nJSON'), [], 'instruction headers are not grounding');
  assert.deepEqual(findEmptyGrounding('Link: https://example.com/kb\nOpened at: 2026-11-13 10:30:00'), [], 'URLs and times have colons too');
  assert.deepEqual(findEmptyGrounding('Title: {{incident.short_description}}'), [], 'unfilled variables are SKILL-PLACEHOLDER, not this rule');
  assert.deepEqual(findEmptyGrounding(''), []);
  // Shapes seen in real skill prompts on a live instance
  assert.deepEqual(findEmptyGrounding('INPUT METADATA:\nname: Close stale tasks\ntable: task\nadv_condition_type: null'), ['adv_condition_type'], 'a section header before filled fields is not empty');
  assert.deepEqual(findEmptyGrounding('Always display all the following fields:\nHR case number:\nOverall outcome:\nFindings and conclusions:\nWrite in plain English.'), [], 'an output template is not missing data');
  const wrapped = JSON.stringify([{ role: 'user', content: 'Title: VPN setup\nDescription:\nResolution notes: []\nSummarise it.' }]);
  assert.deepEqual(findEmptyGrounding(wrapped), ['Description', 'Resolution notes'], 'JSON messages arrays are unwrapped first');
});

test('SKILL-EMPTY-GROUNDING fires on the mock\'s rejected skill call', async () => {
  const rca = runRules(await new Collector(client()).trace(IDS.skill), { now: NOW });
  const f = byId(rca, 'SKILL-EMPTY-GROUNDING');
  assert.equal(f.length, 1);
  assert.match(f[0].title, /Article Summarizer Demo.*1 of 4 LLM calls/);
  assert.match(f[0].detail, /Empty in the final prompt: Description, Resolution notes/);
  assert.deepEqual(f[0].evidence, [{ table: 'genaiLog', id: IDS.log5 }]);
});

test('Recent failures: failed and stuck plans plus failed or rejected LLM calls, newest first', async () => {
  const ev = await new Collector(client(), { stuckMinutes: 5 }).recentFailures({ days: 7, now: new Date(NOW) });
  const got = ev.recentFailures.map(x => [x.kind, x.id, x.count]);
  assert.deepEqual(got, [['plan', IDS.secPlan, 1], ['plan', IDS.stuckPlan, 1], ['plan', IDS.plan, 1], ['genaiLog', IDS.log2, 1], ['genaiLog', IDS.log7, 2], ['genaiLog', IDS.log5, 1]]);
  const [sec, stuck, failed, llmErr, cancelled, rejected] = ev.recentFailures;
  assert.match(sec.reason, /Ended "terminated" · security_violation/, 'terminated counts as failed, with its state reason');
  assert.equal(sec.display, 'Travel Assessment', 'runs are named by their workflow so repeats merge');
  assert.equal(sec.label, 'Agent run');
  assert.equal(stuck.display, 'Summarise open P1 incidents', 'no workflow or agent: the objective');
  assert.match(cancelled.reason, /^\[200000\] HTTP request cancelled$/, 'status "failed" is included, with the error code');
  assert.match(stuck.reason, /Still "in_progress" after 120 min/);
  assert.match(failed.reason, /Ended "error"/);
  assert.match(llmErr.reason, /resolveModelConfig/);
  assert.equal(llmErr.display, 'Article Summarizer Demo');
  assert.equal(rejected.reason, 'The user rejected the response');
  assert.equal(ev.recentPlans.length, 0, 'the failures list replaces the plain run list');
  assert.ok(!ev.recentFailures.some(x => x.id === id140()), 'completed runs are not failures');
});

test('Recent failures: nothing in the window falls back to the latest runs', async () => {
  const ev = await new Collector(client()).recentFailures({ days: 7, now: new Date('2026-12-31T00:00:00Z') });
  assert.equal(ev.recentFailures.length, 0);
  assert.ok(ev.recentPlans.length > 0);
});

test('findings link to their evidence records; the report lists them for the root cause', async () => {
  const ev = await new Collector(client()).trace(IDS.plan);
  const rca = runRules(ev, { now: NOW });
  assert.equal(evidenceTable(ev, 'toolExec'), 'sn_aia_tools_execution');
  assert.equal(evidenceTable(ev, 'acl'), 'sys_security_acl');
  assert.equal(evidenceTable(ev, 'syslog'), 'syslog');
  assert.equal(evidenceTable(ev, 'guard'), null, 'unresolvable keys are dropped, not linked');
  assert.equal(evidenceTable(ev, 'x_mock_guardian_log'), 'x_mock_guardian_log', 'real table names pass through');
  const md = toMarkdown(redactEvidence(ev), rca);
  assert.match(md, new RegExp(`Records: sn_aia_tools_execution / ${IDS.exec1}`));
});

test('Next Experience: only a user ID on the page still gives a user name and roles', async () => {
  const idOnly = makeHttpClient(`http://127.0.0.1:${mock.port}`, { token: mock.token, user: { userID: IDS.me } });
  const ev = await new Collector(idOnly).trace(IDS.plan);
  assert.equal(ev.user.userName, 'alex.admin');
  assert.equal(ev.user.fullName, 'Alex Admin');
  assert.ok(ev.user.isAdmin);
});

test('dictionary references are read when the API returns { link, value } objects', async () => {
  const ev = await new Collector(client()).trace(IDS.exec2);
  assert.equal(ev.norm.plan.id, IDS.plan, 'child → plan uses a forward reference from the dictionary');
  const tool = ev.norm.agents[0].tools.find(t => t.name === 'Evaluate Country Policy');
  assert.deepEqual(tool.deps.map(dp => dp.table).sort(), ['sys_hub_flow', 'sys_script_include']);
});

test('security violation: PLAN-SECURITY leads; the shared workflow team is not pulled in', async () => {
  const ev = await new Collector(client()).trace(IDS.secPlan);
  assert.equal(ev.norm.plan.stateReasonValue, 'security_violation');
  assert.equal(ev.norm.agents.length, 0, 'the run never reached an agent');
  assert.equal(ev.norm.workflow.display, 'Travel Assessment', 'workflow found through the access check task and the plan');
  const rca = runRules(ev, { now: NOW });
  assert.equal(rca.rootCause.id, 'PLAN-SECURITY');
  assert.match(rca.rootCause.detail, /access_verification task on sn_aia_usecase.*Run type: trigger, started by trigger\.runner.*sn_hr_core_case record/);
  assert.deepEqual(rca.rootCause.evidence.map(e => e.table), ['plan', 'task']);
  assert.ok(byId(rca, 'PLAN-FAIL').length, 'terminated is a failed plan');
  assert.equal(byId(rca, 'GENAI-NONE').length, 0, 'no LLM call is expected after a failed access check');
});

test('time-window noise: unrelated flows are one Info line; other users\' denials are ignored', async () => {
  const rca = runRules(await new Collector(client()).trace(IDS.plan), { now: NOW });
  assert.deepEqual(byId(rca, 'FLOW-ERR').map(f => f.title), ['Flow or subflow "Travel - Evaluate Policy" ended in "ERROR ERROR"']);
  const near = byId(rca, 'FLOW-NEARBY')[0];
  assert.equal(near.severity, 'Info');
  assert.match(near.detail, /Failed: "Nightly CMDB sync"/);
  assert.match(byId(rca, 'SYSLOG-ACL')[0].title, /^1 access-denied/);
  assert.equal(rca.rootCause.id, 'TOOL-INPUT-CASE');
});

test('awaiting_input is a chat waiting on the user, not a stuck run', () => {
  const ev = { norm: { plan: { id: 'p', state: 'Awaiting Input', stateValue: 'awaiting_input', created: '2026-10-29 01:00:00', updated: '2026-10-29 01:00:00' }, tasks: [{ id: 't' }] } };
  assert.equal(byId(runRules(ev, { now: NOW }), 'PLAN-STUCK').length, 0);
  ev.norm.plan.stateValue = 'in_progress'; ev.norm.plan.state = 'In progress';
  assert.equal(byId(runRules(ev, { now: NOW }), 'PLAN-STUCK').length, 1);
});

test('docTargets follows document-ID pairs (target_document_table + target_document_id)', () => {
  const row = { target_document_table: { value: 'sn_aia_agent' }, target_document_id: { value: IDS.agent }, related_task_table: 'incident', related_task_record: IDS.plan };
  assert.deepEqual(docTargets(row, 'sn_aia_agent'), [IDS.agent]);
  assert.deepEqual(docTargets(row, 'incident'), [IDS.plan]);
  assert.deepEqual(docTargets(row, 'sn_aia_usecase'), []);
});

// ---- business records: "I clicked Summarize on this record" ----
const wsUrl = `https://x.service-now.com/now/hr/agent/record/x_mock_case/${IDS.erCase}/params/selected-tab-index/4/selected-tab/id%3Drelated_list%5Eindex%3D3/sub/record/x_mock_evidence/${IDS.evid}`;

test('workspace sub-record URL: the record on screen is the last one, the parent is context', () => {
  assert.deepEqual(parseSnUrl(wsUrl), { table: 'x_mock_evidence', sysId: IDS.evid, records: [{ table: 'x_mock_evidence', sysId: IDS.evid }, { table: 'x_mock_case', sysId: IDS.erCase }] });
});

test('record trace: Otto calls on the record, the nested skill call, and agent runs on the parent', async () => {
  const ev = await new Collector(client()).trace(wsUrl);
  assert.equal(ev.root.kind, 'record');
  assert.equal(ev.root.label, 'Record (x_mock_evidence)');
  const ids = ev.recordActivity.map(x => x.id);
  assert.deepEqual(ids.slice().sort(), [IDS.log8, IDS.log9, IDS.log10, IDS.casePlan].sort(), 'other users and other records are left out');
  assert.equal(ev.recordActivity.find(x => x.id === IDS.log10).nested, true);
  assert.equal(ev.recordActivity.find(x => x.id === IDS.log9).detail, 'WWNA: Refine · gpt_large');
  assert.equal(ev.recordActivity.find(x => x.id === IDS.casePlan).on, 'x_mock_case');
  assert.deepEqual(ev.norm.skills.map(x => x.display).sort(), ['Evidence Summarizer', 'Evidence Summarizer Wrapper']);
  assert.ok(ev.timeline.some(e => e.kind === 'llm' && /Evidence Summarizer Wrapper · WWNA: Refine/.test(e.who)));
  const rca = runRules(ev, { now: NOW });
  const empty = byId(rca, 'SKILL-EMPTY-GROUNDING')[0];
  assert.ok(empty, 'the JSON-wrapped prompt is unwrapped and checked');
  assert.match(empty.detail, /Evidence text/);
  assert.match(toMarkdown(redactEvidence(ev), rca), /## Otto activity on this record/);
});

test('a bare sys_id of a business record resolves through the Gen AI log', async () => {
  const ev = await new Collector(client()).trace(IDS.evid);
  assert.equal(ev.root.kind, 'record');
  assert.equal(ev.root.table, 'x_mock_evidence');
  assert.ok(ev.recordActivity.length >= 3);
});

test('a record with no Otto activity says so', async () => {
  const ev = await new Collector(client()).trace(`https://x.service-now.com/x_mock_case.do?sys_id=${IDS.erCase}`);
  assert.equal(ev.root.kind, 'record');
  assert.deepEqual(ev.recordActivity.map(x => x.id), [IDS.casePlan], 'only the agent run on the case');
  const none = await new Collector(client()).trace(`https://x.service-now.com/sys_user.do?sys_id=${IDS.runAs}`);
  assert.ok(none.warnings.some(w => /No Otto skill calls or agent runs are linked to this sys_user record/.test(w)));
});

// ---- answers that skip the task, and noise from the time window (from a live report) ----
test('nonAnswer: replies that ask for input or only acknowledge, not real answers', () => {
  assert.equal(nonAnswer('Kindly check if attachments are present. Make sure that the uploaded documents are in formats: PNG, JPG, JPEG, PDF or DOCX only.'), 'input');
  assert.equal(nonAnswer('No attachments were found on this case.'), 'input');
  assert.equal(nonAnswer('I could not find any documents attached to this record.'), 'input');
  assert.equal(nonAnswer('Understood. I will respond only in English.'), 'ack');
  assert.equal(nonAnswer('Sure.'), 'ack');
  assert.equal(nonAnswer("I'm sorry, but I can't help with that request."), 'ack');
  // real answers
  assert.equal(nonAnswer('Please check that the VPN client is installed, then restart it.'), null, 'advice to the user is an answer');
  assert.equal(nonAnswer('No issues were found in the evidence; the badge logs match the shift roster.'), null);
  assert.equal(nonAnswer('Sure, here is the summary: the VPN drops every hour after the 2.3 update.'), null);
  assert.equal(nonAnswer('Summary: ' + 'The investigator reviewed the badge logs. '.repeat(12) + 'Please provide the missing details.'), null, 'long answers are not checked');
  assert.equal(nonAnswer(''), null);
  // things a skill reports on are not missing input (live false positive)
  assert.equal(nonAnswer('*Employee History Summary*\n\nThere are no employee case records available for this employee.'), null);
  assert.equal(nonAnswer('No evidence of wrongdoing was found in the badge logs.'), null);
  assert.equal(nonAnswer('Please provide the record number so I can look it up.'), 'input', 'asking the user for a record is still a non-answer');
});

test('Gen AI log trace of a nested call: the missing input is the root cause, the wrapper reply follows from it', async () => {
  const ev = await new Collector(client()).trace(IDS.log10);
  assert.equal(ev.root.kind, 'genaiLog');
  assert.deepEqual(ev.norm.genaiLogs.map(g => g.id).sort(), [IDS.log10, IDS.log9].sort(), 'the wrapper call at the same moment; not another user\'s call 5 s later, nor the same user\'s call on another record 8 s later');
  const rca = runRules(ev, { now: NOW });
  assert.equal(rca.rootCause.id, 'SKILL-NO-INPUT');
  assert.match(rca.rootCause.title, /input was missing for "Evidence Summarizer"/);
  assert.match(rca.rootCause.detail, /Kindly check if attachments are present/);
  // the session's error seconds before, and how often the skill does this
  assert.match(rca.rootCause.detail, /Just before it, the same session logged: "Error while executing sync feature FDIH call[^"]*" \(07:04:57\)/);
  assert.match(rca.rootCause.detail, /Of the skill's last 3 successful calls, 1 gave this same reply, so it depends on the record or the moment/);
  assert.match(rca.rootCause.fix, /^An "FDIH" error means a flow, subflow or action that the skill runs as a tool failed/);
  assert.ok(rca.rootCause.evidence.some(e => e.table === 'syslog'), 'links the preceding error');
  // the wrapper gives this reply on every call: how it is built, not this call's failure
  const ack = byId(rca, 'SKILL-NO-ANSWER')[0];
  assert.equal(ack.severity, 'Medium');
  assert.match(ack.title, /own reply is never an answer for "Evidence Summarizer Wrapper"/);
  assert.match(ack.detail, /All of its last 5 calls gave this same reply[\s\S]*"Evidence Summarizer" said its input was missing/);
  assert.match(ack.fix, /For this run, fix the missing input of "Evidence Summarizer"/);
  assert.match(byId(rca, 'SYSLOG-RUN')[0].fix, /FDIH/);
});

test('background errors: left out of the timeline and findings, grouped in a summary and the report', async () => {
  const ev = await new Collector(client()).trace(IDS.plan);
  const errs = ev.timeline.filter(e => e.kind === 'error');
  assert.ok(!errs.some(e => /Impact Tree Builder|ServletErrorListener/.test(e.who)), 'no background job in the timeline');
  assert.ok(errs.some(e => e.who === 'sn-gaf'), "the run's own error stays");
  assert.equal(ev.background.total, 4);
  assert.deepEqual(ev.background.groups.map(g => [g.source, g.count]), [['Impact Tree Builder Job', 3], ['com.glide.ui.ServletErrorListener', 1]], 'same message with different numbers is one group');
  const rca = runRules(ev, { now: NOW });
  assert.ok(!rca.findings.some(f => /Impact Tree Builder|GlideEncrypter/.test(f.detail || '')));
  const md = toMarkdown(redactEvidence(ev), rca);
  assert.match(md, /## Background \(not from this run\)\n4 errors/);
  assert.match(md, /- ×3 Impact Tree Builder Job/);
  const sent = compactEvidence(ev, rca).data;
  assert.ok(sent.syslog.every(x => x.linkedBy), 'Claude gets only the run\'s lines');
  assert.equal(sent.backgroundErrors.total, 4);
});

test('the same error repeated in a run is one timeline entry with a count', async () => {
  const ev = await new Collector(client()).trace(IDS.plan);
  ev.norm.syslog.push({ ...ev.norm.syslog.find(x => x.id === IDS.sys4), id: 'f'.repeat(32), created: '2026-10-29 02:00:59' });
  const { buildTimeline } = await import('../lib/timeline.js');
  const tl = buildTimeline(ev.norm, {});
  const gaf = tl.filter(e => e.who === 'sn-gaf');
  assert.equal(gaf.length, 1);
  assert.equal(gaf[0].count, 2);
});

test('redaction keeps KB and record numbers, still masks phone numbers', () => {
  assert.equal(redactText('refer KB0012345 for alternatives'), 'refer KB0012345 for alternatives');
  assert.equal(redactText('INC0010001 updated'), 'INC0010001 updated');
  assert.equal(redactText('call +65 6123 4567 now'), 'call [PHONE] now');
});

function id140() { return (140).toString(16).padStart(32, '0'); }

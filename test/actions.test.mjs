import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGlide } from './glide-mock.mjs';
import { stopPlansScript, deactivateScript, availableActions } from '../lib/actions.js';

const H = n => n.toString(16).padStart(32, '0');
const P1 = H(1), P2 = H(2), T1 = H(3), T2 = H(4), X1 = H(5), M1 = H(6), A1 = H(7), FC = H(8);
function world(over = {}) {
  return {
    sn_aia_execution_plan: { fields: ['sys_id', 'number', 'state', 'sys_updated_on'], rows: [
      { sys_id: P1, number: 'AIAPLN1', state: 'in_progress', sys_updated_on: '2026-10-31 02:30:00' },
      { sys_id: P2, number: 'AIAPLN2', state: 'in_progress', sys_updated_on: '2026-10-31 02:59:00' }] },
    sn_aia_execution_task: { fields: ['sys_id', 'execution_plan', 'state'], rows: [
      { sys_id: T1, execution_plan: P1, state: 'in_progress' }, { sys_id: T2, execution_plan: P1, state: 'complete' }] },
    sn_aia_tools_execution: { fields: ['sys_id', 'execution_plan', 'state'], rows: [{ sys_id: X1, execution_plan: P1, state: 'running' }] },
    sn_aia_message: { fields: ['sys_id', 'execution_plan', 'content'], rows: [{ sys_id: M1, execution_plan: P1, content: 'hi' }] },
    sn_aia_agent: { fields: ['sys_id', 'name', 'active'], rows: [{ sys_id: A1, name: 'Travel Advisor', active: 'true' }] },
    sys_dictionary: { fields: [], rows: [
      { name: 'sn_aia_execution_task', element: 'execution_plan', internal_type: 'reference', reference: 'sn_aia_execution_plan' },
      { name: 'sn_aia_tools_execution', element: 'execution_plan', internal_type: 'reference', reference: 'sn_aia_execution_plan' },
      { name: 'sn_aia_message', element: 'execution_plan', internal_type: 'reference', reference: 'sn_aia_execution_plan' },
      { name: 'sys_audit', element: 'documentkey', internal_type: 'reference', reference: 'sn_aia_execution_plan' }] },
    sys_choice: { fields: [], rows: [
      ...['ready', 'in_progress', 'complete', 'cancelled'].map(v => ({ name: 'sn_aia_execution_plan', element: 'state', value: v, label: v, inactive: 'false' })),
      ...['in_progress', 'complete', 'cancelled'].map(v => ({ name: 'sn_aia_execution_task', element: 'state', value: v, label: v, inactive: 'false' })),
      ...[['running', 'Running'], ['aborted', 'Aborted']].map(([v, l]) => ({ name: 'sn_aia_tools_execution', element: 'state', value: v, label: l, inactive: 'false' }))] },
    ...over,
  };
}
const gen = (o = {}) => stopPlansScript({ planIds: [P1], instanceName: 'dev00000', user: 'alex.admin', now: 'T', ...o });
const apply = s => s.replace('var DRY_RUN = true;', 'var DRY_RUN = false;');

test('generated scripts are valid ES5-compatible JavaScript', () => {
  for (const s of [gen(), deactivateScript({ table: 'sn_aia_agent', sysId: A1, name: 'x', instanceName: 'dev00000' })]) {
    assert.doesNotThrow(() => new Function('GlideRecord', 'GlideDateTime', 'gs', 'sn_fd', s));
    assert.doesNotMatch(s, /=>|\blet\b|\bconst\b|`/, 'no ES6 syntax inside the snippet');
    assert.match(s, /var DRY_RUN = true;/);
  }
});

test('refuses to run on a different instance', () => {
  const g = makeGlide({ instance: 'acmeprod', tables: world() });
  g.run(apply(gen()));
  assert.equal(g.updates.length, 0);
  assert.match(g.printed.join('\n'), /Aborted: this snippet was generated for "dev00000" but this is "acmeprod"/);
});

test('dry run changes nothing and lists what would change', () => {
  const g = makeGlide({ tables: world() });
  g.run(gen());
  assert.equal(g.updates.length, 0);
  const p = g.printed.join('\n');
  assert.match(p, /DRY RUN/);
  assert.match(p, /WOULD SET sn_aia_execution_task .*"in_progress" -> "cancelled"/);
  assert.match(p, /WOULD SET sn_aia_tools_execution .*"running" -> "aborted"/);
  assert.match(p, /WOULD SET sn_aia_execution_plan .*"in_progress" -> "cancelled"/);
  assert.match(p, /SKIP sn_aia_execution_task .*already "complete"/);
  assert.match(p, /SKIP sn_aia_message .*no state field/);
  assert.match(p, /3 record\(s\) would change/);
});

test('apply cancels the plan and its open children, then logs to syslog', () => {
  const g = makeGlide({ tables: world() });
  g.run(apply(gen()));
  const byId = Object.fromEntries(g.updates.map(u => [u.id, u.state]));
  assert.deepEqual(byId, { [T1]: 'cancelled', [X1]: 'aborted', [P1]: 'cancelled' });
  assert.equal(g.tables.sn_aia_execution_task.rows[1].state, 'complete');
  assert.match(g.infos[0], /\[SNAI-STOP\] applied by admin/);
});

test('stuck-run mode skips plans updated recently and honours the cap', () => {
  const g = makeGlide({ tables: world() });
  g.run(apply(gen({ planIds: [P1, P2], minAgeMinutes: 5 })));
  assert.ok(g.updates.some(u => u.id === P1));
  assert.ok(!g.updates.some(u => u.id === P2));
  assert.match(g.printed.join('\n'), /SKIP AIAPLN2: updated less than 5 min ago/);
  const g2 = makeGlide({ tables: world() });
  g2.run(apply(gen()).replace('var MAX_RECORDS = 200;', 'var MAX_RECORDS = 1;'));
  assert.equal(g2.updates.length, 1);
  assert.match(g2.printed.join('\n'), /reached MAX_RECORDS/);
});

test('no cancel choice: skips instead of guessing; CANCEL_STATE override works', () => {
  const w = world(); w.sys_choice.rows = w.sys_choice.rows.filter(r => r.name !== 'sn_aia_execution_plan');
  const g = makeGlide({ tables: w });
  g.run(apply(gen()));
  assert.ok(!g.updates.some(u => u.id === P1));
  assert.match(g.printed.join('\n'), /no cancel choice on sn_aia_execution_plan.state/);
  const g2 = makeGlide({ tables: world() });
  g2.run(apply(gen()).replace("var CANCEL_STATE = '';", "var CANCEL_STATE = 'closed_cancelled';"));
  assert.ok(g2.updates.every(u => u.state === 'closed_cancelled'));
});

test('flow contexts are only cancelled when switched on', () => {
  const g = makeGlide({ tables: world() });
  g.run(apply(gen({ flowContextIds: [FC] })));
  assert.equal(g.flowCancels.length, 0);
  const g2 = makeGlide({ tables: world() });
  g2.run(apply(gen({ flowContextIds: [FC] })).replace('var CANCEL_FLOWS = false;', 'var CANCEL_FLOWS = true;'));
  assert.deepEqual(g2.flowCancels.map(f => f.id), [FC]);
});

test('deactivate agent: dry run, apply, already inactive', () => {
  const s = deactivateScript({ table: 'sn_aia_agent', sysId: A1, name: 'Travel Advisor', instanceName: 'dev00000' });
  const g = makeGlide({ tables: world() });
  g.run(s);
  assert.equal(g.updates.length, 0);
  assert.match(g.printed.join('\n'), /WOULD DEACTIVATE sn_aia_agent Travel Advisor/);
  g.run(apply(s));
  assert.equal(g.tables.sn_aia_agent.rows[0].active, 'false');
  g.run(apply(s));
  assert.match(g.printed.at(-1), /already inactive/);
});

test('names and ids cannot break out of the script', () => {
  const s = deactivateScript({ table: 'sn_aia_agent', sysId: A1, name: 'Bad"\n}); gs.print("pwned', instanceName: 'dev00000' });
  const g = makeGlide({ tables: world() });
  g.run(s);
  assert.ok(!g.printed.some(x => x === 'pwned'));
  assert.equal(stopPlansScript({ planIds: ['not-an-id', P1], instanceName: 'x' }).match(/PLAN_IDS = (\[.*\])/)[1], `["${P1}"]`);
});

test('available actions follow the traced record', () => {
  const ev = {
    root: { kind: 'plan', table: 'sn_aia_execution_plan', sysId: P1, display: 'AIAPLN1' },
    meta: { instance: 'dev00000.service-now.com', tables: { plan: 'sn_aia_execution_plan' } }, user: { userName: 'alex.admin' },
    norm: { plan: { id: P1, display: 'AIAPLN1', state: 'In progress' }, flows: [{ id: FC, state: 'WAITING' }] },
  };
  const acts = availableActions(ev);
  assert.deepEqual(acts.map(a => a.id), ['stop-plan']);
  assert.ok(acts[0].open);
  const s = acts[0].script();
  assert.match(s, /EXPECTED_INSTANCE = "dev00000"/);
  assert.ok(s.includes(FC));
  const ag = availableActions({ ...ev, root: { kind: 'agent', table: 'sn_aia_agent', sysId: A1, display: 'Travel' }, norm: {},
    recentPlans: [{ id: P1, state: 'In progress', created: '2026-10-31 01:00:00' }, { id: P2, state: 'Complete', created: '2026-10-31 01:00:00' }] }, { now: new Date('2026-10-31T03:00:00Z') });
  assert.deepEqual(ag.map(a => a.id), ['stop-stuck', 'deactivate']);
  const wf = availableActions({ ...ev, root: { kind: 'workflow', table: 'sn_aia_usecase', sysId: A1, display: 'WF' }, norm: { triggers: [{ id: FC, display: 'On create', active: true }, { id: P2, display: 'Off', active: false }] }, recentPlans: [] });
  assert.deepEqual(wf.map(a => a.id), [`deactivate-trigger-${FC}`, 'deactivate']);
  assert.match(wf[0].script(), /TABLE = "sn_aia_trigger_configuration"/);
  assert.match(ag[0].label, /\(1\)/);
});

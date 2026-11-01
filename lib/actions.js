// Opt-in "stop" actions. The extension itself never writes to the instance: it generates a
// Scripts - Background snippet, fills it into sys.scripts.do, and the user reviews and clicks Run.
// Every snippet starts in dry-run mode, refuses to run on any instance other than the one it
// was generated for, caps how many records it touches, and prints what it changed.

const q = s => JSON.stringify(String(s ?? ''));
const ids = a => '[' + (a || []).filter(x => /^[0-9a-f]{32}$/i.test(x)).map(q).join(', ') + ']';

const HEADER = ({ title, instanceName, user, now }) => `// ServiceNow AI Debugger: ${title}
// Generated ${now} for instance "${instanceName}" by ${user || 'unknown user'}.
// Review it, keep DRY_RUN = true for a first run, read the output, then set DRY_RUN = false.
// Unsupported direct write: prefer the supported controls (Cancel on the agentic workflow card,
// Deactivate in AI Agent Studio, AI Control Tower kill switch) when they work.`;

// Shared helpers inside every snippet (ES5, runs in Scripts - Background).
const HELPERS = `
  var TERMINAL = /complete|success|succeed|cancel|abort|error|fail|closed|done|finish|skip/i;
  var log = [];
  function out(s) { gs.print(TAG + ' ' + s); log.push(s); }
  function stateField(gr) { return gr.isValidField('state') ? 'state' : (gr.isValidField('status') ? 'status' : null); }
  var cancelCache = {};
  function cancelValue(table, field) {
    var key = table + '.' + field;
    if (cancelCache.hasOwnProperty(key)) return cancelCache[key];
    var val = CANCEL_STATE || null;
    if (!val) {
      var ch = new GlideRecord('sys_choice');
      ch.addQuery('name', table);
      ch.addQuery('element', field);
      ch.addQuery('inactive', false);
      ch.query();
      var second = null;
      while (ch.next()) {
        var v = String(ch.getValue('value')), l = String(ch.getValue('label'));
        if (/cancel/i.test(v) || /cancel/i.test(l)) { val = v; break; }
        if (!second && (/abort|stop/i.test(v) || /abort|stop/i.test(l))) second = v;
      }
      val = val || second;
    }
    cancelCache[key] = val;
    return val;
  }
  function stopRecord(gr, why) {
    var table = gr.getTableName(), f = stateField(gr);
    if (!f) { out('SKIP ' + table + ' ' + gr.getUniqueValue() + ': no state field'); return false; }
    var cur = String(gr.getValue(f) || '');
    if (TERMINAL.test(cur)) { out('SKIP ' + table + ' ' + gr.getUniqueValue() + ': already "' + cur + '"'); return false; }
    var cv = cancelValue(table, f);
    if (!cv) { out('SKIP ' + table + ' ' + gr.getUniqueValue() + ': no cancel choice on ' + table + '.' + f + ' (set CANCEL_STATE)'); return false; }
    if (touched >= MAX_RECORDS) { out('STOP: reached MAX_RECORDS (' + MAX_RECORDS + ')'); return false; }
    touched++;
    out((DRY_RUN ? 'WOULD SET ' : 'SET ') + table + ' ' + gr.getUniqueValue() + ' ' + f + ': "' + cur + '" -> "' + cv + '" (' + why + ')');
    if (!DRY_RUN) { gr.setValue(f, cv); gr.update(); }
    return true;
  }
  function childRefs(table) {
    var refs = [], dict = new GlideRecord('sys_dictionary');
    dict.addQuery('internal_type', 'reference');
    dict.addQuery('reference', table);
    dict.addQuery('name', 'STARTSWITH', 'sn_aia');
    dict.query();
    while (dict.next()) refs.push({ table: String(dict.getValue('name')), field: String(dict.getValue('element')) });
    return refs;
  }`;

const GUARD = `
  if (String(gs.getProperty('instance_name')) !== EXPECTED_INSTANCE) {
    gs.print(TAG + ' Aborted: this snippet was generated for "' + EXPECTED_INSTANCE + '" but this is "' + gs.getProperty('instance_name') + '".');
    return;
  }
  out((DRY_RUN ? 'DRY RUN (nothing will change). ' : 'APPLYING CHANGES. ') + 'Instance ' + EXPECTED_INSTANCE + ', run by ' + gs.getUserName());`;

// Cancel one or more execution plans and their open child records (tasks, tool executions…).
export function stopPlansScript({ planIds, instanceName, user, minAgeMinutes = 0, flowContextIds = [], planTable = 'sn_aia_execution_plan', reason = 'Stopped from ServiceNow AI Debugger', now = new Date().toISOString(), title }) {
  return `${HEADER({ title: title || 'stop AI Agent run(s)', instanceName, user, now })}
(function () {
  var DRY_RUN = true;                       // set to false to apply
  var EXPECTED_INSTANCE = ${q(instanceName)};
  var PLAN_TABLE = ${q(planTable)};
  var PLAN_IDS = ${ids(planIds)};
  var MIN_AGE_MINUTES = ${Number(minAgeMinutes) || 0};          // skip plans updated more recently than this
  var CANCEL_STATE = '';                    // leave empty to use the table's own "cancelled" choice
  var MAX_RECORDS = 200;                    // safety cap on records changed
  var CANCEL_FLOWS = false;                 // also cancel the flow contexts below (check each one first)
  var FLOW_CONTEXT_IDS = ${ids(flowContextIds)};
  var REASON = ${q(reason)};
  var TAG = '[SNAI-STOP]';
  var touched = 0;
${HELPERS}
${GUARD}
  var cutoff = new GlideDateTime();
  cutoff.addSeconds(-60 * MIN_AGE_MINUTES);
  var children = childRefs(PLAN_TABLE);
  for (var i = 0; i < PLAN_IDS.length; i++) {
    var plan = new GlideRecord(PLAN_TABLE);
    if (!plan.get(PLAN_IDS[i])) { out('NOT FOUND ' + PLAN_TABLE + ' ' + PLAN_IDS[i]); continue; }
    if (MIN_AGE_MINUTES > 0 && new GlideDateTime(plan.getValue('sys_updated_on')).after(cutoff)) {
      out('SKIP ' + plan.getDisplayValue() + ': updated less than ' + MIN_AGE_MINUTES + ' min ago'); continue;
    }
    out('PLAN ' + plan.getDisplayValue() + ' (' + plan.getUniqueValue() + ')');
    for (var c = 0; c < children.length; c++) {
      if (children[c].table === PLAN_TABLE) continue;
      var ch = new GlideRecord(children[c].table);
      if (!ch.isValid()) continue;
      ch.addQuery(children[c].field, plan.getUniqueValue());
      ch.query();
      while (ch.next()) stopRecord(ch, REASON);
    }
    stopRecord(plan, REASON);
  }
  if (CANCEL_FLOWS) {
    for (var k = 0; k < FLOW_CONTEXT_IDS.length; k++) {
      out((DRY_RUN ? 'WOULD CANCEL' : 'CANCEL') + ' flow context ' + FLOW_CONTEXT_IDS[k]);
      if (!DRY_RUN) { try { sn_fd.FlowAPI.cancel(FLOW_CONTEXT_IDS[k], REASON); } catch (e) { out('  failed: ' + e); } }
    }
  }
  out('Done. ' + touched + ' record(s) ' + (DRY_RUN ? 'would change. Set DRY_RUN = false to apply.' : 'changed.'));
  gs.info(TAG + ' ' + (DRY_RUN ? 'dry run' : 'applied') + ' by ' + gs.getUserName() + ':\\n' + log.join('\\n'));
})();
`;
}

// Deactivate an AI agent or agentic workflow so it stops being picked up.
export function deactivateScript({ table, sysId, name, instanceName, user, now = new Date().toISOString() }) {
  return `${HEADER({ title: `deactivate "${String(name || sysId).replace(/[\r\n]/g, ' ')}"`, instanceName, user, now })}
(function () {
  var DRY_RUN = true;                       // set to false to apply
  var EXPECTED_INSTANCE = ${q(instanceName)};
  var TABLE = ${q(table)};
  var SYS_ID = ${q(sysId)};
  var TAG = '[SNAI-STOP]';
  var log = [];
  function out(s) { gs.print(TAG + ' ' + s); log.push(s); }
${GUARD}
  var gr = new GlideRecord(TABLE);
  if (!gr.get(SYS_ID)) { out('NOT FOUND ' + TABLE + ' ' + SYS_ID); return; }
  if (!gr.isValidField('active')) { out('No active field on ' + TABLE + '; nothing to do.'); return; }
  if (String(gr.getValue('active')) !== '1' && String(gr.getValue('active')) !== 'true') { out(gr.getDisplayValue() + ' is already inactive.'); return; }
  out((DRY_RUN ? 'WOULD DEACTIVATE ' : 'DEACTIVATED ') + TABLE + ' ' + gr.getDisplayValue() + ' (' + SYS_ID + '). Reactivate it in AI Agent Studio when fixed.');
  if (!DRY_RUN) { gr.setValue('active', false); gr.update(); }
  gs.info(TAG + ' ' + (DRY_RUN ? 'dry run' : 'applied') + ' by ' + gs.getUserName() + ': ' + log.join(' | '));
})();
`;
}

const OPEN = /ready|queued|pending|new|waiting|in[\s_-]?progress|running|process|draft|open|planning|executing/i;
const DONE = /complete|success|succeed|cancel|abort|error|fail|closed|done|finish/i;

// What the panel can offer for the current trace.
export function availableActions(ev, { stuckMinutes = 5, now = new Date() } = {}) {
  const out = [];
  const root = ev?.root;
  if (!root) return out;
  const instanceName = String(ev.meta?.instance || '').split('.')[0];
  const base = { instanceName, user: ev.user?.userName };
  const openFlows = (ev.norm?.flows || []).filter(f => /wait|progress|running|queued/i.test(`${f.state} ${f.stateValue}`)).map(f => f.id);
  const plan = ev.norm?.plan;
  if (plan) {
    const st = `${plan.state || ''} ${plan.stateValue || ''}`;
    out.push({
      id: 'stop-plan', label: 'Stop this run', open: OPEN.test(st) && !DONE.test(st),
      detail: `Cancels execution plan ${plan.display} and its open tasks and tool executions.${openFlows.length ? ` ${openFlows.length} waiting or running flow context(s) from the run window are listed in the script, off by default.` : ''}`,
      script: () => stopPlansScript({ ...base, planIds: [plan.id], planTable: ev.meta?.tables?.plan || undefined, flowContextIds: openFlows, title: `stop run ${plan.display}` }),
    });
  }
  if ((root.kind === 'agent' || root.kind === 'workflow' || root.kind === 'conversation') && ev.recentPlans?.length) {
    const cutoff = now.getTime() - stuckMinutes * 60000;
    const stuck = ev.recentPlans.filter(p => OPEN.test(p.state || '') && !DONE.test(p.state || '') && p.created && Date.parse(p.created.replace(' ', 'T') + 'Z') < cutoff);
    out.push({
      id: 'stop-stuck', label: `Stop stuck runs (${stuck.length})`, open: stuck.length > 0,
      detail: `Cancels ${stuck.length} recent plan(s) still open after ${stuckMinutes} min, and their open child records. The script re-checks each plan's state and age before changing it.`,
      script: () => stopPlansScript({ ...base, planIds: stuck.map(p => p.id), minAgeMinutes: stuckMinutes, planTable: ev.meta?.tables?.plan || undefined, title: `stop ${stuck.length} stuck run(s) for ${root.display}` }),
    });
  }
  for (const t of (ev.norm?.triggers || []).filter(x => x.active !== false).slice(0, 3)) {
    out.push({
      id: `deactivate-trigger-${t.id}`, label: `Deactivate trigger "${String(t.display).slice(0, 30)}"`, open: true,
      detail: 'Stops this trigger from starting new runs, the same thing the Kill Switch does in enforce mode. Use it for a runaway trigger; fix the trigger condition before re-activating (re-activating resets the breach cycle).',
      script: () => deactivateScript({ ...base, table: ev.meta?.tables?.trigger || 'sn_aia_trigger_configuration', sysId: t.id, name: t.display }),
    });
  }
  if (root.kind === 'agent' || root.kind === 'workflow') {
    out.push({
      id: 'deactivate', label: `Deactivate this ${root.kind === 'agent' ? 'agent' : 'workflow'}`, open: true,
      detail: `Sets ${root.display} inactive so the orchestrator stops using it. Running plans are not cancelled; use "Stop stuck runs" for those.`,
      script: () => deactivateScript({ ...base, table: root.table, sysId: root.sysId, name: root.display }),
    });
  }
  return out;
}

// Injected into a sys.scripts.do tab: fills the script box, never clicks Run.
export function pageFillScript(script) {
  const ta = document.querySelector('textarea[name="script"]') || document.getElementById('runscript') || document.querySelector('form textarea');
  if (!ta) return { ok: false };
  ta.value = script;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.scrollIntoView({ block: 'center' });
  return { ok: true };
}

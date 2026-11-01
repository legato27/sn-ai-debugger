// Deterministic root-cause rules. Pure functions over the evidence model, so they can be
// unit-tested in Node and never send data anywhere.

export const SEVERITY = ['Critical', 'High', 'Medium', 'Low', 'Info'];

// Lower rank = closer to the actual cause (a failed plan is usually a symptom).
const CAUSAL_RANK = {
  'TOOL-DEP-BROKEN': 1, 'TOOL-MISSING': 1, 'TOOL-INPUT-CASE': 1.5, 'TOOL-ERR': 2, 'RCA-DENIED': 2, 'SYSLOG-ACL': 2,
  'ACL-ROLEGAP': 3, 'TOOL-EMPTY': 3, 'GENAI-ERR': 3, 'PLUGIN-INACTIVE': 3, 'SUPERVISED-UNATTENDED': 3,
  'HTTP-ERR': 4, 'FLOW-ERR': 4, 'SYSLOG-TOOL': 4, 'GUARD': 4, 'AGENT-INACTIVE': 4, 'TOOL-INACTIVE': 4, 'SKILL-INACTIVE': 4,
  'GENAI-EMPTY': 5, 'VA-FAULT': 5, 'AI-ACL-MISSING': 2.5, 'TRIGGER-DISABLED': 2.5, 'RUNAWAY-TRIGGER': 4, 'TASK-FAIL': 6, 'PLAN-NOTASKS': 6, 'PLAN-STUCK': 7, 'PLAN-FAIL': 8,
};

const FAIL = /fail|error|cancel|abort|timed?[\s_-]?out|reject|declin/i;
const DONE = /complete|success|succeed|done|finish|closed|resolved/i;
const OPEN = /ready|queued|pending|new|waiting|in[\s_-]?progress|running|process|draft|open|planning|executing/i;
const EMPTY_OUT = /^\s*(null|undefined|""|''|\{\s*\}|\[\s*\]|\{\s*"(result|records|data|output)"\s*:\s*(\[\s*\]|\{\s*\}|null|"")\s*\})?\s*$/i;

const stateText = x => `${x?.state ?? ''} ${x?.stateValue ?? ''}`.trim();
const isFail = x => FAIL.test(stateText(x)) || Boolean(x?.error && String(x.error).trim());
const isOpen = x => OPEN.test(stateText(x)) && !DONE.test(stateText(x)) && !FAIL.test(stateText(x));
const trunc = (s, n = 300) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n) + '…' : s; };
const minutesSince = (t, now) => (t ? (now - new Date(String(t).replace(' ', 'T') + 'Z')) / 60000 : null);

function parseKeys(x) {
  if (!x) return null;
  try {
    const o = typeof x === 'string' ? JSON.parse(x) : x;
    if (Array.isArray(o)) return o.map(i => i?.name || i?.key || i?.id).filter(Boolean);
    if (o && typeof o === 'object') {
      if (o.properties && typeof o.properties === 'object') return Object.keys(o.properties);
      if (Array.isArray(o.inputs)) return o.inputs.map(i => i?.name).filter(Boolean);
      return Object.keys(o);
    }
  } catch (e) {}
  return null;
}

function words(s) { return new Set(String(s || '').toLowerCase().match(/[a-z]{4,}/g) || []); }
function jaccard(a, b) { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); }

export function runRules(ev, settings = {}) {
  const s = { stuckMinutes: 5, slowToolMs: 30000, ...settings };
  const now = settings.now ? new Date(settings.now) : new Date();
  const n = ev.norm || {};
  const F = [];
  const add = (id, severity, category, title, detail, fix, evidence = []) => F.push({ id, severity, category, title, detail, fix, evidence });

  const allTools = [...(n.agents || []).flatMap(a => a.tools || []), ...(n.tools || [])];
  const toolNames = [...new Set(allTools.map(t => t.name).filter(Boolean))];
  const depNames = allTools.flatMap(t => (t.deps || []).map(dp => dp.name || dp.display)).filter(Boolean);

  // ---- data quality ----
  if (ev.meta && ev.meta.dictionaryReadable === false)
    add('DICT', 'Info', 'gap', 'Data dictionary is not readable for your user',
      'Reference fields could not be discovered from sys_dictionary, so the trace fell back to guessed field names and may be incomplete.',
      'Run the trace with a user that can read sys_dictionary and sys_db_object, for example an admin on sub-production.');
  if (ev.user?.isAdmin)
    add('ADMIN', 'Info', 'risky', 'You are tracing as admin',
      'Admin can read records that the agent\'s run-as identity cannot. A passing Studio test as admin does not prove the real run works.',
      'Reproduce the run as the run-as user (impersonate) before closing the incident.');

  // ---- plan ----
  const plan = n.plan;
  if (plan) {
    const age = minutesSince(plan.updated || plan.created, now);
    if (isFail(plan))
      add('PLAN-FAIL', 'Critical', 'gap', `Execution plan ended in "${plan.state || plan.stateValue}"`,
        plan.error ? `Plan error: ${trunc(plan.error)}` : 'The plan has a failed or cancelled state. The findings below point to the step that caused it.',
        'Read the trace backwards and fix the first failing task or tool shown below.', [{ table: 'plan', id: plan.id }]);
    else if (isOpen(plan) && age != null && age > s.stuckMinutes)
      add('PLAN-STUCK', 'High', 'gap', `Execution plan has been "${plan.state || plan.stateValue}" for ${Math.round(age)} min`,
        (n.tasks || []).length ? 'Tasks exist but the plan never reached a final state. A task is probably waiting on a tool, a subflow or a supervised approval.'
          : 'No execution tasks were created, so the orchestrator never dispatched the work. Common causes: plugin version mismatch after a patch, an inactive or unavailable agent, or the background job queue.',
        'Check the plugin versions panel against the store, the Flow / subflow and System log sections, and whether any tool is supervised on an unattended path.', [{ table: 'plan', id: plan.id }]);
    if (!(n.tasks || []).length && ev.meta?.dictionaryReadable !== false)
      add('PLAN-NOTASKS', 'High', 'gap', 'No execution tasks were recorded for this plan',
        'The orchestrator did not hand the objective to any agent. Usually the agent is inactive, hidden by its availability conditions or ACL, or its description does not match the request.',
        'Check the agent\'s active flag, its user-access ACL and its description against the request text.', [{ table: 'plan', id: plan.id }]);
  }
  for (const t of n.tasks || []) if (isFail(t))
    add('TASK-FAIL', 'Critical', 'gap', `Execution task "${t.display}" failed`, t.error ? trunc(t.error) : `State: ${stateText(t)}`,
      'Open the task and the tool executions under it.', [{ table: 'task', id: t.id }]);

  // ---- tool executions ----
  const schemaByTool = new Map(allTools.filter(t => t.inputSchema).map(t => [t.name, parseKeys(t.inputSchema)]));
  const callCounts = new Map();
  for (const x of n.toolExecs || []) {
    const name = x.toolName || x.display;
    const sig = name + '|' + trunc(x.input, 500);
    callCounts.set(sig, (callCounts.get(sig) || 0) + 1);
    if (isFail(x)) {
      add('TOOL-ERR', 'Critical', 'gap', `Tool "${name}" failed`, x.error ? trunc(x.error, 500) : `State: ${stateText(x)}`,
        'Run the tool\'s script or subflow directly with the same input (Scripts - Background or Flow Designer test) and fix the error. Make the tool return an explicit success or failure the agent can act on.',
        [{ table: 'toolExec', id: x.id }]);
    } else if (x.output !== undefined && EMPTY_OUT.test(String(x.output ?? ''))) {
      add('TOOL-EMPTY', 'High', 'gap', `Tool "${name}" returned an empty result`,
        'ServiceNow notes that silent failures returning no values may indicate an underlying access error. The query may also be filtering on a wrong or unresolved value.',
        'Impersonate the run-as user and run the same query. Check ACLs on the tables the tool reads, and use GlideRecordSecure so denials are explicit.',
        [{ table: 'toolExec', id: x.id }]);
    }
    if (x.durationMs && x.durationMs > s.slowToolMs)
      add('TOOL-SLOW', 'Medium', 'risky', `Tool "${name}" took ${Math.round(x.durationMs / 1000)} s`,
        'Long synchronous tools feel broken in chat and can hit timeouts.',
        'Add a progress message, make the step async with a notification, or narrow the query.', [{ table: 'toolExec', id: x.id }]);
    const expected = schemaByTool.get(name);
    const got = parseKeys(x.input);
    if (expected && got) {
      const gotSet = new Set(got);
      const gotLower = new Map(got.map(k => [k.toLowerCase(), k]));
      for (const k of expected) {
        if (gotSet.has(k)) continue;
        const near = gotLower.get(k.toLowerCase());
        if (near) add('TOOL-INPUT-CASE', 'High', 'gap', `Input name mismatch on "${name}": "${near}" sent, "${k}" expected`,
          'The agent passed the input with different casing than the tool defines, so the tool receives an empty value.',
          'Align the input name in the tool definition and the instructions (camelCase vs snake_case), then re-test.', [{ table: 'toolExec', id: x.id }]);
        else add('TOOL-INPUT-MISSING', 'Medium', 'gap', `Tool "${name}" was called without input "${k}"`,
          'The tool definition declares this input but the execution did not include it.',
          'Tell the agent in its instructions where this value comes from, or make the input optional with a default.', [{ table: 'toolExec', id: x.id }]);
      }
    }
  }
  for (const [sig, c] of callCounts) if (c >= 4)
    add('LOOP-TOOL', 'Medium', 'gap', `Tool "${sig.split('|')[0]}" was called ${c} times with the same input`,
      'The agent is retrying without changing anything, so it is probably looping.', 'Add a completion condition and a retry cap to the instructions.');
  const msgCounts = new Map();
  for (const m of n.messages || []) { const k = trunc(m.content, 200).trim(); if (k) msgCounts.set(k, (msgCounts.get(k) || 0) + 1); }
  for (const [k, c] of msgCounts) if (c >= 3)
    add('LOOP-MSG', 'Medium', 'gap', `The same message appears ${c} times`, `"${trunc(k, 120)}"`,
      'Usually a re-ask loop: the agent did not recognise the data it already had. Pre-fill from context and add a completion condition.');

  // ---- agent configuration ----
  const background = Boolean(plan && (/^(system|guest)$/i.test(plan.createdBy || '') || (n.triggers || []).length));
  for (const a of n.agents || []) {
    if (a.active === false) add('AGENT-INACTIVE', 'High', 'gap', `Agent "${a.name}" is inactive`, 'Inactive agents are not offered to the orchestrator.', 'Activate it, or remove it from the workflow.', [{ table: 'agent', id: a.id }]);
    if (!(a.tools || []).length) add('NO-TOOLS', 'Medium', 'gap', `Agent "${a.name}" has no tools bound`,
      'Any instruction step that needs data or an action will fail or be made up.', 'Bind the tools the instructions rely on.', [{ table: 'agent', id: a.id }]);
    for (const t of a.tools || []) {
      if (t.missing) add('TOOL-MISSING', 'Critical', 'gap', `Agent "${a.name}" is bound to a tool that cannot be read`,
        `Binding points to ${t.id}. The tool was deleted, sits in another scope, or you lack read access.`, 'Re-bind the tool or restore it.', [{ table: 'agent', id: a.id }]);
      if (t.active === false || t.binding?.active === false) add('TOOL-INACTIVE', 'High', 'gap', `Tool "${t.name}" is inactive on agent "${a.name}"`,
        'The agent cannot call an inactive tool, so it will improvise or stop.', 'Activate the tool or the binding.', [{ table: 'tool', id: t.id }]);
      for (const dp of t.deps || []) {
        if (!dp.found) add('TOOL-DEP-BROKEN', 'Critical', 'gap', `Tool "${t.name}" points to a missing ${dp.table}`,
          `${dp.field} = ${dp.display || dp.id}, but that record cannot be read.`, 'Restore or re-point the dependency, and check that it was included in the update set.', [{ table: 'tool', id: t.id }]);
        else if (dp.active === false) add('TOOL-DEP-INACTIVE', 'High', 'gap', `Tool "${t.name}" depends on inactive ${dp.table} "${dp.name}"`,
          'The tool calls a script, flow or action that is switched off.', 'Activate it.', [{ table: 'tool', id: t.id }]);
      }
      const mode = `${t.executionMode || ''} ${t.binding?.state || ''}`;
      if (background && /supervis/i.test(mode)) add('SUPERVISED-UNATTENDED', 'High', 'risky', `Supervised tool "${t.name}" on an unattended run`,
        'Supervised tools wait for a person to approve them. On triggered or background runs nobody is there, so the plan stalls.',
        'Set the tool to autonomous for reads or low-risk writes, or replace the approval with a deterministic approval flow.', [{ table: 'tool', id: t.id }]);
    }
    // Instruction references that are not bound tools.
    if (a.instructions && (a.tools || []).length) {
      const bound = new Set((a.tools || []).map(t => String(t.name || '').toLowerCase()));
      const refs = new Set();
      for (const m of String(a.instructions).matchAll(/`([^`]{3,60})`|"([^"]{3,60})"\s+tool|\buse\s+(?:the\s+)?([A-Z][\w ]{2,40}?)\s+tool\b/g)) refs.add((m[1] || m[2] || m[3]).trim());
      const unbound = [...refs].filter(r => !bound.has(r.toLowerCase()) && !/^\$|\{|\}/.test(r));
      if (unbound.length) add('INSTR-UNBOUND', 'Medium', 'gap', `Instructions of "${a.name}" mention tools that are not bound`,
        `Mentioned but not bound: ${unbound.slice(0, 8).join(', ')}`, 'Bind these tools or change the instructions. An instruction to fetch data that nothing can fetch fails at run time.', [{ table: 'agent', id: a.id }]);
    }
    // Access.
    const who = a.runAs || (ev.user ? { name: ev.user.userName || 'you', roles: ev.user.roles || [] } : null);
    if (a.runAs && (a.runAs.roles || []).includes('admin'))
      add('RUNAS-ADMIN', 'High', 'risky', `Agent "${a.name}" runs as an admin identity`, `Run-as user: ${a.runAs.name}.`, 'Use a dedicated least-privilege AI user, or run as the invoking user.', [{ table: 'agent', id: a.id }]);
    for (const acl of a.acls || []) {
      if (!acl.active || !acl.roles?.length || !who) continue;
      if ((who.roles || []).includes('admin')) continue;
      if (!acl.roles.some(r => (who.roles || []).includes(r)))
        add('ACL-ROLEGAP', 'High', 'gap', `${a.runAs ? 'Run-as user' : 'Your user'} "${who.name}" has none of the roles on ACL "${acl.name}" (${acl.operation || 'op'})`,
          `ACL requires one of: ${acl.roles.join(', ')}.`, 'Grant the minimum role to the identity, or correct the ACL. Security settings must agree across the workflow, its agents and their tools.', [{ table: 'acl', id: acl.id }]);
    }
  }
  // Description overlap between siblings (misrouting).
  const sib = (n.siblingAgents || []).filter(x => x.description);
  const focus = new Set((n.agents || []).map(a => a.id));
  for (let i = 0; i < sib.length; i++) for (let j = i + 1; j < sib.length; j++) {
    if (focus.size && !focus.has(sib[i].id) && !focus.has(sib[j].id)) continue;
    const sim = jaccard(words(sib[i].description), words(sib[j].description));
    if (sim >= 0.55) add('DESC-OVERLAP', 'Medium', 'risky', `Agents "${sib[i].name}" and "${sib[j].name}" have overlapping descriptions (${Math.round(sim * 100)}%)`,
      'The orchestrator picks agents by name and description, so overlapping descriptions cause misrouting.', 'Rewrite both descriptions to name the distinct goal, trigger, records and done state.');
  }

  // ---- skills / Gen AI ----
  for (const sk of n.skills || []) if (sk.active === false)
    add('SKILL-INACTIVE', 'High', 'gap', `Skill "${sk.display}" is inactive`, 'Inactive skills are not offered in any surface.', 'Activate it in AI Admin Hub (or Now Assist Admin).');
  for (const g of n.genaiLogs || []) {
    const errText = String(g.error || '');
    if (isFail(g)) {
      let hint = 'Open the log entry and read the error together with the final prompt.';
      if (/resolveModelConfig|OneExtend|capability/i.test(errText)) hint = 'Capability or model routing failed in the Generative AI Controller. Compare plugin versions with the store and the instance patch level; this pattern has followed platform hotfixes before. Then check the OneExtend capability and the provider configuration.';
      else if (/429|rate|throttl|quota/i.test(errText)) hint = 'The LLM provider throttled the request. Check consumption and add retries with backoff.';
      else if (/timeout|timed out/i.test(errText)) hint = 'The LLM call timed out. Reduce prompt size and grounding, or move the step to async.';
      else if (/token|context length|too long/i.test(errText)) hint = 'The prompt exceeded the model\'s context window. Trim the grounding data or summarise it first.';
      else if (/guard|block|offensive|injection/i.test(errText)) hint = 'AI Guardian blocked the request. Review the guardrail mode (log or block) and the input that triggered it.';
      add('GENAI-ERR', 'Critical', 'gap', `LLM call failed${g.skill ? ` for "${g.skill}"` : ''}`, trunc(errText || stateText(g), 500), hint, [{ table: 'genaiLog', id: g.id }]);
    } else if (g.response !== undefined && !String(g.response ?? '').trim())
      add('GENAI-EMPTY', 'High', 'gap', `LLM returned an empty response${g.skill ? ` for "${g.skill}"` : ''}`,
        'No error was logged, but the response is blank.', 'Check AI Guardian and the prompt: the grounding fields may have been empty.', [{ table: 'genaiLog', id: g.id }]);
    for (const gf of g.guard || []) if (/^(true|1|yes|block|blocked|detected)$/i.test(String(gf.value)))
      add('GUARD', 'High', 'risky', `Guardrail flag "${gf.field}" is set on an LLM call`, 'AI Guardian flagged this request.', 'Review the input. In block mode the user receives no answer.', [{ table: 'genaiLog', id: g.id }]);
  }
  if ((plan || (n.skills || []).length) && !(n.genaiLogs || []).length && ev.sections?.some(x => x.key === 'genaiLog')) {
    const hr = (ev.user?.roles || []).some(r => /sn_hr_core\.admin/.test(r));
    add('GENAI-NONE', 'Medium', 'gap', 'No Generative AI log rows were found for this run',
      'The run may never have reached the LLM, the time window may be too narrow, or the rows may be hidden from you.' + (hr ? '' : ' HR-related Gen AI log entries are restricted to HR administrators.'),
      'Widen the time window in settings, or re-run the trace with a user that can read HR log entries.');
  }
  for (const g of n.guard || [])
    add('GUARD', 'High', 'risky', 'AI Guardian recorded a detection during the run', g.display || g.id, 'Check whether the guardrail is in block mode and what triggered it.', [{ table: 'guard', id: g.id }]);

  // ---- platform logs ----
  const sys = n.syslog || [];
  const isErr = x => String(x.level) === '2' || /error/i.test(String(x.level));
  const aclHits = sys.filter(x => /security restricted|access denied|not authori[sz]ed|ACL|operation .* denied|restricted caller/i.test(x.logText || ''));
  if (aclHits.length) add('SYSLOG-ACL', 'High', 'gap', `${aclHits.length} access-denied messages in the system log during the run`,
    aclHits.slice(0, 3).map(x => `• ${trunc(x.logText, 160)}`).join('\n'), 'Grant the missing access to the run-as identity, or approve the restricted caller access record if the cross-scope call is intended.',
    aclHits.slice(0, 5).map(x => ({ table: 'syslog', id: x.id })));
  const names = [...toolNames, ...depNames].filter(x => x && x.length > 3);
  const toolHits = sys.filter(x => isErr(x) && names.some(nm => String(x.logText || '').includes(nm) || String(x.source || '').includes(nm)));
  if (toolHits.length) add('SYSLOG-TOOL', 'High', 'gap', `${toolHits.length} errors in the system log mention the agent's tools or scripts`,
    toolHits.slice(0, 3).map(x => `• [${x.source || 'log'}] ${trunc(x.logText, 160)}`).join('\n'), 'Fix the script error; it is very likely the root cause of the tool failure.',
    toolHits.slice(0, 5).map(x => ({ table: 'syslog', id: x.id })));
  const aiHits = sys.filter(x => isErr(x) && !toolHits.includes(x) && /sn_aia|generative|one_?extend|nowassist|now_assist|gen_?ai|llm|skill|agent/i.test(`${x.source} ${x.logText}`));
  if (aiHits.length) add('SYSLOG-AI', 'Medium', 'gap', `${aiHits.length} AI platform errors in the system log during the run`,
    aiHits.slice(0, 3).map(x => `• [${x.source || 'log'}] ${trunc(x.logText, 160)}`).join('\n'), 'Read these with the plan timeline. Repeated framework errors after a patch point to a plugin or platform issue.',
    aiHits.slice(0, 5).map(x => ({ table: 'syslog', id: x.id })));
  const http = (n.http || []).filter(x => x.httpStatus === 0 || x.httpStatus >= 400);
  if (http.length) add('HTTP-ERR', 'High', 'gap', `${http.length} outbound HTTP calls failed during the run`,
    http.slice(0, 3).map(x => `• ${x.httpStatus ?? '?'} ${trunc(x.url, 120)}`).join('\n'), 'Check the spoke or REST message credentials, the endpoint and the MID Server if one is used.' + (http.some(x => x.httpStatus === 401) ? ' For Agent2Agent (external agent) calls: flow actions no longer add the Authorization "Bearer" prefix, so include it in the API Key credential value.' : ''),
    http.slice(0, 5).map(x => ({ table: 'http', id: x.id })));
  for (const f of n.flows || []) {
    if (isFail(f)) add('FLOW-ERR', 'High', 'gap', `Flow or subflow "${f.display}" ended in "${stateText(f)}"`, f.error ? trunc(f.error) : '', 'Open the flow execution details and fix the failing step.', [{ table: 'flow', id: f.id }]);
    else if (/wait/i.test(stateText(f))) add('FLOW-WAIT', 'Medium', 'risky', `Flow "${f.display}" is waiting`, 'A tool subflow that waits (approval, timer, async) leaves the agent with nothing to return.', 'Return an interim result to the agent, or notify the user when the flow completes.', [{ table: 'flow', id: f.id }]);
  }
  for (const r of n.rca || []) if (/denied|requested|invalid/i.test(stateText(r)))
    add('RCA-DENIED', 'High', 'gap', `Restricted caller access "${r.display}" is "${stateText(r)}"`,
      'A cross-scope call made during the run was blocked. Editing the calling script can invalidate an earlier approval.',
      'Approve the record if the access is intended, or move the code into the target scope.', [{ table: 'rca', id: r.id }]);

  // ---- Virtual Agent conversation ----
  const conv = n.conversation;
  if (conv && /fault|error/i.test(`${conv.state} ${conv.stateValue}`))
    add('VA-FAULT', 'High', 'gap', `The VA conversation ended in "${conv.state || conv.stateValue}"`,
      'A runtime exception closed the conversation, so the user hit a dead end.', 'Open the conversation and read the timeline around the last bot message; check the system log at that time.', [{ table: 'conversation', id: conv.id }]);
  const botCounts = new Map();
  for (const m of n.vaMessages || []) if (m.side === 'bot') { const k = trunc(m.text, 200).trim(); if (k) botCounts.set(k, (botCounts.get(k) || 0) + 1); }
  for (const [k, c] of botCounts) if (c >= 3)
    add('VA-REASK', 'Medium', 'gap', `Virtual Agent sent the same message ${c} times`, `"${trunc(k, 120)}"`,
      'The user is being asked the same thing again. Check that the topic or agent reads the answer it already has, and add a fallback after two attempts.');
  if (plan && n.conversationLink === 'none' && (ev.sections || []).some(x => x.key === 'message'))
    add('VA-NOLINK', 'Info', 'gap', 'No Virtual Agent conversation is linked to this plan',
      'The run was triggered, tested in AI Agent Studio, or the link field is named differently on this release, so the user-facing transcript is not in the timeline.', 'Trace the conversation sys_id directly if the run came from Virtual Agent.');

  // ---- agentic AI access (Brazil deny-by-default) ----
  const plat = ev.platform || {};
  const brazilPlus = (plat.rank ?? -1) >= 5;   // RELEASE_ORDER index of 'brazil'
  const relLabel = plat.family ? `${plat.family[0].toUpperCase()}${plat.family.slice(1)}${plat.patch ? ' patch ' + plat.patch : ''}` : 'this release';
  const aclGap = (what, cov, evidence) => {
    const ownCount = Array.isArray(cov?.own) ? cov.own.length : Number(cov?.own) || 0;
    if (!cov || cov.readable === false || ownCount > 0) return;
    const denyWildcard = (cov.wildcard || []).some(w => /never/i.test(String(w.securityAttribute || '')) || (!w.roles?.length && /deny/i.test(String(w.decision || ''))));
    const sev = brazilPlus || denyWildcard ? 'High' : 'Medium';
    add('AI-ACL-MISSING', sev, 'gap', `No ${cov.type} ACL for ${what}`,
      (denyWildcard ? `The ${cov.type} wildcard ACL denies access (Security Attribute "Never"), so only admins can invoke it. ` : '') +
      `From Brazil, newly activated instances deny agentic AI record types (gen_ai_agent, gen_ai_workflow, gen_ai_skill, Flow, flow_action) unless a component-specific ACL allows them. Instance: ${relLabel}. ACLs control who may invoke the component, not what it can do after.`,
      'Add an "Allow If" ACL for this component (AI Agent Studio security controls, or sys_security_acl), then use "Test access" on the AI asset and Access Analyzer to confirm for a non-admin user.', evidence);
  };
  for (const a of n.agents || []) if (a.aclCoverage && !a.acls?.length) aclGap(`agent "${a.name}"`, { ...a.aclCoverage, type: 'gen_ai_agent', own: [] }, [{ table: 'agent', id: a.id }]);
  if (n.workflowAcl && !n.workflowAcl.own.length) aclGap(`workflow "${n.workflow?.display || ''}"`, n.workflowAcl, n.workflow ? [{ table: 'workflow', id: n.workflow.id }] : []);
  if (n.skillAcl && !n.skillAcl.own.length) aclGap(`skill "${(n.skills || [])[0]?.display || ''}"`, n.skillAcl);
  for (const t of allTools) for (const dp of t.deps || []) if (dp.acl && !dp.acl.own) aclGap(`${dp.acl.type === 'flow' ? 'flow' : dp.acl.type === 'flow_action' ? 'flow action' : 'skill'} "${dp.name || dp.display}" behind tool "${t.name}"`, { ...dp.acl, own: [] }, [{ table: 'tool', id: t.id }]);

  // ---- runaway triggers / kill switch ----
  const ks = Object.fromEntries(Object.entries(plat.props || {}).filter(([k]) => /kill_switch/.test(k)).map(([k, x]) => [k.replace(/^.*kill_switch\./, ''), x]));
  const maxFires = Number(ks.max_fires_per_window) || 5;
  const windowMin = Number(ks.window_size) || 1440;
  const byObjective = new Map();
  for (const p of ev.recentPlans || []) { const k = String(p.objective || '').trim().toLowerCase(); if (k) byObjective.set(k, (byObjective.get(k) || []).concat(p)); }
  for (const [k, plans] of byObjective) {
    const ts = plans.map(p => Date.parse(String(p.created).replace(' ', 'T') + 'Z')).filter(Number.isFinite).sort((x, y) => x - y);
    let burst = 0;
    for (let i = 0, j = 0; j < ts.length; j++) { while (ts[j] - ts[i] > windowMin * 60000) i++; burst = Math.max(burst, j - i + 1); }
    if (burst >= maxFires) add('RUNAWAY-TRIGGER', 'High', 'risky', `The same objective ran ${burst} times within ${Math.round(windowMin / 60)} h`,
      `"${trunc(k, 140)}". This is the pattern the AI agent Kill Switch looks for (same record, same objective, at least ${maxFires} fires per window). Each run consumes assists. Kill switch mode: ${ks.mode || 'unknown (property not readable)'}.`,
      'Fix the trigger condition so the record no longer re-matches after the agent updates it. To stop it now, deactivate the trigger in AI Agent Studio or use Deactivate Agent in AI Control Tower.');
  }
  if (ks.mode === 'off') add('KILLSWITCH-OFF', 'Low', 'risky', 'Runaway-trigger protection is off', 'The kill switch mode property is "off": no detection, no warnings, triggers never disabled.', 'Set it to warn_only (default) or enforce.');
  for (const t of n.triggers || []) if (t.active === false && ks.mode === 'enforce')
    add('TRIGGER-DISABLED', 'High', 'gap', `Trigger "${t.display}" is inactive while the kill switch is enforcing`,
      'In enforce mode the Kill Switch disables a trigger after repeated breaches and emails the trigger and agent creators. The agent will not start from this trigger.',
      'Fix the trigger condition first, then re-activate it; re-enabling resets the breach cycle.', [{ table: 'trigger', id: t.id }]);
  if (plat.readable === false || !plat.family)
    add('RELEASE-UNKNOWN', 'Info', 'gap', 'Instance release could not be read', 'Release-specific rules (for example Brazil deny-by-default ACLs) fall back to conservative severities.', 'Trace with a user that can read sys_properties.');

  // ---- plugins ----
  for (const p of ev.plugins || []) if (!p.active)
    add('PLUGIN-INACTIVE', 'High', 'gap', `AI app "${p.name}" (${p.scope}) is inactive`, `Version ${p.version || '?'}.`, 'Activate it, or confirm it is not needed.');

  // ---- rank ----
  F.sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) || (CAUSAL_RANK[a.id] ?? 50) - (CAUSAL_RANK[b.id] ?? 50));
  const causal = F.filter(f => f.severity !== 'Info').sort((a, b) => (CAUSAL_RANK[a.id] ?? 50) - (CAUSAL_RANK[b.id] ?? 50) || SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
  const rootCause = causal[0] || null;
  // Other independent candidates close to the cause (a run can fail for more than one reason).
  const alsoLikely = causal.slice(1).filter(f => (CAUSAL_RANK[f.id] ?? 50) <= 4).slice(0, 3);
  return { findings: F, rootCause, alsoLikely };
}

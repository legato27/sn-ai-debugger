// Evidence collectors. Everything here is read-only and dictionary-driven: reference fields
// are discovered from sys_dictionary instead of being hard-coded.
import { TABLES, RESOLVE_ORDER, KIND_LABEL, PLUGIN_SCOPE_QUERY, DEFAULT_SETTINGS, AI_ACL_TYPES, RELEASE_PROPS, RELEASE_ORDER, SKILL_FLOW_QUICK_MODE_PROP } from './config.js';
import { Schema, v, d, pickFromRow } from './schema.js';
import { buildTimeline, summarizeBackground, extractText, vaSide } from './timeline.js';
import { isFail, isStuckCandidate, planFailed, minutesSince, trunc, annotateLinks, runContext, nonAnswer } from './rules.js';

const HEX32 = /^[0-9a-f]{32}$/i;
const DEP_TABLES = [
  'sys_script_include', 'sys_hub_flow', 'sys_hub_action_type_definition', 'sys_generative_ai_config',
  'sn_nowassist_skill_config', 'sys_ws_operation', 'sys_rest_message', 'sys_one_extend_capability',
  'sys_script', 'sys_hub_step_instance',
];

export const snTime = s => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);
export const fmtTime = dt => dt.toISOString().slice(0, 19).replace('T', ' ');

export async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Extract table + sys_id from a ServiceNow URL (classic, Next Experience, workspace).
export function parseSnUrl(url) {
  if (!url) return {};
  let s = url;
  try { s = decodeURIComponent(decodeURIComponent(url)); } catch (e) {}
  let m = s.match(/\/([a-z0-9_]+)\.do\?(?:[^#]*&)?sys_id=([0-9a-f]{32})/i);
  if (m) return { table: m[1], sysId: m[2] };
  // Workspaces nest records: …/record/sn_hr_er_case/<id>/…/sub/record/sn_em_evidence/<id>. The last
  // one is the record on screen; the others (newest first) are kept as context.
  const recs = [...s.matchAll(/\/record\/([a-z0-9_]+)\/([0-9a-f]{32})/gi)].map(x => ({ table: x[1], sysId: x[2] }));
  if (recs.length) return recs.length > 1 ? { ...recs[recs.length - 1], records: recs.slice().reverse() } : recs[0];
  m = s.match(/([0-9a-f]{32})/i);
  if (m) return { sysId: m[1] };
  return {};
}

export class Collector {
  constructor(client, settings = {}, log = () => {}) {
    this.c = client;
    this.s = { ...DEFAULT_SETTINGS, ...settings };
    this.log = log;
    this.schema = new Schema(client);
    this.T = {};
    this.ev = null;
  }

  async init() {
    const keys = Object.keys(TABLES);
    const found = await mapLimit(keys, 4, k => this.schema.firstExisting(TABLES[k]));
    keys.forEach((k, i) => { this.T[k] = found[i]; });
    const probes = [...this.schema._exists.values()];
    if (probes.length && probes.every(p => p.status === 401))
      throw new Error('ServiceNow rejected the session (401). Reload the ServiceNow tab, make sure you are signed in, and try again.');
    if (!this.T.plan && !this.T.agent)
      this.log('AI Agent tables are not readable for your user, or the AI Agents plugin is not installed.');
    await this.skillTableFromLog();
    return this.T;
  }

  // The Gen AI log's skill reference (Skill Config Id) names the real skill table on this
  // release. Prefer it to the guessed names in config.js; keep the guess if the dictionary is closed.
  async skillTableFromLog() {
    if (!this.T.genaiLog) return;
    const fields = await this.schema.fields(this.T.genaiLog);
    const hit = [...fields].find(([el, f]) => f.type === 'reference' && f.reference && /skill/i.test(el));
    const target = hit?.[1].reference;
    if (!target || target === this.T.skill) return;
    if ((await this.schema.probe(target)).exists) {
      this.log(`Skill table read from ${this.T.genaiLog}.${hit[0]}: ${target}`);
      this.T.skill = target;
    }
  }

  kindForTable(table) {
    for (const [k, t] of Object.entries(this.T)) if (t && t === table) return k;
    for (const [k, list] of Object.entries(TABLES)) if (list.includes(table)) return k;
    return 'generic';
  }

  newEvidence(input) {
    this.ev = {
      meta: { input, startedAt: new Date().toISOString(), tables: this.T, apiCalls: 0, version: '0.5.0' },
      user: null, root: null, sections: [], plugins: [],
      norm: { plan: null, tasks: [], messages: [], toolExecs: [], genaiLogs: [], syslog: [], runInfo: [], http: [], flows: [], rca: [], guard: [], agents: [], tools: [], skills: [] },
      recentPlans: [], candidates: [], warnings: [],
    };
    return this.ev;
  }

  section(key, title, table, rows, extra = {}) {
    const sec = { key, title, table, rows: rows || [], ...extra };
    this.ev.sections.push(sec);
    return sec;
  }

  async list(table, query, { limit = this.s.rowLimit, order = '^ORDERBYDESCsys_created_on', fields } = {}) {
    if (!table) return { ok: false, rows: [], status: 404, error: 'table not present on this instance' };
    const r = await this.c.get(`/api/now/table/${table}`, {
      sysparm_query: (query || '') + (order || ''), sysparm_limit: limit,
      sysparm_display_value: 'all', sysparm_exclude_reference_link: 'true', sysparm_fields: fields, sysparm_no_count: 'true',
    });
    return { ok: r.ok, rows: r.ok ? (r.result || []) : [], status: r.status, error: r.error };
  }

  async byId(table, id) {
    if (!table || !HEX32.test(id || '')) return null;
    const r = await this.c.get(`/api/now/table/${table}/${id}`, { sysparm_display_value: 'all', sysparm_exclude_reference_link: 'true' });
    return r.ok ? r.result : null;
  }

  // ---------------- entry point ----------------

  async trace(input, { url } = {}) {
    await this.init();
    this.newEvidence(input || url);
    await this.collectUser();
    await this.collectPlatform();
    let table, id, records = [];
    const raw = (input || '').trim();
    if (/^https?:\/\//i.test(raw)) ({ table, sysId: id, records = [] } = parseSnUrl(raw));
    else if (HEX32.test(raw)) id = raw.toLowerCase();
    else if (!raw && url) ({ table, sysId: id, records = [] } = parseSnUrl(url));

    if (!id && raw) { await this.searchByName(raw); this.ev.meta.finishedAt = new Date().toISOString(); this.ev.meta.apiCalls = this.c.calls; return this.ev; }
    if (!id) { this.ev.warnings.push('No sys_id found in the input or the current page.'); return this.ev; }

    let kind = table ? this.kindForTable(table) : null, row = null;
    if (table) row = await this.byId(table, id);
    if (!row) {
      for (const k of RESOLVE_ORDER) {
        if (!this.T[k]) continue;
        row = await this.byId(this.T[k], id);
        if (row) { kind = k; table = this.T[k]; break; }
      }
    }
    if (!row && !table && this.T.genaiLog && (await this.schema.fields(this.T.genaiLog)).has('metadata_document')) {
      // A bare sys_id of a business record: the Gen AI log names its table when a skill ran on it.
      const r = await this.list(this.T.genaiLog, `metadata_document=${id}`, { limit: 1, fields: 'metadata_table' });
      const t = v(r.rows[0], 'metadata_table');
      if (t) { table = t; kind = 'record'; row = (await this.byId(t, id)) || { sys_id: id }; }
    }
    if (!row) {
      this.ev.warnings.push(`sys_id ${id} was not found in any AI table${table ? ' (or in ' + table + ')' : ''}, or you cannot read it.`);
      await this.collectPlugins();
      return this.finish();
    }
    if (!kind || kind === 'generic') kind = 'record';   // a business record: incident, HR case, evidence…
    this.ev.root = { kind, table, sysId: id, label: kind === 'record' ? `Record (${table})` : KIND_LABEL[kind] || table, display: displayOf(row) };
    this.log(`Resolved ${KIND_LABEL[kind] || table}: ${displayOf(row)}`);

    if (kind === 'plan') await this.tracePlan(row);
    else if (kind === 'task' || kind === 'message' || kind === 'toolExec') await this.traceViaParentPlan(table, row);
    else if (kind === 'agent') await this.traceAgent(row);
    else if (kind === 'workflow') await this.traceWorkflow(row);
    else if (kind === 'tool') await this.traceTool(row);
    else if (kind === 'skill' || kind === 'prompt' || kind === 'capability') await this.traceSkill(table, row);
    else if (kind === 'genaiLog') await this.traceGenaiLog(row);
    else if (kind === 'conversation') await this.traceConversation(row);
    else await this.traceRecord(table, row, records);

    await this.collectPromptConfigs();
    await this.collectReplyHistory();
    await this.collectPlugins();
    return this.finish();
  }

  // For a skill whose reply in this trace was not an answer (rules.nonAnswer): its last successful
  // replies, to tell a one-off from how the skill always behaves. Live: a wrapper skill gave the same
  // "Understood…" reply on 40 of 40 calls; its inner skill asked for attachments on 4 of 40.
  async collectReplyHistory() {
    const G = this.T.genaiLog, n = this.ev.norm;
    if (!G || !this.T.skill) return;
    const field = (await this.schema.refFieldsTo(G, this.T.skill))[0];
    const stateF = (await this.schema.pick(G, 'state')) || 'status';
    const flagged = new Map();
    for (const g of n.genaiLogs) if (g.skillId && !isFail(g) && nonAnswer(g.response) && !flagged.has(g.skillId)) flagged.set(g.skillId, String(g.response).trim());
    if (!field || !flagged.size) return;
    n.replyHistory = {};
    await mapLimit([...flagged].slice(0, 3), 2, async ([id, reply]) => {
      const r = await this.list(G, `${field}=${id}^${stateF}=success`, { limit: 20, fields: 'sys_id,response' });
      const replies = r.rows.map(x => String(v(x, 'response') ?? '').trim());
      n.replyHistory[id] = { sampled: replies.length, same: replies.filter(x => x === reply).length, nonAnswers: replies.filter(x => nonAnswer(x)).length };
    });
  }

  // Token limits of the prompt configs behind the LLM calls, for the truncation rule (SKILL-TRUNCATED).
  async collectPromptConfigs() {
    const ids = [...new Set(this.ev.norm.genaiLogs.map(g => g.promptConfigId).filter(Boolean))].slice(0, 5);
    if (!ids.length || !this.T.genaiLog) return;
    const ref = (await this.schema.forwardRefs(this.T.genaiLog)).find(r => /prompt_config/.test(r.field) || /generative_ai(_prompt)?_config/.test(r.reference));
    const table = ref?.reference || this.T.prompt;
    const out = {};
    // Live chain: sys_generative_ai_log.prompt_config_id → sys_generative_ai_prompt_config.ai_config
    // → sys_generative_ai_config.max_tokens. Follow one hop when the first record has no limit.
    const hops = (await this.schema.forwardRefs(table)).filter(r => /generative_ai_config$/.test(r.reference) && r.reference !== table);
    await mapLimit(ids, 3, async id => {
      let row = await this.byId(table, id), at = table;
      if (!row) return;
      if (num(pv(row, 'maxTokens')) == null) for (const h of hops) {
        const next = v(row, h.field) && await this.byId(h.reference, v(row, h.field));
        if (next) { row = next; at = h.reference; break; }
      }
      out[id] = { id, table: at, name: displayOf(row), maxTokens: num(pv(row, 'maxTokens')) };
    });
    this.ev.norm.promptConfigs = out;
  }

  finish() {
    const vaSec = this.ev.sections.find(s => s.key === 'vaMessage');
    annotateLinks(this.ev);
    this.ev.background = summarizeBackground(this.ev.norm);
    this.ev.timeline = buildTimeline(this.ev.norm, { ...this.T, syslog: 'syslog', vaMessage: vaSec?.table || 'sys_cs_message' });
    this.ev.meta.finishedAt = new Date().toISOString();
    this.ev.meta.apiCalls = this.c.calls;
    this.ev.meta.dictionaryReadable = this.schema.dictionaryReadable;
    return this.ev;
  }

  // ---------------- user, plugins ----------------

  async collectUser() {
    const who = await this.c.whoami();
    let userId = who.userID, userName = who.userName;
    if (!userId && userName) {
      const r = await this.list('sys_user', `user_name=${userName}`, { limit: 1, order: '' });
      userId = v(r.rows[0], 'sys_id');
    }
    let fullName = who.fullName;
    if (userId && !userName) {   // Next Experience: window.NOW.user carries only userID and isImpersonating
      const u = await this.byId('sys_user', userId);
      userName = v(u, 'user_name') || '';
      fullName ||= d(u, 'name') || '';
    }
    const roles = userId ? await this.rolesOf(userId) : [];
    this.ev.user = { ...who, userID: userId, userName, fullName, roles, isAdmin: roles.includes('admin') };
    this.ev.meta.instance = who.host;
  }

  async rolesOf(userId) {
    const r = await this.list('sys_user_has_role', `user=${userId}`, { limit: 2000, order: '', fields: 'role,state' });
    return [...new Set(r.rows.filter(x => !v(x, 'state') || v(x, 'state') === 'active').map(x => d(x, 'role')).filter(Boolean))];
  }

  // Release family/patch and the AI properties that change behaviour (kill switch, MCP guardian).
  async collectPlatform() {
    const r = await this.list('sys_properties', `nameIN${RELEASE_PROPS.join(',')}^ORnameLIKEkill_switch^ORnameLIKEmcp_guardian_check^ORname=${SKILL_FLOW_QUICK_MODE_PROP}`, { limit: 40, order: '', fields: 'name,value' });
    const props = Object.fromEntries(r.rows.map(x => [v(x, 'name'), v(x, 'value')]));
    const build = RELEASE_PROPS.map(p => props[p]).filter(Boolean).join(' ');
    this.ev.platform = { ...parseRelease(build), build: build.slice(0, 160), readable: r.ok, props: Object.fromEntries(Object.entries(props).filter(([k]) => !RELEASE_PROPS.includes(k))) };
    if (r.ok && this.ev.platform.family) this.log(`Release: ${this.ev.platform.family}${this.ev.platform.patch ? ' patch ' + this.ev.platform.patch : ''}`);
  }

  // All ACLs of the agentic AI types, once per trace, with their roles.
  async aiAcls() {
    if (this._aiAcls) return this._aiAcls;
    const fields = 'sys_id,name,operation,type,type.name,active,advanced,condition,decision_type,security_attribute,admin_overrides';
    let r = await this.list('sys_security_acl', `type.nameIN${AI_ACL_TYPES.join(',')}`, { limit: 1000, order: '', fields });
    if (r.ok && !r.rows.length) r = await this.list('sys_security_acl', `typeIN${AI_ACL_TYPES.join(',')}`, { limit: 1000, order: '', fields });
    const rows = r.rows;
    const ids = rows.map(x => v(x, 'sys_id'));
    const roles = ids.length ? (await this.list('sys_security_acl_role', `sys_security_aclIN${ids.join(',')}`, { limit: 2000, order: '' })).rows : [];
    this._aiAcls = { ok: r.ok, status: r.status, list: rows.map(a => ({
      id: v(a, 'sys_id'), name: String(v(a, 'name') || ''), type: String(v(a, 'type.name') || (AI_ACL_TYPES.includes(String(v(a, 'type')).toLowerCase()) ? v(a, 'type') : d(a, 'type')) || '').toLowerCase(),
      operation: d(a, 'operation'), active: String(v(a, 'active')) === 'true', advanced: String(v(a, 'advanced')) === 'true',
      decision: d(a, 'decision_type'), securityAttribute: d(a, 'security_attribute'), condition: v(a, 'condition'),
      roles: roles.filter(x => v(x, 'sys_security_acl') === v(a, 'sys_id')).map(x => d(x, 'sys_user_role')),
    })) };
    if (rows.length) this.section('aiAcl', 'Agentic AI ACLs (all)', 'sys_security_acl', rows, { status: st(r) });
    return this._aiAcls;
  }

  // ACL coverage for one component: its own ACLs and the type's wildcard fallback.
  async aclCoverage(type, ...keys) {
    const all = await this.aiAcls();
    const ks = keys.filter(Boolean).map(k => String(k).toLowerCase());
    const ofType = all.list.filter(a => a.type.replace(/\s+/g, '_') === type || a.type === type.replace(/_/g, ' '));
    const own = ofType.filter(a => ks.some(k => a.name.toLowerCase().includes(k)));
    const wildcard = ofType.filter(a => /^\*$|\.\*$|^\*\./.test(a.name));
    return { type, readable: all.ok, own, wildcard };
  }

  async collectPlugins() {
    const r = await this.list('sys_store_app', PLUGIN_SCOPE_QUERY, { limit: 100, order: '^ORDERBYscope', fields: 'scope,name,version,active,sys_updated_on' });
    this.ev.plugins = r.rows.map(x => ({ scope: v(x, 'scope'), name: d(x, 'name'), version: v(x, 'version'), active: String(v(x, 'active')) === 'true', updated: v(x, 'sys_updated_on') }));
    this.section('plugins', 'AI plugins and store apps', 'sys_store_app', r.rows, { status: r.ok ? 'ok' : 'error', error: r.error });
  }

  // ---------------- plan ----------------

  async traceViaParentPlan(table, row) {
    this.section('root', KIND_LABEL[this.kindForTable(table)] || table, table, [row]);
    const fields = this.T.plan ? await this.schema.refFieldsTo(table, this.T.plan) : [];
    const planId = fields.map(f => v(row, f)).find(Boolean);
    const plan = planId ? await this.byId(this.T.plan, planId) : null;
    if (plan) { this.ev.root.parentPlan = planId; await this.tracePlan(plan); }
    else this.ev.warnings.push('Could not find the parent execution plan for this record.');
  }

  async tracePlan(plan) {
    const P = this.T.plan, id = v(plan, 'sys_id');
    this.section('plan', 'Execution plan', P, [plan]);
    const n = this.ev.norm;
    n.plan = normPlan(plan);

    // Children of the plan, discovered from the dictionary.
    let children = await this.schema.reverseRefs(P);
    if (!children.length) {   // dictionary not readable: fall back to documented tables and a guessed field
      children = ['task', 'message'].filter(k => this.T[k]).map(k => ({ table: this.T[k], field: 'execution_plan' }));
    }
    const byTable = groupBy(children, c => c.table);
    await mapLimit(Object.entries(byTable), 3, async ([table, refs]) => {
      if (table === P) return;
      const q = refs.map(r => `${r.field}=${id}`).join('^OR');
      const r = await this.list(table, q, { order: '^ORDERBYsys_created_on', limit: Math.max(this.s.rowLimit, 100) });
      if (!r.rows.length && r.ok) return;
      const kind = classifyChild(table);
      const title = { task: 'Execution tasks', message: 'Messages', toolExec: 'Tool executions' }[kind] || `Related: ${table}`;
      this.section(kind || 'related', title, table, r.rows, { status: r.ok ? 'ok' : 'error', error: r.error, via: refs.map(x => x.field).join(',') });
      if (kind === 'task') n.tasks.push(...r.rows.map(normTask));
      if (kind === 'message') n.messages.push(...r.rows.map(normMessage));
      if (kind === 'toolExec') n.toolExecs.push(...r.rows.map(normToolExec));
    });

    // Agents and workflow involved.
    const agentIds = new Set(), wfIds = new Set();
    if (this.T.agent) {
      for (const f of await this.schema.refFieldsTo(P, this.T.agent)) { const x = v(plan, f); if (x) agentIds.add(x); }
      for (const sec of this.ev.sections.filter(s => s.key === 'task' || s.key === 'toolExec')) {
        for (const f of await this.schema.refFieldsTo(sec.table, this.T.agent)) for (const r of sec.rows) { const x = v(r, f); if (x) agentIds.add(x); }
        for (const r of sec.rows) { docTargets(r, this.T.agent).forEach(x => agentIds.add(x)); docTargets(r, this.T.workflow).forEach(x => wfIds.add(x)); }
      }
    }
    if (this.T.workflow) for (const f of await this.schema.refFieldsTo(P, this.T.workflow)) { const x = v(plan, f); if (x) wfIds.add(x); }
    // No team fallback here: on a live instance a workflow's team was shared with unrelated agents,
    // so describing it for a run that never reached an agent added noise, not evidence.
    for (const wid of wfIds) {
      const wf = await this.byId(this.T.workflow, wid);
      if (wf) { this.section('workflow', 'Agentic workflow', this.T.workflow, [wf]); n.workflow = normGeneric(wf); n.workflowAcl = await this.aclCoverage('gen_ai_workflow', wid, v(wf, 'internal_name'), v(wf, 'name')); }
    }
    await mapLimit([...agentIds].slice(0, 6), 2, aid => this.describeAgent(aid));

    // The Virtual Agent conversation this run belongs to, if any.
    await this.collectConversationForPlan(plan);

    // Gen AI log rows share the plan's (and its tasks') usage-log reference, which links them
    // more precisely than the time window.
    const usageIds = new Set();
    if (this.T.usageLog) {
      for (const f of await this.schema.refFieldsTo(P, this.T.usageLog)) { const x = v(plan, f); if (x) usageIds.add(x); }
      for (const sec of this.ev.sections.filter(s => s.key === 'task')) for (const f of await this.schema.refFieldsTo(sec.table, this.T.usageLog)) sec.rows.forEach(r => v(r, f) && usageIds.add(v(r, f)));
    }

    // Time-correlated logs.
    const from = new Date(snTime(v(plan, 'sys_created_on')).getTime() - this.s.windowMinutes * 60000);
    const to = new Date((snTime(v(plan, 'sys_updated_on')) || new Date()).getTime() + this.s.windowMinutes * 60000);
    await this.collectWindowLogs(from, to, { planId: id, usageIds: [...usageIds], conversationId: n.conversationId });
  }

  // Agents on an agentic workflow's team. Team members may reference the workflow directly, or
  // (live instance) a team that the workflow references: sn_aia_usecase.team → sn_aia_team ← sn_aia_team_member.team.
  async teamAgentIds(table, id) {
    const TM = this.T.teamMember;
    if (!TM || !this.T.agent || !table || !id) return [];
    const byAgent = await this.schema.refFieldsTo(TM, this.T.agent);
    if (!byAgent.length) return [];
    const conds = (await this.schema.refFieldsTo(TM, table)).map(f => `${f}=${id}`);
    if (!conds.length) {
      const wf = await this.byId(table, id);
      for (const ref of await this.schema.forwardRefs(table)) {
        const val = v(wf, ref.field);
        if (val && ref.reference !== table) for (const f of await this.schema.refFieldsTo(TM, ref.reference)) conds.push(`${f}=${val}`);
      }
    }
    if (!conds.length) return [];
    const r = await this.list(TM, conds.join('^OR'), { limit: 20, order: '' });
    if (r.rows.length) this.section('teams', 'Workflow team members', TM, r.rows);
    return [...new Set(r.rows.flatMap(x => byAgent.map(f => v(x, f))).filter(Boolean))];
  }

  async collectWindowLogs(from, to, { planId, skipGenai, usageIds = [], conversationId } = {}) {
    const win = `sys_created_on>=${fmtTime(from)}^sys_created_on<=${fmtTime(to)}`;
    this.ev.meta.window = { from: fmtTime(from), to: fmtTime(to) };
    const n = this.ev.norm;
    const jobs = [];

    jobs.push(async () => {   // Gen AI log: the most precise link available, else the time window
      if (!this.T.genaiLog || skipGenai) return;
      const G = this.T.genaiLog;
      let q = win, note = 'matched by time window';
      const byPlan = planId && this.T.plan ? await this.schema.refFieldsTo(G, this.T.plan) : [];
      const byUsage = usageIds.length && this.T.usageLog ? await this.schema.refFieldsTo(G, this.T.usageLog) : [];
      const byConv = conversationId && this.T.conversation ? await this.schema.refFieldsTo(G, this.T.conversation) : [];
      if (byPlan.length) { q = byPlan.map(x => `${x}=${planId}`).join('^OR'); note = 'linked to the plan'; }
      else if (byUsage.length) { q = byUsage.map(x => `${x}IN${usageIds.join(',')}`).join('^OR'); note = 'linked by usage log'; }
      else if (byConv.length) { q = `${win}^${byConv[0]}=${conversationId}`; note = 'same conversation, in the time window'; }
      const r = await this.list(G, q, { limit: 50 });
      this.section('genaiLog', 'Generative AI log', G, r.rows, { status: st(r), error: r.error, note });
      const existing = new Set(n.genaiLogs.map(x => x.id));
      n.genaiLogs.push(...r.rows.map(normGenaiLog).filter(x => !existing.has(x.id)));
    });
    jobs.push(async () => {   // System log: the run's own lines (all levels), plus a window sample for the background summary
      const fields = 'sys_id,sys_created_on,level,source,message,sys_created_by,context_map';
      const ctx = runContext(this.ev);
      const users = [...ctx.users].slice(0, 6);
      const ids = [this.ev.root?.sysId, n.plan?.id, ...n.genaiLogs.map(g => g.id), ...[...ctx.ids]].filter(Boolean);
      const terms = [...(users.length ? [`sys_created_byIN${users.join(',')}`] : []), ...[...new Set(ids)].slice(0, 8).flatMap(id => [`messageLIKE${id}`, `context_mapLIKE${id}`])];
      const runQ = terms.length ? `${win}^${terms.join('^OR')}` : null;
      this.ev.meta.runLogQuery = runQ;   // reused by "Open in System Log"
      // Warnings and errors are fetched apart from info and debug lines: a live instance writes about
      // 12 info lines a second, which would otherwise crowd the errors out of the row limit.
      // Level 3 is Fatal. [V] live sys_choice
      const none = { ok: true, rows: [] };
      const [own, info, sample] = await Promise.all([
        runQ ? this.list('syslog', `${win}^levelIN1,2,3^${terms.join('^OR')}`, { limit: 100, fields }) : none,
        runQ ? this.list('syslog', `${win}^levelNOT IN1,2,3^${terms.join('^OR')}`, { limit: 150, fields }) : none,
        this.list('syslog', `${win}^levelIN1,2,3`, { limit: 200, fields: 'sys_id,sys_created_on,level,source,message,sys_created_by' }),
      ]);
      const seen = new Set(own.rows.map(x => v(x, 'sys_id')));
      const rows = [...own.rows, ...sample.rows.filter(x => !seen.has(v(x, 'sys_id')))];
      this.section('syslog', 'System log (warnings and errors)', 'syslog', rows, { status: st(sample), error: sample.error, note: `${own.rows.length} linked to the run, ${rows.length - own.rows.length} from the same minutes` });
      n.syslog.push(...rows.map(normSyslog));
      if (runQ) {
        this.section('runInfo', 'System log (the run\'s info and debug lines)', 'syslog', info.rows, { status: st(info), error: info.error, note: info.rows.length >= 150 ? 'first 150; open the System Log list for the rest' : undefined });
        n.runInfo.push(...info.rows.map(normSyslog));
      }
    });
    jobs.push(async () => {
      if (!this.T.http) return;
      const r = await this.list(this.T.http, win, { limit: 100 });
      this.section('http', 'Outbound HTTP log', this.T.http, r.rows, { status: st(r), error: r.error });
      n.http.push(...r.rows.map(normHttp));
    });
    jobs.push(async () => {
      if (!this.T.flow) return;
      const F = this.T.flow;   // only the columns the rules read: a full fetch of 100 flow contexts took 6.6 s live
      const fields = ['sys_id', 'sys_created_on', 'sys_updated_on', 'sys_created_by', 'name', await this.schema.pick(F, 'state'), await this.schema.pick(F, 'error')].filter(Boolean).join(',');
      const r = await this.list(F, `sys_updated_on>=${fmtTime(from)}^sys_created_on<=${fmtTime(to)}`, { limit: 100, fields });
      this.section('flow', 'Flow / subflow executions', this.T.flow, r.rows, { status: st(r), error: r.error });
      n.flows.push(...r.rows.map(normGeneric));
    });
    jobs.push(async () => {
      if (!this.T.rca) return;
      const wide = `sys_updated_on>=${fmtTime(new Date(from.getTime() - 10 * 60000))}^sys_updated_on<=${fmtTime(new Date(to.getTime() + 10 * 60000))}`;
      const r = await this.list(this.T.rca, wide, { limit: 50, order: '^ORDERBYDESCsys_updated_on' });
      this.section('rca', 'Restricted caller access', this.T.rca, r.rows, { status: st(r), error: r.error });
      n.rca.push(...r.rows.map(normGeneric));
    });
    jobs.push(async () => {   // AI Guardian tables, discovered by name
      const r = await this.list('sys_db_object', 'nameLIKEguardrail^ORnameLIKEguardian', { limit: 10, order: '', fields: 'name,label' });
      for (const t of r.rows.map(x => v(x, 'name')).filter(Boolean).slice(0, 4)) {
        const g = await this.list(t, win, { limit: 50 });
        if (g.rows.length) { this.section('guard', `AI Guardian: ${t}`, t, g.rows, { status: st(g) }); n.guard.push(...g.rows.map(x => ({ ...normGeneric(x), table: t }))); }
      }
    });
    await mapLimit(jobs, 3, j => j());
  }

  // ---------------- agent ----------------

  async describeAgent(agentId) {
    const A = this.T.agent;
    const agent = await this.byId(A, agentId);
    if (!agent) { this.ev.warnings.push(`Agent ${agentId} referenced by the run could not be read.`); return null; }
    this.section('agent', `AI agent: ${displayOf(agent)}`, A, [agent]);
    const na = normAgent(agent);

    // Tools via the agent-tool M2M.
    const M = this.T.agentToolM2M;
    if (M) {
      const agentField = (await this.schema.refFieldsTo(M, A))[0] || 'agent';
      const toolRef = (await this.schema.forwardRefs(M)).find(r => r.field !== agentField && /tool/.test(r.reference + r.field));
      const r = await this.list(M, `${agentField}=${agentId}`, { limit: 100, order: '' });
      this.section('agentTools', `Tool bindings: ${na.name}`, M, r.rows, { status: st(r), error: r.error });
      const toolTable = toolRef?.reference || this.T.tool;
      const toolField = toolRef?.field || 'tool';
      const ids = r.rows.map(x => v(x, toolField)).filter(Boolean);
      const tools = ids.length && toolTable ? (await this.list(toolTable, `sys_idIN${ids.join(',')}`, { limit: 100, order: '' })).rows : [];
      this.section('tools', `Tools: ${na.name}`, toolTable, tools);
      for (const b of r.rows) {
        const t = tools.find(x => v(x, 'sys_id') === v(b, toolField));
        const nt = t ? normTool(t) : { id: v(b, toolField), name: d(b, toolField) || '(unknown)', missing: true };
        nt.binding = normGeneric(b);
        nt.agent = na.name;
        if (t) nt.deps = await this.toolDeps(toolTable, t);
        na.tools.push(nt);
      }
    }

    // ACLs that name this agent, and their roles.
    const nameField = pickFromRow(agent, 'name');
    const internal = v(agent, 'internal_name') || v(agent, nameField);
    const aclQ = `nameLIKE${agentId}` + (internal ? `^ORnameLIKE${internal}` : '');
    const acl = await this.list('sys_security_acl', aclQ, { limit: 30, order: '', fields: 'sys_id,name,operation,type,active,admin_overrides,advanced,condition,description' });
    const cov = await this.aclCoverage('gen_ai_agent', agentId, internal);
    na.aclCoverage = { readable: cov.readable, own: cov.own.length, wildcard: cov.wildcard };
    for (const a of cov.own) if (!acl.rows.some(x => v(x, 'sys_id') === a.id)) na.acls.push(a);
    if (acl.rows.length) {
      const ar = await this.list('sys_security_acl_role', `sys_security_aclIN${acl.rows.map(x => v(x, 'sys_id')).join(',')}`, { limit: 200, order: '' });
      na.acls = na.acls.concat(acl.rows.map(a => ({
        id: v(a, 'sys_id'), name: v(a, 'name'), operation: d(a, 'operation'), type: d(a, 'type'),
        active: String(v(a, 'active')) === 'true', advanced: String(v(a, 'advanced')) === 'true', condition: v(a, 'condition'),
        roles: ar.rows.filter(x => v(x, 'sys_security_acl') === v(a, 'sys_id')).map(x => d(x, 'sys_user_role')),
      })));
      this.section('acl', `ACLs: ${na.name}`, 'sys_security_acl', acl.rows, { status: st(acl) });
    } else if (!acl.ok) this.ev.warnings.push(`Could not read ACLs (${acl.status}): ${acl.error}`);

    // Run-as identity.
    const userRefs = (await this.schema.forwardRefs(A)).filter(r => r.reference === 'sys_user' && !/^sys_/.test(r.field));
    const runAsField = userRefs.find(r => /run|as|identity|user/.test(r.field))?.field;
    if (runAsField && v(agent, runAsField)) {
      na.runAs = { field: runAsField, id: v(agent, runAsField), name: d(agent, runAsField) };
      na.runAs.userName = v(await this.byId('sys_user', na.runAs.id), 'user_name') || undefined;
      na.runAs.roles = await this.rolesOf(na.runAs.id);
    }
    this.ev.norm.agents.push(na);
    return na;
  }

  async toolDeps(toolTable, tool) {
    const deps = [];
    for (const ref of await this.schema.forwardRefs(toolTable)) {
      const isSkill = ref.reference === 'sn_nowassist_skill_config' || ref.reference === this.T.skill;
      if (!DEP_TABLES.includes(ref.reference) && !isSkill) continue;
      const id = v(tool, ref.field);
      if (!id) continue;
      const rec = await this.byId(ref.reference, id);
      const dep = { field: ref.field, table: ref.reference, id, display: d(tool, ref.field), found: Boolean(rec), active: rec ? String(v(rec, 'active')) !== 'false' : null, name: rec ? displayOf(rec) : null };
      const aclType = ref.reference === 'sys_hub_flow' ? 'flow' : ref.reference === 'sys_hub_action_type_definition' ? 'flow_action' : isSkill ? 'gen_ai_skill' : null;
      if (aclType && rec) { const c = await this.aclCoverage(aclType, id, v(rec, 'internal_name'), v(rec, 'name')); dep.acl = { type: aclType, readable: c.readable, own: c.own.length, wildcard: c.wildcard }; }
      deps.push(dep);
    }
    return deps;
  }

  async recentPlansFor(table, id) {
    if (!this.T.plan) return;
    const f = await this.schema.refFieldsTo(this.T.plan, table);
    let rows = [];
    if (f.length) rows = (await this.list(this.T.plan, f.map(x => `${x}=${id}`).join('^OR'), { limit: 50 })).rows;
    else if (this.T.task && table === this.T.agent) {   // plans reached through tasks
      const tf = await this.schema.refFieldsTo(this.T.task, table);
      const pf = (await this.schema.refFieldsTo(this.T.task, this.T.plan))[0];
      if (tf.length && pf) {
        const tasks = (await this.list(this.T.task, tf.map(x => `${x}=${id}`).join('^OR'), { limit: 30 })).rows;
        const pids = [...new Set(tasks.map(t => v(t, pf)).filter(Boolean))].slice(0, 15);
        if (pids.length) rows = (await this.list(this.T.plan, `sys_idIN${pids.join(',')}`, { limit: 15 })).rows;
      }
    }
    this.ev.recentPlans = rows.map(r => ({ id: v(r, 'sys_id'), display: displayOf(r), state: d(r, pickFromRow(r, 'state')), created: v(r, 'sys_created_on'), objective: String(v(r, 'objective') || v(r, 'short_description') || '').slice(0, 300) }));
  }

  async traceAgent(agent) {
    const id = v(agent, 'sys_id');
    await this.describeAgent(id);
    await this.recentPlansFor(this.T.agent, id);
    const tm = this.T.teamMember;
    if (tm) {
      const f = await this.schema.refFieldsTo(tm, this.T.agent);
      if (f.length) {
        const r = await this.list(tm, f.map(x => `${x}=${id}`).join('^OR'), { limit: 50, order: '' });
        this.section('teams', 'Workflows (teams) using this agent', tm, r.rows);
      }
    }
    // Sibling agents for description-overlap checks.
    const sib = await this.list(this.T.agent, 'active=true', { limit: 200, order: '' });
    this.ev.norm.siblingAgents = sib.rows.map(normAgent);
  }

  async traceWorkflow(wf) {
    const W = this.T.workflow, id = v(wf, 'sys_id');
    this.section('workflow', 'Agentic workflow', W, [wf]);
    this.ev.norm.workflow = normGeneric(wf);
    this.ev.norm.workflowAcl = await this.aclCoverage('gen_ai_workflow', id, v(wf, 'internal_name'), v(wf, 'name'));
    const agentIds = new Set();
    for (const { table, field } of await this.schema.reverseRefs(W)) {
      if (table === this.T.plan) continue;
      const r = await this.list(table, `${field}=${id}`, { limit: 50, order: '' });
      if (!r.rows.length) continue;
      this.section(/trigger/.test(table) ? 'trigger' : /team/.test(table) ? 'teams' : 'related', table, table, r.rows);
      if (this.T.agent) for (const f of await this.schema.refFieldsTo(table, this.T.agent)) r.rows.forEach(x => v(x, f) && agentIds.add(v(x, f)));
      if (/trigger/.test(table)) this.ev.norm.triggers = r.rows.map(normGeneric);
    }
    if (!agentIds.size) (await this.teamAgentIds(W, id)).forEach(x => agentIds.add(x));
    await mapLimit([...agentIds].slice(0, 8), 2, aid => this.describeAgent(aid));
    this.ev.norm.siblingAgents = this.ev.norm.agents.slice();
    await this.recentPlansFor(W, id);
  }

  async traceTool(tool) {
    const table = this.ev.root.table, id = v(tool, 'sys_id');
    const nt = normTool(tool);
    nt.deps = await this.toolDeps(table, tool);
    this.section('tools', `Tool: ${nt.name}`, table, [tool]);
    this.ev.norm.tools.push(nt);
    for (const { table: t, field } of await this.schema.reverseRefs(table)) {
      const r = await this.list(t, `${field}=${id}`, { limit: 25 });
      if (!r.rows.length) continue;
      const kind = classifyChild(t);
      this.section(kind || 'related', kind === 'toolExec' ? 'Recent tool executions' : t, t, r.rows);
      if (kind === 'toolExec') this.ev.norm.toolExecs.push(...r.rows.map(normToolExec));
    }
  }

  // ---------------- skills / gen AI ----------------

  async traceSkill(table, row) {
    const id = v(row, 'sys_id');
    this.section('skill', `${KIND_LABEL[this.kindForTable(table)] || table}: ${displayOf(row)}`, table, [row]);
    this.ev.norm.skills.push(normGeneric(row));
    if (table === this.T.skill || /skill/.test(table)) this.ev.norm.skillAcl = await this.aclCoverage('gen_ai_skill', id, v(row, 'internal_name'), v(row, 'name'));
    // Forward refs that point at prompt / capability / other skill records.
    for (const ref of await this.schema.forwardRefs(table)) {
      if (!/generative|one_extend|nowassist|skill/.test(ref.reference) || !v(row, ref.field)) continue;
      const rec = await this.byId(ref.reference, v(row, ref.field));
      if (rec) this.section('skillDep', `${ref.field} → ${ref.reference}`, ref.reference, [rec]);
      else this.ev.warnings.push(`${table}.${ref.field} points to a ${ref.reference} record that is missing or unreadable.`);
    }
    for (const { table: t, field } of await this.schema.reverseRefs(table)) {
      if (t === this.T.genaiLog || t === this.T.usageLog) continue;
      const r = await this.list(t, `${field}=${id}`, { limit: 25 });
      if (r.rows.length) this.section('skillDep', t, t, r.rows);
    }
    // Logs linked to the skill.
    let q = null;
    if (this.T.genaiLog) {
      const f = await this.schema.refFieldsTo(this.T.genaiLog, table);
      if (f.length) q = f.map(x => `${x}=${id}`).join('^OR');
    }
    if (q) {
      const r = await this.list(this.T.genaiLog, q, { limit: 25 });
      this.section('genaiLog', 'Generative AI log (recent runs of this skill)', this.T.genaiLog, r.rows, { status: st(r), error: r.error });
      this.ev.norm.genaiLogs.push(...r.rows.map(normGenaiLog));
      const latest = r.rows[0] && snTime(v(r.rows[0], 'sys_created_on'));
      if (latest) {
        const w = this.s.windowMinutes * 60000;
        await this.collectWindowLogs(new Date(latest.getTime() - w), new Date(latest.getTime() + w), { skipGenai: true });
      }
    } else this.ev.warnings.push('No reference from the Generative AI log to this record was found, so recent runs could not be linked.');
    if (this.T.usageLog) {
      const f = await this.schema.refFieldsTo(this.T.usageLog, table);
      if (f.length) {
        const r = await this.c.get(`/api/now/stats/${this.T.usageLog}`, { sysparm_count: 'true', sysparm_query: f.map(x => `${x}=${id}`).join('^OR') });
        if (r.ok) this.ev.norm.usageCount = Number(r.result?.stats?.count ?? NaN);
      }
    }
  }

  async traceGenaiLog(row) {
    this.section('genaiLogRoot', 'Generative AI log entry', this.T.genaiLog, [row]);
    this.ev.norm.genaiLogs.push(normGenaiLog(row));
    for (const ref of await this.schema.forwardRefs(this.T.genaiLog)) {
      if (!v(row, ref.field) || /^sys_(user|domain)/.test(ref.reference) || ref.field.startsWith('sys_')) continue;
      const rec = await this.byId(ref.reference, v(row, ref.field));
      if (rec) this.section('skillDep', `${ref.field} → ${ref.reference}`, ref.reference, [rec]);
    }
    // The calls made with this one: same user within ±5 s (a wrapper skill and the skill it calls),
    // and earlier calls on the same record. Other users' calls in the window are not part of it.
    const t = snTime(v(row, 'sys_created_on')), w = this.s.windowMinutes * 60000, G = this.T.genaiLog;
    const by = v(row, 'sys_created_by'), doc = v(row, 'metadata_document');
    const near = `sys_created_by=${by}^sys_created_on>=${fmtTime(new Date(t.getTime() - 5000))}^sys_created_on<=${fmtTime(new Date(t.getTime() + 5000))}`;
    const lists = await Promise.all([by ? this.list(G, near, { limit: 25 }) : { rows: [] }, doc ? this.list(G, `metadata_document=${doc}`, { limit: 10 }) : { rows: [] }]);
    const others = dedupeRows(lists.flatMap(l => l.rows)).filter(x => v(x, 'sys_id') !== v(row, 'sys_id'));
    if (others.length) this.section('genaiLog', 'Calls made with this one (same user ±5 s, or same record)', G, others, { note: 'linked by user and time, or by metadata_document' });
    this.ev.norm.genaiLogs.push(...others.map(normGenaiLog));
    await this.collectWindowLogs(new Date(t.getTime() - w), new Date(t.getTime() + w), { skipGenai: true });
    this.ev.norm.genaiLogs = dedupeById(this.ev.norm.genaiLogs);
  }

  async traceConversation(row) {
    await this.collectConversation(this.ev.root.table, row);
    await this.recentPlansFor(this.ev.root.table, v(row, 'sys_id'));
    if (this.ev.recentPlans[0]) {
      const plan = await this.byId(this.T.plan, this.ev.recentPlans[0].id);
      if (plan) await this.tracePlan(plan);
    }
  }

  // Find the VA conversation a plan belongs to: a reference field first, then any
  // conversation-named field holding a sys_id.
  async collectConversationForPlan(plan) {
    const C = this.T.conversation;
    if (!C || this.ev.norm.conversation) return;
    let convId = null;
    for (const f of await this.schema.refFieldsTo(this.T.plan, C)) if (v(plan, f)) { convId = v(plan, f); break; }
    if (!convId) {
      const k = Object.keys(plan).find(x => /conversation|interaction/.test(x) && /^[0-9a-f]{32}$/i.test(String(v(plan, x) || '')));
      if (k) convId = v(plan, k);
    }
    if (!convId) { this.ev.norm.conversationLink = 'none'; return; }
    this.ev.norm.conversationId = convId;
    const row = await this.byId(C, convId);
    if (row) await this.collectConversation(C, row);
    else this.ev.warnings.push(`The plan points to conversation ${convId}, but it could not be read.`);
  }

  async collectConversation(table, row) {
    const id = v(row, 'sys_id');
    this.section('conversation', 'VA conversation', table, [row]);
    const n = this.ev.norm;
    n.conversation = { ...normGeneric(row), id, deviceType: d(row, 'device_type'), state: d(row, pickFromRow(row, 'state')) };
    // Message table: whatever sys_cs_* table references the conversation and looks like messages.
    let refs = (await this.schema.reverseRefs(table)).filter(r => /message|transcript/.test(r.table) && r.table !== this.T.message);
    if (!refs.length) refs = [{ table: 'sys_cs_message', field: 'conversation' }];
    for (const { table: t, field } of refs.slice(0, 2)) {
      const r = await this.list(t, `${field}=${id}`, { limit: 300, order: '^ORDERBYsys_created_on' });
      if (!r.ok && r.status !== 403) continue;
      this.section('vaMessage', `VA transcript (${t})`, t, r.rows, { status: st(r), error: r.error, via: field });
      const textField = r.rows[0] ? (Object.keys(r.rows[0]).find(k => /^(payload|message|text|content|body)$/.test(k)) || Object.keys(r.rows[0]).find(k => /payload|message|text|content/.test(k))) : null;
      const seqField = r.rows[0] ? Object.keys(r.rows[0]).find(k => /^(sequence|order|seq)$/.test(k)) : null;
      n.vaMessages = (n.vaMessages || []).concat(r.rows.map(x => ({
        id: v(x, 'sys_id'), created: v(x, 'sys_created_on'), side: vaSide(x),
        text: extractText(textField ? v(x, textField) : ''), seq: Number(seqField ? v(x, seqField) : 0) || 0,
      })));
      if (r.rows.length) break;
    }
  }

  // A business record (incident, HR case, evidence…): what Otto did on it. Skill calls name the record
  // in the Gen AI log's metadata_table/metadata_document, agent runs in the plan's related_task_record.
  // A wrapper skill's inner skill call is logged without the record, so calls by the same user within
  // seconds of the latest linked call are added too. [V] live instance
  async traceRecord(table, row, records = []) {
    const id = v(row, 'sys_id'), n = this.ev.norm, G = this.T.genaiLog, P = this.T.plan;
    this.section('record', `Record: ${displayOf(row)}`, table, [row]);
    const targets = [{ table, sysId: id }, ...records.filter(r => r.sysId !== id)].slice(0, 3);
    const activity = [];
    const calls = [];
    const gf = G ? await this.schema.fields(G) : new Map();
    if (gf.has('metadata_document')) {
      for (const t of targets) {
        const r = await this.list(G, `metadata_document=${t.sysId}`, { limit: 25 });
        if (r.rows.length) this.section('genaiLog', `Otto calls on this ${t.table} record`, G, r.rows, { status: st(r), note: 'linked by metadata_document' });
        r.rows.forEach(x => calls.push({ row: x, on: t.table }));
      }
      calls.sort((a, b) => (v(a.row, 'sys_created_on') < v(b.row, 'sys_created_on') ? 1 : -1));
      const latest = calls[0]?.row;
      if (latest) {
        const t = snTime(v(latest, 'sys_created_on')), by = v(latest, 'sys_created_by');
        const r = await this.list(G, `sys_created_by=${by}^sys_created_on>=${fmtTime(new Date(t.getTime() - 5000))}^sys_created_on<=${fmtTime(new Date(t.getTime() + 5000))}`, { limit: 20 });
        const have = new Set(calls.map(c => v(c.row, 'sys_id')));
        const nested = r.rows.filter(x => !have.has(v(x, 'sys_id')) && !v(x, 'metadata_document'));
        if (nested.length) this.section('genaiLog', 'Calls made with the latest one (same user, ±5 s, no record)', G, nested, { note: 'nested skill calls, matched by user and time' });
        nested.forEach(x => calls.push({ row: x, on: null }));
      }
    }
    n.genaiLogs.push(...calls.map(c => normGenaiLog(c.row)));
    for (const c of calls) {
      const g = normGenaiLog(c.row);
      activity.push({ kind: 'genaiLog', id: g.id, display: g.skill || g.source || 'LLM call', detail: [g.skill && g.source, g.model].filter(Boolean).join(' · '), created: g.created, state: g.state || g.stateValue, error: g.error, on: c.on, nested: !c.on });
    }
    // The skills behind those calls.
    const skillField = this.T.skill && G ? (await this.schema.refFieldsTo(G, this.T.skill))[0] : null;
    const skillIds = [...new Set(calls.map(c => skillField && v(c.row, skillField)).filter(Boolean))].slice(0, 3);
    for (const sid of skillIds) { const sk = await this.byId(this.T.skill, sid); if (sk) { this.section('skill', `Skill: ${displayOf(sk)}`, this.T.skill, [sk]); n.skills.push(normGeneric(sk)); } }
    // Agent runs about this record.
    if (P && (await this.schema.fields(P)).has('related_task_record')) {
      const r = await this.list(P, targets.map(t => `related_task_record=${t.sysId}`).join('^OR'), { limit: 15 });
      this.ev.recentPlans = r.rows.map(x => { const p = normPlan(x); return { id: p.id, display: displayOf(x), state: [p.state, p.stateReason].filter(Boolean).join(' · '), created: p.created }; });
      r.rows.forEach(x => { const p = normPlan(x); activity.push({ kind: 'plan', id: p.id, display: p.objective || displayOf(x), detail: 'Agent run', created: p.created, state: [p.state, p.stateReason].filter(Boolean).join(' · '), error: p.error, on: p.relatedTable }); });
    }
    this.ev.recordActivity = activity.sort((a, b) => (a.created < b.created ? 1 : -1));
    if (!activity.length) this.ev.warnings.push(`No Otto skill calls or agent runs are linked to this ${table} record. Skills record it in the Generative AI log's metadata_document; if a skill has just run, wait a few seconds and trace again.`);
    // Platform logs around the latest call or run.
    const latestAt = snTime(this.ev.recordActivity[0]?.created);
    if (latestAt) {
      const w = this.s.windowMinutes * 60000;
      await this.collectWindowLogs(new Date(latestAt.getTime() - w), new Date(latestAt.getTime() + w), { skipGenai: true });
    }
    await this.relatedGeneric(table, row);
  }

  async relatedGeneric(table, row) {
    for (const { table: t, field } of (await this.schema.reverseRefs(table)).slice(0, 10)) {
      const r = await this.list(t, `${field}=${v(row, 'sys_id')}`, { limit: 20 });
      if (r.rows.length) this.section('related', t, t, r.rows);
    }
  }

  // Failed or stuck plans and failed or rejected LLM calls (skills included) from the last `days`,
  // newest first, identical ones merged with a count. Plan state values differ by release, so the
  // state values present are read first (Stats API) and classified with the rules' own tests; only
  // the failing and still-open ones are then fetched. With no failures, the latest runs are listed.
  async recentFailures({ days = 7, limit = 50, now = new Date() } = {}) {
    await this.init();
    this.newEvidence('recent failures');
    const since = fmtTime(new Date(now.getTime() - days * 86400000));
    this.ev.meta.failureWindow = { days, since };
    const out = [];
    const jobs = [];
    if (this.T.plan) jobs.push(async () => {
      const P = this.T.plan;
      const pf = await this.schema.fields(P);
      const stateF = (await this.schema.pick(P, 'state')) || 'state';
      const errF = await this.schema.pick(P, 'error');
      const reasonF = pf.has('state_reason') ? 'state_reason' : null;
      const owner = [...(this.T.workflow ? await this.schema.refFieldsTo(P, this.T.workflow) : []), ...(this.T.agent ? await this.schema.refFieldsTo(P, this.T.agent) : [])];
      const fields = ['sys_id', 'sys_created_on', 'sys_updated_on', 'sys_created_by', 'number', 'objective', 'name', stateF, reasonF, errF, 'run_type', 'related_task_table', ...owner].filter(Boolean).join(',');
      let rows = null;
      const st = await this.c.get(`/api/now/stats/${P}`, { sysparm_count: 'true', sysparm_group_by: stateF, sysparm_query: `sys_created_on>=${since}` });
      if (st.ok && Array.isArray(st.result)) {
        const values = st.result.map(x => x.groupby_fields?.[0]?.value).filter(Boolean);
        const failVals = values.filter(x => isFail({ state: x })), openVals = values.filter(x => isStuckCandidate({ state: x }));
        const qs = [];
        const failQ = [failVals.length && `${stateF}IN${failVals.join(',')}`, reasonF && `${reasonF}LIKEfail`, reasonF && `${reasonF}LIKEviolation`].filter(Boolean);
        if (failQ.length) qs.push(`sys_created_on>=${since}^${failQ.join('^OR')}`);
        if (openVals.length) qs.push(`sys_created_on>=${since}^${stateF}IN${openVals.join(',')}^sys_updated_on<${fmtTime(new Date(now.getTime() - this.s.stuckMinutes * 60000))}`);
        const res = await Promise.all(qs.map(q => this.list(P, q, { limit, fields })));
        res.filter(r => !r.ok).forEach(r => this.ev.warnings.push(`Could not list execution plans (${r.status}): ${r.error}`));
        rows = res.flatMap(r => r.rows);
      } else {   // Stats API not readable: classify the latest plans instead
        const r = await this.list(P, `sys_created_on>=${since}`, { limit, fields });
        if (!r.ok) { this.ev.warnings.push(`Could not list execution plans (${r.status}): ${r.error}`); return; }
        rows = r.rows;
      }
      for (const row of rows) {
        const n = normPlan(row);
        const age = minutesSince(n.updated || n.created, now);
        const state = n.state || n.stateValue;
        const reason = planFailed(n) ? (n.error ? trunc(n.error, 160) : `Ended "${state}"${n.stateReason ? ` · ${n.stateReason}` : ''}`)
          : isStuckCandidate(n) && age > this.s.stuckMinutes ? `Still "${state}" after ${Math.round(age)} min` : null;
        // Name runs by their workflow or agent, so repeats of one failure merge into one line.
        const ownerName = owner.map(f => d(row, f)).find(Boolean);
        const plain = n.objective || v(row, 'number') || `${n.runType ? n.runType[0].toUpperCase() + n.runType.slice(1) : 'Agent'} run${n.relatedTable ? ` on ${n.relatedTable}` : ''}`;
        if (reason) out.push({ kind: 'plan', label: ownerName ? 'Agent run' : 'Execution plan', id: n.id, display: ownerName || trunc(plain, 90), created: n.created, reason });
      }
    });
    if (this.T.genaiLog) jobs.push(async () => {
      const G = this.T.genaiLog;
      const gf = await this.schema.fields(G);
      const stateF = (await this.schema.pick(G, 'state')) || 'status';
      const errF = (await this.schema.pick(G, 'error')) || 'error';
      const has = f => (gf.has(f) ? f : null);
      const fields = ['sys_id', 'sys_created_on', 'source', stateF, errF, has('error_code'), has('feedback'), ...[...gf.keys()].filter(k => /skill/.test(k))].filter(Boolean).join(',');
      const q = `sys_created_on>=${since}^${stateF}LIKEerror^OR${stateF}LIKEfail^OR${errF}ISNOTEMPTY${has('feedback') ? '^ORfeedbackLIKEreject' : ''}`;
      const r = await this.list(G, q, { limit, fields });
      if (!r.ok) { this.ev.warnings.push(`Could not list Generative AI log errors (${r.status}): ${r.error}`); return; }
      for (const row of r.rows) {
        const g = normGenaiLog(row);
        const code = g.errorCode ? `[${g.errorCode}] ` : '';
        // Seen live: status "error" with the message "Success" (code 200000). Say so rather than call "Success" the reason.
        const reason = /^\s*(success|ok)\s*$/i.test(g.error || '') ? `Status "${g.state || g.stateValue}" but the message says "${g.error.trim()}" ${code.trim()}`.trim()
          : g.error ? `${code}${trunc(g.error, 160)}` : /reject/i.test(g.feedback || '') ? 'The user rejected the response' : `Status "${g.state || g.stateValue}"`;
        const skillKey = Object.keys(row).find(k => /skill/.test(k));   // g.skill falls back to the source name
        out.push({ kind: 'genaiLog', label: skillKey && v(row, skillKey) ? 'Skill call' : 'LLM call', id: g.id, display: g.skill || g.source || 'LLM call', created: g.created, reason });
      }
    });
    await mapLimit(jobs, 2, j => j());
    // Merge repeats of the same failure (same kind, subject and reason); keep the newest record.
    const merged = new Map();
    for (const x of out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))) {
      const k = `${x.kind}|${x.display}|${x.reason}`;
      if (merged.has(k)) merged.get(k).count++; else merged.set(k, { ...x, count: 1 });
    }
    this.ev.recentFailures = [...merged.values()];
    if (!out.length && this.T.plan) {
      const r = await this.list(this.T.plan, '', { limit: 15 });
      this.ev.recentPlans = r.rows.map(row => { const n = normPlan(row); return { id: n.id, display: displayOf(row), state: n.state, created: n.created }; });
    }
    this.ev.meta.finishedAt = new Date().toISOString();
    this.ev.meta.apiCalls = this.c.calls;
    return this.ev;
  }

  // ---------------- search by name ----------------

  async searchByName(text) {
    const kinds = ['agent', 'workflow', 'tool', 'skill', 'prompt'];
    const out = [];
    await mapLimit(kinds, 3, async k => {
      const t = this.T[k];
      if (!t) return;
      const nameField = (await this.schema.pick(t, 'name')) || 'name';
      const r = await this.list(t, `${nameField}LIKE${text}`, { limit: 10, order: '', fields: `sys_id,${nameField}` });
      for (const x of r.rows) out.push({ kind: k, label: KIND_LABEL[k], table: t, id: v(x, 'sys_id'), display: d(x, nameField) });
    });
    if (this.T.plan) {
      const r = await this.list(this.T.plan, `numberLIKE${text}^ORobjectiveLIKE${text}`, { limit: 10 });
      for (const x of r.rows) out.push({ kind: 'plan', label: 'Execution plan', table: this.T.plan, id: v(x, 'sys_id'), display: displayOf(x) });
    }
    this.ev.candidates = out;
    if (!out.length) this.ev.warnings.push(`Nothing named like "${text}" was found in the AI tables.`);
  }
}

// ---------------- normalizers ----------------

function st(r) { return r.ok ? 'ok' : (r.status === 403 ? 'forbidden' : r.status === 400 || r.status === 404 ? 'missing' : 'error'); }
function groupBy(arr, f) { return arr.reduce((m, x) => ((m[f(x)] ||= []).push(x), m), {}); }
function dedupeRows(rows) { const s = new Set(); return rows.filter(x => { const id = v(x, 'sys_id'); return s.has(id) ? false : s.add(id); }); }
function dedupeById(arr) { const s = new Set(); return arr.filter(x => (s.has(x.id) ? false : s.add(x.id))); }

export function classifyChild(table) {
  if (/tool/.test(table) && /exec/.test(table)) return 'toolExec';
  if (/task/.test(table)) return 'task';
  if (/message/.test(table)) return 'message';
  return null;
}

export function displayOf(row) {
  if (!row) return '';
  for (const f of ['number', 'name', 'display_name', 'label', 'objective', 'short_description', 'title']) {
    const x = d(row, f); if (x) return String(x);
  }
  return v(row, 'sys_id') || '';
}

const pv = (row, hint) => { const f = pickFromRow(row, hint); return f ? v(row, f) : undefined; };
const pd = (row, hint) => { const f = pickFromRow(row, hint); return f ? d(row, f) : undefined; };

export function normGeneric(row) {
  return {
    id: v(row, 'sys_id'), display: displayOf(row), state: pd(row, 'state'), stateValue: pv(row, 'state'),
    error: pv(row, 'error'), created: v(row, 'sys_created_on'), updated: v(row, 'sys_updated_on'),
    active: v(row, 'active') === undefined ? null : String(v(row, 'active')) === 'true', name: pd(row, 'name'),
    createdBy: v(row, 'sys_created_by'),
  };
}
// state_reason, run_type and related_task_table/record: plan fields seen on a live instance. [V]
export function normPlan(row) {
  return {
    ...normGeneric(row), stateReason: d(row, 'state_reason') || undefined, stateReasonValue: v(row, 'state_reason') || undefined,
    runType: d(row, 'run_type') || undefined, objective: v(row, 'objective'),
    relatedTable: v(row, 'related_task_table') || undefined, relatedRecord: v(row, 'related_task_record') || undefined,
  };
}
// Tasks carry a type (e.g. access_verification) and point at their agent or workflow with a
// document-ID pair (target_document_table + target_document_id), not a reference field. [V]
export function normTask(row) { return { ...normGeneric(row), type: d(row, 'type') || undefined, targetTable: v(row, 'target_document_table') || undefined }; }
export function docTargets(row, table) {
  const out = [];
  if (!row || !table) return out;
  for (const k of Object.keys(row)) {
    if (!k.endsWith('_table') || v(row, k) !== table) continue;
    const base = k.slice(0, -6);
    const id = [`${base}_id`, `${base}_record`, base].map(x => v(row, x)).find(x => HEX32.test(String(x || '')));
    if (id) out.push(id);
  }
  return out;
}
export function normMessage(row) {
  const rk = Object.keys(row).find(k => /^(role|sender|author|from|message_type)$/.test(k));
  return { ...normGeneric(row), content: pv(row, 'content'), role: rk ? d(row, rk) : undefined };
}
export function normToolExec(row) {
  const toolField = Object.keys(row).find(k => /^tool$|tool_id|^tool_/.test(k));
  const start = snTime(pv(row, 'start')) || snTime(v(row, 'sys_created_on'));
  const end = snTime(pv(row, 'end')) || snTime(v(row, 'sys_updated_on'));
  return {
    ...normGeneric(row), toolName: (toolField && d(row, toolField)) || pd(row, 'name'),
    input: pv(row, 'input'), output: pv(row, 'output'),
    durationMs: start && end ? end - start : null,
  };
}
const num = x => (x === undefined || x === null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
export function normGenaiLog(row) {
  return {
    ...normGeneric(row), prompt: pv(row, 'prompt'), response: v(row, 'response') ?? pv(row, 'output'),
    skill: d(row, Object.keys(row).find(k => /skill/.test(k)) || '') || d(row, 'source'),
    skillId: v(row, Object.keys(row).find(k => /skill/.test(k)) || '') || undefined,
    source: v(row, 'source'), guard: Object.keys(row).filter(k => /guard|offensive|injection|sensitive|blocked/.test(k)).map(k => ({ field: k, value: v(row, k) })),
    errorCode: pv(row, 'errorCode'), model: pd(row, 'model'), feedback: pd(row, 'feedback'), outputMeta: pv(row, 'outputMeta'),
    promptTokens: num(pv(row, 'promptTokens')), responseTokens: num(pv(row, 'responseTokens')), promptConfigId: pv(row, 'promptConfig'),
  };
}
// context_map (JSON) carries the session user, scope and the record or script being run. [V] live instance
export function normSyslog(row) {
  let c = {};
  try { c = JSON.parse(v(row, 'context_map') || '{}') || {}; } catch (e) {}
  return {
    id: v(row, 'sys_id'), created: v(row, 'sys_created_on'), level: v(row, 'level'), source: v(row, 'source'), logText: v(row, 'message'),
    createdBy: v(row, 'sys_created_by'), ctxUser: c._user || c._logged_in_user || undefined, ctxScope: c._scope || undefined,
    ctxRecord: c.record_sys_id || undefined, ctxScript: c._script_record || undefined,
  };
}
export function normHttp(row) {
  const sf = Object.keys(row).find(k => /response_status|status_code/.test(k)) || pickFromRow(row, 'httpStatus');
  return { ...normGeneric(row), httpStatus: Number(v(row, sf)) || null, url: pv(row, 'url') };
}
export function normAgent(row) {
  return {
    ...normGeneric(row), name: pd(row, 'name') || displayOf(row),
    description: pv(row, 'description'), instructions: pv(row, 'instructions'),
    tools: [], acls: [], runAs: null,
  };
}
export function normTool(row) {
  return {
    ...normGeneric(row), name: pd(row, 'name') || displayOf(row), type: d(row, 'type') || d(row, 'tool_type'),
    description: pv(row, 'description'), inputSchema: pv(row, 'inputSchema'),
    executionMode: d(row, Object.keys(row).find(k => /execution_mode|supervis|autonom/.test(k)) || ''),
  };
}

// "glide-brazil-12-04-2026__patch5-..." → { family: 'brazil', patch: 5 }
export function parseRelease(build) {
  const s = String(build || '').toLowerCase();
  const family = RELEASE_ORDER.slice().reverse().find(f => s.includes(f)) || (s.includes('washington') ? 'washingtondc' : null);
  const m = s.match(/patch[\s_-]?(\d+)/);
  return { family, patch: m ? Number(m[1]) : null, rank: family ? RELEASE_ORDER.indexOf(family) : -1 };
}

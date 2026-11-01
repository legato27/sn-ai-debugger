// Evidence collectors. Everything here is read-only and dictionary-driven: reference fields
// are discovered from sys_dictionary instead of being hard-coded.
import { TABLES, RESOLVE_ORDER, KIND_LABEL, PLUGIN_SCOPE_QUERY, DEFAULT_SETTINGS, AI_ACL_TYPES, RELEASE_PROPS, RELEASE_ORDER } from './config.js';
import { Schema, v, d, pickFromRow } from './schema.js';
import { buildTimeline, extractText, vaSide } from './timeline.js';

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
  m = s.match(/\/record\/([a-z0-9_]+)\/([0-9a-f]{32})/i);
  if (m) return { table: m[1], sysId: m[2] };
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
    return this.T;
  }

  kindForTable(table) {
    for (const [k, list] of Object.entries(TABLES)) if (list.includes(table)) return k;
    return 'generic';
  }

  newEvidence(input) {
    this.ev = {
      meta: { input, startedAt: new Date().toISOString(), tables: this.T, apiCalls: 0, version: '0.5.0' },
      user: null, root: null, sections: [], plugins: [],
      norm: { plan: null, tasks: [], messages: [], toolExecs: [], genaiLogs: [], syslog: [], http: [], flows: [], rca: [], guard: [], agents: [], tools: [], skills: [] },
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
      sysparm_display_value: 'all', sysparm_exclude_reference_link: 'true', sysparm_fields: fields,
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
    let table, id;
    const raw = (input || '').trim();
    if (/^https?:\/\//i.test(raw)) ({ table, sysId: id } = parseSnUrl(raw));
    else if (HEX32.test(raw)) id = raw.toLowerCase();
    else if (!raw && url) ({ table, sysId: id } = parseSnUrl(url));

    if (!id && raw) { await this.searchByName(raw); this.ev.meta.finishedAt = new Date().toISOString(); return this.ev; }
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
    if (!row) {
      this.ev.warnings.push(`sys_id ${id} was not found in any AI table${table ? ' (or in ' + table + ')' : ''}, or you cannot read it.`);
      await this.collectPlugins();
      return this.finish();
    }
    this.ev.root = { kind, table, sysId: id, label: KIND_LABEL[kind] || table, display: displayOf(row) };
    this.log(`Resolved ${KIND_LABEL[kind] || table}: ${displayOf(row)}`);

    if (kind === 'plan') await this.tracePlan(row);
    else if (kind === 'task' || kind === 'message' || kind === 'toolExec') await this.traceViaParentPlan(table, row);
    else if (kind === 'agent') await this.traceAgent(row);
    else if (kind === 'workflow') await this.traceWorkflow(row);
    else if (kind === 'tool') await this.traceTool(row);
    else if (kind === 'skill' || kind === 'prompt' || kind === 'capability') await this.traceSkill(table, row);
    else if (kind === 'genaiLog') await this.traceGenaiLog(row);
    else if (kind === 'conversation') await this.traceConversation(row);
    else { this.section('root', table, table, [row]); await this.relatedGeneric(table, row); }

    await this.collectPlugins();
    return this.finish();
  }

  finish() {
    const vaSec = this.ev.sections.find(s => s.key === 'vaMessage');
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
    const roles = userId ? await this.rolesOf(userId) : [];
    this.ev.user = { ...who, userID: userId, roles, isAdmin: roles.includes('admin') };
    this.ev.meta.instance = who.host;
  }

  async rolesOf(userId) {
    const r = await this.list('sys_user_has_role', `user=${userId}`, { limit: 2000, order: '', fields: 'role,state' });
    return [...new Set(r.rows.filter(x => !v(x, 'state') || v(x, 'state') === 'active').map(x => d(x, 'role')).filter(Boolean))];
  }

  // Release family/patch and the AI properties that change behaviour (kill switch, MCP guardian).
  async collectPlatform() {
    const r = await this.list('sys_properties', `nameIN${RELEASE_PROPS.join(',')}^ORnameLIKEkill_switch^ORnameLIKEmcp_guardian_check`, { limit: 40, order: '', fields: 'name,value' });
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
      if (kind === 'task') n.tasks.push(...r.rows.map(normGeneric));
      if (kind === 'message') n.messages.push(...r.rows.map(normMessage));
      if (kind === 'toolExec') n.toolExecs.push(...r.rows.map(normToolExec));
    });

    // Agents and workflow involved.
    const agentIds = new Set(), wfIds = new Set();
    if (this.T.agent) {
      for (const f of await this.schema.refFieldsTo(P, this.T.agent)) { const x = v(plan, f); if (x) agentIds.add(x); }
      for (const sec of this.ev.sections.filter(s => s.key === 'task' || s.key === 'toolExec')) {
        for (const f of await this.schema.refFieldsTo(sec.table, this.T.agent)) for (const r of sec.rows) { const x = v(r, f); if (x) agentIds.add(x); }
      }
    }
    if (this.T.workflow) for (const f of await this.schema.refFieldsTo(P, this.T.workflow)) { const x = v(plan, f); if (x) wfIds.add(x); }
    for (const wid of wfIds) {
      const wf = await this.byId(this.T.workflow, wid);
      if (wf) { this.section('workflow', 'Agentic workflow', this.T.workflow, [wf]); n.workflow = normGeneric(wf); n.workflowAcl = await this.aclCoverage('gen_ai_workflow', wid, v(wf, 'internal_name'), v(wf, 'name')); }
    }
    await mapLimit([...agentIds].slice(0, 6), 2, aid => this.describeAgent(aid));

    // The Virtual Agent conversation this run belongs to, if any.
    await this.collectConversationForPlan(plan);

    // Time-correlated logs.
    const from = new Date(snTime(v(plan, 'sys_created_on')).getTime() - this.s.windowMinutes * 60000);
    const to = new Date((snTime(v(plan, 'sys_updated_on')) || new Date()).getTime() + this.s.windowMinutes * 60000);
    await this.collectWindowLogs(from, to, { planId: id });
  }

  async collectWindowLogs(from, to, { planId, skipGenai } = {}) {
    const win = `sys_created_on>=${fmtTime(from)}^sys_created_on<=${fmtTime(to)}`;
    this.ev.meta.window = { from: fmtTime(from), to: fmtTime(to) };
    const n = this.ev.norm;
    const jobs = [];

    jobs.push(async () => {   // Gen AI log: by plan reference if one exists, else by window
      if (!this.T.genaiLog || skipGenai) return;
      let q = win;
      if (planId && this.T.plan) {
        const f = await this.schema.refFieldsTo(this.T.genaiLog, this.T.plan);
        if (f.length) q = f.map(x => `${x}=${planId}`).join('^OR');
      }
      const r = await this.list(this.T.genaiLog, q, { limit: 50 });
      this.section('genaiLog', 'Generative AI log', this.T.genaiLog, r.rows, { status: st(r), error: r.error, note: q === win ? 'matched by time window' : 'linked to the plan' });
      const existing = new Set(n.genaiLogs.map(x => x.id));
      n.genaiLogs.push(...r.rows.map(normGenaiLog).filter(x => !existing.has(x.id)));
    });
    jobs.push(async () => {
      const r = await this.list('syslog', `${win}^levelIN1,2`, { limit: 200, fields: 'sys_id,sys_created_on,level,source,message,sys_created_by' });
      this.section('syslog', 'System log (warnings and errors)', 'syslog', r.rows, { status: st(r), error: r.error });
      n.syslog.push(...r.rows.map(x => ({ id: v(x, 'sys_id'), created: v(x, 'sys_created_on'), level: v(x, 'level'), source: v(x, 'source'), logText: v(x, 'message') })));
    });
    jobs.push(async () => {
      if (!this.T.http) return;
      const r = await this.list(this.T.http, win, { limit: 100 });
      this.section('http', 'Outbound HTTP log', this.T.http, r.rows, { status: st(r), error: r.error });
      n.http.push(...r.rows.map(normHttp));
    });
    jobs.push(async () => {
      if (!this.T.flow) return;
      const r = await this.list(this.T.flow, `sys_updated_on>=${fmtTime(from)}^sys_created_on<=${fmtTime(to)}`, { limit: 100 });
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
        if (g.rows.length) { this.section('guard', `AI Guardian: ${t}`, t, g.rows, { status: st(g) }); n.guard.push(...g.rows.map(normGeneric)); }
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
      na.runAs.roles = await this.rolesOf(na.runAs.id);
    }
    this.ev.norm.agents.push(na);
    return na;
  }

  async toolDeps(toolTable, tool) {
    const deps = [];
    for (const ref of await this.schema.forwardRefs(toolTable)) {
      if (!DEP_TABLES.includes(ref.reference)) continue;
      const id = v(tool, ref.field);
      if (!id) continue;
      const rec = await this.byId(ref.reference, id);
      const dep = { field: ref.field, table: ref.reference, id, display: d(tool, ref.field), found: Boolean(rec), active: rec ? String(v(rec, 'active')) !== 'false' : null, name: rec ? displayOf(rec) : null };
      const aclType = ref.reference === 'sys_hub_flow' ? 'flow' : ref.reference === 'sys_hub_action_type_definition' ? 'flow_action' : ref.reference === 'sn_nowassist_skill_config' ? 'gen_ai_skill' : null;
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
    if (/skill/.test(table)) this.ev.norm.skillAcl = await this.aclCoverage('gen_ai_skill', id, v(row, 'internal_name'), v(row, 'name'));
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
    const t = snTime(v(row, 'sys_created_on')), w = this.s.windowMinutes * 60000;
    await this.collectWindowLogs(new Date(t.getTime() - w), new Date(t.getTime() + w));
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

  async relatedGeneric(table, row) {
    for (const { table: t, field } of (await this.schema.reverseRefs(table)).slice(0, 10)) {
      const r = await this.list(t, `${field}=${v(row, 'sys_id')}`, { limit: 20 });
      if (r.rows.length) this.section('related', t, t, r.rows);
    }
  }

  async recentRuns(limit = 20) {
    await this.init();
    this.newEvidence('recent runs');
    if (!this.T.plan) { this.ev.warnings.push('The execution plan table is not readable on this instance.'); return this.ev; }
    const r = await this.list(this.T.plan, '', { limit });
    this.ev.recentPlans = r.rows.map(x => ({ id: v(x, 'sys_id'), display: displayOf(x), state: d(x, pickFromRow(x, 'state')), created: v(x, 'sys_created_on') }));
    if (!r.ok) this.ev.warnings.push(`Could not list execution plans (${r.status}): ${r.error}`);
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
  };
}
export function normPlan(row) { return { ...normGeneric(row), createdBy: v(row, 'sys_created_by') }; }
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
export function normGenaiLog(row) {
  return {
    ...normGeneric(row), prompt: pv(row, 'prompt'), response: v(row, 'response') ?? pv(row, 'output'),
    skill: d(row, Object.keys(row).find(k => /skill/.test(k)) || '') || d(row, 'source'),
    source: v(row, 'source'), guard: Object.keys(row).filter(k => /guard|offensive|injection|sensitive|blocked/.test(k)).map(k => ({ field: k, value: v(row, k) })),
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

// Markdown report for pasting into an incident, a Claude chat or a HI case.
import { redactText } from './redact.js';

export function toMarkdown(ev, rca, { redact = true } = {}) {
  const r = s => (redact ? redactText(s) : s);
  const L = [];
  const root = ev.root || {};
  L.push(`# ServiceNow AI trace: ${root.label || 'unresolved'} ${root.display ? '— ' + r(root.display) : ''}`);
  L.push('');
  L.push(`- Instance: ${ev.meta?.instance || '?'}`);
  L.push(`- Traced: ${ev.meta?.startedAt} by ${ev.user?.userName || '?'}${ev.user?.isAdmin ? ' (admin)' : ''}`);
  if (root.sysId) L.push(`- Root: ${root.table} / ${root.sysId}`);
  if (ev.platform?.family) L.push(`- Release: ${ev.platform.family}${ev.platform.patch ? ' patch ' + ev.platform.patch : ''}`);
  if (ev.meta?.window) L.push(`- Log window (UTC): ${ev.meta.window.from} → ${ev.meta.window.to}`);
  L.push(`- API calls: ${ev.meta?.apiCalls ?? '?'} (read-only)`);
  L.push('');
  if (rca.rootCause) {
    L.push('## Most likely root cause');
    L.push(`**[${rca.rootCause.severity}] ${r(rca.rootCause.title)}**`);
    if (rca.rootCause.detail) L.push('', r(rca.rootCause.detail));
    if (rca.rootCause.fix) L.push('', `Fix: ${r(rca.rootCause.fix)}`);
    if (rca.alsoLikely?.length) L.push('', 'Also check:', ...rca.alsoLikely.map(a => `- [${a.severity}] ${r(a.title)}`));
    L.push('');
  }
  L.push('## Findings');
  if (!rca.findings.length) L.push('No rule fired. The run looks clean, or the evidence was not readable.');
  else {
    L.push('| # | Severity | Rule | Finding | Fix |', '|---|---|---|---|---|');
    rca.findings.forEach((f, i) => L.push(`| ${i + 1} | ${f.severity} | ${f.id} | ${cell(r(f.title))}${f.detail ? '<br>' + cell(r(f.detail)) : ''} | ${cell(r(f.fix || ''))} |`));
  }
  L.push('');
  const agents = ev.norm?.agents || [];
  if (agents.length) {
    L.push('## Agents and tools');
    for (const a of agents) {
      L.push(`### ${r(a.name)} ${a.active === false ? '(inactive)' : ''}`);
      if (a.runAs) L.push(`Run as: ${r(a.runAs.name)} — roles: ${(a.runAs.roles || []).join(', ') || 'none'}`);
      for (const t of a.tools || []) L.push(`- Tool **${r(t.name)}** ${t.type ? '[' + t.type + ']' : ''} ${t.executionMode ? '· ' + t.executionMode : ''} ${t.active === false ? '· inactive' : ''}${(t.deps || []).map(dp => ` · ${dp.table}: ${dp.found ? r(dp.name) : 'MISSING'}`).join('')}`);
      for (const acl of a.acls || []) L.push(`- ACL ${acl.name} (${acl.operation}) roles: ${acl.roles.join(', ') || 'none'}${acl.active ? '' : ' · inactive'}`);
    }
    L.push('');
  }
  if ((ev.norm?.toolExecs || []).length) {
    L.push('## Tool executions');
    L.push('| Tool | State | Duration | Error |', '|---|---|---|---|');
    for (const x of ev.norm.toolExecs) L.push(`| ${cell(r(x.toolName || x.display))} | ${x.state || ''} | ${x.durationMs != null ? Math.round(x.durationMs / 100) / 10 + ' s' : ''} | ${cell(r(String(x.error || '').slice(0, 200)))} |`);
    L.push('');
  }
  if ((ev.timeline || []).length) {
    L.push(`## Conversation timeline (${ev.timeline.length} events${ev.timeline.length > 60 ? ', first 60' : ''})`);
    L.push('| Time (UTC) | Event | Who | State / error | Text |', '|---|---|---|---|---|');
    for (const e of ev.timeline.slice(0, 60)) L.push(`| ${String(e.t).slice(11)} | ${e.kind} | ${cell(r(e.who))} | ${cell(r([e.state, e.error].filter(Boolean).join(' · ')))} | ${cell(r(String(e.content || '').slice(0, 200)))} |`);
    L.push('');
  }
  if ((ev.plugins || []).length) {
    L.push('## AI app versions');
    for (const p of ev.plugins) L.push(`- ${p.scope} ${p.version || ''}${p.active ? '' : ' (inactive)'}`);
    L.push('');
  }
  L.push('## Evidence collected');
  for (const s of ev.sections || []) L.push(`- ${s.title} (${s.table}): ${s.rows.length} rows${s.status && s.status !== 'ok' ? ' · ' + s.status : ''}`);
  if ((ev.warnings || []).length) { L.push('', '## Warnings'); ev.warnings.forEach(w => L.push(`- ${r(w)}`)); }
  return L.join('\n');
}

const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');

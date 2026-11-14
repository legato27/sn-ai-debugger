// The run's own log lines, at every level, for the Run logs card, the report and "Copy logs".
// Which lines belong to the run is decided by rules.annotateLinks (they name a record of the run or
// come from one of its users' sessions); this module only lists, filters and formats them.

// syslog.level choices. [V] live instance (sys_choice): -2 Trace, -1 Debug, 0 Information,
// 1 Warning, 2 Error, 3 Fatal.
export const LEVEL_NAME = { '3': 'Fatal', '2': 'Error', '1': 'Warning', '0': 'Info', '-1': 'Debug', '-2': 'Trace' };
export const levelName = l => LEVEL_NAME[String(l)] || String(l ?? '?');
export const isErrorLevel = l => Number(l) >= 2 || /error|fatal/i.test(String(l ?? ''));

// The four filter groups shown as pills, most severe first.
export const LOG_GROUPS = ['error', 'warning', 'info', 'debug'];
export const GROUP_LABEL = { error: 'Error', warning: 'Warning', info: 'Info', debug: 'Debug' };
export function levelGroup(l) {
  if (isErrorLevel(l)) return 'error';
  const n = Number(l);
  if (n === 1 || /warn/i.test(String(l))) return 'warning';
  return n < 0 || /debug|trace/i.test(String(l)) ? 'debug' : 'info';
}

// Warnings and errors (norm.syslog) and the info/debug lines fetched for the run (norm.runInfo),
// linked lines only, one row per sys_id, oldest first.
export function runLogs(norm = {}) {
  const seen = new Set(), out = [];
  for (const x of [...(norm.syslog || []), ...(norm.runInfo || [])]) {
    if (!x?.link || !x.id || seen.has(x.id)) continue;
    seen.add(x.id);
    out.push({ id: x.id, created: x.created || '', level: String(x.level ?? ''), group: levelGroup(x.level), source: x.source || '', text: x.logText || '', why: x.link, user: x.ctxUser || x.createdBy || '' });
  }
  return out.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
}

export function countByGroup(lines) {
  const c = Object.fromEntries(LOG_GROUPS.map(g => [g, 0]));
  for (const l of lines) c[l.group]++;
  return c;
}

// groups: a Set of LOG_GROUPS to keep (all when omitted); text: case-insensitive match on source,
// message or user.
export function filterLogs(lines, { groups, text = '' } = {}) {
  const q = text.trim().toLowerCase();
  return lines.filter(l => (!groups || groups.has(l.group)) && (!q || `${l.source}\n${l.text}\n${l.user}`.toLowerCase().includes(q)));
}

// Plain text, one line per entry (continuation lines indented), ready to paste into a ticket.
export function logsAsText(lines) {
  return lines.map(l => `${l.created} ${levelName(l.level).padEnd(7)} ${l.source || 'syslog'}${l.user ? ` [${l.user}]` : ''}: ${String(l.text).replace(/\r?\n/g, '\n    ')}`).join('\n');
}

// ---- links into the instance ----

// Flow executions open in Flow Designer's execution details; the sys_flow_context form shows little.
const VIEWS = {
  sys_flow_context: id => `$flow-designer.do?sysparm_nostack=true#/operations/context/${id}`,
};
export function recordUrl(origin, table, id) {
  if (!origin || !table || !id) return null;
  return `${origin}/${VIEWS[table] ? VIEWS[table](encodeURIComponent(id)) : `${table}.do?sys_id=${encodeURIComponent(id)}`}`;
}

// The System Log list with the same filter the collector used for the run's lines, all levels,
// oldest first, so the investigation can continue in the platform with its own columns and export.
export function logListUrl(origin, query) {
  if (!origin || !query) return null;
  return `${origin}/syslog_list.do?sysparm_query=${encodeURIComponent(`${query}^ORDERBYsys_created_on`)}`;
}

// One ordered view of a run: what the user and Virtual Agent said, what the agents said,
// which tools ran, which LLM calls were made, and the errors around them.
// Entry text lives in `content` so exports omit it unless bodies are switched on.

const KIND_ORDER = { 'va-user': 0, 'agent-msg': 1, task: 2, llm: 3, tool: 4, 'va-bot': 5, error: 6 };

// Virtual Agent payloads are often JSON; pull the human-readable strings out of them.
export function extractText(raw, max = 2000) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!/^[[{]/.test(s)) return s.slice(0, max);
  try {
    const out = [];
    const keys = /^(value|label|message|text|displayValue|display_value|title|header|content|body|prompt|question)$/i;
    const walk = (o, depth = 0) => {
      if (depth > 6 || out.join(' ').length > max) return;
      if (Array.isArray(o)) return o.forEach(x => walk(x, depth + 1));
      if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) {
        if (typeof x === 'string' && keys.test(k) && x.trim() && !/^[0-9a-f]{32}$/i.test(x)) out.push(x.trim());
        else if (typeof x === 'object') walk(x, depth + 1);
      }
    };
    walk(JSON.parse(s));
    return [...new Set(out)].join(' · ').slice(0, max) || s.slice(0, max);
  } catch (e) { return s.slice(0, max); }
}

// Who sent a VA message: 'user' or 'bot', from whatever fields the row carries.
export function vaSide(row) {
  const pick = (re) => { const k = Object.keys(row).find(x => re.test(x)); return k ? String(row[k]?.value ?? row[k] ?? '').toLowerCase() : ''; };
  const dir = pick(/^direction$/) || pick(/direction/);
  if (dir) return /in|request|user|received/.test(dir) && !/outbound/.test(dir) ? 'user' : 'bot';
  const sender = pick(/^(sender|is_agent|is_bot|author|source|message_type|type)$/);
  if (/user|requester|customer|inbound|false/.test(sender)) return 'user';
  return 'bot';
}

const short = (s, n = 160) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n) + '…' : s; };

export function buildTimeline(norm = {}, tables = {}) {
  const T = [];
  const add = (t, kind, who, content, extra = {}) => {
    if (!t) return;
    if (extra.ref) extra.ref = { ...extra.ref, table: tables[extra.ref.table] || extra.ref.table };
    T.push({ t, kind, who, content: content ?? '', ...extra });
  };
  for (const m of norm.vaMessages || []) add(m.created, m.side === 'user' ? 'va-user' : 'va-bot', m.side === 'user' ? 'User' : 'Virtual Agent', m.text, { ref: { table: 'vaMessage', id: m.id }, seq: m.seq });
  for (const m of norm.messages || []) add(m.created, 'agent-msg', m.role || 'Agent', m.content, { ref: { table: 'message', id: m.id } });
  for (const t of norm.tasks || []) add(t.created, 'task', t.display || 'Task', '', { state: t.state, error: short(t.error, 300), ref: { table: 'task', id: t.id } });
  for (const x of norm.toolExecs || []) add(x.created, 'tool', x.toolName || x.display || 'Tool', [x.input && `in: ${x.input}`, x.output && `out: ${x.output}`].filter(Boolean).join('\n'), { state: x.state, error: short(x.error, 300), durationMs: x.durationMs, ref: { table: 'toolExec', id: x.id } });
  for (const g of norm.genaiLogs || []) add(g.created, 'llm', g.skill || g.source || 'LLM call', g.response ? `response: ${g.response}` : '', { state: g.state, error: short(g.error, 300), ref: { table: 'genaiLog', id: g.id } });
  for (const s of norm.syslog || []) if (String(s.level) === '2') add(s.created, 'error', s.source || 'syslog', '', { error: short(s.logText, 300), ref: { table: 'syslog', id: s.id } });
  for (const f of norm.flows || []) if (/error|fail|cancel/i.test(`${f.state} ${f.stateValue}`)) add(f.updated || f.created, 'error', f.display || 'Flow', '', { state: f.state, error: short(f.error, 300), ref: { table: 'flow', id: f.id } });
  T.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || ((a.seq ?? 0) - (b.seq ?? 0))));
  return T;
}

export const KIND_LABEL = { 'va-user': 'User', 'va-bot': 'Virtual Agent', 'agent-msg': 'Agent message', task: 'Task', tool: 'Tool call', llm: 'LLM call', error: 'Error' };

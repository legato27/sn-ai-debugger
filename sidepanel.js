import { makeTabClient } from './lib/sn-client.js';
import { Collector, parseSnUrl } from './lib/collectors.js';
import { runRules, SEVERITY } from './lib/rules.js';
import { redactEvidence } from './lib/redact.js';
import { toMarkdown } from './lib/report.js';
import { DEFAULT_SETTINGS, KIND_LABEL } from './lib/config.js';
import { KIND_LABEL as TL_LABEL } from './lib/timeline.js';
import { availableActions, pageFillScript } from './lib/actions.js';
import { CLAUDE_DEFAULTS, CLAUDE_MODELS, ClaudeSession, compactEvidence, buildPastePrompt, mdToHtml } from './lib/claude.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SN_HOST = /\.(service-now\.com|servicenowservices\.com)$/i;

let settings = { ...DEFAULT_SETTINGS, ...CLAUDE_DEFAULTS };
let claude = null;        // ClaudeSession for the current trace
let tab = null;
let last = null;          // { ev, rca }
let sevFilter = new Set(SEVERITY);
let busy = false;

// ---------------- settings ----------------

async function loadSettings() {
  try { const s = await chrome.storage.local.get('settings'); settings = { ...DEFAULT_SETTINGS, ...CLAUDE_DEFAULTS, ...(s.settings || {}) }; } catch (e) {}
  $('setWindow').value = settings.windowMinutes; $('setRows').value = settings.rowLimit; $('setStuck').value = settings.stuckMinutes;
  $('setRedact').checked = settings.redact; $('setBodies').checked = settings.includeBodies; $('setActions').checked = settings.actionsEnabled;
  const models = CLAUDE_MODELS.some(m => m.id === settings.claudeModel) ? CLAUDE_MODELS : [...CLAUDE_MODELS, { id: settings.claudeModel, label: settings.claudeModel }];
  $('setModel').innerHTML = models.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
  $('setModel').value = settings.claudeModel;
  $('setKey').value = settings.claudeKey; $('setClaudeBodies').checked = settings.claudeBodies; $('setAsk').checked = !settings.claudeConfirmed;
}
function saveSettings() {
  settings = {
    ...settings,
    windowMinutes: clampNum($('setWindow').value, 0, 60, 2), rowLimit: clampNum($('setRows').value, 5, 500, 50),
    stuckMinutes: clampNum($('setStuck').value, 1, 1440, 5), redact: $('setRedact').checked, includeBodies: $('setBodies').checked,
    actionsEnabled: $('setActions').checked,
    claudeKey: $('setKey').value.trim(), claudeModel: $('setModel').value, claudeBodies: $('setClaudeBodies').checked, claudeConfirmed: !$('setAsk').checked,
  };
  if (claude) claude.settings = settings;
  if (last) { renderClaude(); renderActions(); }
  chrome.storage.local.set({ settings }).catch(() => {});
}
const clampNum = (x, lo, hi, dflt) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

// ---------------- tab detection ----------------

async function currentTab() {
  const forced = new URLSearchParams(location.search).get('tabId');
  if (forced) { try { return await chrome.tabs.get(Number(forced)); } catch (e) {} }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t || null;
}

async function refreshTab() {
  tab = await currentTab();
  let host = '';
  try { host = new URL(tab?.url || '').host; } catch (e) {}
  const isSn = SN_HOST.test(host);
  let granted = isSn;
  if (!isSn && host && /^https:/.test(tab.url)) {
    try { granted = await chrome.permissions.contains({ origins: [`https://${host}/*`] }); } catch (e) {}
    $('perm').classList.toggle('hidden', granted);
  } else $('perm').classList.add('hidden');
  $('instance').textContent = granted ? host : 'Open a ServiceNow tab to start';
  for (const b of ['btnTrace', 'btnPage', 'btnRecent']) $(b).disabled = !granted || busy;
  return granted;
}

// ---------------- actions ----------------

function progress(msg) { $('progress').textContent = msg; }

async function run(fn) {
  if (busy) return;
  if (!(await refreshTab())) return;
  busy = true; await refreshTab();
  $('out').innerHTML = '';
  const t0 = performance.now();
  try {
    const client = makeTabClient(tab.id);
    const col = new Collector(client, settings, m => progress(m));
    progress('Collecting evidence…');
    const ev = await fn(col);
    const rca = runRules(ev, { stuckMinutes: settings.stuckMinutes });
    last = { ev, rca };
    claude?.stop(); claude = null; actionView = null;
    claudeState = { phase: 'idle', error: '', consent: false, streaming: '', pendingQ: '' };
    render(ev, rca);
    progress(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s · ${ev.meta.apiCalls ?? client.calls} read-only calls`);
    renderInstance(ev);
  } catch (e) {
    progress('');
    $('out').innerHTML = `<section class="card warn">Trace failed: ${esc(e?.message || e)}</section>`;
    console.error(e);
  } finally {
    busy = false; await refreshTab();
    $('btnCopy').disabled = $('btnJson').disabled = !last;
  }
}

function renderInstance(ev) {
  const u = ev.user || {};
  $('instance').innerHTML = `${esc(ev.meta.instance || '')} · ${esc(u.userName || '?')}${u.isAdmin ? '<span class="badge" title="Results reflect admin access">admin</span>' : ''}`;
}

const traceInput = text => run(col => col.trace(text, { url: tab?.url }));

// ---------------- rendering ----------------

function render(ev, rca) {
  const out = [];
  if (ev.warnings?.length) out.push(`<section class="card">${ev.warnings.map(w => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}</section>`);

  if (ev.candidates?.length) {
    out.push(`<section class="card"><h2>Matches</h2>${ev.candidates.map(c => `
      <div class="list-item"><div><div>${esc(c.display)}</div><div class="meta">${esc(c.label)} · ${esc(c.table)}</div></div>
      <button data-trace="${esc(c.id)}">Trace</button></div>`).join('')}</section>`);
  }

  if (ev.root) {
    out.push(`<section class="card"><h2>Traced</h2><div class="kv">
      <div>Type</div><div>${esc(ev.root.label)}</div>
      <div>Record</div><div>${esc(ev.root.display)}</div>
      <div>Table</div><div>${esc(ev.root.table)}</div>
      ${ev.platform?.family ? `<div>Release</div><div>${esc(ev.platform.family[0].toUpperCase() + ev.platform.family.slice(1))}${ev.platform.patch ? ' patch ' + esc(ev.platform.patch) : ''}</div>` : ''}
      ${ev.meta.window ? `<div>Log window</div><div>${esc(ev.meta.window.from)} → ${esc(ev.meta.window.to)} UTC</div>` : ''}
      </div></section>`);
  }

  if (rca.rootCause) {
    const f = rca.rootCause;
    out.push(`<section class="card root-cause"><h2>Most likely root cause</h2>
      <div class="rc-title"><span class="sev ${f.severity}">${f.severity}</span>${esc(f.title)}</div>
      ${f.detail ? `<div class="fd">${esc(f.detail)}</div>` : ''}
      ${f.fix ? `<div class="fx"><b>Fix:</b> ${esc(f.fix)}</div>` : ''}
      <div class="rid">${esc(f.id)}</div>
      ${rca.alsoLikely?.length ? `<div class="also"><b>Also check:</b><ul>${rca.alsoLikely.map(a => `<li><span class="sev ${a.severity}">${a.severity}</span>${esc(a.title)}</li>`).join('')}</ul></div>` : ''}</section>`);
  }

  if (ev.root || rca.findings.length) {
    const counts = Object.fromEntries(SEVERITY.map(s => [s, rca.findings.filter(f => f.severity === s).length]));
    out.push(`<section class="card"><h2>Findings (${rca.findings.length})</h2>
      <div class="filters">${SEVERITY.filter(s => counts[s]).map(s => `<button data-sev="${s}" class="${sevFilter.has(s) ? 'on' : ''}">${s} ${counts[s]}</button>`).join('')}</div>
      <div id="findings">${findingsHtml(rca.findings)}</div></section>`);
  }

  if (ev.timeline?.length) {
    const tl = ev.timeline;
    const conv = ev.norm?.conversation;
    out.push(`<section class="card"><h2>Conversation timeline (${tl.length})</h2>
      ${conv ? `<div class="hint">VA conversation · ${esc(conv.deviceType || '')} ${esc(conv.state || '')}</div>` : `<div class="hint">No Virtual Agent transcript linked; showing agent messages, tool and LLM calls.</div>`}
      <div class="timeline">${tl.slice(0, 300).map(e => `<div class="tl ${esc(e.kind)}">
        <div class="tl-h"><span class="tl-t">${esc(String(e.t).slice(11))}</span><span class="tl-k">${esc(TL_LABEL[e.kind] || e.kind)}</span>
          ${e.ref?.id ? `<a href="#" data-open="${esc(e.ref.table)}|${esc(e.ref.id)}">${esc(e.who)}</a>` : esc(e.who)}
          ${e.state ? `<span class="tl-s">${esc(e.state)}</span>` : ''}${e.durationMs ? `<span class="tl-s">${(e.durationMs / 1000).toFixed(1)} s</span>` : ''}</div>
        ${e.content ? (String(e.content).length > 400 ? `<details><summary class="tl-c">${esc(String(e.content).slice(0, 400))}…</summary><div class="tl-c">${esc(e.content)}</div></details>` : `<div class="tl-c">${esc(e.content)}</div>`) : ''}
        ${e.error ? `<div class="tl-e">${esc(e.error)}</div>` : ''}</div>`).join('')}</div></section>`);
  }

  if (ev.root) out.push('<section class="card claude" id="claudeCard"></section>');
  if (ev.root) out.push('<section class="card actions hidden" id="actionsCard"></section>');

  if (ev.recentPlans?.length) {
    out.push(`<section class="card"><h2>Execution plans</h2>${ev.recentPlans.slice(0, 15).map(p => `
      <div class="list-item"><div><div>${esc(p.display)}</div><div class="meta">${esc(p.state || '')} · ${esc(p.created || '')}</div></div>
      <button data-trace="${esc(p.id)}">Trace</button></div>`).join('')}</section>`);
  }

  if (ev.plugins?.length) {
    out.push(`<section class="card"><h2>AI app versions</h2><table><tr><th>Scope</th><th>Version</th><th>Active</th></tr>
      ${ev.plugins.map(p => `<tr><td>${esc(p.scope)}</td><td>${esc(p.version)}</td><td>${p.active ? 'yes' : '<span class="warn">no</span>'}</td></tr>`).join('')}</table></section>`);
  }

  const secs = (ev.sections || []).filter(s => s.key !== 'plugins');
  if (secs.length) {
    out.push(`<section class="card"><h2>Evidence</h2>${secs.map((s, i) => `
      <details><summary>${esc(s.title)} <span class="count">${s.rows.length}</span>${s.status && s.status !== 'ok' ? ` <span class="bad">${esc(s.status)}</span>` : ''}</summary>
      <div class="meta hint">${esc(s.table)}${s.via ? ' · via ' + esc(s.via) : ''}${s.note ? ' · ' + esc(s.note) : ''}${s.error ? ' · ' + esc(s.error) : ''}</div>
      ${rowsTable(s, i)}</details>`).join('')}</section>`);
  }
  $('out').innerHTML = out.join('');
  renderClaude();
  renderActions();
}

// ---------------- stop actions (opt-in) ----------------

let actionView = null;   // { action, script }

function renderActions() {
  const card = $('actionsCard');
  if (!card || !last) return;
  const acts = settings.actionsEnabled ? availableActions(last.ev, { stuckMinutes: settings.stuckMinutes }) : [];
  card.classList.toggle('hidden', !acts.length);
  if (!acts.length) return;
  const parts = ['<h2>Stop AI Agent processing</h2>',
    '<div class="hint">These change the instance. The extension does not run them: it opens Scripts - Background with the script filled in, in dry-run mode. Read the output, then set DRY_RUN = false and run again.</div>',
    `<div class="row buttons" style="margin-top:8px">${acts.map(a => `<button data-act="${esc(a.id)}" ${a.open ? '' : 'title="Nothing open to stop"'}>${esc(a.label)}</button>`).join('')}</div>`];
  if (actionView) {
    parts.push(`<div class="consent"><b>${esc(actionView.action.label)}</b><div class="fd">${esc(actionView.action.detail)}</div>
      ${actionView.action.open ? '' : '<div class="warn">The run does not look open any more; the script will skip records already in a final state.</div>'}
      <details open><summary class="hint">Script (${actionView.script.split('\n').length} lines)</summary><pre>${esc(actionView.script)}</pre></details>
      <div class="row buttons"><button class="primary" id="actOpen">Open in Scripts - Background</button><button id="actCopy">Copy script</button><button id="actClose">Close</button></div>
      <div class="hint">Supported alternatives: Cancel on the agentic workflow card, Deactivate in AI Agent Studio, or the AI Control Tower kill switch.</div></div>`);
  }
  card.innerHTML = parts.join('');
}

async function openScriptsBackground(script) {
  try { await navigator.clipboard.writeText(script); } catch (e) {}
  const origin = new URL(tab.url).origin;
  const t = await chrome.tabs.create({ url: `${origin}/sys.scripts.do`, active: true });
  const ready = new Promise(resolve => {
    const done = (id, info) => { if (id === t.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); resolve(); } };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 15000);
  });
  await ready;
  let filled = false;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: pageFillScript, args: [script] });
    filled = Boolean(res?.result?.ok);
  } catch (e) {}
  progress(filled ? 'Script filled into Scripts - Background (also copied). Review it and click Run; it starts as a dry run.'
    : 'Opened Scripts - Background. The script is on your clipboard: paste it into the box, review, and click Run.');
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act], #actOpen, #actCopy, #actClose');
  if (!t || !last) return;
  if (t.dataset.act) {
    const a = availableActions(last.ev, { stuckMinutes: settings.stuckMinutes }).find(x => x.id === t.dataset.act);
    actionView = a ? { action: a, script: a.script() } : null;
    renderActions();
  } else if (t.id === 'actOpen' && actionView) openScriptsBackground(actionView.script);
  else if (t.id === 'actCopy' && actionView) navigator.clipboard.writeText(actionView.script).then(() => progress('Script copied.'));
  else if (t.id === 'actClose') { actionView = null; renderActions(); }
});

// ---------------- Claude ----------------

let claudeState = { phase: 'idle', error: '', consent: false, streaming: '', pendingQ: '' };

function renderClaude() {
  const card = $('claudeCard');
  if (!card || !last) return;
  const hasKey = Boolean(settings.claudeKey);
  const turns = claude ? claude.transcript() : [];
  const parts = [`<h2>Claude analysis</h2>`];
  if (!turns.length && claudeState.phase === 'idle') {
    parts.push(`<div class="hint">${hasKey ? `Send a redacted summary of this trace to ${esc(modelLabel())} for a written root-cause analysis. You can ask follow-ups after.` : 'Add your Anthropic API key in settings to analyse here, or copy the prompt and paste it into claude.ai.'}</div>`);
  }
  turns.forEach((m, i) => {
    if (m.role === 'user') { if (i > 0) parts.push(`<div class="q">You: ${esc(m.content)}</div>`); }
    else parts.push(`<div class="answer">${mdToHtml(m.content)}</div>`);
  });
  if (claudeState.phase === 'streaming') {
    if (claudeState.pendingQ && turns.length) parts.push(`<div class="q">You: ${esc(claudeState.pendingQ)}</div>`);
    parts.push(`<div class="answer">${claudeState.streaming ? mdToHtml(claudeState.streaming) : '<span class="hint">Claude is reading the evidence…</span>'}</div>`);
  }
  if (claudeState.error) parts.push(`<div class="warn">⚠ ${esc(claudeState.error)}</div>`);
  if (claudeState.consent) {
    const c = compactEvidence(last.ev, last.rca, { redact: true, includeBodies: settings.claudeBodies });
    parts.push(`<div class="consent"><b>Send this trace to Claude?</b>
      <ul><li>About ${Math.round(c.chars / 1000)} KB of redacted evidence and the rule findings</li>
      <li>To api.anthropic.com, model ${esc(settings.claudeModel)}, billed to your key</li>
      <li>Prompt, response and tool input/output bodies: ${settings.claudeBodies ? 'included (redacted, truncated)' : 'left out'}</li></ul>
      <details><summary class="hint">Preview what is sent</summary><pre>${esc(JSON.stringify(c.data, null, 1).slice(0, 30000))}</pre></details>
      <label class="chk"><input type="checkbox" id="claudeDontAsk"> Don't ask again</label>
      <div class="row buttons"><button class="primary" id="claudeSend">Send</button><button id="claudeCancel">Cancel</button></div></div>`);
  }
  const streaming = claudeState.phase === 'streaming';
  if (!claudeState.consent) {
    const btns = [];
    if (!turns.length) btns.push(`<button class="primary" id="claudeGo" ${!hasKey || streaming ? 'disabled' : ''}>Analyse with Claude</button>`);
    if (streaming) btns.push(`<button id="claudeStop">Stop</button>`);
    btns.push(`<button id="claudePaste" title="Copy the full prompt and open claude.ai">Copy prompt for claude.ai</button>`);
    parts.push(`<div class="row buttons" style="margin-top:8px">${btns.join('')}</div>`);
    if (turns.length && !streaming) parts.push(`<div class="followup"><input type="text" id="claudeQ" placeholder="Ask a follow-up about this trace"><button id="claudeAsk">Ask</button></div>`);
  }
  if (claudeState.usage) parts.push(`<div class="meta-line">${esc(settings.claudeModel)} · ${claudeState.usage.input_tokens ?? '?'} in / ${claudeState.usage.output_tokens ?? '?'} out tokens</div>`);
  card.innerHTML = parts.join('');
}

const modelLabel = () => (CLAUDE_MODELS.find(m => m.id === settings.claudeModel)?.label || settings.claudeModel).replace(/ \(.*\)$/, '');

function claudeStart() {
  if (!settings.claudeKey) { $('settings').classList.remove('hidden'); $('setKey').focus(); return; }
  if (!settings.claudeConfirmed) { claudeState = { ...claudeState, consent: true, error: '' }; renderClaude(); return; }
  claudeAsk(null);
}

async function claudeAsk(question) {
  if (!last) return;
  if (!claude) claude = new ClaudeSession({ ev: last.ev, rca: last.rca, settings });
  claudeState = { ...claudeState, phase: 'streaming', streaming: '', error: '', consent: false, pendingQ: question || '' };
  renderClaude();
  let raf = 0;
  try {
    const res = await claude.ask(question, text => {
      claudeState.streaming = text;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderClaude(); });
    });
    claudeState.usage = res.usage;
    if (res.stopReason === 'max_tokens') claudeState.error = 'The answer hit the length limit; ask Claude to continue.';
  } catch (e) {
    claudeState.error = e?.name === 'AbortError' ? 'Stopped.' : String(e?.message || e);
  } finally {
    cancelAnimationFrame(raf);
    claudeState.phase = 'idle'; claudeState.streaming = ''; claudeState.pendingQ = '';
    renderClaude();
  }
}

async function claudePaste() {
  if (!last) return;
  const c = compactEvidence(last.ev, last.rca, { redact: true, includeBodies: settings.claudeBodies });
  await navigator.clipboard.writeText(buildPastePrompt(c));
  progress(`Prompt copied (${Math.round(c.chars / 1000)} KB, redacted). Paste it into the new claude.ai chat.`);
  chrome.tabs.create({ url: 'https://claude.ai/new' });
}

document.addEventListener('click', e => {
  const id = e.target?.id;
  if (id === 'claudeGo') claudeStart();
  else if (id === 'claudeStop') claude?.stop();
  else if (id === 'claudePaste') claudePaste();
  else if (id === 'claudeCancel') { claudeState.consent = false; renderClaude(); }
  else if (id === 'claudeSend') {
    if ($('claudeDontAsk')?.checked) { settings.claudeConfirmed = true; $('setAsk').checked = false; chrome.storage.local.set({ settings }).catch(() => {}); }
    claudeAsk(null);
  } else if (id === 'claudeAsk') { const q = $('claudeQ').value.trim(); if (q) claudeAsk(q); }
});
document.addEventListener('keydown', e => {
  if (e.target?.id === 'claudeQ' && e.key === 'Enter') { const q = e.target.value.trim(); if (q) claudeAsk(q); }
});

function findingsHtml(findings) {
  const shown = findings.filter(f => sevFilter.has(f.severity));
  if (!findings.length) return '<div class="hint">No rule fired. The run looks clean, or the evidence was not readable with your access.</div>';
  return shown.map(f => `<div class="finding">
      <div class="ft"><span class="sev ${f.severity}">${f.severity}</span>${esc(f.title)}</div>
      ${f.detail ? `<div class="fd">${esc(f.detail)}</div>` : ''}
      ${f.fix ? `<div class="fx"><b>Fix:</b> ${esc(f.fix)}</div>` : ''}
      <div class="rid">${esc(f.id)} · ${esc(f.category)}</div></div>`).join('');
}

const val = (row, f) => { const x = row?.[f]; return x && typeof x === 'object' && 'display_value' in x ? (x.display_value || x.value) : x; };
function rowsTable(sec, i) {
  if (!sec.rows.length) return '<div class="hint">No rows.</div>';
  const first = sec.rows[0];
  const stateF = Object.keys(first).find(k => /^(state|status|level)$/.test(k)) || Object.keys(first).find(k => /state|status/.test(k));
  const nameF = ['number', 'name', 'display_name', 'label', 'objective', 'message', 'short_description', 'source'].find(k => k in first);
  return `<table><tr><th style="width:52%">Record</th><th>State</th><th>Created</th></tr>
    ${sec.rows.slice(0, 200).map((r, j) => `<tr>
      <td><a href="#" data-open="${esc(sec.table)}|${esc(val(r, 'sys_id'))}">${esc(String(val(r, nameF) ?? val(r, 'sys_id') ?? '').slice(0, 160))}</a>
        <details><summary class="hint">fields</summary><pre>${esc(JSON.stringify(flatten(r), null, 1))}</pre></details></td>
      <td>${esc(stateF ? val(r, stateF) : '')}</td><td>${esc(val(r, 'sys_created_on') || '')}</td></tr>`).join('')}</table>`;
}
const flatten = r => Object.fromEntries(Object.entries(r).filter(([, x]) => x !== '' && !(x && typeof x === 'object' && x.value === '')).map(([k, x]) => [k, x && typeof x === 'object' && 'value' in x ? (x.display_value && x.display_value !== x.value ? `${x.display_value} (${x.value})` : x.value) : x]));

// ---------------- export ----------------

async function copyReport() {
  if (!last) return;
  const ev = redactEvidence(last.ev, { redact: settings.redact, includeBodies: settings.includeBodies });
  let md = toMarkdown(ev, last.rca, { redact: settings.redact });
  if (claude?.started) md += '\n\n## Claude analysis (' + settings.claudeModel + ')\n\n' + claude.transcript().map((m, i) => m.role === 'user' ? (i ? `**Q: ${m.content}**` : '') : m.content).filter(Boolean).join('\n\n');
  await navigator.clipboard.writeText(md);
  progress('Report copied to clipboard' + (settings.redact ? ' (redacted)' : ''));
}
function downloadJson() {
  if (!last) return;
  const ev = redactEvidence(last.ev, { redact: settings.redact, includeBodies: settings.includeBodies });
  const blob = new Blob([JSON.stringify({ evidence: ev, rca: last.rca, claude: claude?.started ? { model: settings.claudeModel, transcript: claude.transcript() } : undefined }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sn-ai-trace-${(ev.root?.sysId || 'run').slice(0, 8)}-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------- wiring ----------------

document.addEventListener('click', e => {
  const t = e.target.closest('[data-trace],[data-open],[data-sev]');
  if (!t) return;
  e.preventDefault();
  if (t.dataset.trace) { $('q').value = t.dataset.trace; traceInput(t.dataset.trace); }
  else if (t.dataset.open) {
    const [table, id] = t.dataset.open.split('|');
    const host = new URL(tab.url).origin;
    if (id) chrome.tabs.create({ url: `${host}/${table}.do?sys_id=${id}` });
  } else if (t.dataset.sev) {
    const s = t.dataset.sev;
    sevFilter.has(s) ? sevFilter.delete(s) : sevFilter.add(s);
    t.classList.toggle('on');
    $('findings').innerHTML = findingsHtml(last.rca.findings);
  }
});
$('btnTrace').addEventListener('click', () => traceInput($('q').value));
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') traceInput($('q').value); });
$('btnPage').addEventListener('click', async () => {
  await refreshTab();
  const p = parseSnUrl(tab?.url);
  if (!p.sysId) { progress('No sys_id in the current page URL. Open the agent, plan, tool or skill record first.'); return; }
  $('q').value = p.sysId;
  run(col => col.trace(tab.url));
});
$('btnRecent').addEventListener('click', () => run(col => col.recentRuns(20)));
$('btnSettings').addEventListener('click', () => $('settings').classList.toggle('hidden'));
for (const id of ['setWindow', 'setRows', 'setStuck', 'setRedact', 'setBodies', 'setActions', 'setKey', 'setModel', 'setClaudeBodies', 'setAsk']) $(id).addEventListener('change', saveSettings);
$('btnCopy').addEventListener('click', copyReport);
$('btnJson').addEventListener('click', downloadJson);
$('btnGrant').addEventListener('click', async () => {
  const host = new URL(tab.url).host;
  try { await chrome.permissions.request({ origins: [`https://${host}/*`] }); } catch (e) {}
  refreshTab();
});
chrome.tabs.onActivated.addListener(() => refreshTab());
chrome.tabs.onUpdated.addListener((id, info) => { if (info.url || info.status === 'complete') refreshTab(); });

loadSettings().then(refreshTab);

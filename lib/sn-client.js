// Read-only ServiceNow REST client.
// In the extension, every call runs inside the ServiceNow tab (MAIN world) so it is a
// same-origin request carrying the user's own session and X-UserToken. Only GET is ever
// issued, and only to /api/now/table/ and /api/now/stats/.

// ---- functions injected into the page (must be self-contained) ----

export async function pageGet(path, query) {
  const ALLOWED = /^\/api\/now\/(table|stats)\/[a-z0-9_]+(\/[0-9a-f]{32})?$/i;
  if (!ALLOWED.test(path)) return { ok: false, status: 0, error: 'Blocked by read-only allowlist: ' + path };
  async function token() {
    if (window.__snaiTok) return window.__snaiTok;
    let t = window.g_ck;
    if (!t) { try { t = document.getElementById('gsft_main')?.contentWindow?.g_ck; } catch (e) {} }
    if (!t) { try { t = window.top?.g_ck; } catch (e) {} }
    if (!t) {
      try {
        const r = await fetch('/sys_user_list.do?sysparm_query=sys_idISEMPTY', { credentials: 'same-origin' });
        const m = (await r.text()).match(/g_ck\s*=\s*['"]([a-f0-9]{20,})['"]/i);
        if (m) t = m[1];
      } catch (e) {}
    }
    window.__snaiTok = t || '';
    return window.__snaiTok;
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const url = path + (qs.toString() ? '?' + qs.toString() : '');
  try {
    const tok = await token();
    const headers = { Accept: 'application/json' };
    if (tok) headers['X-UserToken'] = tok;
    const r = await fetch(url, { method: 'GET', credentials: 'same-origin', headers });
    let body = null;
    try { body = await r.json(); } catch (e) {}
    if (!r.ok) {
      if (r.status === 401) window.__snaiTok = '';
      return { ok: false, status: r.status, error: body?.error?.message || body?.error?.detail || r.statusText, url };
    }
    return { ok: true, status: r.status, result: body?.result, total: Number(r.headers.get('X-Total-Count') || NaN), url };
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message || e), url };
  }
}

export function pageWhoAmI() {
  const N = window.NOW || {};
  const u = N.user || {};
  const g = window.g_user || {};
  return {
    host: location.host,
    userID: u.userID || g.userID || '',
    userName: u.name || g.userName || '',
    fullName: u.fullName || ((g.firstName || '') + ' ' + (g.lastName || '')).trim(),
    hasToken: Boolean(window.g_ck),
    url: location.href,
  };
}

// ---- client factories ----

export function makeTabClient(tabId) {
  let calls = 0;
  async function get(path, query = {}) {
    calls++;
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageGet, args: [path, query] });
    return res?.result ?? { ok: false, status: 0, error: 'Script injection returned nothing' };
  }
  async function whoami() {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageWhoAmI });
    return res?.result || {};
  }
  return { get, whoami, get calls() { return calls; } };
}

// Used by the Node test harness against the mock instance.
export function makeHttpClient(baseUrl, { token = 'test-token', user = {} } = {}) {
  let calls = 0;
  async function get(path, query = {}) {
    calls++;
    const ALLOWED = /^\/api\/now\/(table|stats)\/[a-z0-9_]+(\/[0-9a-f]{32})?$/i;
    if (!ALLOWED.test(path)) return { ok: false, status: 0, error: 'Blocked by read-only allowlist: ' + path };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const r = await fetch(baseUrl + path + '?' + qs, { headers: { Accept: 'application/json', 'X-UserToken': token } });
    const body = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, status: r.status, error: body?.error?.message || r.statusText };
    return { ok: true, status: r.status, result: body?.result, total: Number(r.headers.get('X-Total-Count') || NaN) };
  }
  return { get, whoami: async () => ({ host: new URL(baseUrl).host, ...user }), get calls() { return calls; } };
}

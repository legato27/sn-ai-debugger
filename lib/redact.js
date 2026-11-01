// PII redaction for exported evidence. Conservative by default: prompt and response
// bodies are dropped unless the user opts in, and common identifiers are masked.

const PATTERNS = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]'],
  [/\b[STFGM]\d{7}[A-Z]\b/g, '[NRIC]'],                          // Singapore NRIC/FIN
  [/\b(?:\d[ -]?){13,19}\b/g, '[CARD?]'],
  [/(?:\+?\d{1,3}[ -]?)?(?:\(?\d{2,4}\)?[ -]?)?\d{3,4}[ -]?\d{4}\b/g, '[PHONE]'],
  [/\b(?:eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[JWT]'],
  [/\b(?:sk|pk|api|key|token|secret)[-_]?[A-Za-z0-9]{16,}\b/gi, '[SECRET]'],
  [/(password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]'],
];
const BODY_FIELDS = /^(prompt|final_prompt|response|request|payload|request_body|response_body|content|message|input|output|inputs|outputs|value|user_input|transcript)$/i;
const SKIP = /^(sys_id|sys_created_on|sys_updated_on|number|state|status|level|source|table|kind)$/i;

export function redactText(s) {
  if (s == null) return s;
  let out = String(s);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redactEvidence(ev, { redact = true, includeBodies = false, bodyMax = 1500 } = {}) {
  const walk = (x, key = '') => {
    if (x == null) return x;
    if (Array.isArray(x)) return x.map(i => walk(i, key));
    if (typeof x === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(x)) o[k] = walk(val, k);
      return o;
    }
    if (typeof x !== 'string') return x;
    if (SKIP.test(key) || /^[0-9a-f]{32}$/i.test(x)) return x;
    let s = x;
    if (BODY_FIELDS.test(key)) {
      if (!includeBodies) return s ? `[${s.length} chars omitted]` : s;
      if (s.length > bodyMax) s = s.slice(0, bodyMax) + `… [${x.length - bodyMax} more chars]`;
    }
    return redact ? redactText(s) : s;
  };
  const clone = walk(ev);
  if (clone.user) clone.user = { ...clone.user, fullName: redact ? '[USER]' : clone.user.fullName };
  clone.meta = { ...clone.meta, redacted: redact, bodiesIncluded: includeBodies };
  return clone;
}

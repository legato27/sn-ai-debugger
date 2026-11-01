// Minimal in-memory Glide runtime for executing generated background scripts in Node.
export function makeGlide({ instance = 'dev00000', now = '2026-10-31 03:00:00', tables = {} }) {
  const toDate = s => new Date(String(s).replace(' ', 'T') + 'Z');
  const printed = [], infos = [], updates = [], flowCancels = [];
  class GlideDateTime {
    constructor(v) { this.t = v ? toDate(v).getTime() : toDate(now).getTime(); }
    addSeconds(n) { this.t += n * 1000; }
    after(o) { return this.t > o.t; }
  }
  class GlideRecord {
    constructor(table) { this.table = table; this.conds = []; this.res = []; this.i = -1; this.cur = null; this.pending = {}; }
    isValid() { return Boolean(tables[this.table]); }
    isValidField(f) { return Boolean(tables[this.table]?.fields.includes(f)); }
    addQuery(f, op, v) { if (v === undefined) { v = op; op = '='; } this.conds.push({ f, op, v: String(v) }); }
    query() {
      const rows = tables[this.table]?.rows || [];
      this.res = rows.filter(r => this.conds.every(c => {
        const x = String(r[c.f] ?? '');
        if (c.op === 'STARTSWITH') return x.startsWith(c.v);
        return x === c.v;
      }));
      this.i = -1;
    }
    next() { this.i++; this.cur = this.res[this.i] || null; this.pending = {}; return Boolean(this.cur); }
    get(id) { this.cur = (tables[this.table]?.rows || []).find(r => r.sys_id === id) || null; this.pending = {}; return Boolean(this.cur); }
    getValue(f) { const x = this.cur?.[f]; return x === undefined || x === '' ? null : String(x); }
    setValue(f, v) { this.pending[f] = String(v); }
    update() { updates.push({ table: this.table, id: this.cur.sys_id, ...this.pending }); Object.assign(this.cur, this.pending); this.pending = {}; return this.cur.sys_id; }
    getUniqueValue() { return this.cur?.sys_id; }
    getDisplayValue() { return this.cur?.number || this.cur?.name || this.cur?.sys_id; }
    getTableName() { return this.table; }
  }
  const gs = { getProperty: k => (k === 'instance_name' ? instance : null), print: s => printed.push(String(s)), info: s => infos.push(String(s)), getUserName: () => 'admin' };
  const sn_fd = { FlowAPI: { cancel: (id, why) => flowCancels.push({ id, why }) } };
  const run = script => new Function('GlideRecord', 'GlideDateTime', 'gs', 'sn_fd', script)(GlideRecord, GlideDateTime, gs, sn_fd);
  return { run, printed, infos, updates, flowCancels, tables };
}

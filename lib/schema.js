// Discovers tables, hierarchies and reference fields from the instance's own data dictionary,
// so the collectors do not depend on hard-coded field names.
import { CHILD_TABLE_PREFIXES, FIELD_HINTS } from './config.js';

export const v = (row, f) => (row && row[f] !== undefined && row[f] !== null && typeof row[f] === 'object' && 'value' in row[f]) ? row[f].value : (row ? row[f] : undefined);
export const d = (row, f) => (row && row[f] && typeof row[f] === 'object' && 'display_value' in row[f]) ? row[f].display_value : v(row, f);

export class Schema {
  constructor(client) {
    this.c = client;
    this._exists = new Map();
    this._hier = new Map();
    this._fields = new Map();
    this._rev = new Map();
    this.dictionaryReadable = true;
  }

  // { exists: bool, readable: bool, status }
  async probe(table) {
    if (this._exists.has(table)) return this._exists.get(table);
    const r = await this.c.get(`/api/now/table/${table}`, { sysparm_limit: 1, sysparm_fields: 'sys_id' });
    const out = { exists: r.ok || r.status === 403, readable: r.ok, status: r.status, error: r.ok ? null : r.error };
    this._exists.set(table, out);
    return out;
  }

  async firstExisting(tables) {
    for (const t of tables) { const p = await this.probe(t); if (p.exists) return t; }
    return null;
  }

  async hierarchy(table) {
    if (this._hier.has(table)) return this._hier.get(table);
    const chain = [table];
    let cur = table;
    for (let i = 0; i < 8; i++) {
      const r = await this.c.get('/api/now/table/sys_db_object', {
        sysparm_query: `name=${cur}`, sysparm_fields: 'name,super_class.name', sysparm_limit: 1,
      });
      if (!r.ok) { this.dictionaryReadable = false; break; }
      const parent = r.result?.[0]?.['super_class.name'];
      if (!parent || chain.includes(parent)) break;
      chain.push(parent); cur = parent;
    }
    this._hier.set(table, chain);
    return chain;
  }

  // Map element -> { type, reference, label, table }
  async fields(table) {
    if (this._fields.has(table)) return this._fields.get(table);
    const hier = await this.hierarchy(table);
    const r = await this.c.get('/api/now/table/sys_dictionary', {
      sysparm_query: `nameIN${hier.join(',')}^elementISNOTEMPTY`,
      sysparm_fields: 'name,element,internal_type,reference,column_label',
      sysparm_limit: 1500,
    });
    const map = new Map();
    if (r.ok) {
      for (const f of r.result || []) {
        map.set(f.element, { type: f.internal_type, reference: f.reference, label: f.column_label, table: f.name });
      }
    } else this.dictionaryReadable = false;
    this._fields.set(table, map);
    return map;
  }

  // Fields on `table` that reference any table in `targetTable`'s hierarchy.
  async refFieldsTo(table, targetTable) {
    const [fields, targetHier] = [await this.fields(table), await this.hierarchy(targetTable)];
    const out = [];
    for (const [el, f] of fields) if (f.type === 'reference' && targetHier.includes(f.reference)) out.push(el);
    return out;
  }

  // All forward references on a table: [{ field, reference }]
  async forwardRefs(table) {
    const fields = await this.fields(table);
    return [...fields].filter(([, f]) => f.type === 'reference' && f.reference).map(([field, f]) => ({ field, reference: f.reference }));
  }

  // Child tables (filtered by prefix) that hold a reference to `table`: [{ table, field }]
  async reverseRefs(table) {
    if (this._rev.has(table)) return this._rev.get(table);
    const hier = await this.hierarchy(table);
    const r = await this.c.get('/api/now/table/sys_dictionary', {
      sysparm_query: `internal_type=reference^referenceIN${hier.join(',')}`,
      sysparm_fields: 'name,element', sysparm_limit: 500,
    });
    const out = [];
    if (r.ok) {
      for (const f of r.result || []) {
        if (CHILD_TABLE_PREFIXES.some(p => f.name.startsWith(p)) && !f.name.endsWith('_list')) out.push({ table: f.name, field: f.element });
      }
    } else this.dictionaryReadable = false;
    this._rev.set(table, out);
    return out;
  }

  // Pick the best-matching real field name for a semantic hint (state, error, ...)
  async pick(table, hint, extraNames = []) {
    const fields = await this.fields(table);
    const names = fields.size ? [...fields.keys()] : extraNames;
    return pickName(names, hint);
  }
}

export function pickName(names, hint) {
  const pats = FIELD_HINTS[hint] || [];
  for (const p of pats) { const hit = names.find(n => p.test(n)); if (hit) return hit; }
  return null;
}

// Pick from a row when the dictionary is not readable.
export function pickFromRow(row, hint) {
  return row ? pickName(Object.keys(row), hint) : null;
}

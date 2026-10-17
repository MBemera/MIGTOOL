import {
  type Binding,
  type Data,
  type Envelope,
  type Pack,
  type Conflict,
  fields,
  get,
  set,
  same,
  fieldDefinition,
  PlatformError,
} from './model';

export function transform(value: any, name: string | undefined, pack: Pack): any {
  if (!name) return value ?? '';
  if (name === 'trim') return String(value ?? '').trim();
  if (name === 'digitsOnly') return String(value ?? '').replace(/\D/g, '');
  if (name === 'padPostcode') return String(value ?? '').padStart(4, '0');
  if (name === 'uppercase') return String(value ?? '').toUpperCase();
  if (name === 'yesNo') {
    if (typeof value === 'boolean') return value;
    const text = String(value ?? '')
      .trim()
      .toUpperCase();
    if (['Y', 'YES', 'TRUE', '1'].includes(text)) return true;
    if (['N', 'NO', 'FALSE', '0'].includes(text)) return false;
    throw new PlatformError('INVALID_FLAG', `Expected Y or N, received ${String(value)}`);
  }
  if (name === 'isoDate') {
    const text = String(value ?? '').trim();
    const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
    const iso = dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : text;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(iso) ||
      Number.isNaN(Date.parse(iso)) ||
      new Date(iso).toISOString().slice(0, 10) !== iso
    )
      throw new PlatformError('INVALID_DATE', `Expected DD/MM/YYYY or ISO date, received ${text}`);
    return iso;
  }
  if (name.startsWith('lookup:')) {
    const table = pack.lookups[name.slice(7)];
    if (!table || !Object.hasOwn(table, String(value)))
      throw new PlatformError('UNKNOWN_LOOKUP', `Unknown ${name} value: ${String(value)}`);
    return table[String(value)];
  }
  if (name === 'date:DD/MM/YYYY') {
    // Optional dates export blank; malformed dates are still an error.
    if (value == null || value === '') return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)))
      throw new PlatformError('INVALID_DATE', 'Expected ISO date');
    return String(value).split('-').reverse().join('/');
  }
  throw new PlatformError('UNKNOWN_TRANSFORM', `Unregistered transform ${name}`);
}
export const knownTransform = (name?: string) =>
  !name ||
  [
    'trim',
    'digitsOnly',
    'padPostcode',
    'uppercase',
    'yesNo',
    'isoDate',
    'date:DD/MM/YYYY',
  ].includes(name) ||
  name.startsWith('lookup:');
function applyBindings(source: Data, bindings: Binding[], pack: Pack): Data {
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new PlatformError('MALFORMED_ROW', 'Extract groups must contain objects');
  const target: Data = {};
  for (const b of bindings)
    if (Object.hasOwn(source, b.from) && source[b.from] != null)
      set(target, b.to!, transform(source[b.from], b.transform, pack));
  return target;
}
export function ingestRow(pack: Pack, row: Data): Data {
  const data = applyBindings(row, pack.ingest.fields, pack);
  for (const group of pack.ingest.groups) {
    const source = row[group.from];
    if (source !== undefined && !Array.isArray(source))
      throw new PlatformError('MALFORMED_ROW', `${group.from} must be an array`);
    set(
      data,
      group.to,
      (source ?? []).map((item: Data) => applyBindings(item, group.fields, pack)),
    );
  }
  for (const { field, path } of fields(pack))
    if (field.declaredBy === 'customer') {
      if (pack.ingest.fields.some((b) => b.to === path))
        throw new PlatformError('DECLARED_FIELD', 'Customer declaration cannot be ingested');
    }
  return data;
}
export function leafValues(data: Data, prefix = ''): Data {
  const out: Data = {};
  for (const [key, value] of Object.entries(data)) {
    const path = prefix ? (Array.isArray(data) ? `${prefix}[${key}]` : `${prefix}.${key}`) : key;
    if (value && typeof value === 'object' && Object.keys(value).length)
      Object.assign(out, leafValues(value, path));
    else out[path] = value;
  }
  return out;
}
export function merge(
  record: Envelope,
  incoming: Data,
  actor: string,
  at: string,
  eventId: string,
): { record: Envelope; changes: string[]; conflicts: Conflict[] } {
  const result = structuredClone(record),
    changes: string[] = [],
    conflicts: Conflict[] = [];
  // Collections use whole-collection conflicts when shape changes, preserving human edits.
  const roots = new Set([...Object.keys(record.data), ...Object.keys(incoming)]);
  const incomingLeaves = leafValues(incoming);
  for (const root of roots)
    if (Array.isArray(incoming[root]) || Array.isArray(record.data[root])) {
      const edited = Object.entries(record.provenance).some(
        ([p, v]) => (p === root || p.startsWith(`${root}[`)) && v.source !== 'extract',
      );
      for (const path of Object.keys(result.baseline))
        if (path === root || path.startsWith(`${root}[`)) delete result.baseline[path];
      Object.assign(result.baseline, leafValues({ [root]: incoming[root] ?? [] }));
      if (
        edited &&
        !same(incoming[root], record.data[root]) &&
        !same(incoming[root], getBaselineRoot(record, root))
      ) {
        conflicts.push({
          path: root,
          baseline: getBaselineRoot(record, root),
          current: record.data[root],
          incoming: incoming[root],
        });
      } else if (!edited) {
        result.data[root] = structuredClone(incoming[root] ?? []);
        changes.push(root);
        for (const p of Object.keys(result.provenance))
          if (p.startsWith(`${root}[`)) delete result.provenance[p];
      }
      for (const p of Object.keys(incomingLeaves))
        if ((p === root || p.startsWith(`${root}[`)) && edited) delete incomingLeaves[p];
    }
  // A value the extract no longer supplies is a change to blank, not a reason to keep the old value.
  const arrayRoots = [...roots].filter(
    (root) => Array.isArray(incoming[root]) || Array.isArray(record.data[root]),
  );
  for (const path of Object.keys(record.baseline))
    if (
      !Object.hasOwn(incomingLeaves, path) &&
      !arrayRoots.some((root) => path === root || path.startsWith(`${root}[`)) &&
      record.baseline[path] != null
    )
      incomingLeaves[path] = null;
  for (const [path, value] of Object.entries(incomingLeaves)) {
    const current = get(record.data, path),
      baseline = record.baseline[path],
      human = record.provenance[path] && record.provenance[path].source !== 'extract';
    if (human && !same(value, current) && !same(value, baseline)) {
      conflicts.push({ path, baseline, current, incoming: value });
    } else if (!human || same(value, current)) {
      if (!same(current ?? null, value)) changes.push(path);
      set(result.data, path, value);
      result.provenance[path] = { source: 'extract', actor, at, traceEventId: eventId };
    }
    result.baseline[path] = structuredClone(value);
  }
  result.conflicts = conflicts;
  // Exported records may already be at the CBS, so they are frozen like loaded ones.
  if (
    ['exported', 'loaded', 'reconciled', 'amendment_pending'].includes(record.state) &&
    (!same(result.data, record.data) || conflicts.length)
  ) {
    if (record.state !== 'amendment_pending') result.amendmentFrom = record.state;
    result.pendingData = structuredClone(result.data);
    result.pendingBaseline = structuredClone(result.baseline);
    result.pendingProvenance = structuredClone(result.provenance);
    result.data = structuredClone(record.data);
    result.baseline = structuredClone(record.baseline);
    result.provenance = structuredClone(record.provenance);
    result.state = 'amendment_pending';
  }
  return { record: result, changes, conflicts };
}
export function assertEditableData(pack: Pack, data: Data) {
  const collections = new Set(
    pack.schema.pages.flatMap((p) =>
      p.sections.flatMap((s) => (s.collection ? [s.collection.path] : [])),
    ),
  );
  for (const path of Object.keys(leafValues(data)))
    if (!fieldDefinition(pack, path) && !(collections.has(path) && Array.isArray(get(data, path))))
      throw new PlatformError('UNKNOWN_FIELD', `Unknown field ${path}`);
}
function getBaselineRoot(record: Envelope, root: string) {
  const data: Data = {};
  for (const [p, v] of Object.entries(record.baseline))
    if (p === root || p.startsWith(`${root}[`)) set(data, p, v);
  return data[root];
}
export function csvRows(pack: Pack, record: Envelope, mapping: Pack['mappings'][number]): Data[] {
  const source = mapping.row_source ? get(record.data, mapping.row_source) : [record.data];
  if (!Array.isArray(source))
    throw new PlatformError('MAPPING_SOURCE', `Invalid row source ${mapping.row_source}`);
  const rows = source.map((item) =>
    Object.fromEntries(
      mapping.columns.map((c) => [
        c.name!,
        transform(
          c.from === '$record.recordId' ? record.recordId : get(item, c.from),
          c.transform,
          pack,
        ),
      ]),
    ),
  );
  const order = mapping.order_by ?? [];
  return rows.sort((a, b) => {
    for (const key of order) {
      const aa = String(a[key]),
        bb = String(b[key]);
      if (aa !== bb) return aa < bb ? -1 : 1;
    }
    return 0;
  });
}
export function csv(headers: string[], rows: Data[]): string {
  const escape = (value: any) => {
    const s = String(value ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    headers.map(escape).join(',') +
    '\r\n' +
    rows.map((row) => headers.map((h) => escape(row[h])).join(',')).join('\r\n') +
    (rows.length ? '\r\n' : '')
  );
}

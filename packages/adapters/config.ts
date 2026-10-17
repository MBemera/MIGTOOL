import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { compile } from '../core/engine';
import { type Pack, fields, normalisePath, PlatformError } from '../core/model';
import { knownTransform } from '../core/mapping';

export const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export const hash = (value: unknown) =>
  createHash('sha256')
    .update(value instanceof Uint8Array ? value : typeof value === 'string' ? value : stable(value))
    .digest('hex');
const condition = z.union([
  z.string(),
  z
    .object({ engine: z.literal('fn'), name: z.string(), args: z.array(z.string()).optional() })
    .strict(),
  z.object({ engine: z.literal('jsonlogic'), rule: z.any() }).strict(),
  z.object({ engine: z.literal('jsonata'), expression: z.string() }).strict(),
]);
const binding = z.object({
  from: z.string(),
  to: z.string().optional(),
  name: z.string().optional(),
  transform: z.string().optional(),
});
const field = z
  .object({
    path: z.string(),
    label: z.string(),
    type: z.enum(['text', 'select', 'boolean', 'number', 'currency', 'date', 'document-ref']),
    required: z.boolean().optional(),
    requiredWhen: condition.optional(),
    visibleWhen: condition.optional(),
    declaredBy: z.literal('customer').optional(),
    options: z.string().optional(),
    widget: z.string().optional(),
  })
  .strict();
const schemas: Record<string, z.ZodType> = {
  'operations.yaml': z.object({
    leaseMs: z.number().int().positive(),
    workerLeaseMs: z.number().int().positive(),
    renewMs: z.number().int().positive(),
    inactivityMs: z.number().int().positive(),
    retrySeconds: z.array(z.number().positive()).min(1).max(10),
    circuitCount: z.number().int().positive(),
    circuitFraction: z.number().positive().max(1),
    llmMode: z.literal('disabled'),
    reviewAgeBusinessDays: z.number().int().positive(),
  }),
  'schema.yaml': z.object({
    version: z.string(),
    pages: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        enabledWhen: condition.optional(),
        sections: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            fields: z.array(field),
            collection: z
              .object({
                path: z.string(),
                min: z.number().int().nonnegative(),
                max: z.number().int().positive(),
              })
              .optional(),
          }),
        ),
      }),
    ),
  }),
  'rules.yaml': z.object({
    defaults: z.object({ engine: z.enum(['jsonata', 'jsonlogic', 'fn']) }),
    rules: z.array(
      z.object({
        id: z.string(),
        section: z.string(),
        severity: z.enum(['critical', 'warning', 'info']),
        weight: z.number().positive(),
        assert: condition,
        fields: z.array(z.string()).min(1),
        message: z.string(),
        class: z.enum(['gap', 'data']).optional(),
        reason: z.string().optional(),
      }),
    ),
  }),
  'gates.yaml': z.object({
    gates: z.record(
      z.string(),
      z.object({
        block_on: z.array(z.enum(['critical', 'warning', 'info'])),
        min_score: z.number().min(0).max(100),
        requires: z.array(z.string()).optional(),
        unlocks: z.array(z.string()),
      }),
    ),
  }),
  'protected-fields.yaml': z.object({ protected: z.array(z.string()) }),
  'playbook.yaml': z.object({
    entries: z.array(
      z.object({
        id: z.string(),
        match: z.object({ step: z.string(), errorCode: z.string() }),
        path: z.string(),
        transform: z.string(),
        autoApply: z.boolean(),
        approvedBy: z.string().min(1),
      }),
    ),
  }),
  'mappings/ingest/bank1.yaml': z.object({
    key: z.string(),
    required_columns: z.array(z.string()),
    csv: z
      .object({
        customers: z.string().regex(/^[\w.-]+\.csv$/),
        control: z.string().regex(/^[\w.-]+\.csv$/),
        groups: z.record(z.string(), z.string().regex(/^[\w.-]+\.csv$/)),
      })
      .strict()
      .optional(),
    fields: z.array(binding),
    groups: z.array(z.object({ from: z.string(), to: z.string(), fields: z.array(binding) })),
  }),
};
const outputSchema = z.object({
  output: z.string().regex(/^[\w.-]+$/),
  gate: z.string(),
  kind: z.enum(['csv', 'pdf']),
  row_source: z.string().nullable().optional(),
  columns: z.array(binding).min(1),
  order_by: z.array(z.string()).optional(),
});
export function loadPack(root = 'config'): Pack {
  const hashes: Record<string, string> = {},
    warnings: string[] = [];
  function read(file: string, schema?: z.ZodType): any {
    const raw = readFileSync(join(root, file), 'utf8'),
      lineCounter = new LineCounter(),
      doc = parseDocument(raw, { lineCounter });
    if (doc.errors.length)
      throw new PlatformError('CONFIG_INVALID', `${file}: ${doc.errors[0].message}`, 500);
    const data = doc.toJS();
    hashes[file] = hash(raw);
    if (schema) {
      const result = schema.safeParse(data);
      if (!result.success) {
        const issue = result.error.issues[0];
        const node = doc.getIn(issue.path as any, true) as any;
        const line = lineCounter.linePos(node?.range?.[0] ?? 0).line;
        throw new PlatformError(
          'CONFIG_INVALID',
          `${file}:${line} ${issue.path.join('.')}: ${issue.message}`,
          500,
        );
      }
      return result.data;
    }
    return data;
  }
  const pack: Pack = {
    operations: read('operations.yaml', schemas['operations.yaml']),
    schema: read('schema.yaml', schemas['schema.yaml']),
    rules: read('rules.yaml', schemas['rules.yaml']),
    gates: read('gates.yaml', schemas['gates.yaml']),
    protected: read('protected-fields.yaml', schemas['protected-fields.yaml']),
    playbook: read('playbook.yaml', schemas['playbook.yaml']),
    ingest: read('mappings/ingest/bank1.yaml', schemas['mappings/ingest/bank1.yaml']),
    mappings: [],
    lookups: {},
    version: hashes,
    warnings,
  };
  for (const file of readdirSync(join(root, 'lookups')).sort())
    if (file.endsWith('.yaml'))
      pack.lookups[file.slice(0, -5)] = read(`lookups/${file}`, z.record(z.string(), z.string()));
  for (const file of readdirSync(join(root, 'mappings/output')).sort())
    if (file.endsWith('.yaml')) pack.mappings.push(read(`mappings/output/${file}`, outputSchema));
  const all = fields(pack),
    paths = new Set(all.map((f) => f.path)),
    sections = new Set(all.map((f) => f.section.id));
  if (pack.operations.renewMs >= pack.operations.leaseMs)
    throw new Error('operations.yaml: renewal must occur before human lease expiry');
  const check = (p: string, where: string) => {
    if (!paths.has(normalisePath(p)))
      throw new PlatformError('CONFIG_INVALID', `${where}: unknown schema field ${p}`, 500);
  };
  const checkTransform = (t: string | undefined, where: string) => {
    if (!knownTransform(t))
      throw new PlatformError('CONFIG_INVALID', `${where}: unknown transform ${t}`, 500);
    if (t?.startsWith('lookup:') && !pack.lookups[t.slice(7)])
      throw new PlatformError('CONFIG_INVALID', `${where}: unknown lookup ${t}`, 500);
  };
  const compileAt = (c: any, where: string) => {
    try {
      compile(c, pack.rules.defaults.engine);
    } catch (e) {
      throw new PlatformError('CONFIG_INVALID', `${where}: ${String(e)}`, 500);
    }
  };
  const ids = new Set<string>();
  for (const rule of pack.rules.rules) {
    if (ids.has(rule.id)) throw new Error(`rules.yaml: duplicate rule ${rule.id}`);
    ids.add(rule.id);
    if (!sections.has(rule.section)) throw new Error(`rules.yaml: unknown section ${rule.section}`);
    rule.fields.forEach((p) => check(p, `rules.yaml rule ${rule.id}`));
    compileAt(rule.assert, `rules.yaml rule ${rule.id}`);
    if (
      typeof rule.assert !== 'string' &&
      rule.assert.engine !== pack.rules.defaults.engine &&
      !rule.reason
    )
      warnings.push(`${rule.id} uses ${rule.assert.engine} without a reason`);
  }
  for (const { field: fieldDef, page, path } of all) {
    if (fieldDef.options && !pack.lookups[fieldDef.options.replace('lookup:', '')])
      throw new Error(`schema.yaml: unknown lookup ${fieldDef.options}`);
    if (fieldDef.widget && !['abn', 'address', 'signatory'].includes(fieldDef.widget))
      throw new Error(`schema.yaml: unregistered widget ${fieldDef.widget}`);
    if (fieldDef.visibleWhen) compileAt(fieldDef.visibleWhen, `schema.yaml ${path}`);
    if (fieldDef.requiredWhen) compileAt(fieldDef.requiredWhen, `schema.yaml ${path}`);
    if (page.enabledWhen) compileAt(page.enabledWhen, `schema.yaml ${page.id}`);
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function gate(id: string) {
    if (visiting.has(id)) throw new Error(`gates.yaml: cyclic gate ${id}`);
    if (visited.has(id)) return;
    if (!pack.gates.gates[id]) throw new Error(`gates.yaml: unknown gate ${id}`);
    visiting.add(id);
    for (const parent of pack.gates.gates[id].requires ?? []) gate(parent);
    visiting.delete(id);
    visited.add(id);
  }
  Object.keys(pack.gates.gates).forEach(gate);
  if (!pack.gates.gates.aaf || !pack.gates.gates.cbs)
    throw new Error('gates.yaml: aaf and cbs required');
  for (const b of pack.ingest.fields) {
    check(b.to!, 'bank1.yaml');
    checkTransform(b.transform, 'bank1.yaml');
    if (all.find((f) => f.path === b.to)?.field.declaredBy)
      throw new Error(`bank1.yaml: declared field ${b.to} cannot be ingested`);
  }
  for (const group of pack.ingest.groups)
    for (const b of group.fields) {
      const path = `${group.to}[*].${b.to}`;
      check(path, 'bank1.yaml');
      checkTransform(b.transform, 'bank1.yaml');
      if (all.find((f) => f.path === path)?.field.declaredBy)
        throw new Error(`bank1.yaml: declared field ${path} cannot be ingested`);
    }
  for (const mapping of pack.mappings) {
    if (!pack.gates.gates[mapping.gate]?.unlocks.includes(mapping.output))
      throw new Error(`${mapping.output}: not unlocked by gate ${mapping.gate}`);
    for (const col of mapping.columns) {
      if (col.from !== '$record.recordId')
        check(
          mapping.row_source ? `${mapping.row_source}[*].${col.from}` : col.from,
          mapping.output,
        );
      checkTransform(col.transform, mapping.output);
      if (!col.name) throw new Error(`${mapping.output}: missing column name`);
    }
  }
  // A protected path not yet in the schema stays listed so it is enforced when the field is added,
  // but it must not pass silently.
  pack.protected.protected.forEach((p) => {
    if (![...paths].some((path) => path === p || path.startsWith(`${p}.`)))
      warnings.push(`protected-fields.yaml: ${p} matches no schema field yet`);
  });
  if (pack.ingest.csv)
    for (const group of Object.keys(pack.ingest.csv.groups))
      if (!pack.ingest.groups.some((g) => g.from === group))
        throw new Error(`bank1.yaml: csv group ${group} has no group mapping`);
  for (const entry of pack.playbook.entries) {
    check(entry.path, 'playbook.yaml');
    checkTransform(entry.transform, 'playbook.yaml');
  }
  return pack;
}

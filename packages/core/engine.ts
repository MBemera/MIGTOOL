import jsonata from 'jsonata';
import logic from 'json-logic-js';
import { z } from 'zod';
import {
  type Condition,
  type Data,
  type Envelope,
  type Evaluation,
  type Pack,
  type State,
  fields,
  expand,
  get,
  PlatformError,
} from './model';

export const functions: Record<string, (data: Data, args: string[]) => boolean> = {
  present: (d, args) =>
    args.every((p) => {
      const v = get(d, p);
      return v !== undefined && v !== null && String(v).trim() !== '';
    }),
  validAbn: (d, [p]) => {
    const s = String(get(d, p) ?? '');
    if (!/^\d{11}$/.test(s)) return false;
    const a = [...s].map(Number);
    a[0] -= 1;
    return a.reduce((v, n, i) => v + n * [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19][i], 0) % 89 === 0;
  },
  validPostcode: (d, [p]) => /^\d{4}$/.test(String(get(d, p) ?? '')),
  knownProduct: (d) =>
    Array.isArray(d.accounts) &&
    d.accounts.every((a: Data) =>
      [
        'TRAN',
        'SAVE',
        'TD',
        'FX',
        'LOAN',
        'OD',
        'CARD',
        'MERCHANT',
        'PAYROLL',
        'BPAY',
        'DIRECT',
        'TRADE',
        'GUARANTEE',
        'CASH',
        'TRUST',
        'ESCROW',
      ].includes(a.productCode),
    ),
};
const cache = new Map<string, (data: Data) => boolean>();
export function compile(condition: Condition, defaultEngine = 'jsonata'): (data: Data) => boolean {
  const key = JSON.stringify([condition, defaultEngine]);
  if (cache.has(key)) return cache.get(key)!;
  const spec =
    typeof condition === 'string' ? { engine: defaultEngine, expression: condition } : condition;
  let compiled: (data: Data) => boolean;
  if (spec.engine === 'fn' && 'name' in spec) {
    const fn = functions[spec.name];
    if (!fn) throw new Error(`Unregistered function ${spec.name}`);
    compiled = (d) => fn(d, spec.args ?? []);
  } else if (spec.engine === 'jsonlogic' && 'rule' in spec) {
    const allowed = new Set([
      'var',
      '!!',
      '!',
      'and',
      'or',
      '==',
      '===',
      '!=',
      '!==',
      '>',
      '>=',
      '<',
      '<=',
      'in',
      'missing',
      'missing_some',
      'all',
      'some',
      'none',
      'if',
      'map',
      'filter',
      'reduce',
      'merge',
      'cat',
      '+',
      '-',
      '*',
      '/',
      '%',
      'min',
      'max',
      'substr',
      '?:',
    ]);
    const validate = (v: any): void => {
      if (Array.isArray(v)) v.forEach(validate);
      else if (v && typeof v === 'object') {
        for (const [k, value] of Object.entries(v)) {
          if (!allowed.has(k)) throw new Error(`Unsupported JSONLogic operation ${k}`);
          validate(value);
        }
      }
    };
    validate(spec.rule);
    compiled = (d) => Boolean(logic.apply(spec.rule, d));
  } else if (spec.engine === 'jsonata' && 'expression' in spec) {
    const expression = jsonata(spec.expression);
    compiled = (d) => Boolean(expression.evaluate(d));
  } else throw new Error(`Unsupported condition engine ${spec.engine}`);
  cache.set(key, compiled);
  return compiled;
}
export function visible(pack: Pack, path: string, data: Data): boolean {
  const found = fields(pack).find((f) => f.path === path.replace(/\[\d+\]/g, '[*]'));
  return (
    !found ||
    ((!found.page.enabledWhen || compile(found.page.enabledWhen)(data)) &&
      (!found.field.visibleWhen || compile(found.field.visibleWhen)(data)))
  );
}
export function validator(pack: Pack) {
  return z.record(z.string(), z.unknown()).superRefine((data, ctx) => {
    for (const page of pack.schema.pages) {
      if (page.enabledWhen && !compile(page.enabledWhen)(data)) continue;
      for (const section of page.sections) {
        if (section.collection) {
          const items = get(data, section.collection.path);
          if (
            !Array.isArray(items) ||
            items.length < section.collection.min ||
            items.length > section.collection.max
          )
            ctx.addIssue({
              code: 'custom',
              path: [section.collection.path],
              message: `Expected ${section.collection.min} to ${section.collection.max} items`,
            });
        }
        for (const field of section.fields) {
          const pattern = section.collection
            ? `${section.collection.path}[*].${field.path}`
            : field.path;
          for (const path of expand(data, pattern)) {
            if (!visible(pack, path, data)) continue;
            const v = get(data, path);
            const required =
              field.required || (field.requiredWhen && compile(field.requiredWhen)(data));
            if (required && (v == null || v === ''))
              ctx.addIssue({ code: 'custom', path: [path], message: `${field.label} is required` });
            if (v != null && v !== '') {
              if (
                field.type === 'date' &&
                (typeof v !== 'string' ||
                  !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
                  Number.isNaN(Date.parse(v)) ||
                  new Date(v).toISOString().slice(0, 10) !== v)
              )
                ctx.addIssue({
                  code: 'custom',
                  path: [path],
                  message: 'Expected a valid calendar date',
                });
              if (
                ['text', 'select', 'document-ref', 'date'].includes(field.type) &&
                typeof v !== 'string'
              )
                ctx.addIssue({ code: 'custom', path: [path], message: 'Expected text' });
              if (field.type === 'boolean' && typeof v !== 'boolean')
                ctx.addIssue({ code: 'custom', path: [path], message: 'Expected true or false' });
              if (
                ['number', 'currency'].includes(field.type) &&
                (typeof v !== 'number' || !Number.isFinite(v))
              )
                ctx.addIssue({ code: 'custom', path: [path], message: 'Expected finite number' });
              if (field.options) {
                const table = pack.lookups[field.options.replace('lookup:', '')];
                if (!Object.hasOwn(table, String(v)))
                  ctx.addIssue({ code: 'custom', path: [path], message: 'Unknown option' });
              }
            }
          }
        }
      }
    }
  });
}
export function evaluate(pack: Pack, data: Data): Evaluation {
  const results = pack.rules.rules
    .filter((rule) => rule.fields.some((p) => visible(pack, p, data)))
    .map((rule) => {
      let passed = false;
      try {
        passed = compile(rule.assert, pack.rules.defaults.engine)(data);
      } catch {
        passed = false;
      }
      const { assert: _, ...rest } = rule;
      return { ...rest, passed };
    });
  const shape = validator(pack).safeParse(data);
  if (!shape.success)
    for (const issue of shape.error.issues) {
      const path = String(issue.path[0]);
      if (
        issue.message.endsWith('is required') &&
        results.some((r) => !r.passed && r.fields.includes(path.replace(/\[\d+\]/g, '[*]')))
      )
        continue;
      results.push({
        id: `schema:${path}`,
        section:
          fields(pack).find((f) => f.path === path.replace(/\[\d+\]/g, '[*]'))?.section.id ??
          'structure',
        severity: 'critical',
        weight: 1,
        fields: [path],
        message: issue.message,
        class: 'gap',
        passed: false,
      });
    }
  const score = (rules: typeof results) => {
    const total = rules.reduce((n, r) => n + r.weight, 0);
    return total
      ? Math.round(
          (10000 * rules.filter((r) => r.passed).reduce((n, r) => n + r.weight, 0)) / total,
        ) / 100
      : 100;
  };
  const overall = score(results);
  const sections: Record<string, number> = {};
  for (const r of results)
    sections[r.section] = score(results.filter((v) => v.section === r.section));
  const gates: Evaluation['gates'] = {};
  const resolve = (id: string): Evaluation['gates'][string] => {
    if (gates[id]) return gates[id];
    const gate = pack.gates.gates[id];
    const blocking = results
      .filter((r) => !r.passed && gate.block_on.includes(r.severity))
      .map((r) => r.id);
    const prerequisites = (gate.requires ?? []).every((p) => resolve(p).open);
    return (gates[id] = {
      open: prerequisites && blocking.length === 0 && overall >= gate.min_score,
      score: overall,
      blockingRules: blocking,
    });
  };
  for (const id of Object.keys(pack.gates.gates)) resolve(id);
  const failures = results.filter((r) => !r.passed);
  const gap = failures.some((r) => r.class === 'gap');
  const state: State = gates.cbs?.open
    ? 'cbs_ready'
    : gates.aaf?.open
      ? 'aaf_ready'
      : gap
        ? 'needs_input'
        : 'blocked';
  return { rules: results, score: overall, sections, gates, state };
}
const transitions: Record<State, State[]> = {
  ingested: ['validating'],
  validating: ['needs_input', 'blocked', 'aaf_ready'],
  needs_input: ['validating'],
  blocked: ['validating', 'on_hold'],
  aaf_ready: ['cbs_ready', 'validating'],
  cbs_ready: ['exported', 'validating'],
  exported: ['loaded', 'blocked', 'amendment_pending'],
  loaded: ['reconciled', 'blocked', 'amendment_pending'],
  reconciled: ['amendment_pending'],
  // A rejected amendment returns to the state it was raised from; delivery failures block.
  amendment_pending: ['reconciled', 'loaded', 'exported', 'blocked'],
  on_hold: ['validating'],
  withdrawn: [],
};
export function transition(record: Envelope, next: State): void {
  if (!transitions[record.state].includes(next))
    throw new PlatformError('ILLEGAL_TRANSITION', `Cannot move ${record.state} to ${next}`, 409);
  record.state = next;
}
export function validationStates(result: Evaluation): State[] {
  return result.state === 'cbs_ready'
    ? ['validating', 'aaf_ready', 'cbs_ready']
    : result.state === 'aaf_ready'
      ? ['validating', 'aaf_ready']
      : ['validating', result.state];
}

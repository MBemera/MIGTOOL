export type Data = Record<string, any>;
export type State =
  | 'ingested'
  | 'validating'
  | 'needs_input'
  | 'blocked'
  | 'aaf_ready'
  | 'cbs_ready'
  | 'exported'
  | 'loaded'
  | 'reconciled'
  | 'amendment_pending'
  | 'on_hold'
  | 'withdrawn';
export type Role = 'operator' | 'reviewer' | 'admin';
export type Actor = {
  id: string;
  kind: 'human' | 'system' | 'llm';
  model?: string;
  promptVersion?: string;
};
export type Provenance = {
  source: 'extract' | 'operator' | 'playbook' | 'llm_approved' | 'migration';
  actor: string;
  at: string;
  traceEventId: string;
};
export interface Envelope {
  recordId: string;
  schemaVersion: string;
  version: number;
  state: State;
  data: Data;
  provenance: Record<string, Provenance>;
  baseline: Data;
  sourceRowHash: string;
  batchId: string;
  createdAt: string;
  updatedAt: string;
  conflicts: Conflict[];
  pendingData?: Data;
  pendingBaseline?: Data;
  pendingProvenance?: Record<string, Provenance>;
  missingFromRefresh?: boolean;
}
export type Conflict = { path: string; baseline: unknown; current: unknown; incoming: unknown };
export type Condition =
  | string
  | { engine: 'fn'; name: string; args?: string[] }
  | { engine: 'jsonlogic'; rule: any }
  | { engine: 'jsonata'; expression: string };
export interface Field {
  path: string;
  label: string;
  type: 'text' | 'select' | 'boolean' | 'number' | 'currency' | 'date' | 'document-ref';
  required?: boolean;
  requiredWhen?: Condition;
  visibleWhen?: Condition;
  declaredBy?: 'customer';
  options?: string;
  widget?: string;
}
export interface Section {
  id: string;
  title: string;
  fields: Field[];
  collection?: { path: string; min: number; max: number };
}
export interface Page {
  id: string;
  title: string;
  sections: Section[];
  enabledWhen?: Condition;
}
export interface Rule {
  id: string;
  section: string;
  severity: 'critical' | 'warning' | 'info';
  weight: number;
  assert: Condition;
  fields: string[];
  message: string;
  class?: 'gap' | 'data';
  reason?: string;
}
export interface RuleResult extends Omit<Rule, 'assert'> {
  passed: boolean;
}
export interface Gate {
  block_on: Rule['severity'][];
  min_score: number;
  requires?: string[];
  unlocks: string[];
}
export interface Evaluation {
  rules: RuleResult[];
  score: number;
  sections: Record<string, number>;
  gates: Record<string, { open: boolean; score: number; blockingRules: string[] }>;
  state: State;
}
export interface Binding {
  from: string;
  to?: string;
  name?: string;
  transform?: string;
}
export interface Mapping {
  output: string;
  gate: string;
  kind: 'csv' | 'pdf';
  row_source?: string;
  columns: Binding[];
  order_by?: string[];
}
export interface Pack {
  operations: {
    leaseMs: number;
    workerLeaseMs: number;
    renewMs: number;
    inactivityMs: number;
    retrySeconds: number[];
    circuitCount: number;
    circuitFraction: number;
    llmMode: 'disabled';
    reviewAgeBusinessDays: number;
  };
  schema: { version: string; pages: Page[] };
  rules: { defaults: { engine: string }; rules: Rule[] };
  gates: { gates: Record<string, Gate> };
  ingest: {
    key: string;
    required_columns: string[];
    fields: Binding[];
    groups: { from: string; to: string; fields: Binding[] }[];
  };
  mappings: Mapping[];
  lookups: Record<string, Record<string, string>>;
  protected: { protected: string[] };
  playbook: {
    entries: {
      id: string;
      match: { step: string; errorCode: string };
      path: string;
      transform: string;
      autoApply: boolean;
      approvedBy: string;
    }[];
  };
  version: Record<string, string>;
  warnings: string[];
}
export interface Lease {
  recordId: string;
  holder: string;
  holderKind: 'human' | 'worker';
  leaseToken: string;
  acquiredAt: string;
  expiresAt: string;
}
export interface Trace {
  eventId: string;
  traceId: string;
  recordId: string;
  batchId?: string;
  step: string;
  recordVersion: number;
  configVersion: Record<string, string>;
  actor: Actor;
  decision: string;
  detail?: Data;
  at: string;
  inputHash?: string;
  outputHash?: string;
  errorCode?: string;
  errorClass?: string;
  tier?: number;
}
export interface Exception {
  id: string;
  recordId: string;
  batchId: string;
  code: string;
  errorClass: string;
  tier: number;
  message: string;
  fields: string[];
  createdAt: string;
  assignee: string;
  status: 'open' | 'resolved';
  signature: string;
}
export interface Batch {
  id: string;
  name: string;
  createdAt: string;
  state: 'ready' | 'running' | 'on_hold' | 'completed';
  counts: {
    source: number;
    accounts: number;
    created: number;
    updated: number;
    skipped: number;
    rejected: number;
  };
  inputHash: string;
  reason?: string;
}
export type Proposal = {
  errorClass: 'data';
  diagnosis: string;
  patch: { op: 'replace' | 'add'; path: string; value: string | number | boolean | null }[];
  citedFields: string[];
  confidence: number;
};

export class PlatformError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function parts(path: string): string[] {
  const result = path
    .replace(/\[(\d+|\*)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  if (
    !result.length ||
    result.some(
      (p) => ['__proto__', 'prototype', 'constructor'].includes(p) || !/^[\w*-]+$/.test(p),
    )
  )
    throw new PlatformError('INVALID_PATH', `Invalid field path: ${path}`);
  return result;
}
export function get(data: any, path: string): any {
  return parts(path).reduce((v, p) => v?.[p], data);
}
export function set(data: any, path: string, value: unknown): void {
  const keys = parts(path);
  let node = data;
  for (let i = 0; i < keys.length - 1; i++)
    node = node[keys[i]] ??= /^\d+$/.test(keys[i + 1]) ? [] : {};
  node[keys.at(-1)!] = structuredClone(value ?? null);
}
export function expand(data: any, path: string): string[] {
  const keys = parts(path);
  const walk = (node: any, index: number, prefix: string): string[] => {
    if (index === keys.length) return [prefix];
    if (keys[index] === '*')
      return Array.isArray(node)
        ? node.flatMap((v, i) => walk(v, index + 1, `${prefix}[${i}]`))
        : [];
    return walk(node?.[keys[index]], index + 1, prefix ? `${prefix}.${keys[index]}` : keys[index]);
  };
  return walk(data, 0, '');
}
export const normalisePath = (path: string) => path.replace(/\[\d+\]/g, '[*]');
export function fields(pack: Pack): { field: Field; path: string; section: Section; page: Page }[] {
  return pack.schema.pages.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.fields.map((field) => ({
        field,
        path: section.collection ? `${section.collection.path}[*].${field.path}` : field.path,
        section,
        page,
      })),
    ),
  );
}
export function fieldDefinition(pack: Pack, path: string): Field | undefined {
  return fields(pack).find((f) => f.path === normalisePath(path))?.field;
}

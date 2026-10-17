import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { compile, evaluate, transition } from '../packages/core/engine';
import { csvRows, ingestRow, merge } from '../packages/core/mapping';
import { get, set } from '../packages/core/model';
import { validateProposal } from '../packages/core/proposals';
import { renderBundle } from '../packages/adapters/renderers';
import { hash, loadPack } from '../packages/adapters/config';
import { migrate } from '../migrations';
import { compareValidation } from '../packages/core/shadow';
import { pack, extract, readyRecord } from './helpers';

describe('configuration and shared rules', () => {
  it('TC-001 loads and fingerprints every domain file', () => {
    expect(Object.keys(pack.version)).toHaveLength(18);
    expect(pack.warnings).toEqual([]);
    expect(pack.schema.pages).toHaveLength(21);
  });
  it.each(['syntax', 'field', 'condition', 'function', 'gate-cycle'])(
    'TC-002/003/004/006 fails early on %s',
    (kind) => {
      const dir = mkdtempSync(join(tmpdir(), 'migtool-config-'));
      try {
        cpSync('config', dir, { recursive: true });
        const path = join(dir, 'rules.yaml');
        if (kind === 'syntax') writeFileSync(path, 'rules: [ invalid');
        else if (kind === 'gate-cycle') {
          const gates = JSON.parse(readFileSync(join(dir, 'gates.yaml'), 'utf8'));
          gates.gates.aaf.requires = ['cbs'];
          writeFileSync(join(dir, 'gates.yaml'), JSON.stringify(gates));
        } else {
          const data = JSON.parse(readFileSync(path, 'utf8'));
          if (kind === 'field') data.rules[0].fields = ['does.not.exist'];
          if (kind === 'condition') data.rules[0].assert = 'entity.(';
          if (kind === 'function') data.rules[0].assert = { engine: 'fn', name: 'unknown' };
          writeFileSync(path, JSON.stringify(data));
        }
        expect(() => loadPack(dir)).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it('TC-005 shares the default engine and JSONLogic', () => {
    expect(compile("entity.type = 'company'")(readyRecord().data)).toBe(true);
    expect(
      compile({ engine: 'jsonlogic', rule: { '===': [{ var: 'entity.type' }, 'company'] } })(
        readyRecord().data,
      ),
    ).toBe(true);
  });
  it('TC-020/023/024 requires declarations and gates in order', () => {
    const data = ingestRow(pack, extract.rows[0]),
      r = evaluate(pack, data);
    expect(r.state).toBe('needs_input');
    expect(r.gates.aaf.open).toBe(false);
    expect(r.gates.cbs.open).toBe(false);
    expect(data.tax.declaration).toBeUndefined();
    expect(evaluate(pack, readyRecord().data).gates.cbs.open).toBe(true);
  });
  it('TC-021 scores are weighted and section-specific', () => {
    const data = readyRecord().data;
    delete data.entity.email;
    const e = evaluate(pack, data);
    expect(e.score).toBeCloseTo((100 * 16) / 17, 2);
    expect(e.sections['entity.core']).toBe(80);
    expect(e.gates.aaf.open).toBe(true);
    expect(e.gates.cbs.open).toBe(false);
  });
  it('TC-022 fixing a postcode never reduces the score', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999 }), (n) => {
        const data = readyRecord().data;
        data.address.postcode = String(n);
        const before = evaluate(pack, data).score;
        data.address.postcode = String(n).padStart(4, '0');
        expect(evaluate(pack, data).score).toBeGreaterThanOrEqual(before);
      }),
      { numRuns: 50 },
    );
  });
  it('TC-013/014 validates visible declarations and collection bounds', () => {
    const data = readyRecord().data;
    data.tax.foreignTax = false;
    expect(evaluate(pack, data).gates.cbs.open).toBe(true);
    data.tax.foreignTax = true;
    expect(
      evaluate(pack, data).rules.some((r) => r.id === 'schema:tax.foreignTin' && !r.passed),
    ).toBe(true);
    data.signatories = [];
    expect(evaluate(pack, data).gates.aaf.open).toBe(false);
  });
  it('TC-025 rejects an illegal lifecycle jump', () => {
    expect(() => transition(readyRecord(), 'reconciled')).toThrow('Cannot move');
  });
  it('TC-026 shadow comparison reports drift', () => {
    const data = readyRecord().data;
    expect(compareValidation(pack, data, (d) => evaluate(pack, d)).matches).toBe(true);
    expect(compareValidation(pack, data, (d) => ({ ...evaluate(pack, d), score: 0 })).matches).toBe(
      false,
    );
  });
  it('TC-011 migrates once and freezes loaded schemas', () => {
    const record = readyRecord();
    record.schemaVersion = 'aaf-v73-demo';
    const upgraded = migrate(record, pack);
    expect(upgraded.versions).toEqual([pack.schema.version]);
    expect(migrate(upgraded.record, pack).versions).toEqual([]);
    record.state = 'reconciled';
    expect(migrate(record, pack).record.schemaVersion).toBe('aaf-v73-demo');
  });
});
describe('mapping, merge and proposal guardrails', () => {
  it('TC-032 refuses unknown product codes', () => {
    expect(() =>
      ingestRow(pack, { ...extract.rows[0], ACCOUNTS: [{ PRODUCT: 'UNKNOWN' }] }),
    ).toThrow('Unknown');
  });
  it('TC-033 round-trips source names without loss', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 100 }), (name) => {
        const data = ingestRow(pack, { ...extract.rows[0], CUST_LEGAL_NAME: name });
        const row = csvRows(
          pack,
          { ...readyRecord(), data },
          pack.mappings.find((m) => m.output === 'Customer_Create.csv')!,
        )[0];
        expect(row.LEGAL_NAME).toBe(name.trim());
      }),
    );
  });
  it('TC-050/051/052 never overwrites an operator edit', () => {
    const record = readyRecord();
    record.data.address.line1 = 'Human address';
    record.provenance['address.line1'] = {
      source: 'operator',
      actor: 'user',
      at: record.updatedAt,
      traceEventId: 'edit',
    };
    const next = structuredClone(record.data);
    next.address.line1 = 'Refreshed address';
    next.entity.legalName = 'Source update';
    const result = merge(record, next, 'source', record.updatedAt, 'merge');
    expect(result.record.data.address.line1).toBe('Human address');
    expect(result.record.data.entity.legalName).toBe('Source update');
    expect(result.conflicts.map((c) => c.path)).toContain('address.line1');
    next.address.line1 = 'Human address';
    expect(merge(record, next, 'source', record.updatedAt, 'merge').conflicts).toHaveLength(0);
  });
  it('TC-053 freezes loaded data and stages an amendment', () => {
    const record = readyRecord();
    record.state = 'reconciled';
    const next = structuredClone(record.data);
    next.address.line1 = 'New address';
    const result = merge(record, next, 'source', record.updatedAt, 'merge').record;
    expect(result.state).toBe('amendment_pending');
    expect(result.data.address.line1).toBe(record.data.address.line1);
    expect(result.pendingData!.address.line1).toBe('New address');
  });
  it('preserves human edits when a repeating group changes shape', () => {
    const record = readyRecord();
    record.provenance['accounts[0].accountNumber'] = {
      source: 'operator',
      actor: 'user',
      at: record.updatedAt,
      traceEventId: 'edit',
    };
    const next = structuredClone(record.data);
    next.accounts = [];
    const result = merge(record, next, 'source', record.updatedAt, 'merge');
    expect(result.record.data.accounts).toEqual(record.data.accounts);
    expect(result.conflicts[0].path).toBe('accounts');
  });
  const proposal = (path: string, value: any) => ({
    errorClass: 'data',
    diagnosis: 'Synthetic formatting fix',
    patch: [{ op: 'replace', path: '/' + path.replaceAll('.', '/'), value }],
    citedFields: [path],
    confidence: 1,
  });
  it('TC-073 allows an approved formatting fix and revalidates it', () => {
    const data = readyRecord().data;
    data.address.postcode = '800';
    const result = validateProposal(
      pack,
      data,
      proposal('address.postcode', '0800'),
      'postcode-valid',
      { source: 'playbook' },
    );
    expect(result.apply).toBe(true);
    expect(result.data.address.postcode).toBe('0800');
  });
  it('TC-080 high confidence cannot bypass protected-field review', () => {
    const data = readyRecord().data;
    data.entity.abn = 'bad';
    expect(
      validateProposal(pack, data, proposal('entity.abn', '51824753556'), 'abn-valid').reason,
    ).toBe('protected_field_review');
  });
  it('TC-081 refuses customer declarations even in proposals for review', () => {
    const data = readyRecord().data;
    delete data.tax.declaration;
    expect(() =>
      validateProposal(pack, data, proposal('tax.declaration', 'invented'), 'tax-declaration', {
        humanApproved: true,
      }),
    ).toThrow('declarations');
  });
  it('TC-083 rejects patches outside cited and failing fields', () => {
    const data = readyRecord().data;
    data.address.postcode = '800';
    const p = proposal('address.postcode', '0800');
    p.citedFields = ['entity.legalName'];
    expect(() => validateProposal(pack, data, p, 'postcode-valid')).toThrow('scope');
  });
  it('TC-087 keeps LLM proposals in shadow mode', () => {
    const data = readyRecord().data;
    data.address.postcode = '800';
    expect(
      validateProposal(pack, data, proposal('address.postcode', '0800'), 'postcode-valid', {
        shadow: true,
      }).apply,
    ).toBe(false);
  });
  it('rejects prototype pollution and object-level patch bypasses', () => {
    expect(() => set({}, '__proto__.polluted', true)).toThrow();
    const data = readyRecord().data;
    expect(() => validateProposal(pack, data, proposal('entity', {}), 'abn-valid')).toThrow();
    expect(({} as any).polluted).toBeUndefined();
  });
});
describe('deterministic exports', () => {
  it('TC-034 refuses an export with closed gates', async () => {
    const record = readyRecord();
    delete record.data.tax.declaration;
    await expect(renderBundle(pack, record)).rejects.toThrow('gate');
  });
  it('TC-035 produces identical files and standard SHA-256 manifests', async () => {
    const first = await renderBundle(pack, readyRecord()),
      second = await renderBundle(pack, readyRecord());
    expect(first.digest).toBe(second.digest);
    expect(first.bytes).toEqual(second.bytes);
    const zip = await JSZip.loadAsync(first.bytes);
    for (const file of first.manifest.files)
      expect(hash(await zip.file(file.name)!.async('uint8array'))).toBe(file.sha256);
    expect(zip.file('aaf.pdf')).not.toBeNull();
  });
});

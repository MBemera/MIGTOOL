import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Actor } from '../packages/core/model';
import { Store } from '../packages/adapters/store';
import { SteeringClient } from '../packages/adapters/steering';
import { MigrationService, worker } from '../packages/worker/service';
import { pack, extract, readyRecord } from './helpers';
const human: Actor = { id: 'human-a', kind: 'human' },
  other: Actor = { id: 'human-b', kind: 'human' };
let store: Store, service: MigrationService;
beforeEach(() => {
  store = new Store(':memory:', pack);
  service = new MigrationService(store, pack);
});
afterEach(() => store.close());
function seed() {
  const record = readyRecord(),
    lease = store.acquire(record.recordId, worker, true);
  if (!('leaseToken' in lease)) throw new Error('No lease');
  store.create(record, lease.leaseToken, worker);
  store.release(record.recordId, lease.leaseToken, worker);
  return record;
}
describe('authoritative storage and leases', () => {
  it('TC-060/066 rejects stale and unleased writes without losing data', () => {
    const record = seed();
    expect(() => store.save(record, { ifMatch: '1', leaseToken: 'invalid' }, human)).toThrow(
      'lease',
    );
    const lease = store.acquire(record.recordId, human);
    if (!('leaseToken' in lease)) throw new Error();
    record.data.entity.legalName = 'First edit';
    store.save(record, { ifMatch: '1', leaseToken: lease.leaseToken }, human);
    record.data.entity.legalName = 'Stale edit';
    expect(() => store.save(record, { ifMatch: '1', leaseToken: lease.leaseToken }, human)).toThrow(
      'changed',
    );
    expect(store.load(record.recordId).record.data.entity.legalName).toBe('First edit');
  });
  it('TC-062 admits exactly one holder across two database connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'migtool-race-')),
      path = join(dir, 'records.sqlite'),
      a = new Store(path, pack),
      b = new Store(path, pack);
    try {
      for (let i = 0; i < 100; i++) {
        const results = await Promise.all([
          Promise.resolve().then(() => a.acquire(`record-${i}`, human)),
          Promise.resolve().then(() => b.acquire(`record-${i}`, other)),
        ]);
        expect(results.filter((r) => 'leaseToken' in r)).toHaveLength(1);
      }
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('TC-063 expires on server time and rejects the old holder', () => {
    let now = Date.now();
    store.now = () => now;
    seed();
    const first = store.acquire('SYN-0001', human);
    now += 900001;
    expect('leaseToken' in store.acquire('SYN-0001', other)).toBe(true);
    if ('leaseToken' in first)
      expect(() => store.renew('SYN-0001', first.leaseToken, human)).toThrow();
    expect(store.traces({ recordId: 'SYN-0001' }).some((t) => t.decision === 'expired')).toBe(true);
  });
  it('TC-064 renews for an active holder and blocks another identity', () => {
    let now = Date.now();
    store.now = () => now;
    seed();
    const lease = store.acquire('SYN-0001', human);
    if (!('leaseToken' in lease)) throw new Error();
    for (let i = 0; i < 12; i++) {
      now += 300000;
      store.renew('SYN-0001', lease.leaseToken, human);
    }
    expect('heldBy' in store.acquire('SYN-0001', other)).toBe(true);
    expect(() => store.renew('SYN-0001', lease.leaseToken, other)).toThrow('another');
  });
  it('TC-065 logs admin lease breaks with a mandatory reason', () => {
    seed();
    store.acquire('SYN-0001', human);
    expect(() => store.breakLease('SYN-0001', other, '')).toThrow('reason');
    store.breakLease('SYN-0001', other, 'Operator unavailable');
    expect('leaseToken' in store.acquire('SYN-0001', other)).toBe(true);
    expect(store.traces()[1].decision).toBe('admin_break');
  });
  it('TC-067 workers contend with operators', () => {
    seed();
    store.acquire('SYN-0001', human);
    expect('heldBy' in store.acquire('SYN-0001', worker, true)).toBe(true);
  });
  it('TC-097 prevents event updates and deletes at database level', () => {
    seed();
    expect(() => store.db.exec("UPDATE trace SET body='{}'")).toThrow('append-only');
    expect(() => store.db.exec('DELETE FROM trace')).toThrow('append-only');
  });
  it('links provenance to actual committed trace events', () => {
    seed();
    const traces = store.traces({ recordId: 'SYN-0001' });
    for (const p of Object.values(store.load('SYN-0001').record.provenance))
      expect(traces.some((t) => t.eventId === p.traceEventId)).toBe(true);
  });
});
describe('ingest and durable workflow', () => {
  it('TC-040/041 imports 200 customers idempotently with baselines', async () => {
    const first = await service.ingest(extract, human),
      again = await service.ingest(extract, human);
    expect(first.counts.created).toBe(200);
    expect(again.counts.skipped).toBe(200);
    expect(store.list()).toHaveLength(200);
    expect(store.load('SYN-0001').record.baseline['entity.abn']).toBe('51824753556');
    expect(store.load('SYN-0001').record.data.tax.declaration).toBeUndefined();
  });
  it('TC-042 holds a mismatched batch without ingesting any rows', async () => {
    const batch = await service.ingest(
      { ...extract, totals: { customerCount: 999, accountCount: 200 } },
      human,
    );
    expect(batch.state).toBe('on_hold');
    expect(store.list()).toHaveLength(0);
    await expect(service.batchAction(batch.id, 'resume', 'Ignore totals', human)).rejects.toThrow(
      'Correct',
    );
  });
  it('TC-043/044 rejects both duplicates but ingests valid neighbours', async () => {
    const rows = [extract.rows[0], extract.rows[0], extract.rows[1]],
      batch = await service.ingest({ rows, totals: { customerCount: 3, accountCount: 3 } }, human);
    expect(batch.counts).toMatchObject({ created: 1, rejected: 2 });
    expect(store.exists('SYN-0001')).toBe(false);
    expect(store.exists('SYN-0002')).toBe(true);
  });
  it('TC-054 flags missing snapshot customers without deletion', async () => {
    await service.ingest(
      { rows: extract.rows.slice(0, 2), totals: { customerCount: 2, accountCount: 2 } },
      human,
    );
    await service.ingest(
      {
        rows: [extract.rows[0]],
        totals: { customerCount: 1, accountCount: 1 },
        fullSnapshot: true,
      },
      human,
    );
    expect(store.load('SYN-0002').record.missingFromRefresh).toBe(true);
    expect(store.list()).toHaveLength(2);
  });
  it('TC-070 completes manual gap resolution, export, load and readback', async () => {
    const batch = await service.ingest(
        { rows: [extract.rows[0]], totals: { customerCount: 1, accountCount: 1 } },
        human,
      ),
      loaded = store.load('SYN-0001'),
      lease = store.acquire('SYN-0001', human);
    if (!('leaseToken' in lease)) throw new Error();
    loaded.record.data.tax.declaration = 'SYNTHETIC-EVIDENCE';
    loaded.record.data.signatories[0].identityReference = 'SYNTHETIC-ID';
    const saved = service.edit(
      'SYN-0001',
      loaded.record.data,
      loaded.etag,
      lease.leaseToken,
      human,
      'operator',
    );
    expect(saved.record.state).toBe('cbs_ready');
    expect((await service.releaseBatch(batch.id, human)).queued).toBe(1);
    await service.runOne();
    expect(store.load('SYN-0001').record.state).toBe('reconciled');
    const traces = store.traces({ recordId: 'SYN-0001' });
    for (const step of ['ingest', 'validate', 'edit', 'export', 'load', 'reconcile'])
      expect(traces.some((t) => t.step === step)).toBe(true);
    expect(service.dashboard().straightThroughRate).toBe(0);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM cbs_receipts').get()).toMatchObject({
      n: 1,
    });
  });
  it('TC-071 resumes an exported job after restart without duplicate receipts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'migtool-restart-')),
      path = join(dir, 'db.sqlite');
    let local = new Store(path, pack),
      svc = new MigrationService(local, pack);
    try {
      const batch = await svc.ingest(
        { rows: [extract.rows[0]], totals: { customerCount: 1, accountCount: 1 } },
        human,
      );
      const loaded = local.load('SYN-0001'),
        lease = local.acquire('SYN-0001', human);
      if (!('leaseToken' in lease)) throw new Error();
      loaded.record.data = readyRecord().data;
      svc.edit('SYN-0001', loaded.record.data, loaded.etag, lease.leaseToken, human, 'operator');
      await svc.releaseBatch(batch.id, human);
      local.close();
      local = new Store(path, pack);
      svc = new MigrationService(local, pack);
      await svc.runOne();
      await svc.runOne();
      expect(local.load('SYN-0001').record.state).toBe('reconciled');
      expect(local.db.prepare('SELECT COUNT(*) AS n FROM cbs_receipts').get()).toMatchObject({
        n: 1,
      });
    } finally {
      local.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('TC-073 playbook repairs formatting without inventing declarations', async () => {
    const row = { ...extract.rows[0], POSTCODE: '800' };
    // Tier 1 runs automatically after ingest commits the record.
    await service.ingest({ rows: [row], totals: { customerCount: 1, accountCount: 1 } }, human);
    const record = store.load('SYN-0001').record;
    expect(record.data.address.postcode).toBe('0800');
    expect(record.provenance['address.postcode'].source).toBe('playbook');
    expect(
      store
        .traces({ recordId: 'SYN-0001' })
        .some((t) => t.decision === 'playbook_used' && t.detail?.entry === 'pb-demo-postcode'),
    ).toBe(true);
    expect(() => service.applyPlaybook('SYN-0001', 'postcode-valid', human)).toThrow(
      'changes nothing',
    );
    expect(record.data.tax.declaration).toBeUndefined();
    expect(record.state).toBe('needs_input');
  });
});
describe('LLM minimisation', () => {
  it('TC-085/087 passes only relevant values and never applies a shadow proposal', async () => {
    seed();
    const record = store.load('SYN-0001').record;
    record.data.address.postcode = '800';
    let captured: any;
    const model = {
      id: 'synthetic-eval',
      approvalReference: 'TEST-ONLY',
      propose: async (input: any) => {
        captured = input;
        return {
          errorClass: 'data',
          diagnosis: 'Pad postcode',
          patch: [{ op: 'replace', path: '/address/postcode', value: '0800' }],
          citedFields: ['address.postcode'],
          confidence: 1,
        };
      },
    };
    await new SteeringClient(store, pack, model, 'test-v1', 'shadow').propose(
      record,
      'postcode-valid',
    );
    expect(captured.fields).toEqual({ 'address.postcode': '800' });
    expect(JSON.stringify(captured)).not.toContain(record.data.entity.legalName);
    expect(record.data.address.postcode).toBe('800');
    expect(store.traces()[0].decision).toBe('shadow_mode');
  });
  it('TC-082 retries malformed proposals once and escalates', async () => {
    seed();
    let calls = 0;
    const model = {
      id: 'synthetic-eval',
      approvalReference: 'TEST-ONLY',
      propose: async () => {
        calls++;
        return { invalid: true };
      },
    };
    await expect(
      new SteeringClient(store, pack, model, 'test', 'shadow').propose(
        readyRecord(),
        'postcode-valid',
      ),
    ).rejects.toThrow('Two');
    expect(calls).toBe(2);
  });
});

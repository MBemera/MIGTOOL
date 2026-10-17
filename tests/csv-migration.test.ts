import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  statSync,
  utimesSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Actor, type Data, PlatformError } from '../packages/core/model';
import { Store } from '../packages/adapters/store';
import { hash } from '../packages/adapters/config';
import { CbsRejection, FileDropCbs, SimulatedCbs } from '../packages/adapters/cbs';
import { csvPackageToExtract, parseCsv } from '../packages/adapters/csv-extract';
import {
  assertNotSynced,
  landingPackages,
  prepareOutputFolder,
  readExtractPackage,
  strayFiles,
  sweepStaging,
  writeFolderAtomic,
} from '../packages/adapters/files';
import { createApp } from '../packages/server/app';
import { merge } from '../packages/core/mapping';
import { MigrationService, worker } from '../packages/worker/service';
import { pack, extract, readyRecord } from './helpers';

const admin: Actor = { id: 'admin-1', kind: 'human' },
  operator: Actor = { id: 'operator-1', kind: 'human' },
  reviewer: Actor = { id: 'reviewer-1', kind: 'human' };
const fixtureDir = 'fixtures/bank1-csv';
const csvFiles = () =>
  Object.fromEntries(
    readdirSync(fixtureDir)
      .filter((f) => f.endsWith('.csv'))
      .map((f) => [f, readFileSync(join(fixtureDir, f), 'utf8')]),
  );
// Rewrites one file and its control entry, as Bank 1 would when issuing a corrected extract.
function withFile(files: Record<string, string>, name: string, text: string) {
  const next = { ...files, [name]: text };
  next['control.csv'] =
    ['FILE,ROWS,SHA256']
      .concat(
        Object.keys(next)
          .filter((f) => f !== 'control.csv')
          .sort()
          .map((f) => `${f},${parseCsv(next[f], f).rows.length},${hash(next[f])}`),
      )
      .join('\r\n') + '\r\n';
  return next;
}

let dir: string, store: Store, cbs: FileDropCbs, service: MigrationService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'migtool-csv-'));
  store = new Store(join(dir, 'migtool.sqlite'), pack);
  cbs = new FileDropCbs(join(dir, 'cbs-outbox'), pack);
  service = new MigrationService(store, pack, () => {}, cbs);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
// The operator keys only what the customer must declare; everything else came from the extract.
function supplyDeclarations(id: string, by: Actor = operator) {
  const loaded = store.load(id),
    lease = store.acquire(id, by);
  if (!('leaseToken' in lease)) throw new Error('lease');
  const data = structuredClone(loaded.record.data);
  data.tax.declaration = `DECL-${id}`;
  if (data.tax.foreignTax) data.tax.foreignTin = `TIN-${id}`;
  data.entity.email ??= `contact-${id.toLowerCase()}@example.test`;
  for (const s of data.signatories) s.identityReference = `ID-${s.name.replace(/\W/g, '')}`;
  return service.edit(id, data, loaded.etag, lease.leaseToken, by, 'operator');
}
async function drain(limit = 200) {
  for (let i = 0; i < limit; i++) if (!(await service.runOne())) return;
}

describe('Bank 1 CSV extract to Bank 2 CBS load files', () => {
  it('converts the 10-customer CSV package with groups, dates and flags', () => {
    const extractRows = csvPackageToExtract(pack, csvFiles());
    expect(extractRows.rows).toHaveLength(10);
    expect(extractRows.totals).toEqual({ customerCount: 10, accountCount: 19 });
    const obrien = extractRows.rows.find((r) => r.CUST_ID === 'B1-100004')!;
    expect(obrien.CUST_LEGAL_NAME).toBe("O'Brien, Kelly & Co Pty Ltd");
    expect(obrien.ACCOUNTS.map((a: Data) => a.PRODUCT)).toEqual(['TRAN', 'OD', 'PAYROLL']);
    expect(obrien.PEOPLE[0]).toMatchObject({
      NAME: "Siobhan O'Brien",
      DATE_OF_BIRTH: '19/07/1969',
    });
    // A blank cell is an absent value, never an empty string written into the record.
    expect(extractRows.rows.find((r) => r.CUST_ID === 'B1-100008')!.EMAIL).toBeUndefined();
  });
  it('imports, routes gaps to people, auto-fixes formatting and exports CBS files end to end', async () => {
    const batch = await service.ingestCsv(csvFiles(), { name: 'Bank 1 CSV' }, admin);
    expect(batch.counts).toMatchObject({ source: 10, accounts: 19, created: 10, rejected: 0 });
    const records = store.list();
    expect(records).toHaveLength(10);
    // P5: customer declarations are never filled automatically.
    expect(records.every((r) => r.state === 'needs_input')).toBe(true);
    expect(records.every((r) => r.data.tax.declaration === undefined)).toBe(true);
    const zoe = store.load('B1-100006').record;
    expect(zoe.data.entity.legalName).toBe('Zoë Müller');
    expect(zoe.data.tax.foreignTax).toBe(true);
    expect(zoe.data.people[0].dateOfBirth).toBe('1990-06-27');
    const harbour = store.load('B1-100001').record;
    expect(harbour.data.entity.abn).toBe('51000000680');
    expect(harbour.data.accounts[0]).toMatchObject({ bsb: '062000', openDate: '2011-03-14' });
    expect(harbour.provenance['entity.legalName'].source).toBe('extract');
    // Tier 1 padded the Darwin postcode without a person, and says so.
    const darwin = store.load('B1-100005').record;
    expect(darwin.data.address.postcode).toBe('0800');
    expect(darwin.provenance['address.postcode'].source).toBe('playbook');

    for (const r of records) supplyDeclarations(r.recordId);
    expect(store.list().every((r) => r.state === 'cbs_ready')).toBe(true);
    expect(service.releaseBatch(batch.id, admin).queued).toBe(10);
    await drain();
    expect(store.list().every((r) => r.state === 'reconciled')).toBe(true);
    expect(store.batch(batch.id).state).toBe('completed');

    // One complete delivery folder per customer, nothing half-written, nothing duplicated.
    const outbox = readdirSync(cbs.root).filter((f) => !f.startsWith('.'));
    expect(outbox).toHaveLength(10);
    expect(strayFiles(cbs.root)).toEqual([]);
    const delivered = readFileSync(
      join(cbs.root, outbox.find((f) => f.startsWith('B1-100001'))!, 'Account_Register.csv'),
      'utf8',
    );
    expect(delivered).toBe(
      'CUSTOMER_ID,PRODUCT_CODE,ACCOUNT_NUMBER,BSB,OPEN_DATE\r\n' +
        'B1-100001,TRAN,20481001,062000,14/03/2011\r\n' +
        'B1-100001,SAVE,20481002,062000,14/03/2011\r\n' +
        'B1-100001,FX,20481003,062000,02/07/2019\r\n',
    );

    // Combined batch load files with control totals that match the source extract.
    const { files, manifest } = service.exportBatch(batch.id);
    expect(manifest).toMatchObject({ customers: 10, accounts: 19 });
    const customers = parseCsv(Buffer.from(files['Customer_Create.csv']).toString(), 'c').rows;
    expect(customers.map((c) => c.CUSTOMER_ID)).toEqual(
      Array.from({ length: 10 }, (_, i) => `B1-1000${String(i + 1).padStart(2, '0')}`),
    );
    expect(customers.find((c) => c.CUSTOMER_ID === 'B1-100004')!.LEGAL_NAME).toBe(
      "O'Brien, Kelly & Co Pty Ltd",
    );
    const users = Buffer.from(files['User_Create.csv']).toString();
    expect(users).toContain('B1-100006,Zoë Müller,27/06/1990,zoe@mullerphysio.example,owner');
    expect(parseCsv(users, 'u').rows).toHaveLength(15);
    // Re-running the batch export produces identical bytes.
    expect(service.exportBatch(batch.id).files['Customer_Create.csv']).toEqual(
      files['Customer_Create.csv'],
    );

    // Re-importing the same extract changes nothing and delivers nothing new.
    const again = await service.ingestCsv(csvFiles(), {}, admin);
    expect(again.counts).toMatchObject({ created: 0, updated: 0, skipped: 10 });
    expect(readdirSync(cbs.root).filter((f) => !f.startsWith('.'))).toHaveLength(10);
  });
  it('stops the whole batch on file-level faults and records a tier 4 exception', async () => {
    const files = csvFiles();
    await expect(
      service.ingestCsv({ ...files, 'accounts.csv': files['accounts.csv'] + 'X\r\n' }, {}, admin),
    ).rejects.toThrow('checksum');
    const noBsb = files['accounts.csv'].replace('BSB,', 'SORT_CODE,');
    await expect(
      service.ingestCsv(withFile(files, 'accounts.csv', noBsb), {}, admin),
    ).rejects.toThrow('missing column BSB');
    const orphan = files['people.csv'] + 'B1-999999,Nobody,01/01/1990,,contact\r\n';
    await expect(
      service.ingestCsv(withFile(files, 'people.csv', orphan), {}, admin),
    ).rejects.toThrow('not in customers.csv');
    expect(() => parseCsv('A,B\r\n"open,1\r\n')).toThrow('unterminated');
    expect(store.list()).toHaveLength(0);
    expect(
      store.exceptions().filter((e) => e.errorClass === 'system' && e.tier === 4),
    ).toHaveLength(3);
  });
  it('holds the batch when control totals disagree with the rows (TC-042)', async () => {
    const files = csvFiles();
    const tampered = files['control.csv'].replace(/^accounts\.csv,19,/m, 'accounts.csv,20,');
    const batch = await service.ingestCsv({ ...files, 'control.csv': tampered }, {}, admin);
    expect(batch.state).toBe('on_hold');
    expect(store.list()).toHaveLength(0);
  });
});

describe('review fixes', () => {
  async function importOne(rows = [structuredClone(extract.rows[0])]) {
    return service.ingest(
      { rows, totals: { customerCount: rows.length, accountCount: rows.length } },
      admin,
    );
  }
  it('B1 a keep scope decision leaves validation exceptions open', async () => {
    await importOne([structuredClone(extract.rows[0]), structuredClone(extract.rows[1])]);
    await service.ingest(
      {
        rows: [structuredClone(extract.rows[0])],
        totals: { customerCount: 1, accountCount: 1 },
        fullSnapshot: true,
      },
      admin,
    );
    const open = () =>
      store.exceptions().filter((e) => e.recordId === 'SYN-0002' && e.status === 'open');
    expect(open().some((e) => e.code === 'MISSING_FROM_REFRESH')).toBe(true);
    const lease = store.acquire('SYN-0002', reviewer);
    if (!('leaseToken' in lease)) throw new Error();
    service.decideScope('SYN-0002', 'keep', 'Still a customer', lease.leaseToken, reviewer);
    expect(open().some((e) => e.code === 'MISSING_FROM_REFRESH')).toBe(false);
    expect(open().map((e) => e.code)).toEqual(
      expect.arrayContaining(['tax-declaration', 'signatory-id']),
    );
  });
  it('B2 a refresh that blanks an untouched field blanks it; a blanked edited field conflicts', () => {
    const record = readyRecord();
    record.state = 'needs_input';
    const incoming = structuredClone(record.data);
    delete incoming.entity.email;
    const out = merge(record, incoming, 'w', 'now', 'e');
    expect(out.record.data.entity.email).toBeNull();
    expect(out.record.baseline['entity.email']).toBeNull();
    expect(out.changes).toContain('entity.email');
    record.data.entity.email = 'edited@example.test';
    record.provenance['entity.email'] = {
      source: 'operator',
      actor: 'o',
      at: 'now',
      traceEventId: 'x',
    };
    const edited = merge(record, incoming, 'w', 'now', 'e');
    expect(edited.record.data.entity.email).toBe('edited@example.test');
    expect(edited.conflicts.map((c) => c.path)).toEqual(['entity.email']);
  });
  it('B3 a refresh of an exported record becomes an amendment, and rejection resumes delivery', async () => {
    const batch = await importOne();
    supplyDeclarations('SYN-0001');
    service.releaseBatch(batch.id, admin);
    // Render and export but stop before delivery, as after a crash.
    const blocked = new MigrationService(store, pack, () => {}, {
      deliver: async () => {
        throw new PlatformError('TRANSIENT', 'down', 503);
      },
      readback: async () => undefined,
    });
    await blocked.runOne();
    expect(store.load('SYN-0001').record.state).toBe('exported');
    const row = { ...structuredClone(extract.rows[0]), EMAIL: 'new@example.test' };
    const refresh = await importOne([row]);
    expect(refresh.counts).toMatchObject({ updated: 1, rejected: 0 });
    const pending = store.load('SYN-0001').record;
    expect(pending.state).toBe('amendment_pending');
    expect(pending.amendmentFrom).toBe('exported');
    expect(pending.pendingData!.entity.email).toBe('new@example.test');
    const lease = store.acquire('SYN-0001', reviewer);
    if (!('leaseToken' in lease)) throw new Error();
    await service.decideAmendment('SYN-0001', 'reject', lease.leaseToken, reviewer);
    expect(store.load('SYN-0001').record.state).toBe('exported');
    store.now = () => Date.now() + 600000;
    await drain();
    expect(store.load('SYN-0001').record.state).toBe('reconciled');
  });
  it('B4/B5 resolves retried transient exceptions and never leaves a batch running', async () => {
    let now = Date.now(),
      fail = 1;
    store.now = () => now;
    const flaky = new MigrationService(store, pack, () => {}, {
      deliver: async (...args) => {
        if (fail-- > 0) throw new PlatformError('TRANSIENT', 'Synthetic outage', 503);
        return cbs.deliver(...args);
      },
      readback: (key) => cbs.readback(key),
    });
    const batch = await importOne();
    supplyDeclarations('SYN-0001');
    flaky.releaseBatch(batch.id, admin);
    await flaky.runOne();
    now += 2000;
    await flaky.runOne();
    expect(store.load('SYN-0001').record.state).toBe('reconciled');
    expect(store.exceptions().filter((e) => e.status === 'open')).toEqual([]);
    expect(store.batch(batch.id).state).toBe('completed');

    // A permanent failure on the only job leaves the batch ready for action, not running.
    const other = await importOne([structuredClone(extract.rows[1])]);
    supplyDeclarations('SYN-0002');
    const broken = new MigrationService(store, pack, () => {}, {
      deliver: async () => {
        throw new PipelineFailure();
      },
      readback: async () => undefined,
    });
    broken.releaseBatch(other.id, admin);
    await broken.runOne();
    expect(store.load('SYN-0002').record.state).toBe('blocked');
    expect(['ready', 'on_hold']).toContain(store.batch(other.id).state);
  });
  it('B6 trace queries filter before the limit', () => {
    store.trace('r1', { id: 'auditor-target', kind: 'human' }, 'edit', 'x');
    const insert = store.db.prepare(
      'INSERT INTO trace(id,record_id,batch_id,body) VALUES(?,?,?,?)',
    );
    store.transaction(() => {
      for (let i = 0; i < 5001; i++)
        insert.run(
          `e${i}`,
          'r2',
          null,
          JSON.stringify({ eventId: `e${i}`, recordId: 'r2', actor: { id: 'other' } }),
        );
    });
    expect(store.traces({ actor: 'auditor-target' })).toHaveLength(1);
    expect(store.traces({ recordIds: ['r1'] })).toHaveLength(1);
  });
  it('B7 rejecting an amendment on a loaded record does not mark it reconciled', async () => {
    const record = readyRecord();
    record.state = 'loaded';
    const lease = store.acquire(record.recordId, worker, true);
    if (!('leaseToken' in lease)) throw new Error();
    store.create(record, lease.leaseToken, worker);
    store.release(record.recordId, lease.leaseToken, worker);
    const row = { ...structuredClone(extract.rows[0]), EMAIL: 'changed@example.test' };
    await importOne([row]);
    expect(store.load('SYN-0001').record.state).toBe('amendment_pending');
    const review = store.acquire('SYN-0001', reviewer);
    if (!('leaseToken' in review)) throw new Error();
    await service.decideAmendment('SYN-0001', 'reject', review.leaseToken, reviewer);
    expect(store.load('SYN-0001').record.state).toBe('loaded');
  });
  it('approves an amendment through the CBS adapter and reconciles it', async () => {
    const batch = await importOne();
    supplyDeclarations('SYN-0001');
    service.releaseBatch(batch.id, admin);
    await drain();
    await importOne([{ ...structuredClone(extract.rows[0]), EMAIL: 'amended@example.test' }]);
    const lease = store.acquire('SYN-0001', reviewer);
    if (!('leaseToken' in lease)) throw new Error();
    await service.decideAmendment('SYN-0001', 'approve', lease.leaseToken, reviewer);
    const record = store.load('SYN-0001').record;
    expect(record.state).toBe('reconciled');
    expect(record.data.entity.email).toBe('amended@example.test');
    expect(readdirSync(cbs.root).some((f) => f.startsWith('amendment_SYN-0001'))).toBe(true);
  });
  it('tier 1 fixes a known CBS rejection and reloads; a mapping rejection goes to engineering', async () => {
    const rejectOnce = new MigrationService(store, pack, () => {}, {
      deliver: async (key, id, expected, at) => {
        if (expected['Customer_Create.csv'][0].POSTCODE === '3220')
          throw new CbsRejection('CBS-E1042', 'postcode', 'data', 'address.postcode');
        return cbs.deliver(key, id, expected);
      },
      readback: (key) => cbs.readback(key),
    });
    const batch = await importOne();
    supplyDeclarations('SYN-0001');
    rejectOnce.releaseBatch(batch.id, admin);
    await rejectOnce.runOne();
    // padPostcode changes nothing for a 4-digit postcode, so the fix cannot apply and ops get it.
    const exception = store.exceptions().find((e) => e.code === 'CBS-E1042')!;
    expect(exception).toMatchObject({ errorClass: 'data', tier: 3, fields: ['address.postcode'] });

    const mapping = new MigrationService(store, pack, () => {}, {
      deliver: async () => {
        throw new CbsRejection('CBS-E2001', 'product', 'mapping', 'accounts[*].productCode');
      },
      readback: async () => undefined,
    });
    const second = await importOne([structuredClone(extract.rows[2])]);
    supplyDeclarations('SYN-0003');
    mapping.releaseBatch(second.id, admin);
    await mapping.runOne();
    expect(store.exceptions().find((e) => e.code === 'CBS-E2001')).toMatchObject({
      errorClass: 'mapping',
      tier: 4,
    });
  });
  it('tier 1 load playbook applies once, then the record is reloaded', async () => {
    // A CBS acceptance rule validation does not know about, with an approved fix in the playbook.
    const entry = {
      id: 'pb-test-upper',
      match: { step: 'load', errorCode: 'CBS-E3001' },
      path: 'entity.legalName',
      transform: 'uppercase',
      autoApply: true,
      approvedBy: 'test-reviewer',
    };
    const testPack = { ...pack, playbook: { entries: [...pack.playbook.entries, entry] } };
    let rejected = 0;
    const strict = new MigrationService(store, testPack, () => {}, {
      deliver: async (key, id, expected) => {
        const name = expected['Customer_Create.csv'][0].LEGAL_NAME;
        if (name !== name.toUpperCase()) {
          rejected++;
          throw new CbsRejection(
            'CBS-E3001',
            'names must be upper case',
            'data',
            'entity.legalName',
          );
        }
        return cbs.deliver(key, id, expected);
      },
      readback: (key) => cbs.readback(key),
    });
    const batch = await importOne();
    supplyDeclarations('SYN-0001');
    strict.releaseBatch(batch.id, admin);
    for (let i = 0; i < 5; i++) await strict.runOne();
    const record = store.load('SYN-0001').record;
    expect(rejected).toBe(1);
    expect(record.data.entity.legalName).toBe('SYNTHETIC 001 PTY LTD');
    expect(record.provenance['entity.legalName'].source).toBe('playbook');
    expect(record.state).toBe('reconciled');
    expect(store.exceptions().filter((e) => e.status === 'open')).toEqual([]);
    // Applied once only: a second application of the same entry is refused.
    expect(() => strict.applyPlaybook('SYN-0001', 'CBS-E3001', worker, 'load')).toThrow(
      'already applied',
    );
  });
  it('reconciliation mismatches name the mapped field', async () => {
    const batch = await importOne();
    supplyDeclarations('SYN-0001');
    const lying = new MigrationService(store, pack, () => {}, {
      deliver: (...args) => cbs.deliver(...args),
      readback: async (key) => {
        const real = (await cbs.readback(key))!;
        real['Account_Register.csv'][0].BSB = '999999';
        return real;
      },
    });
    lying.releaseBatch(batch.id, admin);
    await lying.runOne();
    expect(store.exceptions().find((e) => e.code === 'RECONCILIATION_MISMATCH')).toMatchObject({
      errorClass: 'mapping',
      tier: 4,
      fields: ['accounts[0].bsb'],
    });
  });
  it('the circuit breaker counts only the current batch run', async () => {
    const rows = extract.rows.slice(0, 12).map((r: Data) => structuredClone(r));
    const batch = await importOne(rows);
    for (const r of rows) supplyDeclarations(r.CUST_ID);
    const failing = new MigrationService(store, pack, () => {}, {
      deliver: async () => {
        throw new CbsRejection('CBS-E2001', 'product', 'mapping', 'accounts[*].productCode');
      },
      readback: async () => undefined,
    });
    // circuitFraction 5% of 12 is under one record, so use the count path with a large batch.
    store.putBatch({
      ...store.batch(batch.id),
      counts: { ...store.batch(batch.id).counts, source: 1000 },
    });
    failing.releaseBatch(batch.id, admin);
    for (let i = 0; i < 12; i++) await failing.runOne();
    const held = store.batch(batch.id);
    expect(held.state).toBe('on_hold');
    expect(held.reason).toBe('Circuit breaker: CBS-E2001');
    const circuit = store.traces({ batchId: batch.id }).find((t) => t.decision === 'circuit_open')!;
    expect(circuit.detail).toMatchObject({ affected: 10 });
    expect((circuit.detail!.examples as string[]).length).toBe(3);
  });
  it('lease breaks notify the holder and failed renewals are traced', () => {
    const record = readyRecord();
    const w = store.acquire(record.recordId, worker, true);
    if (!('leaseToken' in w)) throw new Error();
    store.create(record, w.leaseToken, worker);
    store.release(record.recordId, w.leaseToken, worker);
    const lease = store.acquire(record.recordId, operator);
    if (!('leaseToken' in lease)) throw new Error();
    store.breakLease(record.recordId, admin, 'Operator on leave');
    expect(store.takeNotices(operator.id)[0].message).toContain('Operator on leave');
    expect(store.takeNotices(operator.id)).toEqual([]);
    expect(() => store.renew(record.recordId, lease.leaseToken, operator)).toThrow();
    expect(
      store.traces({ recordId: record.recordId }).some((t) => t.decision === 'renew_failed'),
    ).toBe(true);
  });
});

describe('temp files, duplicates and synced folders (section 10, NFR-09)', () => {
  it('refuses to store data inside a sync client folder', () => {
    expect(() => assertNotSynced('/Users/a/OneDrive - Bank 2/migtool.sqlite', 'DB')).toThrow(
      'synced folder',
    );
    expect(() => assertNotSynced('C:\\Users\\a\\Dropbox\\out', 'Outbox')).toThrow('synced folder');
    const previous = process.env.OneDrive;
    process.env.OneDrive = join(dir, 'corp-sync');
    try {
      expect(() => new Store(join(dir, 'corp-sync', 'x.sqlite'), pack)).toThrow('synced folder');
    } finally {
      if (previous === undefined) delete process.env.OneDrive;
      else process.env.OneDrive = previous;
    }
    expect(() => assertNotSynced(join(dir, 'local', 'x.sqlite'), 'DB')).not.toThrow();
  });
  it('TC-068 1,000 saves leave only the database and its journal files', () => {
    const record = readyRecord();
    record.state = 'needs_input';
    const lease = store.acquire(record.recordId, operator);
    if (!('leaseToken' in lease)) throw new Error();
    store.create(record, lease.leaseToken, operator);
    let etag = '1';
    for (let i = 0; i < 1000; i++) {
      record.data.entity.legalName = `Name ${i}`;
      etag = store.save(record, { ifMatch: etag, leaseToken: lease.leaseToken }, operator).etag;
    }
    expect(etag).toBe('1001');
    expect(
      readdirSync(dir)
        .filter((f) => f.startsWith('migtool'))
        .sort(),
    ).toEqual(expect.arrayContaining(['migtool.sqlite']));
    expect(
      readdirSync(dir).filter(
        (f) => f !== 'cbs-outbox' && !/^migtool\.sqlite(-wal|-shm)?$/.test(f),
      ),
    ).toEqual([]);
    expect(strayFiles(dir)).toEqual([]);
  });
  it('an interrupted folder write leaves nothing behind, and a repeat delivery never makes a copy', () => {
    const root = join(dir, 'drop');
    expect(() =>
      writeFolderAtomic(root, 'batch-1', {
        'a.csv': Buffer.from('x'),
        'bad/name': Buffer.from('y'),
      }),
    ).toThrow('Invalid output file');
    expect(existsSync(join(root, 'batch-1'))).toBe(false);
    expect(strayFiles(root)).toEqual([]);
    // A crash between write and rename leaves staging, which start-up sweeps away.
    mkdirSync(join(root, '.staging', 'crashed'), { recursive: true });
    writeFileSync(join(root, '.staging', 'crashed', 'a.csv'), 'partial');
    expect(strayFiles(root)).toHaveLength(1);
    sweepStaging(join(root, '.staging'), 0);
    expect(strayFiles(root)).toEqual([]);
    expect(writeFolderAtomic(root, 'batch-1', { 'a.csv': Buffer.from('x') }).created).toBe(true);
    expect(writeFolderAtomic(root, 'batch-1', { 'a.csv': Buffer.from('x') }).created).toBe(false);
    expect(() => writeFolderAtomic(root, 'batch-1', { 'a.csv': Buffer.from('changed') })).toThrow(
      'different content',
    );
    expect(readdirSync(root).filter((f) => !f.startsWith('.'))).toEqual(['batch-1']);
  });
  it('recognises temp files and conflict copies', () => {
    const root = join(dir, 'scan');
    mkdirSync(root);
    for (const name of [
      'record.json.crswap',
      'record (1).json',
      'record-DESKTOP-AB12CD.json',
      'ok.csv',
    ])
      writeFileSync(join(root, name), '');
    expect(
      strayFiles(root)
        .map((p) => p.split(/[\\/]/).at(-1))
        .sort(),
    ).toEqual(['record (1).json', 'record-DESKTOP-AB12CD.json', 'record.json.crswap']);
  });
  it('the simulated store adapter still works for in-memory use', async () => {
    const memory = new Store(':memory:', pack);
    try {
      const simulated = new SimulatedCbs(memory);
      await simulated.deliver('k', 'r', { 'a.csv': [] }, 'now');
      expect(await simulated.readback('k')).toEqual({ 'a.csv': [] });
    } finally {
      memory.close();
    }
  });
});
class PipelineFailure extends PlatformError {
  constructor() {
    super('CBS_DOWN_HARD', 'Permanent delivery failure', 500);
  }
}

describe('OneDrive landing and CBS load folders', () => {
  // A folder shaped like a OneDrive for Business root; detection is by folder name.
  let synced: string, local: string;
  beforeEach(() => {
    synced = join(dir, 'OneDrive - Bank 2');
    local = join(dir, 'local');
    mkdirSync(join(synced, 'Migration', 'Landing'), { recursive: true });
    mkdirSync(local, { recursive: true });
  });
  const landingPackage = (name = 'bank1-2026-10-17') => {
    const target = join(synced, 'Migration', 'Landing', name);
    cpSync(fixtureDir, target, { recursive: true });
    // Files settled by OneDrive some time ago.
    const past = new Date(Date.now() - 3600000);
    for (const f of readdirSync(target)) utimesSync(join(target, f), past, past);
    return target;
  };
  const listing = (root: string) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .map((e) => join(e.parentPath ?? (e as any).path, e.name))
      .sort()
      .map((p) => `${p}:${statSync(p).mtimeMs}:${statSync(p).size}`);

  it('runs the migration with both folders in OneDrive and never exposes partial files', async () => {
    const outbox = join(synced, 'Migration', 'CBS Load'),
      syncedCbs = new FileDropCbs(outbox, pack, join(local, 'staging')),
      svc = new MigrationService(store, pack, () => {}, syncedCbs),
      source = landingPackage(),
      before = listing(source);
    const batch = await svc.ingestCsv(
      readExtractPackage(source),
      { name: 'bank1-2026-10-17' },
      admin,
    );
    expect(batch.counts.created).toBe(10);
    // The landing folder is only read: nothing added, changed or touched.
    expect(listing(source)).toEqual(before);
    for (const r of store.list()) supplyDeclarations(r.recordId);
    svc.releaseBatch(batch.id, admin);
    for (let i = 0; i < 50; i++) if (!(await svc.runOne())) break;
    expect(store.list().every((r) => r.state === 'reconciled')).toBe(true);
    // Only complete delivery folders ever appear in the synced tree: no staging, temp or copies.
    expect(readdirSync(outbox)).toHaveLength(10);
    expect(readdirSync(outbox).some((f) => f.startsWith('.'))).toBe(false);
    expect(strayFiles(synced)).toEqual([]);
    for (const folder of readdirSync(outbox))
      expect(readdirSync(join(outbox, folder)).sort()).toEqual([
        'Account_Register.csv',
        'Customer_Create.csv',
        'User_Create.csv',
        'manifest.json',
      ]);
  });
  it('a failed write leaves the synced folder untouched', () => {
    const outbox = join(synced, 'CBS Load'),
      { staging } = prepareOutputFolder(outbox, join(local, 'staging'));
    expect(() =>
      writeFolderAtomic(
        outbox,
        'r1',
        { 'a.csv': Buffer.from('x'), 'bad/name': Buffer.from('y') },
        staging,
      ),
    ).toThrow('Invalid output file');
    expect(readdirSync(outbox)).toEqual([]);
    expect(readdirSync(staging)).toEqual([]);
  });
  it('refuses staging inside the synced folder, a synced staging area and a synced database', () => {
    expect(() => new FileDropCbs(join(synced, 'CBS Load'), pack)).toThrow(
      'staging area must be outside',
    );
    expect(() => prepareOutputFolder(join(local, 'out'), join(synced, 'staging'))).toThrow(
      'synced folder',
    );
    expect(() => new Store(join(synced, 'migtool.sqlite'), pack)).toThrow('synced folder');
  });
  it.runIf(existsSync('/dev/shm') && statSync('/dev/shm').dev !== statSync(tmpdir()).dev)(
    'refuses staging on a different drive, where the move would be a copy',
    () => {
      const other = mkdtempSync('/dev/shm/migtool-staging-');
      try {
        expect(() => prepareOutputFolder(join(synced, 'CBS Load'), other)).toThrow(
          'different drives',
        );
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    },
  );
  it('stops on open, half-synced, conflicting or unreadable landing files with the reason', () => {
    const source = landingPackage();
    writeFileSync(join(source, 'desktop.ini'), '');
    expect(Object.keys(readExtractPackage(source)).sort()).toEqual([
      'accounts.csv',
      'control.csv',
      'customers.csv',
      'people.csv',
      'signatories.csv',
    ]);
    writeFileSync(join(source, '~$customers.csv'), '');
    expect(() => readExtractPackage(source)).toThrow('customers.csv is open in Excel');
    rmSync(join(source, '~$customers.csv'));
    writeFileSync(join(source, 'customers (1).csv'), '');
    expect(() => readExtractPackage(source)).toThrow('sync conflict copy');
    rmSync(join(source, 'customers (1).csv'));
    utimesSync(join(source, 'accounts.csv'), new Date(), new Date());
    expect(() => readExtractPackage(source)).toThrow('Wait for OneDrive to finish syncing');
    expect(Object.keys(readExtractPackage(source, 0))).toContain('accounts.csv');
    utimesSync(join(source, 'accounts.csv'), new Date(0), new Date(0));
    writeFileSync(join(source, 'people.csv'), Buffer.from([0xff, 0xfe, 0x41]));
    utimesSync(join(source, 'people.csv'), new Date(0), new Date(0));
    expect(() => readExtractPackage(source)).toThrow('not valid UTF-8');
  });
  it('a half-synced data file is caught by the control checksums', async () => {
    const source = landingPackage();
    const text = readFileSync(join(source, 'accounts.csv'), 'utf8');
    writeFileSync(join(source, 'accounts.csv'), text.slice(0, text.length / 2));
    utimesSync(join(source, 'accounts.csv'), new Date(0), new Date(0));
    await expect(service.ingestCsv(readExtractPackage(source), {}, admin)).rejects.toThrow(
      'checksum',
    );
    expect(store.list()).toHaveLength(0);
  });
  it('lists and imports landing packages over the API', async () => {
    landingPackage('bank1-2026-10-17');
    const landing = join(synced, 'Migration', 'Landing');
    expect(landingPackages(landing, 'control.csv').map((p) => p.name)).toEqual([
      'bank1-2026-10-17',
    ]);
    const runtime = createApp({
      databasePath: join(local, 'api.sqlite'),
      demo: true,
      startWorker: false,
      cbsOutbox: join(synced, 'Migration', 'CBS Load'),
      landing,
    });
    const server = runtime.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
    try {
      const login = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'demo-admin-2026' }),
      });
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const list = await (await fetch(`${base}/landing`, { headers: { cookie } })).json();
      expect(list).toMatchObject({ configured: true, packages: [{ name: 'bank1-2026-10-17' }] });
      const imported = await fetch(`${base}/ingest/landing`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: 'bank1-2026-10-17' }),
      });
      expect((await imported.json()).counts).toMatchObject({ created: 10, rejected: 0 });
      const traversal = await fetch(`${base}/ingest/landing`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: '../secrets' }),
      });
      expect(traversal.status).toBe(400);
      const health = await (await fetch(`${base}/health`)).json();
      expect(health).toMatchObject({ delivery: 'file-drop', strayFiles: 0 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runtime.close();
    }
  });
});

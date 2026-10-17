import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Actor } from '../packages/core/model';
import { Store } from '../packages/adapters/store';
import { SharePointAuthority, type Holder } from '../packages/adapters/sharepoint';
import { MigrationService } from '../packages/worker/service';
import { createApp } from '../packages/server/app';
import { FakeSharePoint } from './fake-sharepoint';
import { pack } from './helpers';

// Two app servers, each with its own local working copy, sharing one SharePoint site.
const admin: Actor = { id: 'admin-1', kind: 'human' };
const ana: Holder = { id: 'ana', name: 'Ana Operator', kind: 'human' },
  ben: Holder = { id: 'ben', name: 'Ben Operator', kind: 'human' };
const timing = { leaseMs: pack.operations.leaseMs, workerLeaseMs: pack.operations.workerLeaseMs };
const csvFiles = () =>
  Object.fromEntries(
    readdirSync('fixtures/bank1-csv')
      .filter((f) => f.endsWith('.csv'))
      .map((f) => [f, readFileSync(join('fixtures/bank1-csv', f), 'utf8')]),
  );

let sp: FakeSharePoint;
type Server = { store: Store; service: MigrationService };
let a: Server, b: Server;
const server = (id: string): Server => {
  const store = new Store(':memory:', pack);
  return {
    store,
    service: new MigrationService(
      store,
      pack,
      () => {},
      undefined,
      new SharePointAuthority(sp, id, timing),
    ),
  };
};
beforeEach(async () => {
  sp = new FakeSharePoint();
  a = server('server-a');
  b = server('server-b');
  // Server A imports the Bank 1 extract; every record is published to SharePoint.
  await a.service.ingestCsv(csvFiles(), { name: 'Bank 1 CSV' }, admin);
});
afterEach(() => {
  a.store.close();
  b.store.close();
});

// What the lease route does when a person opens a record.
async function open(s: Server, id: string, who: Holder) {
  const held = await s.service.checkOutRemote(id, who);
  if (held) return held;
  const lease = s.store.acquire(id, { id: who.id, kind: 'human' });
  if (!('leaseToken' in lease)) await s.service.finishRemote(id);
  return lease;
}
// What the save route does: local save, then publish to SharePoint.
async function save(
  s: Server,
  id: string,
  who: Holder,
  leaseToken: string,
  change: (d: any) => void,
) {
  const { record, etag } = s.store.load(id);
  const data = structuredClone(record.data);
  change(data);
  s.service.edit(id, data, etag, leaseToken, { id: who.id, kind: 'human' }, 'operator');
  return s.service.finishRemote(id);
}
const declare = (d: any) => {
  d.tax.declaration = 'DECL';
  if (d.tax.foreignTax) d.tax.foreignTin = 'TIN';
  d.entity.email ??= 'x@example.test';
  for (const s of d.signatories) s.identityReference = 'ID';
};

describe('SharePoint check-out and check-in', () => {
  it('publishes imported records, checked in and with no leases left', () => {
    expect([...sp.files.keys()].filter((p) => p.startsWith('records/'))).toHaveLength(10);
    expect([...sp.files.values()].every((f) => !f.checkedOut)).toBe(true);
    expect(sp.leases.size).toBe(0);
    expect(sp.personView('B1-100001').data.entity.legalName).toBe('Harbourview Logistics Pty Ltd');
    expect(a.store.remote('B1-100001')).toMatchObject({ pending: 0, token: null });
  });
  it('lets exactly one person open a record across servers, and shows the holder to the other', async () => {
    await b.service.syncFromSharePoint();
    const [first, second] = await Promise.all([
      open(a, 'B1-100003', ana),
      open(b, 'B1-100003', ben),
    ]);
    const results = [first, second];
    expect(results.filter((r) => 'leaseToken' in r)).toHaveLength(1);
    const refused = results.find((r) => 'heldBy' in r) as { heldBy: string };
    expect(['Ana Operator', 'Ben Operator']).toContain(refused.heldBy);
    // In SharePoint the file is checked out: people can view the last version but not edit it.
    expect(sp.isCheckedOut('B1-100003')).toBe(true);
    expect(() => sp.personEdit('B1-100003', (r) => (r.data.entity.email = 'x'))).toThrow(
      'checked out',
    );
  });
  it('keeps the previous version visible until the new one is checked in, then frees the record', async () => {
    const lease = (await open(a, 'B1-100003', ana)) as any;
    const { record, etag } = a.store.load('B1-100003');
    const data = structuredClone(record.data);
    declare(data);
    a.service.edit(
      'B1-100003',
      data,
      etag,
      lease.leaseToken,
      { id: 'ana', kind: 'human' },
      'operator',
    );
    // Saved locally, not yet released: SharePoint still shows the old version, checked out.
    expect(sp.personView('B1-100003').data.tax.declaration).toBeUndefined();
    expect(sp.isCheckedOut('B1-100003')).toBe(true);
    expect(await a.service.finishRemote('B1-100003')).toBe('published');
    expect(sp.personView('B1-100003').data.tax.declaration).toBe('DECL');
    expect(sp.personView('B1-100003').state).toBe('cbs_ready');
    expect(sp.isCheckedOut('B1-100003')).toBe(false);
    expect(sp.leases.has('B1-100003')).toBe(false);
    // The trace for the change is stored beside the records, append-only.
    expect([...sp.files.keys()].some((p) => p.startsWith('trace/B1-100003/'))).toBe(true);
    // Another server picks up the change and can then check it out.
    await b.service.syncFromSharePoint();
    expect(b.store.load('B1-100003').record.data.tax.declaration).toBe('DECL');
    expect('leaseToken' in (await open(b, 'B1-100003', ben))).toBe(true);
  });
  it('releasing without changes undoes the check-out and leaves SharePoint unchanged', async () => {
    const before = sp.files.get(sp.path('B1-100002'))!.published;
    const lease = (await open(a, 'B1-100002', ana)) as any;
    a.store.release('B1-100002', lease.leaseToken, { id: 'ana', kind: 'human' });
    expect(await a.service.finishRemote('B1-100002')).toBe('released');
    expect(sp.isCheckedOut('B1-100002')).toBe(false);
    expect(sp.files.get(sp.path('B1-100002'))!.published).toBe(before);
    expect(sp.leases.size).toBe(0);
  });
  it('a failed upload leaves the file checked out and unchanged, closes the record locally and retries', async () => {
    const lease = (await open(a, 'B1-100004', ana)) as any;
    sp.failNext('replaceFile', 503);
    expect(await save(a, 'B1-100004', ana, lease.leaseToken, declare)).toBe('pending');
    expect(sp.isCheckedOut('B1-100004')).toBe(true);
    expect(sp.personView('B1-100004').data.tax.declaration).toBeUndefined();
    expect(a.store.acquire('B1-100004', { id: 'carl', kind: 'human' })).toMatchObject({
      heldBy: 'SharePoint publish in progress',
    });
    expect('heldBy' in (await open(b, 'B1-100004', ben))).toBe(true);
    await a.service.publishPending();
    expect(sp.personView('B1-100004').data.tax.declaration).toBe('DECL');
    expect(sp.isCheckedOut('B1-100004')).toBe(false);
    expect(a.store.remote('B1-100004')).toMatchObject({ pending: 0 });
  });
  it('a crashed server loses the record after expiry and its late save never overwrites', async () => {
    const lease = (await open(a, 'B1-100005', ana)) as any;
    // Server A goes down holding the check-out. SharePoint's check-out never expires by itself,
    // but the lease does.
    expect('heldBy' in (await open(b, 'B1-100005', ben))).toBe(true);
    sp.advance(pack.operations.leaseMs + 1000);
    await b.service.syncFromSharePoint();
    const taken = (await open(b, 'B1-100005', ben)) as any;
    expect(taken.leaseToken).toBeDefined();
    expect(
      await save(
        b,
        'B1-100005',
        ben,
        taken.leaseToken,
        (d) => (d.entity.email = 'ben@example.test'),
      ),
    ).toBe('published');
    // Server A comes back and tries to save: rejected, kept for review, SharePoint untouched.
    expect(
      await save(
        a,
        'B1-100005',
        ana,
        lease.leaseToken,
        (d) => (d.entity.email = 'ana@example.test'),
      ),
    ).toBe('conflict');
    expect(sp.personView('B1-100005').data.entity.email).toBe('ben@example.test');
    expect(a.store.exceptions().some((e) => e.code === 'SHAREPOINT_CONFLICT')).toBe(true);
    expect(a.store.db.prepare('SELECT COUNT(*) AS n FROM remote_conflicts').get()).toMatchObject({
      n: 1,
    });
    // A's next open takes SharePoint's version.
    await open(a, 'B1-100005', ana);
    expect(a.store.load('B1-100005').record.data.entity.email).toBe('ben@example.test');
  });
  it('renewal keeps an active check-out past the lease time', async () => {
    const lease = (await open(a, 'B1-100006', ana)) as any;
    for (let i = 0; i < 6; i++) {
      sp.advance(pack.operations.renewMs);
      await a.service.authority!.renew('B1-100006', a.store.remote('B1-100006')!.token!, 'human');
    }
    expect('heldBy' in (await open(b, 'B1-100006', ben))).toBe(true);
    expect(await save(a, 'B1-100006', ana, lease.leaseToken, declare)).toBe('published');
  });
  it('an edit that gets past the check-out is detected and not overwritten', async () => {
    const lease = (await open(a, 'B1-100007', ana)) as any;
    sp.tamper('B1-100007', (r) => (r.data.entity.email = 'changed-in-sharepoint@example.test'));
    expect(await save(a, 'B1-100007', ana, lease.leaseToken, declare)).toBe('conflict');
    const file = sp.files.get(sp.path('B1-100007'))!;
    expect(JSON.parse(file.draft ?? file.published).data.entity.email).toBe(
      'changed-in-sharepoint@example.test',
    );
  });
  it('an admin break ends the check-out everywhere and the old holder cannot save', async () => {
    const lease = (await open(a, 'B1-100008', ana)) as any;
    await b.service.authority!.breakLease('B1-100008');
    expect(sp.isCheckedOut('B1-100008')).toBe(false);
    expect(sp.leases.has('B1-100008')).toBe(false);
    expect(await save(a, 'B1-100008', ana, lease.leaseToken, declare)).toBe('conflict');
  });
  it('a refresh skips records checked out elsewhere and publishes the rest', async () => {
    await b.service.syncFromSharePoint();
    await open(b, 'B1-100009', ben);
    const files = csvFiles();
    const batch = await a.service.ingestCsv(files, { name: 'again' }, admin);
    expect(batch.counts).toMatchObject({ skipped: 9, rejected: 1 });
    expect(
      a.store.exceptions().some((e) => e.code === 'LEASE_HELD' && e.recordId === 'B1-100009'),
    ).toBe(true);
  });
  it('runs the pipeline under check-outs and publishes the reconciled records', async () => {
    for (const r of a.store.list()) {
      const lease = (await open(a, r.recordId, ana)) as any;
      expect(await save(a, r.recordId, ana, lease.leaseToken, declare)).toBe('published');
    }
    const batch = a.store.batches()[0];
    a.service.releaseBatch(batch.id, admin);
    for (let i = 0; i < 40; i++) if (!(await a.service.runOne())) break;
    expect(a.store.list().every((r) => r.state === 'reconciled')).toBe(true);
    for (const r of a.store.list()) expect(sp.personView(r.recordId).state).toBe('reconciled');
    expect([...sp.files.values()].every((f) => !f.checkedOut)).toBe(true);
    expect(sp.leases.size).toBe(0);
  });
  it('the pipeline waits while a person has the record checked out on another server', async () => {
    const lease = (await open(a, 'B1-100010', ana)) as any;
    await save(a, 'B1-100010', ana, lease.leaseToken, declare);
    await b.service.syncFromSharePoint();
    await open(b, 'B1-100010', ben);
    a.service.releaseBatch(a.store.batches()[0].id, admin);
    expect(await a.service.runOne()).toBe(false);
    expect(a.store.load('B1-100010').record.state).toBe('cbs_ready');
  });
  it('one holder in every trial when servers race for the same record', async () => {
    for (let i = 0; i < 50; i++) {
      const results = await Promise.all([
        a.service.authority!.checkOut('B1-100001', ana),
        b.service.authority!.checkOut('B1-100001', ben),
      ]);
      expect(results.filter((r) => 'token' in r)).toHaveLength(1);
      await a.service.authority!.breakLease('B1-100001');
    }
  });
});

describe('SharePoint through the HTTP API', () => {
  it('shows a record open on another server as read-only with the holder', async () => {
    const apps = [0, 1].map((n) =>
      createApp({
        databasePath: ':memory:',
        demo: true,
        startWorker: false,
        authority: new SharePointAuthority(sp, `api-${n}`, timing),
      }),
    );
    const servers = apps.map((app) => app.app.listen(0, '127.0.0.1'));
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.once('listening', r))));
    const base = servers.map((s) => `http://127.0.0.1:${(s.address() as any).port}/api`);
    const login = async (url: string, user: string) =>
      (
        await fetch(`${url}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, password: `demo-${user}-2026` }),
        })
      ).headers
        .get('set-cookie')!
        .split(';')[0];
    try {
      const [one, two] = [await login(base[0], 'operator'), await login(base[1], 'reviewer')];
      const post = (url: string, cookie: string, path: string, body: unknown) =>
        fetch(`${url}${path}`, {
          method: 'POST',
          headers: { cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then((r) => r.json());
      const lease = await post(base[0], one, '/records/B1-100002/lease', {});
      expect(lease.leaseToken).toBeDefined();
      expect(await post(base[1], two, '/records/B1-100002/lease', {})).toMatchObject({
        heldBy: 'operator',
      });
      const health = await (await fetch(`${base[0]}/health`)).json();
      expect(health.records).toBe('sharepoint');
      expect(await post(base[0], one, '/records/B1-100002/lease/release', lease)).toMatchObject({
        sharepoint: 'released',
      });
      expect((await post(base[1], two, '/records/B1-100002/lease', {})).leaseToken).toBeDefined();
    } finally {
      for (const s of servers) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
      for (const app of apps) app.close();
    }
  });
});

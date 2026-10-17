import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { type Server } from 'node:http';
import { createApp } from '../packages/server/app';
import { extract } from './helpers';
let runtime: ReturnType<typeof createApp>,
  server: Server,
  base: string,
  admin: string,
  operator: string,
  reviewer: string;
async function request(path: string, cookie = '', method = 'GET', body?: any, origin?: string) {
  return fetch(base + '/api' + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function login(username: string) {
  const response = await request('/login', '', 'POST', {
    username,
    password: `demo-${username}-2026`,
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}
beforeAll(async () => {
  runtime = createApp({ databasePath: ':memory:', demo: true, startWorker: false });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  admin = await login('admin');
  operator = await login('operator');
  reviewer = await login('reviewer');
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  runtime.close();
});
describe('authenticated service boundaries', () => {
  it('exposes health without customer data and protects records', async () => {
    expect((await request('/health')).status).toBe(200);
    expect((await request('/overview')).status).toBe(401);
  });
  it('TC-100 denies operator ingestion, batch control and user management', async () => {
    expect((await request('/ingest', operator, 'POST', extract)).status).toBe(403);
    expect((await request('/users', operator)).status).toBe(403);
    expect(
      (await request('/records/test/lease/break', operator, 'POST', { reason: 'test' })).status,
    ).toBe(403);
  });
  it('rejects cross-origin mutations and never returns session tokens in JSON', async () => {
    expect(
      (await request('/ingest', admin, 'POST', extract, 'https://attacker.example')).status,
    ).toBe(403);
    const me = await (await request('/me', admin)).json();
    expect(me.token).toBeUndefined();
    expect(me.password).toBeUndefined();
  });
  it('TC-101 reviewer can view trace but cannot create users', async () => {
    expect((await request('/trace', reviewer)).status).toBe(200);
    expect(
      (
        await request('/users', reviewer, 'POST', {
          username: 'new',
          password: 'not-a-real-password',
          role: 'admin',
        })
      ).status,
    ).toBe(403);
  });
  it('TC-105 second user sees read-only ownership without the lease token', async () => {
    const result = await request('/ingest', admin, 'POST', {
      rows: [extract.rows[0]],
      totals: { customerCount: 1, accountCount: 1 },
    });
    expect(result.status).toBe(200);
    const lease = await (await request('/records/SYN-0001/lease', operator, 'POST', {})).json();
    expect(lease.leaseToken).toBeDefined();
    const competing = await (await request('/records/SYN-0001/lease', reviewer, 'POST', {})).json();
    expect(competing.heldBy).toBeDefined();
    expect(competing.leaseToken).toBeUndefined();
    const read = await (await request('/records/SYN-0001', reviewer)).json();
    expect(read.lease.leaseToken).toBeUndefined();
    expect(
      (
        await request('/records/SYN-0001', reviewer, 'PUT', {
          data: read.record.data,
          etag: read.etag,
          leaseToken: lease.leaseToken,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/records/SYN-0001/lease/release', operator, 'POST', {
          leaseToken: lease.leaseToken,
        })
      ).status,
    ).toBe(200);
  });
  it('TC-102 expires sessions after four hours', async () => {
    const now = runtime.store.now;
    runtime.store.now = () => Date.now() + 14400001;
    expect((await request('/me', operator)).status).toBe(401);
    runtime.store.now = now;
  });
  it('TC-106 returns a real executive PDF', async () => {
    const response = await request('/dashboard.pdf', admin);
    expect(response.status).toBe(200);
    expect(
      Buffer.from(await response.arrayBuffer())
        .subarray(0, 4)
        .toString(),
    ).toBe('%PDF');
  });
  it('imports the CSV package over HTTP and serves combined CBS load files', async () => {
    const files = await (await request('/fixtures/csv', admin)).json();
    expect(Object.keys(files).sort()).toEqual([
      'accounts.csv',
      'control.csv',
      'customers.csv',
      'people.csv',
      'signatories.csv',
    ]);
    expect((await request('/ingest/csv', operator, 'POST', { files })).status).toBe(403);
    const response = await request('/ingest/csv', admin, 'POST', { files, name: 'CSV' });
    expect(response.status).toBe(200);
    const batch = await response.json();
    expect(batch.counts).toMatchObject({ created: 10, rejected: 0 });
    // Nothing is loaded yet, so there are no CBS files to hand over.
    expect((await request(`/batches/${batch.id}/cbs-export`, reviewer)).status).toBe(404);
    expect((await request(`/batches/${batch.id}/cbs-export`, operator)).status).toBe(403);
  });
});

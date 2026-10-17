import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCsv } from '../packages/worker/commands';
import { Store } from '../packages/adapters/store';
import {
  HttpGraphClient,
  SharePointAuthority,
  type GraphClient,
} from '../packages/adapters/sharepoint';
import { FakeSharePoint } from './fake-sharepoint';
import { pack } from './helpers';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'migtool-cli-'));
  vi.stubEnv('DATABASE_PATH', join(dir, 'workspace.sqlite'));
  vi.stubEnv('LOAD_FOLDER', join(dir, 'loads'));
  vi.stubEnv('LOAD_STAGING', join(dir, 'staging'));
  for (const key of [
    'TENANT_ID',
    'CLIENT_ID',
    'CLIENT_SECRET',
    'SITE_ID',
    'DRIVE_ID',
    'LEASE_LIST_ID',
  ])
    vi.stubEnv(`SHAREPOINT_${key}`, 'synthetic-test');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
it('the CSV command obeys SharePoint checkouts and publishes records and batch membership', async () => {
  const graph = new FakeSharePoint();
  const methods: (keyof GraphClient)[] = [
    'now',
    'getFile',
    'readFile',
    'createFile',
    'replaceFile',
    'listFiles',
    'checkOut',
    'checkIn',
    'discardCheckOut',
    'getLease',
    'listLeases',
    'createLease',
    'updateLease',
    'deleteLease',
  ];
  for (const method of methods)
    vi.spyOn(HttpGraphClient.prototype, method).mockImplementation((...args: unknown[]) =>
      Reflect.apply(graph[method], graph, args),
    );
  const authority = new SharePointAuthority(graph, 'other-server', pack.operations);
  const held = await authority.checkOut('B1-100003', {
    id: 'other',
    name: 'Other operator',
    kind: 'human',
  });
  expect('token' in held).toBe(true);
  const batch = await importCsv('fixtures/sample-csv');
  expect(batch.counts).toMatchObject({ created: 9, rejected: 1 });
  expect(graph.files.has(graph.path('B1-100003'))).toBe(false);
  expect([...graph.files.keys()].filter((p) => p.startsWith('records/'))).toHaveLength(9);
  const metadata = JSON.parse(graph.files.get(`batches/${batch.id}.json`)!.published);
  expect(metadata.members).toHaveLength(9);
  const local = new Store(process.env.DATABASE_PATH!, pack);
  try {
    expect(local.pendingRemote()).toEqual([]);
    expect(local.exceptions().some((e) => e.code === 'LEASE_HELD')).toBe(true);
  } finally {
    local.close();
  }
});
it('rejects partial SharePoint settings before creating a local database', async () => {
  vi.stubEnv('SHAREPOINT_DRIVE_ID', '');
  await expect(importCsv('fixtures/sample-csv')).rejects.toThrow('SharePoint is partly configured');
  expect(existsSync(process.env.DATABASE_PATH!)).toBe(false);
});
it.each([false, true])(
  'creates Graph upload folders without rename copies (race: %s)',
  async (race) => {
    const responses = [
      { access_token: 'synthetic-token', expires_in: 3600 },
      { id: 'app-folder', folder: {} },
      404,
      ...(race
        ? [409, { id: 'outputs-folder', folder: {} }]
        : [{ id: 'outputs-folder', folder: {} }]),
      404,
      { id: 'record-folder', folder: {} },
      { id: 'bundle', eTag: 'etag-1' },
    ];
    const requests: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        requests.push({ url, method: options.method!, body: options.body });
        const next = responses.shift();
        if (next === undefined) throw new Error('Unexpected Graph request');
        return new Response(
          JSON.stringify(typeof next === 'number' ? { error: 'synthetic' } : next),
          { status: typeof next === 'number' ? next : 200 },
        );
      }),
    );
    const client = new HttpGraphClient({
      tenantId: 'tenant',
      clientId: 'client',
      clientSecret: 'synthetic-secret',
      siteId: 'site',
      driveId: 'drive',
      leaseListId: 'leases',
      folder: 'MIGTOOL',
    });
    expect(await client.createFile('outputs/R1/digest.json', '{"bundle":true}')).toEqual({
      id: 'bundle',
      eTag: 'etag-1',
    });
    const creates = requests.filter((r) => r.method === 'POST' && r.url.endsWith('/children'));
    expect(creates.map((r) => JSON.parse(r.body as string))).toEqual([
      { name: 'outputs', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      { name: 'R1', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
    ]);
    expect(requests.at(-1)!.url).toContain(
      '/drives/drive/root:/MIGTOOL/outputs/R1/digest.json:/content',
    );
    expect(responses).toHaveLength(0);
  },
);

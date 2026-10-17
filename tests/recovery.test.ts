import { it, expect } from 'vitest';
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFArray,
  PDFString,
  decodePDFRawStream,
  PDFRawStream,
} from 'pdf-lib';
import { writeFileSync } from 'node:fs';
import { Store } from '../packages/adapters/store';
import { MigrationService } from '../packages/worker/service';
import { reportPdf } from '../packages/adapters/renderers';
import { datasetsXml, fillXfaTemplate } from '../packages/adapters/xfa';
import { pack, extract } from './helpers';
import { SimulatedCbs } from '../packages/adapters/cbs';
import { PlatformError } from '../packages/core/model';
const actor = { id: 'synthetic-reviewer', kind: 'human' as const };
async function readyBatch(store: Store, service: MigrationService) {
  const batch = await service.ingest(
    { rows: [extract.rows[0]], totals: { customerCount: 1, accountCount: 1 } },
    actor,
  );
  const loaded = store.load('SYN-0001'),
    lease = store.acquire('SYN-0001', actor);
  if (!('leaseToken' in lease)) throw new Error();
  loaded.record.data.tax.declaration = 'SYNTHETIC-EVIDENCE';
  loaded.record.data.signatories[0].identityReference = 'SYNTHETIC-ID';
  service.edit('SYN-0001', loaded.record.data, loaded.etag, lease.leaseToken, actor, 'reviewer');
  service.releaseBatch(batch.id, actor);
  return batch;
}
it('TC-072 retries transient delivery without duplicate exports or receipts', async () => {
  const store = new Store(':memory:', pack);
  let now = Date.now(),
    attempts = 0;
  store.now = () => now;
  const simulated = new SimulatedCbs(store),
    service = new MigrationService(store, pack, () => {}, {
      deliver: async (...args) => {
        if (++attempts < 3) throw new PlatformError('TRANSIENT', 'Synthetic outage', 503);
        return simulated.deliver(...args);
      },
      readback: (key) => simulated.readback(key),
    });
  try {
    const batch = await readyBatch(store, service);
    await service.runOne();
    expect(store.load('SYN-0001').record.state).toBe('exported');
    expect(store.batch(batch.id).state).toBe('running');
    now += 1001;
    await service.runOne();
    now += 4001;
    await service.runOne();
    expect(store.load('SYN-0001').record.state).toBe('reconciled');
    expect(
      store.traces({ recordId: 'SYN-0001' }).filter((t) => t.decision === 'bundle_created'),
    ).toHaveLength(1);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM cbs_receipts').get()).toMatchObject({
      n: 1,
    });
  } finally {
    store.close();
  }
});
it('TC-076/091 holds the batch and blocks a mismatched readback', async () => {
  const store = new Store(':memory:', pack),
    simulated = new SimulatedCbs(store),
    service = new MigrationService(store, pack, () => {}, {
      deliver: (...args) => simulated.deliver(...args),
      readback: async () => ({ wrong: true }),
    });
  try {
    const batch = await readyBatch(store, service);
    await service.runOne();
    expect(store.load('SYN-0001').record.state).toBe('blocked');
    expect(store.batch(batch.id).state).toBe('on_hold');
    expect(store.exceptions().some((e) => e.code === 'RECONCILIATION_MISMATCH')).toBe(true);
  } finally {
    store.close();
  }
});
it('resumes a persisted import after the originating process is gone', async () => {
  const store = new Store(':memory:', pack);
  try {
    store.db
      .prepare("INSERT INTO ingest_runs VALUES(?,?,?,'queued')")
      .run(
        'recover-import',
        JSON.stringify({
          rows: extract.rows.slice(0, 2),
          totals: { customerCount: 2, accountCount: 2 },
        }),
        JSON.stringify(actor),
      );
    await new MigrationService(store, pack).runOne();
    expect(store.list()).toHaveLength(2);
    expect(store.batch('recover-import').counts.created).toBe(2);
    expect(store.db.prepare('SELECT status FROM ingest_runs').get()).toMatchObject({
      status: 'completed',
    });
  } finally {
    store.close();
  }
});
it('does not reset unresolved exception age or assignment when another field changes', async () => {
  const store = new Store(':memory:', pack),
    service = new MigrationService(store, pack);
  try {
    await service.ingest(
      { rows: [extract.rows[0]], totals: { customerCount: 1, accountCount: 1 } },
      actor,
    );
    const before = store.exceptions().find((e) => e.code === 'tax-declaration')!;
    store.updateException({ ...before, assignee: 'operator' });
    store.now = () => Date.now() + 86400000;
    service.updateExceptions(store.load('SYN-0001').record);
    const after = store.exceptions().find((e) => e.id === before.id)!;
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.assignee).toBe('operator');
    expect(after.status).toBe('open');
  } finally {
    store.close();
  }
});
it('fills an XFA datasets packet deterministically and escapes source text', async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const acro = doc.context.obj({
    XFA: doc.context.obj([
      PDFString.of('datasets'),
      doc.context.register(doc.context.flateStream('<old/>')),
    ]),
  });
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acro));
  const template = await doc.save(),
    bindings = { 'form1.entity.name': 'Synthetic & <Example>' },
    at = '2026-10-17T00:00:00Z';
  const first = await fillXfaTemplate(template, bindings, at),
    second = await fillXfaTemplate(template, bindings, at);
  expect(first).toEqual(second);
  const loaded = await PDFDocument.load(first),
    array = (loaded.catalog.lookup(PDFName.of('AcroForm')) as PDFDict).lookup(
      PDFName.of('XFA'),
    ) as PDFArray;
  const xml = Buffer.from(decodePDFRawStream(array.lookup(1) as PDFRawStream).decode()).toString();
  expect(xml).toContain('Synthetic &amp; &lt;Example&gt;');
  expect(() => datasetsXml({ '__proto__.name': 'x' })).toThrow();
});
it('preserves supported non-ASCII text and rejects missing glyphs instead of replacing names', async () => {
  const bytes = await reportPdf(
    'Synthetic PDF review',
    ['Legal name: Société Δοκιμή', 'Long field: ' + 'W'.repeat(180)],
    '2026-10-17T00:00:00Z',
  );
  expect(bytes.length).toBeGreaterThan(1000);
  writeFileSync('/tmp/migtool-pdf-review.pdf', bytes);
  await expect(
    reportPdf('Test', ['Unsupported: \u{1F9D1}'], '2026-10-17T00:00:00Z'),
  ).rejects.toThrow('does not cover');
});

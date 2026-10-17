import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { loadPack } from '../packages/adapters/config';
import { Store } from '../packages/adapters/store';
import { MigrationService } from '../packages/worker/service';
import { evaluate } from '../packages/core/engine';
import { renderBundle } from '../packages/adapters/renderers';
const pack = loadPack(),
  fixture = JSON.parse(readFileSync('fixtures/bank1-extract.json', 'utf8')),
  store = new Store(':memory:', pack),
  service = new MigrationService(store, pack);
try {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    ...fixture.rows[i % fixture.rows.length],
    CUST_ID: `PERF-${i}`,
  }));
  const start = performance.now();
  await service.ingest(
    { rows, totals: { customerCount: 1000, accountCount: 1000 } },
    { id: 'synthetic-benchmark', kind: 'system' },
  );
  const records = store.list();
  const largest = structuredClone(records[0].data);
  largest.tax.declaration = 'SYNTHETIC-REVIEW';
  largest.signatories = Array.from({ length: 20 }, (_, i) => ({
    name: `Synthetic ${i}`,
    identityReference: 'SYNTHETIC-EVIDENCE',
    authorityLimit: 1000,
  }));
  largest.accounts = Array.from({ length: 30 }, () => structuredClone(largest.accounts[0]));
  const durations = [];
  for (let i = 0; i < 500; i++) {
    const at = performance.now();
    evaluate(pack, largest);
    durations.push(performance.now() - at);
  }
  durations.sort((a, b) => a - b);
  const exportStart = performance.now();
  for (const record of records) {
    record.data.tax.declaration = 'SYNTHETIC-REVIEW';
    record.data.signatories[0].identityReference = 'SYNTHETIC-ID';
    record.data.entity.abn = '51824753556';
    record.data.address.postcode = '3220';
    await renderBundle(pack, record);
  }
  const elapsed = performance.now() - start;
  const result = {
    fixtureRecords: 1000,
    largestRecordRuleP95Ms: Number(durations[Math.floor(durations.length * 0.95)].toFixed(2)),
    ingestValidateExportMs: Math.round(elapsed),
    exportMs: Math.round(performance.now() - exportStart),
    reference: process.version,
    limitations:
      'In-memory database, this container, generated summary PDFs, no live CBS. Browser performance is not certified.',
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.largestRecordRuleP95Ms >= 50 || elapsed >= 300000) process.exitCode = 1;
} finally {
  store.close();
}

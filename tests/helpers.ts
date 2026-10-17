import { readFileSync } from 'node:fs';
import { type Envelope } from '../packages/core/model';
import { loadPack } from '../packages/adapters/config';
import { ingestRow, leafValues } from '../packages/core/mapping';
export const pack = loadPack();
export const extract = JSON.parse(readFileSync('fixtures/bank1-extract.json', 'utf8'));
export function readyRecord(): Envelope {
  const data = ingestRow(pack, extract.rows[0]);
  data.tax.declaration = 'SYNTHETIC-CUSTOMER-EVIDENCE';
  data.signatories[0].identityReference = 'SYNTHETIC-ID-EVIDENCE';
  return {
    recordId: 'SYN-0001',
    schemaVersion: pack.schema.version,
    version: 1,
    state: 'cbs_ready',
    data,
    baseline: leafValues(ingestRow(pack, extract.rows[0])),
    provenance: Object.fromEntries(
      Object.keys(leafValues(ingestRow(pack, extract.rows[0]))).map((path) => [
        path,
        {
          source: 'extract',
          actor: 'fixture',
          at: '2026-10-17T00:00:00Z',
          traceEventId: 'fixture',
        },
      ]),
    ),
    sourceRowHash: 'synthetic',
    batchId: 'fixture-batch',
    createdAt: '2026-10-17T00:00:00Z',
    updatedAt: '2026-10-17T00:00:00Z',
    conflicts: [],
  };
}

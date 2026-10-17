import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Data, type Pack, PlatformError } from '../core/model';
import { csv } from '../core/mapping';
import { Store } from './store';
import { hash, stable } from './config';
import { parseCsv } from './csv-extract';
import { prepareOutputFolder, writeFolderAtomic } from './files';

export interface CbsAdapter {
  deliver(key: string, recordId: string, expected: Data, at: string): Promise<void>;
  readback(key: string): Promise<Data | undefined>;
}
// A load the CBS refused. The code is the CBS error code; triage classifies it (section 8.1).
export class CbsRejection extends PlatformError {
  constructor(
    code: string,
    message: string,
    public errorClass: 'data' | 'mapping',
    public fieldPath: string,
  ) {
    super(code, message, 422);
  }
}
// Values as the CBS sees them: every column is text.
export const asText = (expected: Data): Data =>
  Object.fromEntries(
    Object.entries(expected).map(([file, rows]) => [
      file,
      Array.isArray(rows)
        ? rows.map((row) =>
            Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, String(v ?? '')])),
          )
        : rows,
    ]),
  );
export class SimulatedCbs implements CbsAdapter {
  constructor(private store: Store) {}
  async deliver(key: string, recordId: string, expected: Data, at: string) {
    this.store.db
      .prepare('INSERT INTO cbs_receipts VALUES(?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING')
      .run(key, recordId, JSON.stringify(expected), at);
  }
  async readback(key: string) {
    const row = this.store.db
      .prepare('SELECT expected FROM cbs_receipts WHERE idempotency_key=?')
      .get(key) as any;
    return row ? JSON.parse(row.expected) : undefined;
  }
}
// Delivers Bank 2 CBS load files (Customer_Create.csv, Account_Register.csv, User_Create.csv) to
// a load folder, one complete folder per delivery, written atomically. Readback parses the CSV
// files actually written, so the comparison covers the real serialised load.
export class FileDropCbs implements CbsAdapter {
  public staging: string;
  // The load folder may be a OneDrive/SharePoint folder; staging then sits outside it.
  constructor(
    public root: string,
    private pack: Pack,
    staging?: string,
  ) {
    this.staging = prepareOutputFolder(root, staging).staging;
  }
  folder(key: string) {
    return key.replace(/[^\w.-]/g, '_');
  }
  // Acceptance checks the simulated CBS applies before taking a load.
  private check(expected: Data) {
    for (const row of expected['Customer_Create.csv'] ?? [])
      if (!/^\d{4}$/.test(String(row.POSTCODE ?? '')))
        throw new CbsRejection(
          'CBS-E1042',
          `Customer ${row.CUSTOMER_ID}: postcode must be four digits`,
          'data',
          'address.postcode',
        );
    for (const row of expected['Account_Register.csv'] ?? [])
      if (!Object.hasOwn(this.pack.lookups.products, String(row.PRODUCT_CODE)))
        throw new CbsRejection(
          'CBS-E2001',
          `Customer ${row.CUSTOMER_ID}: unknown product code ${row.PRODUCT_CODE}`,
          'mapping',
          'accounts[*].productCode',
        );
  }
  // The delivery time is not written, so a repeat delivery is byte-identical and a no-op.
  async deliver(key: string, recordId: string, expected: Data, _at?: string) {
    this.check(expected);
    const files: Record<string, Uint8Array> = {},
      manifest: Data[] = [];
    for (const [name, rows] of Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))) {
      const mapping = this.pack.mappings.find((m) => m.output === name);
      if (!mapping) throw new PlatformError('MAPPING_SOURCE', `No mapping for ${name}`, 500);
      const bytes = Buffer.from(
        csv(
          mapping.columns.map((c) => c.name!),
          rows as Data[],
        ),
        'utf8',
      );
      files[name] = bytes;
      manifest.push({ name, rows: (rows as Data[]).length, sha256: hash(bytes) });
    }
    files['manifest.json'] = Buffer.from(
      JSON.stringify({ key, recordId, files: manifest }, null, 2) + '\n',
    );
    writeFolderAtomic(this.root, this.folder(key), files, this.staging);
  }
  async readback(key: string) {
    const dir = join(this.root, this.folder(key));
    if (!existsSync(dir)) return undefined;
    const result: Data = {};
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.csv'))
      .sort())
      result[file] = parseCsv(readFileSync(join(dir, file), 'utf8'), file, true).rows;
    return result;
  }
}
// Combined batch load files, ordered deterministically, with control totals in the manifest.
export function batchLoadFiles(pack: Pack, deliveries: { recordId: string; expected: Data }[]) {
  const files: Record<string, Uint8Array> = {},
    totals: Data = {};
  for (const mapping of pack.mappings.filter((m) => m.kind === 'csv')) {
    const rows = deliveries
      .slice()
      .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
      .flatMap((d) => (d.expected[mapping.output] ?? []) as Data[]);
    const bytes = Buffer.from(
      csv(
        mapping.columns.map((c) => c.name!),
        rows,
      ),
      'utf8',
    );
    files[mapping.output] = bytes;
    totals[mapping.output] = { rows: rows.length, sha256: hash(bytes) };
  }
  const manifest = {
    customers: deliveries.length,
    accounts: (totals['Account_Register.csv'] as Data | undefined)?.rows ?? 0,
    files: totals,
  };
  files['manifest.json'] = Buffer.from(
    JSON.stringify(JSON.parse(stable(manifest)), null, 2) + '\n',
  );
  return { files, manifest };
}
// Local staging for files bound for a (possibly synced) folder: CBS_STAGING, else beside the
// database, which must be on local disk.
export function stagingFor(databasePath: string, outbox?: string) {
  return (
    process.env.LOAD_STAGING ??
    process.env.CBS_STAGING ??
    (databasePath === ':memory:'
      ? join(outbox ?? '.', '.staging')
      : join(dirname(databasePath), 'staging'))
  );
}
// One choice of delivery for the server, the standalone worker and the scripts: the CBS load
// folder beside the database unless CBS_OUTBOX names another; in-memory stores simulate.
export function deliveryFor(
  store: Store,
  databasePath: string,
  outbox = process.env.LOAD_FOLDER ?? process.env.CBS_OUTBOX,
) {
  const root =
    outbox ?? (databasePath === ':memory:' ? undefined : join(dirname(databasePath), 'cbs-outbox'));
  return {
    root,
    cbs: root
      ? new FileDropCbs(root, store.pack, stagingFor(databasePath, root))
      : new SimulatedCbs(store),
  };
}

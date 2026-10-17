import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadPack } from '../packages/adapters/config';
import { Store } from '../packages/adapters/store';
import { deliveryFor } from '../packages/adapters/cbs';
import { MigrationService } from '../packages/worker/service';

// Imports a Bank 1 CSV extract folder (WF-01): npm run import:csv -- <folder> [--full-snapshot]
const dir = process.argv[2];
if (!dir) throw new Error('Usage: npm run import:csv -- <extract folder> [--full-snapshot]');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const files = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => f.endsWith('.csv'))
    .map((f) => [f, decoder.decode(readFileSync(join(dir, f)))]),
);
const pack = loadPack(),
  databasePath = process.env.DATABASE_PATH ?? 'var/migtool.sqlite',
  store = new Store(databasePath, pack),
  service = new MigrationService(store, pack, () => {}, deliveryFor(store, databasePath).cbs);
try {
  const batch = await service.ingestCsv(
    files,
    { name: `CSV extract ${dir}`, fullSnapshot: process.argv.includes('--full-snapshot') },
    { id: process.env.USER ?? 'cli-admin', kind: 'human' },
  );
  console.log(JSON.stringify(batch, null, 2));
} finally {
  store.close();
}

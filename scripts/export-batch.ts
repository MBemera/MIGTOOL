import { loadPack } from '../packages/adapters/config';
import { Store } from '../packages/adapters/store';
import { deliveryFor } from '../packages/adapters/cbs';
import { assertNotSynced, writeFolderAtomic } from '../packages/adapters/files';
import { MigrationService } from '../packages/worker/service';

// Writes a batch's combined Bank 2 CBS load files to a folder, atomically:
// npm run export:batch -- <batchId> [output folder]
const [batchId, out = 'var/cbs-batches'] = process.argv.slice(2);
if (!batchId) throw new Error('Usage: npm run export:batch -- <batchId> [output folder]');
assertNotSynced(out, 'The batch export folder');
const pack = loadPack(),
  databasePath = process.env.DATABASE_PATH ?? 'var/migtool.sqlite',
  store = new Store(databasePath, pack),
  service = new MigrationService(store, pack, () => {}, deliveryFor(store, databasePath).cbs);
try {
  const { files, manifest } = service.exportBatch(batchId);
  const written = writeFolderAtomic(out, batchId, files);
  console.log(
    JSON.stringify({ folder: written.path, created: written.created, manifest }, null, 2),
  );
} finally {
  store.close();
}

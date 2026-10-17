import { stagingFor } from '../packages/adapters/cbs';
import { prepareOutputFolder, writeFolderAtomic } from '../packages/adapters/files';
import { openWorkspace } from '../packages/worker/runtime';

// Writes a batch's combined Bank 2 CBS load files to a folder (OneDrive allowed), atomically:
// npm run export:batch -- <batchId> [output folder]
const [batchId, out = 'var/cbs-batches'] = process.argv.slice(2);
if (!batchId) throw new Error('Usage: npm run export:batch -- <batchId> [output folder]');
const databasePath = process.env.DATABASE_PATH ?? 'var/migtool.sqlite',
  { store, service } = openWorkspace();
try {
  await service.syncFromSharePoint();
  const { files, manifest } = service.exportBatch(batchId);
  const { staging } = prepareOutputFolder(out, stagingFor(databasePath, out));
  const written = writeFolderAtomic(out, batchId, files, staging);
  console.log(
    JSON.stringify({ folder: written.path, created: written.created, manifest }, null, 2),
  );
} finally {
  store.close();
}

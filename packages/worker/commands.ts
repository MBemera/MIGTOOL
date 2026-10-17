import { readExtractPackage } from '../adapters/files';
import { openWorkspace } from './runtime';

export async function importCsv(dir: string, fullSnapshot = false) {
  const { store, service } = openWorkspace();
  try {
    return await service.ingestCsv(
      readExtractPackage(dir),
      { name: `CSV extract ${dir}`, fullSnapshot },
      { id: process.env.USER ?? 'cli-admin', kind: 'human' },
    );
  } finally {
    store.close();
  }
}

import { loadPack } from '../adapters/config';
import { Store } from '../adapters/store';
import { deliveryFor } from '../adapters/cbs';
import { sharePointFromEnv } from '../adapters/sharepoint';
import { MigrationService } from './service';

export function openWorkspace() {
  const pack = loadPack(),
    databasePath = process.env.DATABASE_PATH ?? 'var/migtool.sqlite',
    authority = sharePointFromEnv(pack),
    store = new Store(databasePath, pack);
  try {
    return {
      store,
      service: new MigrationService(
        store,
        pack,
        () => {},
        deliveryFor(store, databasePath).cbs,
        authority,
      ),
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

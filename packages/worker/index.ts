import { loadPack } from '../adapters/config';
import { Store } from '../adapters/store';
import { MigrationService } from './service';
const pack = loadPack(),
  store = new Store(process.env.DATABASE_PATH ?? 'var/migtool.sqlite', pack),
  service = new MigrationService(store, pack);
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await service.runOne();
  } catch (e) {
    console.error(
      JSON.stringify({ level: 'error', event: 'worker_failed', name: (e as Error).name }),
    );
  } finally {
    running = false;
  }
}, 250);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    clearInterval(timer);
    store.close();
    process.exit(0);
  });

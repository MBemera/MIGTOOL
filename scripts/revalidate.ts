import { Store } from '../packages/adapters/store';
import { loadPack } from '../packages/adapters/config';
import { MigrationService, worker } from '../packages/worker/service';
import { migrate } from '../migrations';
const pack = loadPack(),
  store = new Store(process.env.DATABASE_PATH ?? 'var/migtool.sqlite', pack),
  service = new MigrationService(store, pack),
  report: any[] = [];
try {
  for (const record of store.list()) {
    if (
      ['exported', 'loaded', 'reconciled', 'amendment_pending', 'withdrawn'].includes(record.state)
    )
      continue;
    const lease = store.acquire(record.recordId, worker, true);
    if (!('leaseToken' in lease)) {
      report.push({ id: record.recordId, result: 'leased_skip' });
      continue;
    }
    try {
      const upgraded = migrate(record, pack),
        states = service.validated(upgraded.record),
        saved = store.save(
          upgraded.record,
          { ifMatch: String(record.version), leaseToken: lease.leaseToken },
          worker,
          upgraded.versions.length ? 'migrate' : 'validate',
          'config_revalidated',
          states,
        );
      service.updateExceptions(saved.record);
      report.push({ id: record.recordId, from: record.state, to: saved.record.state });
    } finally {
      store.release(record.recordId, lease.leaseToken, worker);
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}

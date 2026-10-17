import { worker } from '../packages/worker/service';
import { openWorkspace } from '../packages/worker/runtime';
import { PlatformError } from '../packages/core/model';
import { migrate } from '../migrations';
const { store, service } = openWorkspace(),
  pack = store.pack,
  report: any[] = [];
try {
  await service.publishPending();
  await service.syncFromSharePoint();
  for (const snapshot of store.list()) {
    if (
      ['exported', 'loaded', 'reconciled', 'amendment_pending', 'withdrawn'].includes(
        snapshot.state,
      )
    )
      continue;
    try {
      await service.withRemote(service.authority ? [snapshot.recordId] : [], () => {
        const record = store.load(snapshot.recordId).record;
        if (
          ['exported', 'loaded', 'reconciled', 'amendment_pending', 'withdrawn'].includes(
            record.state,
          )
        )
          return;
        const lease = store.acquire(record.recordId, worker, true);
        if (!('leaseToken' in lease)) {
          report.push({ id: record.recordId, result: 'leased_skip' });
          return;
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
      });
    } catch (error) {
      if (!(error instanceof PlatformError && error.code === 'LEASE_HELD')) throw error;
      report.push({ id: snapshot.recordId, result: 'leased_skip' });
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}

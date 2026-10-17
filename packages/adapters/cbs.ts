import { type Data } from '../core/model';
import { Store } from './store';
export interface CbsAdapter {
  deliver(key: string, recordId: string, expected: Data, at: string): Promise<void>;
  readback(key: string): Promise<Data | undefined>;
}
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

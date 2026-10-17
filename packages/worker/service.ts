import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  type Actor,
  type Batch,
  type Data,
  type Envelope,
  type Pack,
  type State,
  type Trace,
  type Role,
  expand,
  fieldDefinition,
  get,
  same,
  set,
  PlatformError,
} from '../core/model';
import { evaluate, transition, validationStates } from '../core/engine';
import { ingestRow, leafValues, merge, transform, assertEditableData } from '../core/mapping';
import { validateProposal } from '../core/proposals';
import { Store } from '../adapters/store';
import { hash } from '../adapters/config';
import { renderBundle } from '../adapters/renderers';
import { type CbsAdapter, SimulatedCbs } from '../adapters/cbs';

export const worker: Actor = { id: 'pipeline-worker', kind: 'system' };
export class MigrationService {
  operations: { retrySeconds: number[]; circuitCount: number; circuitFraction: number };
  constructor(
    public store: Store,
    public pack: Pack,
    public changed = () => {},
    public cbs: CbsAdapter = new SimulatedCbs(store),
  ) {
    this.operations = pack.operations;
  }
  validated(record: Envelope): State[] {
    const result = evaluate(this.pack, record.data),
      states = validationStates(result);
    for (const state of states) transition(record, state);
    return states;
  }
  updateExceptions(record: Envelope) {
    const result = evaluate(this.pack, record.data);
    const signatures = new Set([
      ...result.rules.filter((r) => !r.passed).map((r) => `validate:${r.id}`),
      ...record.conflicts.map((c) => `merge:${c.path}`),
      ...(record.missingFromRefresh ? ['merge:missing'] : []),
    ]);
    for (const old of this.store
      .exceptions()
      .filter(
        (e) =>
          e.recordId === record.recordId &&
          e.status === 'open' &&
          e.signature.startsWith('validate:') &&
          !signatures.has(e.signature),
      ))
      this.store.updateException({ ...old, status: 'resolved' });
    for (const old of this.store
      .exceptions()
      .filter(
        (e) =>
          e.recordId === record.recordId &&
          e.status === 'open' &&
          e.signature.startsWith('merge:') &&
          !signatures.has(e.signature),
      ))
      this.store.updateException({ ...old, status: 'resolved' });
    for (const failure of result.rules.filter((r) => !r.passed))
      this.store.exception({
        recordId: record.recordId,
        batchId: record.batchId,
        code: failure.id,
        errorClass: failure.class ?? 'data',
        tier: failure.class === 'gap' ? 3 : 1,
        message: failure.message,
        fields: failure.fields,
        signature: `validate:${failure.id}`,
      });
    for (const c of record.conflicts)
      this.store.exception({
        recordId: record.recordId,
        batchId: record.batchId,
        code: 'REFRESH_CONFLICT',
        errorClass: 'conflict',
        tier: 3,
        message: `Refresh requires review: ${c.path}`,
        fields: [c.path],
        signature: `merge:${c.path}`,
      });
    if (record.missingFromRefresh)
      this.store.exception({
        recordId: record.recordId,
        batchId: record.batchId,
        code: 'MISSING_FROM_REFRESH',
        errorClass: 'conflict',
        tier: 3,
        message: 'Customer absent from the full snapshot. Reviewer must confirm scope.',
        fields: [],
        signature: 'merge:missing',
      });
  }
  async ingest(input: Parameters<MigrationService['ingestSync']>[0], actor: Actor): Promise<Batch> {
    const runId = randomUUID();
    this.store.db
      .prepare("INSERT INTO ingest_runs VALUES(?,?,?,'queued')")
      .run(runId, JSON.stringify(input), JSON.stringify(actor));
    return this.executeImport(runId, input, actor);
  }
  private executeImport(
    runId: string,
    input: Parameters<MigrationService['ingestSync']>[0],
    actor: Actor,
  ): Batch {
    const lease = this.store.acquire(`batch:${runId}`, worker, true);
    if (!('leaseToken' in lease))
      throw new PlatformError(
        'LEASE_HELD',
        'An import worker is already processing this batch',
        409,
      );
    try {
      return this.store.transaction(() => {
        const result = this.ingestSync(input, actor, runId);
        this.store.db.prepare("UPDATE ingest_runs SET status='completed' WHERE id=?").run(runId);
        return result;
      });
    } catch (error) {
      if (error instanceof PlatformError && error.code !== 'TRANSIENT') {
        this.store.db.prepare("UPDATE ingest_runs SET status='failed' WHERE id=?").run(runId);
        this.store.trace(
          `batch:${runId}`,
          worker,
          'ingest',
          'failed',
          { code: error.code },
          { batchId: runId, errorCode: error.code, errorClass: 'system', tier: 4 },
        );
      }
      throw error;
    } finally {
      this.store.release(`batch:${runId}`, lease.leaseToken, worker);
    }
  }
  private ingestSync(
    input: {
      name?: string;
      rows: Data[];
      totals: { customerCount: number; accountCount: number };
      fullSnapshot?: boolean;
      checksum?: string;
    },
    actor: Actor,
    batchId: string,
  ): Batch {
    if (!Array.isArray(input.rows) || input.rows.length > 10000 || !input.totals)
      throw new PlatformError(
        'EXTRACT_INVALID',
        'Provide rows and customer/account control totals; maximum 10,000 rows',
      );
    const digest = hash(input.rows);
    if (input.checksum && input.checksum !== digest)
      throw new PlatformError('CHECKSUM_MISMATCH', 'Extract checksum does not match');
    const batch: Batch = {
      id: batchId,
      name: input.name?.slice(0, 120) || 'Bank 1 extract',
      createdAt: this.store.timestamp(),
      state: 'ready',
      inputHash: digest,
      counts: {
        source: input.rows.length,
        accounts: input.rows.reduce(
          (n, r) => n + (Array.isArray(r?.ACCOUNTS) ? r.ACCOUNTS.length : 0),
          0,
        ),
        created: 0,
        updated: 0,
        skipped: 0,
        rejected: 0,
      },
    };
    const totalsMatch =
      batch.counts.source === input.totals.customerCount &&
      batch.counts.accounts === input.totals.accountCount;
    if (!totalsMatch) {
      batch.state = 'on_hold';
      batch.reason = 'CONTROL_TOTAL_MISMATCH';
      this.store.putBatch(batch);
      this.store.trace(
        `batch:${batch.id}`,
        actor,
        'ingest',
        'control_totals_rejected',
        { expected: input.totals, actual: batch.counts },
        { batchId: batch.id, errorCode: 'CONTROL_TOTAL_MISMATCH', tier: 4, errorClass: 'system' },
      );
      this.changed();
      return batch;
    }
    this.store.putBatch(batch);
    const keys = new Map<string, number>();
    for (const row of input.rows) {
      const key = String(row?.[this.pack.ingest.key] ?? '');
      keys.set(key, (keys.get(key) ?? 0) + 1);
    }
    for (let index = 0; index < input.rows.length; index++) {
      const row = input.rows[index],
        key = String(row?.[this.pack.ingest.key] ?? ''),
        id = key;
      let token: string | undefined;
      try {
        if (!/^[A-Za-z0-9._-]{1,80}$/.test(key))
          throw new PlatformError(
            'INVALID_CUSTOMER_KEY',
            'Stable customer key is missing or invalid',
          );
        if (keys.get(key) !== 1)
          throw new PlatformError(
            'DUPLICATE_CUSTOMER_KEY',
            'Both duplicate customer rows are rejected',
          );
        for (const column of this.pack.ingest.required_columns)
          if (!Object.hasOwn(row, column))
            throw new PlatformError('MISSING_COLUMN', `Missing extract column ${column}`);
        const data = ingestRow(this.pack, row),
          rowHash = hash(row);
        this.store.db
          .prepare('INSERT INTO batch_records VALUES(?,?) ON CONFLICT DO NOTHING')
          .run(batch.id, id);
        if (
          this.store.exists(id) &&
          this.store.load(id).record.sourceRowHash === rowHash &&
          this.store.load(id).record.state !== 'ingested'
        ) {
          batch.counts.skipped++;
          continue;
        }
        const lease = this.store.acquire(id, worker, true);
        if (!('leaseToken' in lease))
          throw new PlatformError(
            'LEASE_HELD',
            'Record is currently in use; re-import this row when available',
            409,
          );
        token = lease.leaseToken;
        if (!this.store.exists(id)) {
          const at = this.store.timestamp(),
            record: Envelope = {
              recordId: id,
              schemaVersion: this.pack.schema.version,
              version: 1,
              state: 'ingested',
              data,
              baseline: leafValues(data),
              provenance: {},
              sourceRowHash: rowHash,
              batchId: batch.id,
              createdAt: at,
              updatedAt: at,
              conflicts: [],
            };
          const eventId = randomUUID();
          for (const path of Object.keys(record.baseline))
            record.provenance[path] = {
              source: 'extract',
              actor: actor.id,
              at,
              traceEventId: eventId,
            };
          this.store.create(record, token, worker);
          const states = this.validated(record);
          this.store.save(
            record,
            { ifMatch: '1', leaseToken: token },
            worker,
            'validate',
            'evaluated',
            states,
          );
          this.updateExceptions(record);
          batch.counts.created++;
        } else {
          const { record, etag } = this.store.load(id);
          if (record.state === 'withdrawn')
            throw new PlatformError(
              'WITHDRAWN',
              'Withdrawn customer requires reviewer intervention',
            );
          const result = merge(record, data, actor.id, this.store.timestamp(), randomUUID());
          result.record.sourceRowHash = rowHash;
          const states: State[] = [];
          if (!['amendment_pending', 'loaded', 'reconciled'].includes(result.record.state))
            states.push(...this.validated(result.record));
          this.store.save(
            result.record,
            { ifMatch: etag, leaseToken: token },
            worker,
            'merge',
            'refreshed',
            states,
          );
          for (const path of [...result.changes, ...result.conflicts.map((c) => c.path)])
            this.store.trace(
              id,
              worker,
              'merge',
              result.conflicts.some((c) => c.path === path) ? 'conflict' : 'field_updated',
              { path },
            );
          this.updateExceptions(result.record);
          batch.counts.updated++;
        }
      } catch (error) {
        if (!(error instanceof PlatformError)) throw error;
        this.store.db
          .prepare('DELETE FROM batch_records WHERE batch_id=? AND record_id=?')
          .run(batch.id, id);
        batch.counts.rejected++;
        const e = error as PlatformError;
        this.store.exception({
          recordId: id || `row:${index + 1}`,
          batchId: batch.id,
          code: e.code ?? 'MALFORMED_ROW',
          errorClass: 'data',
          tier: 3,
          message: e.message,
          fields: [],
          signature: `ingest:${e.code ?? 'MALFORMED_ROW'}`,
        });
        this.store.trace(
          id || `row:${index + 1}`,
          actor,
          'ingest',
          'row_rejected',
          { rowNumber: index + 1 },
          { batchId: batch.id, errorCode: e.code ?? 'MALFORMED_ROW' },
        );
      } finally {
        if (token)
          try {
            this.store.release(id, token, worker);
          } catch {}
      }
    }
    if (input.fullSnapshot && batch.counts.rejected === 0) {
      const incoming = new Set(input.rows.map((row) => String(row[this.pack.ingest.key])));
      for (const record of this.store.list())
        if (!incoming.has(record.recordId) && record.state !== 'withdrawn') {
          const lease = this.store.acquire(record.recordId, worker, true);
          if ('leaseToken' in lease) {
            try {
              record.missingFromRefresh = true;
              this.store.save(
                record,
                { ifMatch: String(record.version), leaseToken: lease.leaseToken },
                worker,
                'merge',
                'missing_from_snapshot',
              );
              this.updateExceptions(record);
            } finally {
              this.store.release(record.recordId, lease.leaseToken, worker);
            }
          } else {
            batch.state = 'on_hold';
            batch.reason = 'Snapshot review could not flag a leased record';
          }
        }
    }
    this.store.putBatch(batch);
    this.store.trace(
      `batch:${batch.id}`,
      actor,
      'ingest',
      'completed',
      { counts: batch.counts, inputHash: digest },
      { batchId: batch.id },
    );
    this.changed();
    return batch;
  }
  edit(
    id: string,
    data: Data,
    etag: string,
    token: string,
    actor: Actor,
    role: Role,
    resolveConflicts = false,
  ) {
    const { record } = this.store.load(id);
    this.store.ownsLease(id, token, actor);
    if (
      ['exported', 'loaded', 'reconciled', 'withdrawn', 'amendment_pending'].includes(record.state)
    )
      throw new PlatformError(
        'FROZEN_RECORD',
        'This record is frozen. Use the amendment or reviewer workflow.',
        409,
      );
    if (resolveConflicts && role === 'operator')
      throw new PlatformError('FORBIDDEN', 'A reviewer must resolve refresh conflicts', 403);
    assertEditableData(this.pack, data);
    const now = this.store.timestamp();
    for (const [path, value] of Object.entries(leafValues(data)))
      if (!same(get(record.data, path), value))
        record.provenance[path] = {
          source: 'operator',
          actor: actor.id,
          at: now,
          traceEventId: randomUUID(),
        };
    record.data = structuredClone(data);
    if (resolveConflicts) record.conflicts = [];
    const states = this.validated(record),
      saved = this.store.save(
        record,
        { ifMatch: etag, leaseToken: token },
        actor,
        'edit',
        'saved',
        states,
      );
    this.updateExceptions(saved.record);
    this.store.release(id, token, actor);
    this.changed();
    return saved;
  }
  applyPlaybook(id: string, code: string, actor: Actor) {
    const entry = this.pack.playbook.entries.find(
      (e) => e.match.step === 'validate' && e.match.errorCode === code,
    );
    if (!entry || !entry.autoApply)
      throw new PlatformError('PLAYBOOK_UNAVAILABLE', 'No approved automatic fix for this error');
    const record = this.store.load(id).record;
    const proposal = {
      errorClass: 'data',
      diagnosis: `Approved playbook ${entry.id}`,
      patch: [
        {
          op: 'replace',
          path: '/' + entry.path.replace(/\./g, '/'),
          value: transform(get(record.data, entry.path), entry.transform, this.pack),
        },
      ],
      citedFields: [entry.path],
      confidence: 1,
    };
    const result = validateProposal(this.pack, record.data, proposal, code, { source: 'playbook' });
    if (!result.apply) throw new PlatformError('REVIEW_REQUIRED', result.reason);
    const lease = this.store.acquire(id, worker, true);
    if (!('leaseToken' in lease)) throw new PlatformError('LEASE_HELD', 'Record is in use', 409);
    try {
      record.data = result.data;
      for (const op of proposal.patch)
        record.provenance[entry.path] = {
          source: 'playbook',
          actor: entry.id,
          at: this.store.timestamp(),
          traceEventId: randomUUID(),
        };
      const states = this.validated(record);
      const saved = this.store.save(
        record,
        { ifMatch: String(record.version), leaseToken: lease.leaseToken },
        worker,
        'fix',
        'auto_applied',
        states,
      );
      this.store.trace(id, actor, 'fix', 'playbook_used', { entry: entry.id });
      this.updateExceptions(saved.record);
    } finally {
      this.store.release(id, lease.leaseToken, worker);
    }
    this.changed();
  }
  releaseBatch(id: string, actor: Actor) {
    const batch = this.store.batch(id);
    if (batch.state === 'on_hold')
      throw new PlatformError('BATCH_ON_HOLD', 'Resume the batch before releasing it', 409);
    let queued = 0;
    const members = new Set(
      (
        this.store.db
          .prepare('SELECT record_id FROM batch_records WHERE batch_id=?')
          .all(id) as any[]
      ).map((x) => x.record_id),
    );
    for (const record of this.store
      .list()
      .filter(
        (r) =>
          members.has(r.recordId) &&
          ['cbs_ready', 'exported', 'loaded'].includes(r.state) &&
          !r.conflicts.length &&
          !r.missingFromRefresh,
      )) {
      const result = this.store.db
        .prepare(
          "INSERT INTO jobs(id,record_id,batch_id,status,available) VALUES(?,?,?,'queued',?) ON CONFLICT(id) DO UPDATE SET status='queued',attempts=0,available=excluded.available WHERE jobs.status='failed'",
        )
        .run(`${id}:${record.recordId}`, record.recordId, id, this.store.now());
      queued += Number(result.changes);
    }
    const pending = this.store.db
      .prepare("SELECT 1 FROM jobs WHERE batch_id=? AND status IN ('queued','running') LIMIT 1")
      .get(id);
    if (pending) batch.state = 'running';
    this.store.putBatch(batch);
    this.store.trace(
      `batch:${id}`,
      actor,
      'admin',
      'released',
      { queued, delivery: 'simulated-cbs' },
      { batchId: id },
    );
    this.changed();
    return { queued };
  }
  batchAction(id: string, action: 'pause' | 'resume', reason: string, actor: Actor) {
    const batch = this.store.batch(id);
    if (!reason.trim()) throw new PlatformError('REASON_REQUIRED', 'A reason is required');
    if (action === 'resume' && batch.reason === 'CONTROL_TOTAL_MISMATCH')
      throw new PlatformError(
        'CONTROL_TOTAL_MISMATCH',
        'Correct the extract totals and import again',
      );
    batch.state = action === 'pause' ? 'on_hold' : 'ready';
    batch.reason = action === 'pause' ? reason : undefined;
    this.store.putBatch(batch);
    this.store.trace(`batch:${id}`, actor, 'admin', action, { reason }, { batchId: id });
    this.changed();
  }
  async runOne(): Promise<boolean> {
    const pendingImport = this.store.db
      .prepare("SELECT * FROM ingest_runs WHERE status='queued' LIMIT 1")
      .get() as any;
    if (pendingImport) {
      try {
        this.executeImport(
          pendingImport.id,
          JSON.parse(pendingImport.input),
          JSON.parse(pendingImport.actor),
        );
        this.changed();
        return true;
      } catch (error) {
        if (error instanceof PlatformError && error.code === 'LEASE_HELD') return false;
        throw error;
      }
    }

    const job = this.store.transaction(() => {
      const row = this.store.db
        .prepare(
          "SELECT * FROM jobs WHERE status IN ('queued','running') AND available<=? ORDER BY available,id LIMIT 1",
        )
        .get(this.store.now()) as any;
      if (!row) return null;
      this.store.db
        .prepare("UPDATE jobs SET status='running',available=? WHERE id=?")
        .run(this.store.now() + 300000, row.id);
      return row;
    });
    if (!job) return false;
    const batch = this.store.batch(job.batch_id);
    if (batch.state === 'on_hold') {
      this.store.db
        .prepare("UPDATE jobs SET status='queued',available=? WHERE id=?")
        .run(this.store.now() + 1000, job.id);
      return false;
    }
    let leaseToken: string | undefined;
    try {
      const lease = this.store.acquire(job.record_id, worker, true);
      if (!('leaseToken' in lease)) {
        this.store.db
          .prepare("UPDATE jobs SET status='queued',available=? WHERE id=?")
          .run(this.store.now() + 1000, job.id);
        return false;
      }
      leaseToken = lease.leaseToken;
      let { record, etag } = this.store.load(job.record_id);
      const save = (step: string, next: State, detail: string) => {
        transition(record, next);
        const saved = this.store.save(
          record,
          { ifMatch: etag, leaseToken: leaseToken! },
          worker,
          step,
          detail,
          [next],
        );
        record = saved.record;
        etag = saved.etag;
      };
      if (record.conflicts.length || record.missingFromRefresh)
        throw new PlatformError('REVIEW_REQUIRED', 'Resolve conflicts and scope before delivery');
      if (record.state === 'cbs_ready') {
        const output = await renderBundle(this.pack, record);
        this.store.db
          .prepare(
            'INSERT INTO outputs VALUES(?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET record_version=excluded.record_version,bytes=excluded.bytes,digest=excluded.digest,expected=excluded.expected',
          )
          .run(
            record.recordId,
            record.version,
            output.bytes,
            output.digest,
            JSON.stringify(output.expected),
          );
        save('export', 'exported', 'bundle_created');
        this.store.trace(
          record.recordId,
          worker,
          'export',
          'file_manifest',
          { manifest: output.manifest },
          { outputHash: output.digest },
        );
      }
      if (record.state === 'exported') {
        const output = this.store.db
          .prepare('SELECT * FROM outputs WHERE record_id=?')
          .get(record.recordId) as any;
        if (!output) throw new PlatformError('OUTPUT_MISSING', 'Exported output not found', 500);
        const expected = JSON.parse(output.expected);
        if (
          expected['Customer_Create.csv']?.length !== 1 ||
          expected['Account_Register.csv']?.length !== (record.data.accounts?.length ?? 0)
        )
          throw new PlatformError('CONTROL_TOTAL_MISMATCH', 'Export totals differ from the record');
        await this.cbs.deliver(
          `${record.recordId}:${output.digest}`,
          record.recordId,
          expected,
          this.store.timestamp(),
        );
        save('load', 'loaded', 'simulated_cbs_accepted');
      }
      if (record.state === 'loaded') {
        const output = this.store.db
          .prepare('SELECT * FROM outputs WHERE record_id=?')
          .get(record.recordId) as any;
        const receipt = await this.cbs.readback(`${record.recordId}:${output.digest}`);
        if (!receipt || !same(JSON.parse(output.expected), receipt))
          throw new PlatformError('RECONCILIATION_MISMATCH', 'CBS readback differs from export');
        for (const [path, value] of Object.entries(record.baseline))
          if (record.provenance[path]?.source === 'extract' && !same(get(record.data, path), value))
            throw new PlatformError('BASELINE_DRIFT', `Extract baseline drift at ${path}`);
        save('reconcile', 'reconciled', 'simulated_readback_matched');
      }
      this.store.db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(job.id);
      const pending = this.store.db
        .prepare("SELECT 1 FROM jobs WHERE batch_id=? AND status IN ('queued','running') LIMIT 1")
        .get(job.batch_id);
      if (!pending) {
        const latest = this.store.batch(job.batch_id);
        if (latest.state !== 'on_hold') {
          const memberIds = new Set(
            (
              this.store.db
                .prepare('SELECT record_id FROM batch_records WHERE batch_id=?')
                .all(job.batch_id) as any[]
            ).map((r) => r.record_id),
          );
          const allDone =
            latest.counts.rejected === 0 &&
            this.store
              .list()
              .filter((r) => memberIds.has(r.recordId))
              .every((r) => ['reconciled', 'withdrawn'].includes(r.state));
          latest.state = allDone ? 'completed' : 'ready';
          this.store.putBatch(latest);
        }
      }
      this.changed();
      return true;
    } catch (error) {
      const e = error as PlatformError,
        attempts = job.attempts + 1,
        transient = ['SQLITE_BUSY', 'TRANSIENT'].includes(e.code),
        retry = transient && attempts <= this.operations.retrySeconds.length;
      if (!retry && leaseToken) {
        const loaded = this.store.load(job.record_id);
        const states: State[] =
          loaded.record.state === 'cbs_ready'
            ? ['validating', 'blocked']
            : ['exported', 'loaded'].includes(loaded.record.state)
              ? ['blocked']
              : [];
        if (states.length) {
          for (const state of states) transition(loaded.record, state);
          this.store.save(
            loaded.record,
            { ifMatch: loaded.etag, leaseToken },
            worker,
            'triage',
            'blocked_after_failure',
            states,
          );
        }
      }
      this.store.db
        .prepare('UPDATE jobs SET status=?,attempts=?,available=?,last_error=? WHERE id=?')
        .run(
          retry ? 'queued' : 'failed',
          attempts,
          this.store.now() + (this.operations.retrySeconds[attempts - 1] ?? 256) * 1000,
          e.code ?? 'SYSTEM',
          job.id,
        );
      this.store.trace(
        job.record_id,
        worker,
        'triage',
        retry ? 'retry_scheduled' : 'engineering_review',
        { attempt: attempts },
        {
          errorCode: e.code ?? 'SYSTEM',
          errorClass: transient ? 'transient' : 'system',
          tier: retry ? 0 : 4,
        },
      );
      this.store.exception({
        recordId: job.record_id,
        batchId: job.batch_id,
        code: e.code ?? 'SYSTEM',
        errorClass: transient ? 'transient' : 'system',
        tier: retry ? 0 : 4,
        message: e.message,
        fields: [],
        signature: `pipeline:${e.code ?? 'SYSTEM'}`,
      });
      const unique = new Set(
        this.store
          .exceptions()
          .filter(
            (x) => x.batchId === job.batch_id && x.signature === `pipeline:${e.code ?? 'SYSTEM'}`,
          )
          .map((x) => x.recordId),
      );
      if (
        !retry &&
        (e.code === 'CONTROL_TOTAL_MISMATCH' ||
          unique.size >= this.operations.circuitCount ||
          unique.size / Math.max(batch.counts.source, 1) >= this.operations.circuitFraction)
      ) {
        batch.state = 'on_hold';
        batch.reason = `Circuit breaker: ${e.code ?? 'SYSTEM'}`;
        this.store.putBatch(batch);
        this.store.trace(
          `batch:${batch.id}`,
          worker,
          'triage',
          'circuit_open',
          { signature: e.code, affected: unique.size },
          { batchId: batch.id, tier: 4 },
        );
      }
      this.changed();
      return true;
    } finally {
      if (leaseToken)
        try {
          this.store.release(job.record_id, leaseToken, worker);
        } catch {}
    }
  }
  dashboard() {
    const records = this.store.list(),
      exceptions = this.store.exceptions().filter((e) => e.status === 'open'),
      edits = this.store.db
        .prepare("SELECT DISTINCT record_id FROM trace WHERE json_extract(body,'$.step')='edit'")
        .all() as { record_id: string }[];
    const states: Record<string, number> = {};
    for (const r of records) states[r.state] = (states[r.state] ?? 0) + 1;
    const reconciled = records.filter((r) => r.state === 'reconciled');
    const touched = new Set(edits.map((t) => t.record_id));
    return {
      total: records.length,
      states,
      reconciled: reconciled.length,
      straightThroughRate: reconciled.length
        ? Math.round(
            (100 * reconciled.filter((r) => !touched.has(r.recordId)).length) / reconciled.length,
          )
        : 0,
      openExceptions: exceptions.length,
      agedExceptions: exceptions.filter(
        (e) => this.store.now() - Date.parse(e.createdAt) > 172800000,
      ).length,
      defects: exceptions.filter((e) => e.code === 'RECONCILIATION_MISMATCH').length,
      batches: this.store.batches().length,
    };
  }
}

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type Actor,
  type Batch,
  type Data,
  type Envelope,
  type Pack,
  type State,
  type Role,
  get,
  normalisePath,
  same,
  PlatformError,
} from '../core/model';
import { evaluate, transition, validationStates } from '../core/engine';
import { ingestRow, leafValues, merge, transform, assertEditableData } from '../core/mapping';
import { validateProposal } from '../core/proposals';
import { Store, type StoredOutput } from '../adapters/store';
import { hash } from '../adapters/config';
import { renderBundle } from '../adapters/renderers';
import {
  type CbsAdapter,
  CbsRejection,
  SimulatedCbs,
  asText,
  batchLoadFiles,
} from '../adapters/cbs';
import { type CsvPackage, csvPackageToExtract } from '../adapters/csv-extract';
import { type Holder, type SharedBatch, SharePointAuthority } from '../adapters/sharepoint';

// A pipeline failure with its triage class and the field it points at (section 8.1).
class PipelineError extends PlatformError {
  constructor(
    code: string,
    message: string,
    public errorClass: 'mapping' | 'system',
    public fieldPath?: string,
  ) {
    super(code, message, 409);
  }
}
type ImportInput = {
  name?: string;
  rows: Data[];
  totals: { customerCount: number; accountCount: number };
  fullSnapshot?: boolean;
  checksum?: string;
  sourceFiles?: Record<string, string>;
};

export const worker: Actor = { id: 'pipeline-worker', kind: 'system' };
const pipeline: Holder = { id: worker.id, name: 'MIGTOOL pipeline', kind: 'worker' };
export class MigrationService {
  operations: { retrySeconds: number[]; circuitCount: number; circuitFraction: number };
  private batchContext = new AsyncLocalStorage<ReadonlySet<string>>();
  constructor(
    public store: Store,
    public pack: Pack,
    public changed = () => {},
    public cbs: CbsAdapter = new SimulatedCbs(store),
    // When set, SharePoint is the record authority and the local database a working copy.
    public authority?: SharePointAuthority,
  ) {
    this.operations = pack.operations;
  }
  // Checks a record out of SharePoint and brings the local working copy up to date with it.
  // Returns who holds it if it is in use elsewhere.
  async checkOutRemote(
    id: string,
    holder: Holder,
  ): Promise<{ heldBy: string; since: string } | undefined> {
    if (!this.authority) return undefined;
    const result = await this.authority.checkOut(id, holder);
    if ('heldBy' in result) return result;
    const state = this.store.remote(id),
      local = this.store.exists(id) ? this.store.load(id).record : undefined;
    let published = state?.published_version ?? 0,
      traceSeq = state?.trace_seq ?? 0;
    try {
      if (result.file && (!local || state?.etag !== result.file.eTag)) {
        const remote = JSON.parse(result.file.body) as Envelope;
        // SharePoint changed while this server held unpublished changes: SharePoint wins and the
        // local copy is kept for review, never silently dropped.
        if (!local || local.version <= published || remote.version !== published) {
          const output = await this.sharedOutput(remote);
          if (local && local.version > published)
            this.remoteConflict(local, 'changed_in_sharepoint');
          this.store.transaction(() => {
            this.store.replaceFromRemote(remote, worker, { eTag: result.file!.eTag });
            if (output) this.store.putOutput(id, output);
            this.updateExceptions(remote);
          });
          published = remote.version;
          traceSeq = this.store.traceSeq(id);
        }
      }
      this.store.setRemote(id, {
        etag: result.file?.eTag ?? null,
        token: result.token,
        holder_kind: holder.kind,
        published_version: published,
        trace_seq: traceSeq,
        error: null,
      });
    } catch (error) {
      await this.authority.abandon(id, result.token).catch(() => {});
      throw error;
    }
    return undefined;
  }
  // Ends a check-out: publishes the local copy if it changed, otherwise undoes the check-out.
  // A failed publish leaves the file checked out and the record closed locally; it is retried.
  async finishRemote(
    id: string,
  ): Promise<'none' | 'published' | 'released' | 'pending' | 'conflict'> {
    const state = this.store.remote(id);
    if (!this.authority || !state?.token) return 'none';
    const local = this.store.exists(id) ? this.store.load(id).record : undefined;
    if (!local || local.version <= state.published_version) {
      try {
        await this.authority.abandon(id, state.token);
      } catch (error) {
        // The SharePoint lease expires on its own; the check-out is undone by the next holder.
        this.store.trace(id, worker, 'lease', 'sharepoint_release_failed', {
          code: (error as PlatformError).code,
        });
      }
      this.store.setRemote(id, { token: null, holder_kind: null, pending: 0 });
      return 'released';
    }
    this.store.setRemote(id, { pending: 1 });
    try {
      if (local.delivery) {
        const output = this.output(id);
        await this.authority.putOutput(id, {
          recordVersion: output.record_version,
          key: local.delivery.key,
          digest: output.digest,
          bytes: Buffer.from(output.bytes).toString('base64'),
          expected: output.expected,
        });
      }
      const etag = await this.authority.publish(
        id,
        state.token,
        local,
        state.etag ?? undefined,
        this.store.tracesAfter(id, state.trace_seq),
      );
      this.store.trace(id, worker, 'merge', 'published_to_sharepoint', { version: local.version });
      this.store.setRemote(id, {
        etag,
        token: null,
        holder_kind: null,
        published_version: local.version,
        pending: 0,
        trace_seq: this.store.traceSeq(id),
        error: null,
      });
      this.changed();
      return 'published';
    } catch (error) {
      const code = (error as PlatformError).code ?? 'SYSTEM';
      if (['SHAREPOINT_STALE', 'SHAREPOINT_LEASE_LOST'].includes(code)) {
        this.remoteConflict(local, code);
        // The next check-out takes SharePoint's version.
        this.store.setRemote(id, {
          etag: null,
          token: null,
          holder_kind: null,
          published_version: local.version,
          pending: 0,
          error: code,
        });
        this.changed();
        return 'conflict';
      }
      this.store.setRemote(id, { error: code });
      this.store.trace(id, worker, 'merge', 'sharepoint_publish_retry', { code });
      return 'pending';
    }
  }
  private remoteConflict(local: Envelope, reason: string) {
    this.store.keepConflict(local);
    this.store.trace(
      local.recordId,
      worker,
      'merge',
      'sharepoint_conflict',
      { reason, localVersion: local.version },
      { errorCode: 'SHAREPOINT_CONFLICT', errorClass: 'conflict', tier: 3 },
    );
    this.store.exception({
      recordId: local.recordId,
      batchId: local.batchId,
      code: 'SHAREPOINT_CONFLICT',
      errorClass: 'conflict',
      tier: 3,
      message: `Local changes to version ${local.version} could not be published (${reason}); SharePoint's copy is current and the local copy is kept for review.`,
      fields: [],
      signature: 'remote:conflict',
    });
  }
  // Runs worker writes inside a SharePoint check-out of each record.
  async withRemote<T>(ids: string[], fn: () => T | Promise<T>): Promise<T> {
    const taken: string[] = [];
    try {
      for (const id of ids) {
        const held = await this.checkOutRemote(id, pipeline);
        if (held) throw new PlatformError('LEASE_HELD', `${id} is in use by ${held.heldBy}`, 409);
        taken.push(id);
      }
      return await fn();
    } finally {
      for (const id of taken) await this.finishRemote(id);
    }
  }
  // Publishes records changed locally outside a check-out (bulk ingest): each is checked out
  // just before publishing, and SharePoint wins if it changed in the meantime.
  async publishLocalChanges(ids: string[]) {
    for (const id of ids) {
      if (this.store.remote(id)?.token) continue;
      const held = await this.checkOutRemote(id, pipeline);
      if (held) {
        // Someone has it checked out: publish after they release it. If they change it first,
        // the next check-out keeps this copy for review instead.
        this.store.setRemote(id, { pending: 1, error: `HELD:${held.heldBy}` });
        continue;
      }
      await this.finishRemote(id);
    }
  }
  // Retries publishes that failed or waited, from the worker loop.
  async publishPending() {
    if (this.authority)
      for (const batch of this.store.batches())
        if (!this.store.remote(`batch:${batch.id}`))
          this.store.setRemote(`batch:${batch.id}`, { pending: 1 });
    for (const id of this.store.pendingRemote())
      if (id.startsWith('batch:')) {
        if (this.store.remote(id)?.token) await this.finishBatchRemote(id.slice(6));
        else await this.withBatch(id.slice(6), () => {});
      } else if (this.store.remote(id)?.token) await this.finishRemote(id);
      else await this.publishLocalChanges([id]);
  }
  private async sharedOutput(record: Envelope): Promise<StoredOutput | undefined> {
    if (!this.authority || !record.delivery) return undefined;
    const existing = this.store.output(record.recordId);
    if (existing?.digest === record.delivery.digest) return existing;
    const output = await this.authority.readOutput(record.recordId, record.delivery.digest),
      bytes = Buffer.from(output.bytes, 'base64');
    if (
      output.key !== record.delivery.key ||
      output.digest !== record.delivery.digest ||
      hash(bytes) !== output.digest
    )
      throw new PlatformError('OUTPUT_MISMATCH', 'Shared delivery output failed its checksum', 409);
    return {
      record_version: output.recordVersion,
      bytes,
      digest: output.digest,
      expected: output.expected,
    };
  }
  private async finishBatchRemote(id: string) {
    const key = `batch:${id}`,
      state = this.store.remote(key);
    if (!this.authority || !state?.token) return;
    const batch = this.store.batch(id);
    try {
      let etag = state.etag;
      if ((batch.version ?? 0) > state.published_version) {
        this.store.setRemote(key, { pending: 1 });
        etag = await this.authority.publishBatch(
          id,
          state.token,
          { batch, members: [...this.members(id)].sort() },
          state.etag ?? undefined,
        );
      } else await this.authority.abandonBatch(id, state.token);
      this.store.setRemote(key, {
        etag,
        token: null,
        holder_kind: null,
        published_version: batch.version ?? 0,
        pending: 0,
        error: null,
      });
    } catch (error) {
      const code = (error as PlatformError).code ?? 'SYSTEM';
      this.store.setRemote(key, {
        pending: 1,
        error: code,
        ...(['SHAREPOINT_STALE', 'SHAREPOINT_LEASE_LOST'].includes(code)
          ? { token: null, holder_kind: null }
          : {}),
      });
      throw error;
    }
  }
  // Batch commands share a checkout too, so pause, release and settlement cannot overwrite
  // another server's decision. Async context limits re-entry to the operation holding it.
  async withBatch<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
    if (!this.authority || this.batchContext.getStore()?.has(id)) return fn();
    const key = `batch:${id}`;
    let previous = this.store.remote(key);
    if (previous?.pending && previous.token) {
      try {
        await this.finishBatchRemote(id);
      } catch (error) {
        if (
          !(
            error instanceof PlatformError &&
            ['SHAREPOINT_STALE', 'SHAREPOINT_LEASE_LOST'].includes(error.code)
          )
        )
          throw error;
      }
      previous = this.store.remote(key);
    }
    const checkedOut = await this.authority.checkOutBatch(id);
    if ('heldBy' in checkedOut)
      throw new PlatformError('LEASE_HELD', `Batch is in use by ${checkedOut.heldBy}`, 409);
    try {
      if (checkedOut.file) {
        const value = JSON.parse(checkedOut.file.body) as SharedBatch;
        if (value.batch.id !== id)
          throw new PlatformError('BATCH_INVALID', 'Shared batch ID differs');
        if (previous?.pending && !previous.token) {
          const local = { batch: this.store.batch(id), members: [...this.members(id)].sort() };
          if ((value.batch.version ?? 0) !== previous.published_version && !same(value, local)) {
            this.store.trace(
              key,
              worker,
              'admin',
              'shared_batch_conflict',
              { local, shared: value },
              { batchId: id, errorCode: 'SHAREPOINT_STALE' },
            );
            this.store.replaceBatch(value.batch, value.members);
            this.store.setRemote(key, {
              pending: 0,
              token: null,
              holder_kind: null,
              error: 'SHAREPOINT_STALE',
              published_version: value.batch.version ?? 0,
            });
            throw new PlatformError(
              'SHAREPOINT_STALE',
              'Shared batch changed before publication',
              409,
            );
          }
        } else this.store.replaceBatch(value.batch, value.members);
      }
      const batch = this.store.batch(id);
      if (!checkedOut.file && !batch.version) this.store.putBatch(batch);
      this.store.setRemote(key, {
        token: checkedOut.token,
        etag: checkedOut.file?.eTag ?? null,
        holder_kind: 'worker',
        published_version: previous?.pending
          ? previous.published_version
          : checkedOut.file
            ? ((JSON.parse(checkedOut.file.body) as SharedBatch).batch.version ?? 0)
            : 0,
      });
      return await this.batchContext.run(
        new Set([...(this.batchContext.getStore() ?? []), id]),
        async () => {
          try {
            await this.syncFromSharePoint();
            return await fn();
          } finally {
            await this.finishBatchRemote(batch.id);
          }
        },
      );
    } catch (error) {
      if (!this.store.remote(key)?.pending) {
        await this.authority.abandonBatch(id, checkedOut.token).catch(() => {});
        this.store.setRemote(key, { token: null, holder_kind: null });
      }
      throw error;
    }
  }
  // Brings local copies up to date with SharePoint for records nobody has checked out.
  async syncFromSharePoint(): Promise<number> {
    if (!this.authority) return 0;
    const { files, leased, batches } = await this.authority.snapshot();
    let pulled = 0,
      batchChanged = false;
    for (const file of files) {
      const id = file.recordId,
        state = this.store.remote(id);
      if (leased.has(id) || state?.token || state?.pending || state?.etag === file.eTag) continue;
      if (this.store.leaseStatus(id)) continue;
      const local = this.store.exists(id) ? this.store.load(id).record : undefined;
      if (local && state && local.version > state.published_version) continue;
      const remote = JSON.parse(await this.authority.read(file.id)) as Envelope;
      const output = await this.sharedOutput(remote);
      this.store.transaction(() => {
        this.store.replaceFromRemote(remote, worker, { eTag: file.eTag });
        if (output) this.store.putOutput(id, output);
        this.store.setRemote(id, {
          etag: file.eTag,
          published_version: remote.version,
          trace_seq: this.store.traceSeq(id),
        });
        this.updateExceptions(remote);
      });
      pulled++;
    }
    for (const file of batches) {
      const key = `batch:${file.batchId}`,
        state = this.store.remote(key);
      if (leased.has(key) || state?.token || state?.pending || state?.etag === file.eTag) continue;
      const value = JSON.parse(await this.authority.read(file.id)) as SharedBatch;
      if (value.batch.id !== file.batchId)
        throw new PlatformError('BATCH_INVALID', 'Shared batch ID differs');
      this.store.transaction(() => {
        this.store.replaceBatch(value.batch, value.members);
        this.store.setRemote(key, {
          etag: file.eTag,
          published_version: value.batch.version ?? 0,
          error: null,
        });
      });
      batchChanged = true;
    }
    if (pulled || batchChanged) this.changed();
    return pulled;
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
        // Data failures with an approved automatic fix sit at tier 1; with LLM steering disabled,
        // everything else is for an operator (tier 3).
        tier: failure.class !== 'gap' && this.playbookEntry('validate', failure.id) ? 1 : 3,
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
  playbookEntry(step: string, code: string) {
    return this.pack.playbook.entries.find(
      (e) => e.autoApply && e.match.step === step && e.match.errorCode === code,
    );
  }
  // WF-01 for a CSV extract package. A file-level fault stops the batch and escalates to tier 4.
  async ingestCsv(
    files: CsvPackage,
    options: { name?: string; fullSnapshot?: boolean },
    actor: Actor,
  ): Promise<Batch> {
    let extract;
    try {
      extract = csvPackageToExtract(this.pack, files, options.name);
    } catch (error) {
      if (error instanceof PlatformError) {
        const id = `file:${randomUUID()}`;
        this.store.trace(
          id,
          actor,
          'ingest',
          'file_rejected',
          { files: Object.keys(files), message: error.message },
          { errorCode: error.code, errorClass: 'system', tier: 4 },
        );
        this.store.exception({
          recordId: id,
          batchId: '',
          code: error.code,
          errorClass: 'system',
          tier: 4,
          message: error.message,
          fields: [],
          signature: `ingest:${error.code}`,
        });
        this.changed();
      }
      throw error;
    }
    return this.ingest({ ...extract, fullSnapshot: options.fullSnapshot }, actor);
  }
  async ingest(input: ImportInput, actor: Actor): Promise<Batch> {
    const runId = randomUUID();
    this.store.db
      .prepare("INSERT INTO ingest_runs VALUES(?,?,?,'queued')")
      .run(runId, JSON.stringify(input), JSON.stringify(actor));
    return this.importWithRemote(runId, input, actor);
  }
  // With SharePoint: refresh local copies first, skip records someone has checked out, import
  // locally in one transaction, then publish every record the import changed.
  private async importWithRemote(runId: string, input: ImportInput, actor: Actor) {
    if (!this.authority) return this.executeImport(runId, input, actor);
    await this.syncFromSharePoint();
    const { leased } = await this.authority.snapshot();
    const before = new Map(this.store.list().map((r) => [r.recordId, r.version]));
    const batch = this.executeImport(runId, input, actor, leased);
    await this.publishLocalChanges(
      this.store
        .list()
        .filter((r) => r.version !== before.get(r.recordId))
        .map((r) => r.recordId),
    );
    await this.withBatch(batch.id, () => {});
    return batch;
  }
  private executeImport(
    runId: string,
    input: ImportInput,
    actor: Actor,
    held?: Set<string>,
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
        const versions = new Map(this.store.list().map((r) => [r.recordId, r.version]));
        const result = this.ingestSync(input, actor, runId, held);
        if (this.authority) {
          for (const record of this.store.list())
            if (record.version !== versions.get(record.recordId))
              this.store.setRemote(record.recordId, { pending: 1 });
          this.store.setRemote(`batch:${result.id}`, { pending: 1 });
        }
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
  private ingestSync(input: ImportInput, actor: Actor, batchId: string, held?: Set<string>): Batch {
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
    const committed: string[] = [];
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
        if (held?.has(key))
          throw new PlatformError(
            'LEASE_HELD',
            'Record is checked out in SharePoint; re-import this row when it is released',
            409,
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
          committed.push(id);
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
          // The customer is in this extract, so an earlier missing-from-snapshot flag is cleared.
          result.record.missingFromRefresh = false;
          const states: State[] = [];
          if (
            !['amendment_pending', 'exported', 'loaded', 'reconciled'].includes(result.record.state)
          )
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
          committed.push(id);
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
    for (const id of committed) this.autoTriage(id);
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
      { counts: batch.counts, inputHash: digest, sourceFiles: input.sourceFiles },
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
  // Tier 1 (WF-05 step 4): apply an approved playbook fix. One application per entry and record;
  // a repeat of the same error escalates instead of looping.
  applyPlaybook(id: string, code: string, actor: Actor, step: 'validate' | 'load' = 'validate') {
    const entry = this.playbookEntry(step, code);
    if (!entry)
      throw new PlatformError('PLAYBOOK_UNAVAILABLE', 'No approved automatic fix for this error');
    const { record, etag } = this.store.load(id);
    if (
      step === 'load' &&
      this.store
        .traces({ recordId: id })
        .some(
          (t) => t.step === 'fix' && t.decision === 'playbook_used' && t.detail?.entry === entry.id,
        )
    )
      throw new PlatformError('PLAYBOOK_EXHAUSTED', `Playbook ${entry.id} was already applied`);
    // A CBS code names no rule, so the fix is checked against the rule that owns the field.
    const rule =
      step === 'validate'
        ? code
        : this.pack.rules.rules.find((r) => r.fields.includes(normalisePath(entry.path)))?.id;
    if (!rule) throw new PlatformError('REVIEW_REQUIRED', `No rule covers ${entry.path}`);
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
    const result = validateProposal(this.pack, record.data, proposal, rule, { source: 'playbook' });
    if (!result.apply) throw new PlatformError('REVIEW_REQUIRED', result.reason);
    if (same(result.data, record.data))
      throw new PlatformError('PLAYBOOK_NO_CHANGE', `Playbook ${entry.id} changes nothing`);
    const lease = this.store.acquire(id, worker, true);
    if (!('leaseToken' in lease)) throw new PlatformError('LEASE_HELD', 'Record is in use', 409);
    try {
      record.data = result.data;
      record.provenance[entry.path] = {
        source: 'playbook',
        actor: entry.id,
        at: this.store.timestamp(),
        traceEventId: randomUUID(),
      };
      const states = this.validated(record);
      const saved = this.store.save(
        record,
        { ifMatch: etag, leaseToken: lease.leaseToken },
        worker,
        'fix',
        'auto_applied',
        states,
      );
      this.store.trace(
        id,
        actor,
        'fix',
        'playbook_used',
        { entry: entry.id, errorCode: code, path: entry.path },
        { tier: 1 },
      );
      this.updateExceptions(saved.record);
      return saved.record;
    } finally {
      this.store.release(id, lease.leaseToken, worker);
    }
  }
  // After a committed write, apply any approved validate-step fixes for failing data rules.
  autoTriage(id: string) {
    const record = this.store.load(id).record;
    if (!['blocked', 'needs_input'].includes(record.state)) return;
    for (const rule of evaluate(this.pack, record.data).rules.filter(
      (r) => !r.passed && r.class !== 'gap' && this.playbookEntry('validate', r.id),
    ))
      try {
        this.applyPlaybook(id, rule.id, worker);
      } catch (error) {
        if (!(error instanceof PlatformError)) throw error;
        this.store.trace(
          id,
          worker,
          'triage',
          'routed_to_ops',
          { rule: rule.id, reason: error.code },
          { errorCode: rule.id, errorClass: 'data', tier: 3 },
        );
      }
  }
  async releaseBatch(id: string, actor: Actor) {
    return this.withBatch(id, () => this.releaseBatchLocal(id, actor));
  }
  private releaseBatchLocal(id: string, actor: Actor) {
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
    if (pending) {
      batch.state = 'running';
      // The circuit breaker counts failures within this run only (section 8.4).
      if (queued) batch.runStartedAt = this.store.timestamp();
    }
    this.store.putBatch(batch);
    this.store.trace(`batch:${id}`, actor, 'admin', 'released', { queued }, { batchId: id });
    this.changed();
    return { queued };
  }
  async batchAction(id: string, action: 'pause' | 'resume', reason: string, actor: Actor) {
    return this.withBatch(id, () => this.batchActionLocal(id, action, reason, actor));
  }
  private batchActionLocal(id: string, action: 'pause' | 'resume', reason: string, actor: Actor) {
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
        await this.importWithRemote(
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
    try {
      return await this.withBatch(job.batch_id, async () => {
        const batch = this.store.batch(job.batch_id);
        if (batch.state === 'on_hold') {
          this.store.db
            .prepare("UPDATE jobs SET status='queued',available=? WHERE id=?")
            .run(this.store.now() + 1000, job.id);
          return false;
        }
        if (!this.authority) return this.runJob(job, batch);
        const held = await this.checkOutRemote(job.record_id, pipeline);
        if (held) {
          this.store.db
            .prepare("UPDATE jobs SET status='queued',available=? WHERE id=?")
            .run(this.store.now() + 1000, job.id);
          return false;
        }
        try {
          return await this.runJob(job, batch);
        } finally {
          await this.finishRemote(job.record_id);
        }
      });
    } catch (error) {
      this.store.db
        .prepare("UPDATE jobs SET status='queued',available=? WHERE id=? AND status='running'")
        .run(this.store.now() + 1000, job.id);
      if (error instanceof PlatformError && error.code === 'LEASE_HELD') return false;
      throw error;
    }
  }
  private async runJob(job: any, batch: Batch): Promise<boolean> {
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
        this.store.transaction(() => {
          this.store.putOutput(record.recordId, {
            record_version: record.version,
            bytes: output.bytes,
            digest: output.digest,
            expected: JSON.stringify(output.expected),
          });
          record.delivery = { key: `${record.recordId}:${output.digest}`, digest: output.digest };
          save('export', 'exported', 'bundle_created');
        });
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
        const output = this.output(record.recordId);
        const expected = JSON.parse(output.expected);
        if (
          expected['Customer_Create.csv']?.length !== 1 ||
          expected['Account_Register.csv']?.length !== (record.data.accounts?.length ?? 0)
        )
          throw new PipelineError(
            'CONTROL_TOTAL_MISMATCH',
            'Export totals differ from the record',
            'system',
          );
        await this.cbs.deliver(
          record.delivery?.key ?? `${record.recordId}:${output.digest}`,
          record.recordId,
          expected,
          this.store.timestamp(),
        );
        save('load', 'loaded', 'cbs_accepted');
      }
      if (record.state === 'loaded') {
        const output = this.output(record.recordId);
        const receipt = await this.cbs.readback(
          record.delivery?.key ?? `${record.recordId}:${output.digest}`,
        );
        if (!receipt)
          throw new PipelineError('RECONCILIATION_MISMATCH', 'CBS holds no load', 'system');
        const difference = this.firstDifference(JSON.parse(output.expected), receipt);
        if (difference)
          throw new PipelineError(
            'RECONCILIATION_MISMATCH',
            `CBS readback differs at ${difference.label}`,
            'mapping',
            difference.path,
          );
        for (const [path, value] of Object.entries(record.baseline))
          if (record.provenance[path]?.source === 'extract' && !same(get(record.data, path), value))
            throw new PipelineError(
              'BASELINE_DRIFT',
              `Extract baseline drift at ${path}`,
              'mapping',
              path,
            );
        save('reconcile', 'reconciled', 'readback_matched');
      }
      this.store.db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(job.id);
      // A step that has now succeeded no longer needs anyone's attention.
      for (const e of this.store
        .exceptions()
        .filter(
          (e) =>
            e.recordId === job.record_id &&
            e.status === 'open' &&
            e.signature.startsWith('pipeline:'),
        ))
        this.store.updateException({ ...e, status: 'resolved' });
      await this.settleBatch(job.batch_id);
      this.changed();
      return true;
    } catch (error) {
      const e = error as PlatformError,
        code = e.code ?? 'SYSTEM',
        attempts = job.attempts + 1,
        transient = ['SQLITE_BUSY', 'TRANSIENT'].includes(code),
        retry = transient && attempts <= this.operations.retrySeconds.length;
      const errorClass = transient
        ? 'transient'
        : error instanceof CbsRejection || error instanceof PipelineError
          ? error.errorClass
          : 'system';
      const fieldPath =
        error instanceof CbsRejection || error instanceof PipelineError
          ? error.fieldPath
          : undefined;
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
        this.store.release(job.record_id, leaseToken, worker);
        leaseToken = undefined;
      }
      // Tier 1 for a CBS rejection: apply the approved playbook fix and send the record round again.
      if (!retry && error instanceof CbsRejection && this.playbookEntry('load', code))
        try {
          const fixed = this.applyPlaybook(job.record_id, code, worker, 'load');
          this.store.db
            .prepare('UPDATE jobs SET status=?,attempts=0,available=?,last_error=? WHERE id=?')
            .run(fixed.state === 'cbs_ready' ? 'queued' : 'failed', this.store.now(), code, job.id);
          this.store.trace(
            job.record_id,
            worker,
            'triage',
            fixed.state === 'cbs_ready' ? 'auto_applied' : 'routed_to_ops',
            { attempt: attempts },
            { batchId: job.batch_id, errorCode: code, errorClass, tier: 1 },
          );
          await this.settleBatch(job.batch_id);
          this.changed();
          return true;
        } catch (fixError) {
          if (!(fixError instanceof PlatformError)) throw fixError;
        }
      // Data faults go to an operator (LLM steering is disabled); mapping and system faults to
      // engineering.
      const tier = retry ? 0 : errorClass === 'data' ? 3 : 4;
      this.store.db
        .prepare('UPDATE jobs SET status=?,attempts=?,available=?,last_error=? WHERE id=?')
        .run(
          retry ? 'queued' : 'failed',
          attempts,
          this.store.now() + (this.operations.retrySeconds[attempts - 1] ?? 256) * 1000,
          code,
          job.id,
        );
      this.store.trace(
        job.record_id,
        worker,
        'triage',
        retry ? 'retry_scheduled' : tier === 3 ? 'routed_to_ops' : 'engineering_review',
        { attempt: attempts, message: e.message },
        { batchId: job.batch_id, errorCode: code, errorClass, tier },
      );
      this.store.exception({
        recordId: job.record_id,
        batchId: job.batch_id,
        code,
        errorClass,
        tier,
        message: e.message,
        fields: fieldPath ? [fieldPath] : [],
        signature: `pipeline:${code}`,
      });
      if (!retry) this.checkCircuit(this.store.batch(job.batch_id), code);
      await this.settleBatch(job.batch_id);
      this.changed();
      return true;
    } finally {
      if (leaseToken)
        try {
          this.store.release(job.record_id, leaseToken, worker);
        } catch {}
    }
  }
  private output(recordId: string) {
    const output = this.store.output(recordId);
    if (!output) throw new PipelineError('OUTPUT_MISSING', 'Exported output not found', 'system');
    const digest = this.store.load(recordId).record.delivery?.digest;
    if (digest && digest !== output.digest)
      throw new PipelineError(
        'OUTPUT_MISMATCH',
        'Delivery output differs from the record',
        'system',
      );
    return output;
  }
  // Locates the first loaded value that differs and maps its column back to the record field.
  private firstDifference(expected: Data, receipt: Data) {
    const want = asText(expected),
      got = asText(receipt);
    for (const file of new Set([...Object.keys(want), ...Object.keys(got)])) {
      const mapping = this.pack.mappings.find((m) => m.output === file);
      const a = want[file] ?? [],
        b = got[file] ?? [];
      if (!Array.isArray(a) || !Array.isArray(b))
        return { label: `${file} format`, path: undefined };
      if (a.length !== b.length)
        return { label: `${file} row count`, path: mapping?.row_source ?? undefined };
      for (let row = 0; row < a.length; row++)
        for (const column of new Set([...Object.keys(a[row]), ...Object.keys(b[row])]))
          if (a[row][column] !== b[row][column]) {
            const from = mapping?.columns.find((c) => c.name === column)?.from;
            return {
              label: `${file} row ${row + 1} column ${column}`,
              path:
                !from || from === '$record.recordId'
                  ? undefined
                  : mapping?.row_source
                    ? `${mapping.row_source}[${row}].${from}`
                    : from,
            };
          }
    }
    return undefined;
  }
  // Same signature across many records in one batch run means a mapping or rule fault (8.4).
  private checkCircuit(batch: Batch, code: string) {
    if (batch.state === 'on_hold') return;
    const affected = (
      this.store.db
        .prepare(
          "SELECT COUNT(DISTINCT record_id) AS n FROM trace WHERE batch_id=? AND json_extract(body,'$.step')='triage' AND json_extract(body,'$.errorCode')=? AND json_extract(body,'$.decision') IN ('engineering_review','routed_to_ops') AND json_extract(body,'$.at')>=?",
        )
        .get(batch.id, code, batch.runStartedAt ?? '') as any
    ).n as number;
    if (
      code === 'CONTROL_TOTAL_MISMATCH' ||
      affected >= this.operations.circuitCount ||
      affected / Math.max(batch.counts.source, 1) >= this.operations.circuitFraction
    ) {
      const examples = this.store
        .traces({ batchId: batch.id, errorCode: code })
        .slice(0, 3)
        .map((t) => t.eventId);
      batch.state = 'on_hold';
      batch.reason = `Circuit breaker: ${code}`;
      this.store.putBatch(batch);
      this.store.trace(
        `batch:${batch.id}`,
        worker,
        'triage',
        'circuit_open',
        { signature: code, affected, examples },
        { batchId: batch.id, errorCode: code, errorClass: 'system', tier: 4 },
      );
    }
  }
  // Recomputes batch status whenever a job finishes, successfully or not. A finished batch also
  // checks CBS counts against the export totals (WF-04 step 4).
  async settleBatch(batchId: string) {
    return this.withBatch(batchId, () => this.settleBatchLocal(batchId));
  }
  private async settleBatchLocal(batchId: string) {
    const pending = this.store.db
      .prepare("SELECT 1 FROM jobs WHERE batch_id=? AND status IN ('queued','running') LIMIT 1")
      .get(batchId);
    const batch = this.store.batch(batchId);
    if (pending || batch.state === 'on_hold') return;
    const members = this.store.list().filter((r) => this.members(batchId).has(r.recordId));
    const allDone =
      batch.counts.rejected === 0 &&
      members.length === this.members(batchId).size &&
      members.every((r) => ['reconciled', 'withdrawn'].includes(r.state));
    batch.state = 'ready';
    if (allDone) {
      const totals = { export: { customers: 0, accounts: 0 }, cbs: { customers: 0, accounts: 0 } };
      for (const record of members.filter((r) => r.state === 'reconciled')) {
        const output = this.output(record.recordId);
        const expected = JSON.parse(output.expected),
          receipt = await this.cbs.readback(
            record.delivery?.key ?? `${record.recordId}:${output.digest}`,
          );
        totals.export.customers += expected['Customer_Create.csv']?.length ?? 0;
        totals.export.accounts += expected['Account_Register.csv']?.length ?? 0;
        totals.cbs.customers += receipt?.['Customer_Create.csv']?.length ?? 0;
        totals.cbs.accounts += receipt?.['Account_Register.csv']?.length ?? 0;
      }
      if (same(totals.export, totals.cbs)) batch.state = 'completed';
      else {
        batch.state = 'on_hold';
        batch.reason = 'CONTROL_TOTAL_MISMATCH';
        this.store.trace(
          `batch:${batchId}`,
          worker,
          'reconcile',
          'control_totals_rejected',
          totals,
          { batchId, errorCode: 'CONTROL_TOTAL_MISMATCH', errorClass: 'system', tier: 4 },
        );
      }
    }
    this.store.putBatch(batch);
  }
  members(batchId: string) {
    return new Set(
      (
        this.store.db
          .prepare('SELECT record_id FROM batch_records WHERE batch_id=?')
          .all(batchId) as any[]
      ).map((r) => r.record_id as string),
    );
  }
  private latestJob(recordId: string) {
    return this.store.db
      .prepare('SELECT id,batch_id FROM jobs WHERE record_id=? ORDER BY rowid DESC LIMIT 1')
      .get(recordId) as { id: string; batch_id: string } | undefined;
  }
  requeue(recordId: string) {
    const job = this.latestJob(recordId);
    if (job)
      this.store.db
        .prepare("UPDATE jobs SET status='queued',attempts=0,available=? WHERE id=?")
        .run(this.store.now(), job.id);
  }
  // WF-08: a reviewer approves or rejects a pending amendment.
  async decideAmendment(
    id: string,
    decision: 'approve' | 'reject',
    leaseToken: string,
    actor: Actor,
  ) {
    return this.withBatch(this.store.load(id).record.batchId, () =>
      this.decideAmendmentLocal(id, decision, leaseToken, actor),
    );
  }
  private async decideAmendmentLocal(
    id: string,
    decision: 'approve' | 'reject',
    leaseToken: string,
    actor: Actor,
  ) {
    const loaded = this.store.load(id);
    this.store.ownsLease(id, leaseToken, actor);
    if (loaded.record.state !== 'amendment_pending' || !loaded.record.pendingData)
      throw new PlatformError('NO_AMENDMENT', 'No amendment is pending');
    if (loaded.record.conflicts.length)
      throw new PlatformError(
        'REVIEW_REQUIRED',
        'Resolve amendment conflicts through a reviewed mapping change before approval',
      );
    const record = loaded.record,
      from = record.amendmentFrom ?? 'reconciled';
    let approvedOutput: Awaited<ReturnType<typeof renderBundle>> | undefined;
    if (decision === 'approve') {
      const next = { ...record, data: record.pendingData! };
      if (!evaluate(this.pack, next.data).gates.cbs.open)
        throw new PlatformError('GATE_CLOSED', 'Amended data must pass both gates');
      const bundle = await renderBundle(this.pack, next),
        key = `amendment:${id}:${bundle.digest}`;
      await this.cbs.deliver(key, id, bundle.expected, this.store.timestamp());
      const receipt = await this.cbs.readback(key);
      if (!receipt || this.firstDifference(bundle.expected, receipt))
        throw new PlatformError('RECONCILIATION_MISMATCH', 'Amendment readback mismatch');
      record.data = record.pendingData!;
      record.baseline = record.pendingBaseline ?? record.baseline;
      record.provenance = record.pendingProvenance ?? record.provenance;
      record.state = 'reconciled';
      record.delivery = { key, digest: bundle.digest };
      approvedOutput = bundle;
    } else record.state = from;
    delete record.pendingData;
    delete record.pendingBaseline;
    delete record.pendingProvenance;
    delete record.amendmentFrom;
    this.store.transaction(() => {
      this.store.save(
        record,
        { ifMatch: loaded.etag, leaseToken },
        actor,
        'reconcile',
        `amendment_${decision}`,
      );
      if (approvedOutput) {
        const previous = this.store.output(id);
        if (previous)
          this.store.db
            .prepare('INSERT INTO amendment_outputs VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
            .run(`${id}:${previous.digest}`, id, previous.bytes, previous.digest);
        this.store.db
          .prepare('INSERT INTO amendment_outputs VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
          .run(`${id}:${approvedOutput.digest}`, id, approvedOutput.bytes, approvedOutput.digest);
        this.store.putOutput(id, {
          record_version: record.version,
          bytes: approvedOutput.bytes,
          digest: approvedOutput.digest,
          expected: JSON.stringify(approvedOutput.expected),
        });
      }
    });
    // A rejected amendment on an unfinished delivery resumes that delivery.
    if (decision === 'reject' && from !== 'reconciled') this.requeue(id);
    this.store.release(id, leaseToken, actor);
    const job = this.latestJob(id);
    if (job) await this.settleBatch(job.batch_id);
    this.changed();
  }
  // A reviewer's scope decision on a customer missing from a full snapshot.
  decideScope(
    id: string,
    decision: 'keep' | 'withdraw',
    reason: string,
    leaseToken: string,
    actor: Actor,
  ) {
    const loaded = this.store.load(id);
    this.store.ownsLease(id, leaseToken, actor);
    if (
      ['loaded', 'reconciled', 'exported', 'amendment_pending'].includes(loaded.record.state) &&
      decision === 'withdraw'
    )
      throw new PlatformError(
        'FROZEN_RECORD',
        'Loaded records require a bank-approved reversal workflow',
        409,
      );
    loaded.record.missingFromRefresh = false;
    if (decision === 'withdraw') loaded.record.state = 'withdrawn';
    const saved = this.store.save(
      loaded.record,
      { ifMatch: loaded.etag, leaseToken },
      actor,
      'admin',
      `scope_${decision}`,
    );
    this.store.trace(id, actor, 'admin', 'scope_review', { reason });
    // Withdrawn customers need no further work. Kept customers only lose the scope exception;
    // their validation failures stay in the queue.
    if (decision === 'withdraw') this.store.resolve(id);
    else this.updateExceptions(saved.record);
    this.store.release(id, leaseToken, actor);
    this.changed();
  }
  // Combined Bank 2 CBS load files for every delivered record in a batch.
  exportBatch(batchId: string) {
    this.store.batch(batchId);
    const members = this.members(batchId);
    const deliveries = this.store
      .list()
      .filter((r) => members.has(r.recordId) && ['loaded', 'reconciled'].includes(r.state))
      .map((r) => {
        const output = this.output(r.recordId);
        return { recordId: r.recordId, expected: JSON.parse(output.expected) };
      });
    if (!deliveries.length)
      throw new PlatformError(
        'NOTHING_DELIVERED',
        'No records in this batch have been loaded',
        404,
      );
    return batchLoadFiles(this.pack, deliveries);
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
      defects: exceptions.filter((e) =>
        ['RECONCILIATION_MISMATCH', 'BASELINE_DRIFT'].includes(e.code),
      ).length,
      batches: this.store.batches().length,
    };
  }
}

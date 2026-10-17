import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type Actor,
  type Batch,
  type Data,
  type Envelope,
  type Exception,
  type Lease,
  type Pack,
  type Role,
  type State,
  type Trace,
  PlatformError,
} from '../core/model';
import { hash } from './config';
import { transition } from '../core/engine';

type User = { id: string; username: string; role: Role; disabled: boolean };
export class Store {
  db: DatabaseSync;
  private transactionDepth = 0;
  constructor(
    path: string,
    public pack: Pack,
    public now = () => Date.now(),
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, body TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (record_id TEXT PRIMARY KEY, holder TEXT NOT NULL, token TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, acquired INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS trace (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, record_id TEXT NOT NULL, batch_id TEXT, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trace_record ON trace(record_id,seq);
      CREATE TRIGGER IF NOT EXISTS trace_no_update BEFORE UPDATE ON trace BEGIN SELECT RAISE(ABORT,'Trace is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trace_no_delete BEFORE DELETE ON trace BEGIN SELECT RAISE(ABORT,'Trace is append-only'); END;
      CREATE TABLE IF NOT EXISTS ingest_runs (id TEXT PRIMARY KEY,input TEXT NOT NULL,actor TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batch_records (batch_id TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(batch_id,record_id));
      CREATE TABLE IF NOT EXISTS exceptions (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, signature TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, batch_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL, last_error TEXT);
      CREATE TABLE IF NOT EXISTS outputs (record_id TEXT PRIMARY KEY, record_version INTEGER NOT NULL, bytes BLOB NOT NULL, digest TEXT NOT NULL, expected TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS amendment_outputs (id TEXT PRIMARY KEY,record_id TEXT NOT NULL,bytes BLOB NOT NULL,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cbs_receipts (idempotency_key TEXT PRIMARY KEY, record_id TEXT NOT NULL, expected TEXT NOT NULL, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
  }
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.transactionDepth--;
    }
  }
  timestamp() {
    return new Date(this.now()).toISOString();
  }
  trace(
    recordId: string,
    actor: Actor,
    step: string,
    decision: string,
    detail: Data = {},
    extra: Partial<Trace> = {},
  ): Trace {
    const row = this.db.prepare('SELECT body FROM records WHERE id=?').get(recordId) as any;
    const record: Envelope | undefined = row ? JSON.parse(row.body) : undefined;
    const event: Trace = {
      eventId: randomUUID(),
      traceId: `trace:${recordId}`,
      recordId,
      batchId: record?.batchId,
      step,
      recordVersion: record?.version ?? 0,
      configVersion: this.pack.version,
      actor,
      decision,
      detail,
      at: this.timestamp(),
      ...extra,
    };
    this.db
      .prepare('INSERT INTO trace(id,record_id,batch_id,body) VALUES(?,?,?,?)')
      .run(event.eventId, recordId, event.batchId ?? null, JSON.stringify(event));
    return event;
  }
  traces(
    filter: {
      recordId?: string;
      batchId?: string;
      actor?: string;
      errorCode?: string;
      traceId?: string;
    } = {},
  ): Trace[] {
    let sql = 'SELECT body FROM trace',
      args: string[] = [];
    if (filter.recordId) {
      sql += ' WHERE record_id=?';
      args = [filter.recordId];
    } else if (filter.batchId) {
      sql += ' WHERE batch_id=?';
      args = [filter.batchId];
    }
    return (this.db.prepare(sql + ' ORDER BY seq DESC LIMIT 5000').all(...args) as any[])
      .map((v) => JSON.parse(v.body))
      .filter(
        (v: Trace) =>
          (!filter.actor || v.actor.id === filter.actor) &&
          (!filter.errorCode || v.errorCode === filter.errorCode) &&
          (!filter.traceId || v.traceId === filter.traceId),
      );
  }
  list(): Envelope[] {
    return (this.db.prepare('SELECT body FROM records ORDER BY id').all() as any[]).map((r) =>
      JSON.parse(r.body),
    );
  }
  exists(id: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM records WHERE id=?').get(id));
  }
  load(id: string): { record: Envelope; etag: string } {
    const row = this.db.prepare('SELECT body,version FROM records WHERE id=?').get(id) as any;
    if (!row) throw new PlatformError('NOT_FOUND', 'Record not found', 404);
    return { record: JSON.parse(row.body), etag: String(row.version) };
  }
  private activeLease(id: string): any {
    const lease = this.db.prepare('SELECT * FROM leases WHERE record_id=?').get(id) as any;
    if (lease && lease.expires <= this.now()) {
      this.db.prepare('DELETE FROM leases WHERE record_id=?').run(id);
      this.trace(id, { id: 'lease-service', kind: 'system' }, 'lease', 'expired', {
        holder: lease.holder,
      });
      return undefined;
    }
    return lease;
  }
  private requireLease(id: string, token: string) {
    const lease = this.activeLease(id);
    if (!lease || lease.token !== token)
      throw new PlatformError('LEASE_INVALID', 'A current edit lease is required', 409);
    return lease;
  }
  private leaseShape(row: any): Lease {
    return {
      recordId: row.record_id,
      holder: row.holder,
      holderKind: row.kind,
      leaseToken: row.token,
      acquiredAt: new Date(row.acquired).toISOString(),
      expiresAt: new Date(row.expires).toISOString(),
    };
  }
  acquire(id: string, actor: Actor, worker = false): Lease | { heldBy: string; since: string } {
    return this.transaction(() => {
      const held = this.activeLease(id);
      if (held) return { heldBy: held.holder, since: new Date(held.acquired).toISOString() };
      const row = {
        record_id: id,
        holder: actor.id,
        kind: worker ? 'worker' : 'human',
        token: randomUUID(),
        acquired: this.now(),
        expires:
          this.now() + (worker ? this.pack.operations.workerLeaseMs : this.pack.operations.leaseMs),
      };
      this.db
        .prepare('INSERT INTO leases VALUES(?,?,?,?,?,?)')
        .run(id, row.holder, row.token, row.kind, row.acquired, row.expires);
      this.trace(id, actor, 'lease', 'acquired', {
        expiresAt: new Date(row.expires).toISOString(),
      });
      return this.leaseShape(row);
    });
  }
  renew(id: string, token: string, actor: Actor): Lease {
    return this.transaction(() => {
      const row = this.requireLease(id, token);
      if (row.holder !== actor.id)
        throw new PlatformError('FORBIDDEN', 'Lease belongs to another user', 403);
      row.expires =
        this.now() +
        (row.kind === 'worker' ? this.pack.operations.workerLeaseMs : this.pack.operations.leaseMs);
      this.db.prepare('UPDATE leases SET expires=? WHERE record_id=?').run(row.expires, id);
      return this.leaseShape(row);
    });
  }
  release(id: string, token: string, actor: Actor): void {
    this.transaction(() => {
      const row = this.requireLease(id, token);
      if (row.holder !== actor.id)
        throw new PlatformError('FORBIDDEN', 'Lease belongs to another user', 403);
      this.db.prepare('DELETE FROM leases WHERE record_id=?').run(id);
      this.trace(id, actor, 'lease', 'released');
    });
  }
  breakLease(id: string, actor: Actor, reason: string): void {
    if (!reason.trim()) throw new PlatformError('REASON_REQUIRED', 'A reason is required');
    this.transaction(() => {
      this.db.prepare('DELETE FROM leases WHERE record_id=?').run(id);
      this.trace(id, actor, 'lease', 'admin_break', { reason });
    });
  }
  leaseStatus(id: string) {
    const row = this.activeLease(id);
    if (!row) return null;
    const { leaseToken: _, ...status } = this.leaseShape(row);
    return status;
  }
  leases() {
    return (this.db.prepare('SELECT record_id FROM leases').all() as any[])
      .map((r) => this.leaseStatus(r.record_id))
      .filter(Boolean);
  }
  ownsLease(id: string, token: string, actor: Actor) {
    const row = this.requireLease(id, token);
    if (row.holder !== actor.id)
      throw new PlatformError('FORBIDDEN', 'Lease belongs to another user', 403);
  }
  create(record: Envelope, token: string, actor: Actor): void {
    this.transaction(() => {
      this.requireLease(record.recordId, token);
      const eventId = randomUUID();
      for (const p of Object.values(record.provenance)) p.traceEventId = eventId;
      this.db
        .prepare('INSERT INTO records VALUES(?,?,?)')
        .run(record.recordId, JSON.stringify(record), record.version);
      this.trace(
        record.recordId,
        actor,
        'ingest',
        'created',
        { sourceRowHash: record.sourceRowHash },
        { eventId },
      );
    });
  }
  save(
    record: Envelope,
    options: { ifMatch: string; leaseToken: string },
    actor: Actor,
    step = 'edit',
    decision = 'saved',
    states: State[] = [],
  ): { etag: string; record: Envelope } {
    return this.transaction(() => {
      this.ownsLease(record.recordId, options.leaseToken, actor);
      const current = this.load(record.recordId);
      if (current.etag !== options.ifMatch)
        throw new PlatformError(
          'STALE_WRITE',
          'This record changed. Reload it before reapplying your draft.',
          409,
        );
      const check = structuredClone(current.record);
      if (states.length) {
        for (const state of states) transition(check, state);
        if (check.state !== record.state)
          throw new PlatformError(
            'ILLEGAL_TRANSITION',
            'Transition history does not match final state',
            409,
          );
      } else if (record.state !== check.state) {
        if (!(step === 'admin' && record.state === 'withdrawn' && actor.kind === 'human'))
          transition(check, record.state);
      }
      const saved = {
          ...structuredClone(record),
          version: current.record.version + 1,
          updatedAt: this.timestamp(),
        },
        eventId = randomUUID();
      for (const [path, p] of Object.entries(saved.provenance))
        if (JSON.stringify(p) !== JSON.stringify(current.record.provenance[path]))
          p.traceEventId = eventId;
      for (const [path, p] of Object.entries(saved.pendingProvenance ?? {}))
        if (JSON.stringify(p) !== JSON.stringify(current.record.pendingProvenance?.[path]))
          p.traceEventId = eventId;
      this.db
        .prepare('UPDATE records SET body=?,version=? WHERE id=? AND version=?')
        .run(JSON.stringify(saved), saved.version, saved.recordId, current.record.version);
      this.trace(
        saved.recordId,
        actor,
        step,
        decision,
        { from: current.record.state, to: saved.state, transitions: states },
        { eventId, inputHash: hash(current.record.data), outputHash: hash(saved.data) },
      );
      return { etag: String(saved.version), record: saved };
    });
  }
  putBatch(batch: Batch) {
    this.db
      .prepare('INSERT INTO batches VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(batch.id, JSON.stringify(batch));
  }
  batch(id: string): Batch {
    const row = this.db.prepare('SELECT body FROM batches WHERE id=?').get(id) as any;
    if (!row) throw new PlatformError('NOT_FOUND', 'Batch not found', 404);
    return JSON.parse(row.body);
  }
  batches(): Batch[] {
    return (this.db.prepare('SELECT body FROM batches ORDER BY rowid DESC').all() as any[]).map(
      (v) => JSON.parse(v.body),
    );
  }
  exception(entry: Omit<Exception, 'id' | 'createdAt' | 'status' | 'assignee'>) {
    const existing = (
      this.db
        .prepare('SELECT body FROM exceptions WHERE record_id=? AND signature=?')
        .all(entry.recordId, entry.signature) as any[]
    )
      .map((v) => JSON.parse(v.body))
      .find((v) => v.status === 'open');
    if (existing) return;
    const e: Exception = {
      ...entry,
      id: randomUUID(),
      createdAt: this.timestamp(),
      status: 'open',
      assignee: '',
    };
    this.db
      .prepare('INSERT INTO exceptions VALUES(?,?,?,?)')
      .run(e.id, e.recordId, e.signature, JSON.stringify(e));
  }
  exceptions(): Exception[] {
    return (this.db.prepare('SELECT body FROM exceptions ORDER BY rowid').all() as any[]).map((v) =>
      JSON.parse(v.body),
    );
  }
  resolve(recordId: string) {
    for (const e of this.exceptions().filter((e) => e.recordId === recordId && e.status === 'open'))
      this.updateException({ ...e, status: 'resolved' });
  }
  updateException(e: Exception) {
    this.db.prepare('UPDATE exceptions SET body=? WHERE id=?').run(JSON.stringify(e), e.id);
  }
  createUser(username: string, password: string, role: Role): User {
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username) || password.length < 12)
      throw new PlatformError(
        'INVALID_USER',
        'Use a 3 to 40 character username and a password of at least 12 characters',
      );
    const id = randomUUID(),
      salt = randomBytes(16).toString('hex');
    this.db
      .prepare('INSERT INTO users(id,username,role,salt,password) VALUES(?,?,?,?,?)')
      .run(id, username, role, salt, scryptSync(password, salt, 64).toString('hex'));
    return { id, username, role, disabled: false };
  }
  users(): User[] {
    return (
      this.db
        .prepare('SELECT id,username,role,disabled FROM users ORDER BY username')
        .all() as any[]
    ).map((u) => ({ ...u, disabled: Boolean(u.disabled) }));
  }
  authenticate(username: string, password: string): { token: string; user: User } | null {
    const user = this.db
      .prepare('SELECT * FROM users WHERE username=? AND disabled=0')
      .get(username) as any;
    const actual = scryptSync(password, user?.salt ?? 'invalid-user-salt', 64),
      expected = user ? Buffer.from(user.password, 'hex') : Buffer.alloc(64);
    if (!timingSafeEqual(actual, expected) || !user) return null;
    const token = randomBytes(32).toString('hex');
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(hash(token), user.id, this.now() + 14400000);
    return {
      token,
      user: { id: user.id, username: user.username, role: user.role, disabled: false },
    };
  }
  session(token: string): User | undefined {
    const row = this.db
      .prepare(
        'SELECT u.id,u.username,u.role,u.disabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0',
      )
      .get(hash(token), this.now()) as any;
    return row ? { ...row, disabled: false } : undefined;
  }
  logout(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token));
  }
  close() {
    this.db.close();
  }
}

import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { stringify } from 'yaml';
import { type Actor, type Data, type Role, type State, PlatformError, same } from '../core/model';
import { evaluate } from '../core/engine';
import { Store } from '../adapters/store';
import { loadPack } from '../adapters/config';
import { renderBundle, reportPdf } from '../adapters/renderers';
import { assertEditableData, leafValues } from '../core/mapping';
import { migrate } from '../../migrations';
import { MigrationService, worker } from '../worker/service';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; username: string; role: Role };
      token?: string;
    }
  }
}
const editBody = z
  .object({
    data: z.record(z.string(), z.any()),
    etag: z.string(),
    leaseToken: z.string().uuid(),
    resolveConflicts: z.boolean().optional(),
  })
  .strict();
const actor = (req: Request): Actor => ({ id: req.user!.id, kind: 'human' });
const id = (req: Request) => String(req.params.id);
const roles =
  (...allowed: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!allowed.includes(req.user!.role))
      return next(new PlatformError('FORBIDDEN', 'This action requires a different role', 403));
    next();
  };
export function createApp(
  options: { databasePath?: string; demo?: boolean; startWorker?: boolean } = {},
) {
  const pack = loadPack(),
    store = new Store(
      options.databasePath ?? process.env.DATABASE_PATH ?? 'var/migtool.sqlite',
      pack,
    ),
    app = express();
  const clients = new Set<Response>();
  const changed = () => {
    for (const response of clients) response.write('event: changed\ndata: {}\n\n');
  };
  const service = new MigrationService(store, pack, changed);
  if (!store.users().length) {
    if (options.demo) {
      for (const role of ['admin', 'operator', 'reviewer'] as const)
        store.createUser(role, `demo-${role}-2026`, role);
    } else {
      const password = process.env.MIGTOOL_ADMIN_PASSWORD;
      if (!password)
        throw new Error('Set MIGTOOL_ADMIN_PASSWORD (12+ characters) or use npm run demo');
      store.createUser(process.env.MIGTOOL_ADMIN_USER ?? 'admin', password, 'admin');
    }
  }
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (_req, res) => {
    store.db.prepare('SELECT 1').get();
    res.json({
      status: 'ok',
      mode: options.demo ? 'synthetic-demo' : 'local',
      delivery: 'simulated',
      llm: 'disabled',
      schemaVersion: pack.schema.version,
    });
  });
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      const expected = process.env.APP_ORIGIN;
      const allowed = expected
        ? [expected]
        : ['http://127.0.0.1:5173', 'http://localhost:5173', `http://${req.get('host')}`];
      if (origin && !allowed.includes(origin))
        return next(new PlatformError('ORIGIN_REJECTED', 'Request origin is not allowed', 403));
      if (req.get('sec-fetch-site') === 'cross-site')
        return next(new PlatformError('ORIGIN_REJECTED', 'Cross-site request rejected', 403));
    }
    next();
  });
  app.post(
    '/api/login',
    rateLimit({ windowMs: 60000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false }),
    (req, res) => {
      const body = z
          .object({ username: z.string().max(40), password: z.string().max(200) })
          .parse(req.body),
        result = store.authenticate(body.username, body.password);
      if (!result)
        throw new PlatformError('LOGIN_FAILED', 'Username or password is incorrect', 401);
      res.cookie('migtool_session', result.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 14400000,
        path: '/',
      });
      res.json(result.user);
    },
  );
  app.use('/api', (req, _res, next) => {
    const token =
      (req.headers.cookie ?? '')
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith('migtool_session='))
        ?.split('=')[1] ?? '';
    const user = store.session(token);
    if (!user)
      return next(
        new PlatformError(
          'AUTH_REQUIRED',
          'Sign in to continue. Your unsaved draft is kept in this tab.',
          401,
        ),
      );
    req.user = user;
    req.token = token;
    next();
  });
  app.get('/api/me', (req, res) => res.json({ ...req.user, demo: !!options.demo }));
  app.post('/api/logout', (req, res) => {
    store.logout(req.token!);
    res.clearCookie('migtool_session');
    res.json({ ok: true });
  });
  app.get('/api/config', (_req, res) => res.json(pack));
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('event: connected\ndata: {}\n\n');
    clients.add(res);
    const keepalive = setInterval(() => {
      if (!store.session(req.token!)) {
        res.end();
        return;
      }
      res.write(': keepalive\n\n');
    }, 30000);
    req.on('close', () => {
      clearInterval(keepalive);
      clients.delete(res);
    });
  });
  app.get('/api/overview', (_req, res) =>
    res.json({
      dashboard: service.dashboard(),
      records: store.list().map((r) => ({
        recordId: r.recordId,
        name: r.data.entity?.legalName ?? r.recordId,
        state: r.state,
        batchId: r.batchId,
        version: r.version,
        score: evaluate(pack, r.data).score,
        updatedAt: r.updatedAt,
        conflicts: r.conflicts.length,
        missingFromRefresh: r.missingFromRefresh,
      })),
      batches: store.batches(),
      exceptions: store.exceptions().filter((e) => e.status === 'open'),
      leases: store.leases(),
    }),
  );
  app.get('/api/fixtures/:kind', (req, res) => {
    const file =
      req.params.kind === 'refresh' ? 'fixtures/bank1-refresh.json' : 'fixtures/bank1-extract.json';
    res.type('json').attachment(file.split('/').at(-1)!).send(readFileSync(file));
  });
  app.post('/api/ingest', roles('admin'), async (req, res) => {
    const input = z
      .object({
        name: z.string().max(120).optional(),
        rows: z.array(z.record(z.string(), z.any())).max(10000),
        totals: z.object({
          customerCount: z.number().int().nonnegative(),
          accountCount: z.number().int().nonnegative(),
        }),
        fullSnapshot: z.boolean().optional(),
        checksum: z.string().length(64).optional(),
      })
      .strict()
      .parse(req.body);
    res.json(await service.ingest(input, actor(req)));
  });
  app.get('/api/records/:id', (req, res) => {
    const original = store.load(id(req));
    const upgrade = migrate(original.record, pack);
    if (upgrade.versions.length) {
      const lease = store.acquire(id(req), worker, true);
      if (!('leaseToken' in lease))
        throw new PlatformError(
          'LEASE_HELD',
          'Schema upgrade is waiting for the current editor',
          409,
        );
      try {
        const states = service.validated(upgrade.record);
        store.save(
          upgrade.record,
          { ifMatch: original.etag, leaseToken: lease.leaseToken },
          worker,
          'migrate',
          'schema_upgraded',
          states,
        );
        service.updateExceptions(upgrade.record);
      } finally {
        store.release(id(req), lease.leaseToken, worker);
      }
    }
    const loaded = store.load(id(req));
    res.json({
      ...loaded,
      evaluation: evaluate(pack, loaded.record.data),
      lease: store.leaseStatus(id(req)),
    });
  });
  app.post('/api/records/:id/lease', (req, res) => {
    store.load(id(req));
    const lease = store.acquire(id(req), actor(req));
    changed();
    res.json(lease);
  });
  app.post('/api/records/:id/lease/renew', (req, res) =>
    res.json(
      store.renew(
        id(req),
        z.object({ leaseToken: z.string().uuid() }).parse(req.body).leaseToken,
        actor(req),
      ),
    ),
  );
  app.post('/api/records/:id/lease/release', (req, res) => {
    store.release(
      id(req),
      z.object({ leaseToken: z.string().uuid() }).parse(req.body).leaseToken,
      actor(req),
    );
    changed();
    res.json({ ok: true });
  });
  app.post('/api/records/:id/lease/break', roles('admin'), (req, res) => {
    store.breakLease(
      id(req),
      actor(req),
      z.object({ reason: z.string().min(1).max(500) }).parse(req.body).reason,
    );
    changed();
    res.json({ ok: true });
  });
  app.put('/api/records/:id', (req, res) => {
    const body = editBody.parse(req.body);
    res.json(
      service.edit(
        id(req),
        body.data,
        body.etag,
        body.leaseToken,
        actor(req),
        req.user!.role,
        body.resolveConflicts,
      ),
    );
  });
  app.post('/api/records/:id/playbook', (req, res) => {
    const body = z.object({ code: z.string() }).parse(req.body);
    service.applyPlaybook(id(req), body.code, actor(req));
    res.json({ ok: true });
  });
  app.get('/api/records/:id/bundle', (req, res) => {
    const output = store.db
      .prepare('SELECT bytes FROM outputs WHERE record_id=?')
      .get(id(req)) as any;
    if (!output)
      throw new PlatformError(
        'OUTPUT_MISSING',
        'No bundle exists. Release a ready batch first.',
        404,
      );
    res
      .type('application/zip')
      .attachment(`${id(req)}-migration.zip`)
      .send(Buffer.from(output.bytes));
  });
  app.post('/api/batches/:id/release', roles('admin'), (req, res) =>
    res.json(service.releaseBatch(id(req), actor(req))),
  );
  app.post('/api/batches/:id/:action', roles('admin'), (req, res) => {
    if (!['pause', 'resume'].includes(String(req.params.action)))
      throw new PlatformError('ACTION_INVALID', 'Unknown action');
    service.batchAction(
      id(req),
      req.params.action as 'pause' | 'resume',
      z.object({ reason: z.string().min(1).max(500) }).parse(req.body).reason,
      actor(req),
    );
    res.json({ ok: true });
  });
  app.post('/api/exceptions/:id/assign', (req, res) => {
    const exception = store.exceptions().find((e) => e.id === id(req));
    if (!exception) throw new PlatformError('NOT_FOUND', 'Exception not found', 404);
    const assignee = z.object({ assignee: z.string().max(40) }).parse(req.body).assignee;
    if (assignee !== req.user!.username && !['reviewer', 'admin'].includes(req.user!.role))
      throw new PlatformError('FORBIDDEN', 'Operators may assign to themselves only', 403);
    store.updateException({ ...exception, assignee });
    store.trace(exception.recordId, actor(req), 'triage', 'assigned', { assignee });
    changed();
    res.json({ ok: true });
  });
  app.post('/api/records/:id/scope', roles('reviewer', 'admin'), (req, res) => {
    const { decision, reason, leaseToken } = z
        .object({
          decision: z.enum(['keep', 'withdraw']),
          reason: z.string().min(1).max(500),
          leaseToken: z.string().uuid(),
        })
        .parse(req.body),
      loaded = store.load(id(req));
    store.ownsLease(id(req), leaseToken, actor(req));
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
    store.save(
      loaded.record,
      { ifMatch: loaded.etag, leaseToken },
      actor(req),
      'admin',
      `scope_${decision}`,
    );
    store.trace(id(req), actor(req), 'admin', 'scope_review', { reason });
    store.resolve(id(req));
    store.release(id(req), leaseToken, actor(req));
    changed();
    res.json({ ok: true });
  });
  app.put('/api/records/:id/amendment', roles('reviewer', 'admin'), (req, res) => {
    const body = editBody.parse(req.body),
      loaded = store.load(id(req));
    store.ownsLease(id(req), body.leaseToken, actor(req));
    if (loaded.record.state !== 'amendment_pending')
      throw new PlatformError('NO_AMENDMENT', 'No amendment is pending');
    assertEditableData(pack, body.data);
    loaded.record.pendingData = body.data;
    loaded.record.pendingProvenance ??= structuredClone(loaded.record.provenance);
    for (const path of Object.keys(leafValues(body.data)))
      if (!same(leafValues(body.data)[path], leafValues(loaded.record.data)[path]))
        loaded.record.pendingProvenance[path] = {
          source: 'operator',
          actor: req.user!.id,
          at: store.timestamp(),
          traceEventId: 'pending-review',
        };
    loaded.record.conflicts = [];
    const result = store.save(
      loaded.record,
      { ifMatch: body.etag, leaseToken: body.leaseToken },
      actor(req),
      'edit',
      'amendment_proposal_saved',
    );
    store.release(id(req), body.leaseToken, actor(req));
    changed();
    res.json(result);
  });
  app.get('/api/records/:id/amendment.pdf', async (req, res) => {
    const record = store.load(id(req)).record;
    if (!record.pendingData) throw new PlatformError('NO_AMENDMENT', 'No amendment is pending');
    res
      .type('pdf')
      .attachment(`${id(req)}-amendment-review.pdf`)
      .send(
        Buffer.from(
          await reportPdf(
            'Proposed amendment review',
            [
              `Record: ${id(req)} | Frozen version: ${record.version}`,
              'Review copy. No amendment has been delivered.',
              ...Object.entries(leafValues(record.pendingData))
                .filter(([path, value]) => !same(leafValues(record.data)[path], value))
                .map(([path, value]) => `${path}: ${String(value)}`),
            ],
            record.updatedAt,
          ),
        ),
      );
  });
  app.post('/api/records/:id/amendment', roles('reviewer', 'admin'), async (req, res) => {
    const { decision, leaseToken } = z
        .object({ decision: z.enum(['approve', 'reject']), leaseToken: z.string().uuid() })
        .parse(req.body),
      loaded = store.load(id(req));
    store.ownsLease(id(req), leaseToken, actor(req));
    if (loaded.record.state !== 'amendment_pending' || !loaded.record.pendingData)
      throw new PlatformError('NO_AMENDMENT', 'No amendment is pending');
    if (loaded.record.conflicts.length)
      throw new PlatformError(
        'REVIEW_REQUIRED',
        'Resolve amendment conflicts through a reviewed mapping change before approval',
      );
    if (decision === 'approve') {
      const next = { ...loaded.record, data: loaded.record.pendingData };
      if (!evaluate(pack, next.data).gates.cbs.open)
        throw new PlatformError('GATE_CLOSED', 'Amended data must pass both gates');
      const bundle = await renderBundle(pack, next);
      store.db
        .prepare('INSERT INTO cbs_receipts VALUES(?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING')
        .run(
          `amendment:${id(req)}:${bundle.digest}`,
          id(req),
          JSON.stringify(bundle.expected),
          store.timestamp(),
        );
      const receipt = store.db
        .prepare('SELECT expected FROM cbs_receipts WHERE idempotency_key=?')
        .get(`amendment:${id(req)}:${bundle.digest}`) as any;
      if (!same(JSON.parse(receipt.expected), bundle.expected))
        throw new PlatformError('RECONCILIATION_MISMATCH', 'Amendment readback mismatch');
      loaded.record.data = loaded.record.pendingData;
      loaded.record.baseline = loaded.record.pendingBaseline ?? loaded.record.baseline;
      loaded.record.provenance = loaded.record.pendingProvenance ?? loaded.record.provenance;
      store.db
        .prepare('INSERT INTO amendment_outputs VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .run(`${id(req)}:${bundle.digest}`, id(req), bundle.bytes, bundle.digest);
    }
    delete loaded.record.pendingData;
    delete loaded.record.pendingBaseline;
    delete loaded.record.pendingProvenance;
    loaded.record.state = 'reconciled';
    store.save(
      loaded.record,
      { ifMatch: loaded.etag, leaseToken },
      actor(req),
      'reconcile',
      `amendment_${decision}_simulated`,
    );
    store.release(id(req), leaseToken, actor(req));
    changed();
    res.json({ ok: true });
  });
  app.get('/api/trace', (req, res) => {
    const filter = z
      .object({
        recordId: z.string().optional(),
        batchId: z.string().optional(),
        actor: z.string().optional(),
        errorCode: z.string().optional(),
        traceId: z.string().optional(),
      })
      .parse(req.query);
    let trace = store.traces(filter);
    if (req.user!.role === 'operator') {
      const owned = new Set(
        store
          .traces()
          .filter((t) => t.actor.id === req.user!.id && ['edit', 'lease'].includes(t.step))
          .map((t) => t.recordId),
      );
      trace = trace.filter((t) => owned.has(t.recordId));
    }
    res.json(trace);
  });
  app.get('/api/dashboard.pdf', async (_req, res) => {
    const d = service.dashboard();
    res
      .type('pdf')
      .attachment('migration-progress.pdf')
      .send(
        Buffer.from(
          await reportPdf(
            'Migration progress',
            Object.entries(d).map(
              ([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`,
            ),
            store.timestamp(),
          ),
        ),
      );
  });
  app.get('/api/records/:id/playbook-draft', roles('reviewer', 'admin'), (req, res) => {
    const traces = store.traces({ recordId: id(req) }),
      approved = traces.find((t) => t.step === 'edit');
    if (!approved)
      throw new PlatformError(
        'NO_APPROVED_FIX',
        'Save a reviewed fix before preparing a playbook change',
      );
    res
      .type('text/yaml')
      .attachment('playbook-review-draft.yaml')
      .send(
        stringify({
          status: 'draft_requires_config_owner_review',
          sourceTrace: approved.eventId,
          approvedBy: req.user!.id,
          entries: [],
          instructions:
            'Add a deterministic signature and a bounded transform. Submit via a configuration pull request; never include customer values.',
        }),
      );
  });
  app.get('/api/users', roles('admin'), (_req, res) => res.json(store.users()));
  app.post('/api/users', roles('admin'), (req, res) => {
    const body = z
      .object({
        username: z.string(),
        password: z.string().max(200),
        role: z.enum(['operator', 'reviewer', 'admin']),
      })
      .parse(req.body);
    const user = store.createUser(body.username, body.password, body.role);
    store.trace('users', actor(req), 'admin', 'user_created', { id: user.id, role: user.role });
    res.status(201).json(user);
  });
  if (existsSync(resolve('dist/index.html'))) {
    app.use(express.static(resolve('dist')));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  }
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const known = error instanceof PlatformError || error instanceof z.ZodError;
    const status =
      error instanceof PlatformError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : error.type === 'entity.too.large'
            ? 413
            : 500;
    if (!known && status === 500)
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'request_failed',
          name: error.name,
          code: error.code ?? 'UNEXPECTED',
        }),
      );
    res.status(status).json({
      code: error instanceof PlatformError ? error.code : 'REQUEST_FAILED',
      message: known
        ? error.message
        : status === 413
          ? 'Extract exceeds 20 MB'
          : 'The request could not be completed',
    });
  });
  let running = false;
  const timer =
    options.startWorker === false
      ? undefined
      : setInterval(async () => {
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
  return {
    app,
    store,
    service,
    close: () => {
      if (timer) clearInterval(timer);
      for (const c of clients) c.end();
      store.close();
    },
  };
}

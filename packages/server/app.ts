import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { z } from 'zod';
import { stringify } from 'yaml';
import { type Actor, type Data, type Role, type State, PlatformError, same } from '../core/model';
import { evaluate } from '../core/engine';
import { Store } from '../adapters/store';
import { loadPack } from '../adapters/config';
import { reportPdf } from '../adapters/renderers';
import { assertEditableData, leafValues } from '../core/mapping';
import { migrate } from '../../migrations';
import { MigrationService, worker } from '../worker/service';
import { deliveryFor } from '../adapters/cbs';
import { type SharePointAuthority, sharePointFromEnv } from '../adapters/sharepoint';
import { landingPackages, readExtractPackage, strayFiles } from '../adapters/files';

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
  options: {
    databasePath?: string;
    demo?: boolean;
    startWorker?: boolean;
    cbsOutbox?: string;
    landing?: string;
    authority?: SharePointAuthority;
  } = {},
) {
  const databasePath = options.databasePath ?? process.env.DATABASE_PATH ?? 'var/migtool.sqlite',
    pack = loadPack(),
    store = new Store(databasePath, pack),
    app = express();
  const { root: outbox, cbs } = deliveryFor(store, databasePath, options.cbsOutbox);
  // Bank 1 extract packages arrive here, one subfolder each; it may be a OneDrive folder and is
  // only ever read.
  const landing = options.landing ?? process.env.EXTRACT_LANDING;
  const clients = new Set<Response>();
  const changed = () => {
    for (const response of clients) response.write('event: changed\ndata: {}\n\n');
  };
  // SharePoint is the record authority when configured; the database is then a working copy.
  const authority = options.authority ?? sharePointFromEnv(pack);
  const service = new MigrationService(store, pack, changed, cbs, authority);
  const holder = (req: Request) => ({
    id: req.user!.id,
    name: req.user!.username,
    kind: 'human' as const,
  });
  // Before a person's save: their SharePoint check-out must still be theirs.
  const assertRemote = async (recordId: string) => {
    const token = store.remote(recordId)?.token;
    if (!authority) return;
    if (!token)
      throw new PlatformError('SHAREPOINT_LEASE_LOST', 'Reopen the record to check it out', 409);
    await authority.assertHeld(recordId, token);
  };
  const migrateIfNeeded = (recordId: string) => {
    const original = store.load(recordId);
    const upgrade = migrate(original.record, pack);
    if (!upgrade.versions.length) return;
    const lease = store.acquire(recordId, worker, true);
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
      store.release(recordId, lease.leaseToken, worker);
    }
  };
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
      delivery: outbox ? 'file-drop' : 'simulated',
      records: authority ? 'sharepoint' : 'local',
      strayFiles:
        (outbox ? strayFiles(outbox).length : 0) + (landing ? strayFiles(landing).length : 0),
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
  app.get('/api/overview', (_req: Request, res) =>
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
      notices: store.takeNotices(_req.user!.id),
      delivery: outbox ? 'file-drop' : 'simulated',
    }),
  );
  app.get('/api/fixtures/csv', (_req, res) => {
    const dir = 'fixtures/sample-csv';
    res.json(
      Object.fromEntries(
        readdirSync(dir)
          .filter((f) => f.endsWith('.csv'))
          .sort()
          .map((f) => [f, readFileSync(join(dir, f), 'utf8')]),
      ),
    );
  });
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
  app.post('/api/ingest/csv', roles('admin'), async (req, res) => {
    const input = z
      .object({
        name: z.string().max(120).optional(),
        files: z.record(z.string().max(80), z.string()),
        fullSnapshot: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    res.json(
      await service.ingestCsv(
        input.files,
        { name: input.name, fullSnapshot: input.fullSnapshot },
        actor(req),
      ),
    );
  });
  app.get('/api/landing', roles('admin'), (_req, res) =>
    res.json({
      configured: Boolean(landing),
      packages: landing ? landingPackages(landing, pack.ingest.csv!.control) : [],
    }),
  );
  app.post('/api/ingest/landing', roles('admin'), async (req, res) => {
    if (!landing)
      throw new PlatformError(
        'LANDING_NOT_CONFIGURED',
        'Set EXTRACT_LANDING to use a landing folder',
      );
    const input = z
      .object({
        package: z.string().regex(/^\w[\w .-]{0,119}$/),
        fullSnapshot: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    res.json(
      await service.ingestCsv(
        readExtractPackage(join(landing, input.package)),
        { name: input.package, fullSnapshot: input.fullSnapshot },
        actor(req),
      ),
    );
  });
  app.get('/api/records/:id', (req, res) => {
    // With SharePoint, upgrades happen when the record is checked out, so they are published.
    if (!authority) migrateIfNeeded(id(req));
    const loaded = store.load(id(req));
    res.json({
      ...loaded,
      evaluation: evaluate(pack, loaded.record.data),
      lease: store.leaseStatus(id(req)),
      sharepoint: authority ? (store.remote(id(req)) ?? null) : undefined,
    });
  });
  app.post('/api/records/:id/lease', async (req, res) => {
    if (authority) {
      const held = await service.checkOutRemote(id(req), holder(req));
      if (held) return res.json(held);
      try {
        store.load(id(req));
        migrateIfNeeded(id(req));
      } catch (error) {
        await service.finishRemote(id(req));
        throw error;
      }
    } else store.load(id(req));
    const lease = store.acquire(id(req), actor(req));
    if (!('leaseToken' in lease)) await service.finishRemote(id(req));
    changed();
    res.json(lease);
  });
  app.post('/api/records/:id/lease/renew', async (req, res) => {
    const lease = store.renew(
      id(req),
      z.object({ leaseToken: z.string().uuid() }).parse(req.body).leaseToken,
      actor(req),
    );
    const token = store.remote(id(req))?.token;
    if (authority && token) await authority.renew(id(req), token, 'human');
    res.json(lease);
  });
  app.post('/api/records/:id/lease/release', async (req, res) => {
    store.release(
      id(req),
      z.object({ leaseToken: z.string().uuid() }).parse(req.body).leaseToken,
      actor(req),
    );
    const sharepoint = await service.finishRemote(id(req));
    changed();
    res.json({ ok: true, sharepoint });
  });
  app.post('/api/records/:id/lease/break', roles('admin'), async (req, res) => {
    store.breakLease(
      id(req),
      actor(req),
      z.object({ reason: z.string().min(1).max(500) }).parse(req.body).reason,
    );
    if (authority) {
      await authority.breakLease(id(req));
      store.setRemote(id(req), { token: null, holder_kind: null });
    }
    changed();
    res.json({ ok: true });
  });
  app.put('/api/records/:id', async (req, res) => {
    const body = editBody.parse(req.body);
    await assertRemote(id(req));
    const saved = service.edit(
      id(req),
      body.data,
      body.etag,
      body.leaseToken,
      actor(req),
      req.user!.role,
      body.resolveConflicts,
    );
    res.json({ ...saved, sharepoint: await service.finishRemote(id(req)) });
  });
  app.post('/api/records/:id/playbook', async (req, res) => {
    const body = z.object({ code: z.string() }).parse(req.body);
    await service.withRemote(authority ? [id(req)] : [], () =>
      service.applyPlaybook(id(req), body.code, actor(req)),
    );
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
  app.get('/api/batches/:id/cbs-export', roles('reviewer', 'admin'), async (req, res) => {
    const { files } = service.exportBatch(id(req)),
      zip = new JSZip(),
      date = new Date(store.batch(id(req)).createdAt);
    for (const [name, bytes] of Object.entries(files))
      zip.file(name, bytes, { date, createFolders: false });
    res
      .type('application/zip')
      .attachment(`${id(req)}-bank2-cbs-load.zip`)
      .send(
        await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'DOS' }),
      );
  });
  app.post('/api/batches/:id/release', roles('admin'), async (req, res) =>
    res.json(await service.releaseBatch(id(req), actor(req))),
  );
  app.post('/api/batches/:id/:action', roles('admin'), async (req, res) => {
    if (!['pause', 'resume'].includes(String(req.params.action)))
      throw new PlatformError('ACTION_INVALID', 'Unknown action');
    await service.batchAction(
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
  app.post('/api/records/:id/scope', roles('reviewer', 'admin'), async (req, res) => {
    const { decision, reason, leaseToken } = z
      .object({
        decision: z.enum(['keep', 'withdraw']),
        reason: z.string().min(1).max(500),
        leaseToken: z.string().uuid(),
      })
      .parse(req.body);
    await assertRemote(id(req));
    service.decideScope(id(req), decision, reason, leaseToken, actor(req));
    res.json({ ok: true, sharepoint: await service.finishRemote(id(req)) });
  });
  app.put('/api/records/:id/amendment', roles('reviewer', 'admin'), async (req, res) => {
    await assertRemote(id(req));
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
    res.json({ ...result, sharepoint: await service.finishRemote(id(req)) });
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
      .parse(req.body);
    await assertRemote(id(req));
    await service.decideAmendment(id(req), decision, leaseToken, actor(req));
    res.json({ ok: true, sharepoint: await service.finishRemote(id(req)) });
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
    // Operators see the trace of records they have edited or leased.
    res.json(
      store.traces(
        req.user!.role === 'operator'
          ? { ...filter, recordIds: store.recordsTouchedBy(req.user!.id) }
          : filter,
      ),
    );
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
  let running = false,
    lastSync = 0;
  const timer =
    options.startWorker === false
      ? undefined
      : setInterval(async () => {
          if (running) return;
          running = true;
          try {
            // Every 15 seconds: retry unfinished SharePoint publishes and pull others' changes.
            if (authority && Date.now() - lastSync > 15000) {
              lastSync = Date.now();
              await service.publishPending();
              await service.syncFromSharePoint();
            }
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

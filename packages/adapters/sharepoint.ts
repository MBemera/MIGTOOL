import { randomUUID } from 'node:crypto';
import { type Envelope, type Pack, type Trace, PlatformError } from '../core/model';

// SharePoint as the record authority (DEC-01, Graph route). Each customer is one JSON file in a
// document library; a SharePoint list holds the leases. The app works only through Microsoft
// Graph, never through the OneDrive sync client, so a check-out is visible to everyone at once
// and a release is confirmed by SharePoint before the record is free again.

export class GraphError extends PlatformError {
  constructor(
    public httpStatus: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(
      httpStatus === 429 || httpStatus >= 500 ? 'TRANSIENT' : `GRAPH_${httpStatus}`,
      message,
      httpStatus === 429 || httpStatus >= 500 ? 503 : 409,
    );
  }
}
export type FileRef = { id: string; eTag: string };
export type LeaseFields = {
  Title: string; // record id; the column enforces unique values
  Holder: string;
  HolderName: string;
  Server: string;
  Token: string;
  Acquired: number;
  Expires: number;
};
export type LeaseItem = { id: string; eTag: string; fields: LeaseFields };
// The Graph operations the authority needs. Paths are relative to the configured folder.
export interface GraphClient {
  now(): number; // SharePoint's clock, so every server judges expiry by the same time
  getFile(path: string): Promise<FileRef | undefined>;
  readFile(id: string): Promise<string>;
  createFile(path: string, body: string): Promise<FileRef>; // 409 if it exists
  replaceFile(id: string, body: string, ifMatch: string): Promise<FileRef>; // 412 if changed
  listFiles(folder: string): Promise<(FileRef & { name: string })[]>;
  checkOut(id: string): Promise<void>;
  checkIn(id: string, comment: string): Promise<void>;
  discardCheckOut(id: string): Promise<void>;
  getLease(recordId: string): Promise<LeaseItem | undefined>;
  listLeases(): Promise<LeaseItem[]>;
  createLease(fields: LeaseFields): Promise<LeaseItem>; // 409 if one exists for the record
  updateLease(itemId: string, fields: LeaseFields, ifMatch: string): Promise<LeaseItem>; // 412
  deleteLease(itemId: string, ifMatch: string): Promise<void>; // 412
}
const conflict = (e: unknown) => e instanceof GraphError && [409, 412].includes(e.httpStatus);
export type Holder = { id: string; name: string; kind: 'human' | 'worker' };
export type CheckedOut = { token: string; file?: FileRef & { body: string } };

export class SharePointAuthority {
  constructor(
    public graph: GraphClient,
    public serverId: string,
    private timing: { leaseMs: number; workerLeaseMs: number },
  ) {}
  path(recordId: string) {
    return `records/${encodeURIComponent(recordId)}.json`;
  }
  private leaseFields(recordId: string, holder: Holder, token: string): LeaseFields {
    const now = this.graph.now();
    return {
      Title: recordId,
      Holder: holder.id,
      HolderName: holder.name,
      Server: this.serverId,
      Token: token,
      Acquired: now,
      Expires: now + (holder.kind === 'worker' ? this.timing.workerLeaseMs : this.timing.leaseMs),
    };
  }
  private heldBy(item: LeaseItem | undefined) {
    return {
      heldBy: item?.fields.HolderName ?? 'another user',
      since: new Date(item?.fields.Acquired ?? this.graph.now()).toISOString(),
    };
  }
  // Open: lease in the list, then SharePoint check-out, then read the file as checked out.
  async checkOut(
    recordId: string,
    holder: Holder,
  ): Promise<CheckedOut | { heldBy: string; since: string }> {
    let item = await this.graph.getLease(recordId);
    if (item && item.fields.Expires > this.graph.now()) return this.heldBy(item);
    const token = randomUUID(),
      fields = this.leaseFields(recordId, holder, token);
    try {
      // An expired lease is taken over only if nobody else did so first.
      item = item
        ? await this.graph.updateLease(item.id, fields, item.eTag)
        : await this.graph.createLease(fields);
    } catch (error) {
      if (conflict(error)) return this.heldBy(await this.graph.getLease(recordId));
      throw error;
    }
    try {
      const existing = await this.graph.getFile(this.path(recordId));
      if (!existing) return { token };
      await this.graph.checkOut(existing.id).catch((error) => {
        // Taking over an expired lease: the file is still checked out to this application.
        if (!(error instanceof GraphError && error.httpStatus === 423)) throw error;
      });
      const file = (await this.graph.getFile(this.path(recordId)))!;
      return { token, file: { ...file, body: await this.graph.readFile(file.id) } };
    } catch (error) {
      await this.releaseLease(recordId, token).catch(() => {});
      throw error;
    }
  }
  async assertHeld(recordId: string, token: string): Promise<LeaseItem> {
    const item = await this.graph.getLease(recordId);
    if (!item || item.fields.Token !== token || item.fields.Expires <= this.graph.now())
      throw new PlatformError(
        'SHAREPOINT_LEASE_LOST',
        'The SharePoint lease on this record has expired or been taken over. Reload the record.',
        409,
      );
    return item;
  }
  async renew(recordId: string, token: string, kind: Holder['kind']) {
    const item = await this.assertHeld(recordId, token);
    const ms = kind === 'worker' ? this.timing.workerLeaseMs : this.timing.leaseMs;
    try {
      await this.graph.updateLease(
        item.id,
        { ...item.fields, Expires: this.graph.now() + ms },
        item.eTag,
      );
    } catch (error) {
      if (conflict(error)) await this.assertHeld(recordId, token);
      throw error;
    }
  }
  // Release with changes: upload only if the file is unchanged since check-out, add the trace,
  // check in, and only then free the lease. Any failure leaves the file checked out and unchanged.
  async publish(
    recordId: string,
    token: string,
    record: Envelope,
    checkedOutETag: string | undefined,
    trace: Trace[],
  ): Promise<string> {
    const item = await this.assertHeld(recordId, token),
      body = JSON.stringify(record, null, 2) + '\n';
    let file: FileRef;
    try {
      const existing = await this.graph.getFile(this.path(recordId));
      if (existing && !checkedOutETag) throw new GraphError(409, 'File appeared after check-out');
      file = existing
        ? await this.graph.replaceFile(existing.id, body, checkedOutETag!)
        : await this.graph.createFile(this.path(recordId), body);
    } catch (error) {
      if (conflict(error))
        throw new PlatformError(
          'SHAREPOINT_STALE',
          'The SharePoint file changed outside this check-out. Nothing was overwritten.',
          409,
        );
      throw error;
    }
    if (trace.length)
      await this.graph.createFile(
        `trace/${encodeURIComponent(recordId)}/v${record.version}-${this.serverId}-${randomUUID().slice(0, 8)}.json`,
        JSON.stringify(trace, null, 2) + '\n',
      );
    await this.graph.checkIn(
      file.id,
      `MIGTOOL version ${record.version} (${item.fields.HolderName})`,
    );
    const published = (await this.graph.getFile(this.path(recordId)))!;
    await this.graph.deleteLease(item.id, item.eTag).catch(() => {});
    return published.eTag;
  }
  // Release without changes: undo the check-out and free the lease.
  async abandon(recordId: string, token: string) {
    const item = await this.graph.getLease(recordId);
    if (!item || item.fields.Token !== token) return;
    await this.undoCheckOut(recordId);
    await this.releaseLease(recordId, token);
  }
  async breakLease(recordId: string) {
    await this.undoCheckOut(recordId);
    const item = await this.graph.getLease(recordId);
    if (item) await this.graph.deleteLease(item.id, item.eTag);
  }
  private async undoCheckOut(recordId: string) {
    const file = await this.graph.getFile(this.path(recordId));
    if (file) await this.graph.discardCheckOut(file.id);
  }
  private async releaseLease(recordId: string, token: string) {
    const item = await this.graph.getLease(recordId);
    if (item && item.fields.Token === token) await this.graph.deleteLease(item.id, item.eTag);
  }
  // Published records and the ids currently leased, for keeping local copies current.
  async snapshot() {
    const now = this.graph.now();
    const [files, leases] = await Promise.all([
      this.graph.listFiles('records'),
      this.graph.listLeases(),
    ]);
    return {
      files: files
        .filter((f) => f.name.endsWith('.json'))
        .map((f) => ({ ...f, recordId: decodeURIComponent(f.name.slice(0, -5)) })),
      leased: new Set(leases.filter((l) => l.fields.Expires > now).map((l) => l.fields.Title)),
    };
  }
  async read(id: string) {
    return this.graph.readFile(id);
  }
}

// Microsoft Graph over HTTPS with an app-only token (client credentials). The app registration
// needs Sites.Selected, granted write access to the migration site only.
export class HttpGraphClient implements GraphClient {
  private token?: { value: string; expires: number };
  private clock = { remote: Date.now(), local: Date.now() };
  constructor(
    private config: {
      tenantId: string;
      clientId: string;
      clientSecret: string;
      siteId: string;
      driveId: string;
      leaseListId: string;
      folder: string;
    },
  ) {}
  now() {
    return this.clock.remote + (Date.now() - this.clock.local);
  }
  private async accessToken() {
    if (this.token && this.token.expires > Date.now() + 60000) return this.token.value;
    const response = await fetch(
      `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }),
      },
    );
    if (!response.ok) throw new GraphError(response.status, 'SharePoint sign-in failed');
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }
  private async request(
    method: string,
    path: string,
    options: { body?: string; json?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const url = path.startsWith('https://') ? path : `https://graph.microsoft.com/v1.0${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(options.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
    });
    const date = response.headers.get('date');
    if (date) this.clock = { remote: Date.parse(date), local: Date.now() };
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new GraphError(
        response.status,
        `SharePoint ${method} failed (${response.status}): ${detail.slice(0, 300)}`,
        Number(response.headers.get('retry-after')) || undefined,
      );
    }
    return response;
  }
  private drivePath(path: string) {
    const folder = this.config.folder.replace(/^\/|\/$/g, '');
    return `/drives/${this.config.driveId}/root:/${folder}/${path}`;
  }
  private items = () => `/sites/${this.config.siteId}/lists/${this.config.leaseListId}/items`;
  async getFile(path: string) {
    try {
      const item = (await (await this.request('GET', this.drivePath(path))).json()) as FileRef;
      return { id: item.id, eTag: item.eTag };
    } catch (error) {
      if (error instanceof GraphError && error.httpStatus === 404) return undefined;
      throw error;
    }
  }
  async readFile(id: string) {
    return (await this.request('GET', `/drives/${this.config.driveId}/items/${id}/content`)).text();
  }
  async createFile(path: string, body: string) {
    const item = (await (
      await this.request(
        'PUT',
        `${this.drivePath(path)}:/content?@microsoft.graph.conflictBehavior=fail`,
        { body },
      )
    ).json()) as FileRef;
    return { id: item.id, eTag: item.eTag };
  }
  async replaceFile(id: string, body: string, ifMatch: string) {
    const item = (await (
      await this.request('PUT', `/drives/${this.config.driveId}/items/${id}/content`, {
        body,
        headers: { 'If-Match': ifMatch },
      })
    ).json()) as FileRef;
    return { id: item.id, eTag: item.eTag };
  }
  async listFiles(folder: string) {
    const out: (FileRef & { name: string })[] = [];
    let next: string | undefined =
      `${this.drivePath(folder)}:/children?$select=id,name,eTag&$top=999`;
    while (next) {
      let page: any;
      try {
        page = await (await this.request('GET', next)).json();
      } catch (error) {
        if (error instanceof GraphError && error.httpStatus === 404) return out;
        throw error;
      }
      out.push(...page.value.map((v: any) => ({ id: v.id, name: v.name, eTag: v.eTag })));
      next = page['@odata.nextLink'];
    }
    return out;
  }
  async checkOut(id: string) {
    await this.request('POST', `/drives/${this.config.driveId}/items/${id}/checkout`);
  }
  async checkIn(id: string, comment: string) {
    await this.request('POST', `/drives/${this.config.driveId}/items/${id}/checkin`, {
      json: { comment },
    });
  }
  async discardCheckOut(id: string) {
    try {
      await this.request('POST', `/drives/${this.config.driveId}/items/${id}/discardCheckout`);
    } catch (error) {
      // Where discard is unavailable, checking in the unchanged file has the same effect.
      if (!(error instanceof GraphError && [400, 404, 405].includes(error.httpStatus))) throw error;
      await this.checkIn(id, 'Released without changes').catch(() => {});
    }
  }
  private lease(v: any): LeaseItem {
    const f = v.fields;
    return {
      id: v.id,
      eTag: v['@odata.etag'] ?? v.eTag,
      fields: {
        Title: f.Title,
        Holder: f.Holder,
        HolderName: f.HolderName,
        Server: f.Server,
        Token: f.Token,
        Acquired: Number(f.Acquired),
        Expires: Number(f.Expires),
      },
    };
  }
  async getLease(recordId: string) {
    const page: any = await (
      await this.request(
        'GET',
        `${this.items()}?$expand=fields&$filter=fields/Title eq '${recordId.replace(/'/g, "''")}'`,
        { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } },
      )
    ).json();
    return page.value[0] ? this.lease(page.value[0]) : undefined;
  }
  async listLeases() {
    const out: LeaseItem[] = [];
    let next: string | undefined = `${this.items()}?$expand=fields&$top=999`;
    while (next) {
      const page: any = await (await this.request('GET', next)).json();
      out.push(...page.value.map((v: any) => this.lease(v)));
      next = page['@odata.nextLink'];
    }
    return out;
  }
  private asText(fields: LeaseFields) {
    return { ...fields, Acquired: String(fields.Acquired), Expires: String(fields.Expires) };
  }
  async createLease(fields: LeaseFields) {
    try {
      const v = await (
        await this.request('POST', this.items(), { json: { fields: this.asText(fields) } })
      ).json();
      return this.lease(v);
    } catch (error) {
      // The unique Title column rejects a second lease for the same record.
      if (error instanceof GraphError && error.httpStatus === 400 && /unique/i.test(error.message))
        throw new GraphError(409, error.message);
      throw error;
    }
  }
  async updateLease(itemId: string, fields: LeaseFields, ifMatch: string) {
    await this.request('PATCH', `${this.items()}/${itemId}/fields`, {
      json: this.asText(fields),
      headers: { 'If-Match': ifMatch },
    });
    const v = await (await this.request('GET', `${this.items()}/${itemId}?$expand=fields`)).json();
    return this.lease(v);
  }
  async deleteLease(itemId: string, ifMatch: string) {
    await this.request('DELETE', `${this.items()}/${itemId}`, { headers: { 'If-Match': ifMatch } });
  }
}

// SharePoint is used when all of its settings are present; otherwise records stay local.
export function sharePointFromEnv(pack: Pack, env = process.env) {
  const keys = [
    'SHAREPOINT_TENANT_ID',
    'SHAREPOINT_CLIENT_ID',
    'SHAREPOINT_CLIENT_SECRET',
    'SHAREPOINT_SITE_ID',
    'SHAREPOINT_DRIVE_ID',
    'SHAREPOINT_LEASE_LIST_ID',
  ];
  const present = keys.filter((k) => env[k]);
  if (!present.length) return undefined;
  if (present.length !== keys.length)
    throw new Error(
      `SharePoint is partly configured; also set ${keys.filter((k) => !env[k]).join(', ')}`,
    );
  return new SharePointAuthority(
    new HttpGraphClient({
      tenantId: env.SHAREPOINT_TENANT_ID!,
      clientId: env.SHAREPOINT_CLIENT_ID!,
      clientSecret: env.SHAREPOINT_CLIENT_SECRET!,
      siteId: env.SHAREPOINT_SITE_ID!,
      driveId: env.SHAREPOINT_DRIVE_ID!,
      leaseListId: env.SHAREPOINT_LEASE_LIST_ID!,
      folder: env.SHAREPOINT_FOLDER ?? 'MIGTOOL',
    }),
    env.MIGTOOL_SERVER_ID ?? 'server',
    { leaseMs: pack.operations.leaseMs, workerLeaseMs: pack.operations.workerLeaseMs },
  );
}

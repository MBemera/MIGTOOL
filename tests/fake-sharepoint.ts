import {
  type FileRef,
  type GraphClient,
  type LeaseFields,
  type LeaseItem,
  GraphError,
} from '../packages/adapters/sharepoint';

type File = {
  id: string;
  path: string;
  published: string;
  draft?: string;
  eTag: string;
  checkedOut: boolean;
};
// In-memory SharePoint with the behaviour the authority relies on: check-out keeps others on the
// last checked-in version and blocks their edits, uploads honour If-Match, the lease list rejects
// a second item for a record, and one clock serves every server.
export class FakeSharePoint implements GraphClient {
  clock = Date.parse('2026-10-17T09:00:00Z');
  files = new Map<string, File>();
  leases = new Map<string, LeaseItem>();
  private seq = 0;
  private failures: { op: string; status: number }[] = [];
  now() {
    return this.clock;
  }
  advance(ms: number) {
    this.clock += ms;
  }
  failNext(op: string, status = 503) {
    this.failures.push({ op, status });
  }
  private check(op: string) {
    const index = this.failures.findIndex((f) => f.op === op);
    if (index >= 0) {
      const [failure] = this.failures.splice(index, 1);
      throw new GraphError(failure.status, `Simulated ${op} failure`);
    }
  }
  private tag() {
    return `"{${++this.seq}},1"`;
  }
  private byId(id: string) {
    const file = [...this.files.values()].find((f) => f.id === id);
    if (!file) throw new GraphError(404, 'Not found');
    return file;
  }
  async getFile(path: string): Promise<FileRef | undefined> {
    this.check('getFile');
    const f = this.files.get(path);
    return f && { id: f.id, eTag: f.eTag };
  }
  async readFile(id: string) {
    this.check('readFile');
    const f = this.byId(id);
    // The application account sees its own checked-out draft.
    return f.draft ?? f.published;
  }
  async createFile(path: string, body: string) {
    this.check('createFile');
    if (this.files.has(path)) throw new GraphError(409, 'nameAlreadyExists');
    const f: File = {
      id: `item-${++this.seq}`,
      path,
      published: body,
      eTag: this.tag(),
      checkedOut: false,
    };
    this.files.set(path, f);
    return { id: f.id, eTag: f.eTag };
  }
  async replaceFile(id: string, body: string, ifMatch: string) {
    this.check('replaceFile');
    const f = this.byId(id);
    if (f.eTag !== ifMatch) throw new GraphError(412, 'Precondition failed');
    if (f.checkedOut) f.draft = body;
    else f.published = body;
    f.eTag = this.tag();
    return { id: f.id, eTag: f.eTag };
  }
  async listFiles(folder: string) {
    this.check('listFiles');
    return [...this.files.values()]
      .filter(
        (f) => f.path.startsWith(`${folder}/`) && !f.path.slice(folder.length + 1).includes('/'),
      )
      .map((f) => ({ id: f.id, eTag: f.eTag, name: f.path.slice(folder.length + 1) }));
  }
  async checkOut(id: string) {
    this.check('checkOut');
    const f = this.byId(id);
    if (f.checkedOut) throw new GraphError(423, 'Locked');
    f.checkedOut = true;
    f.eTag = this.tag();
  }
  async checkIn(id: string) {
    this.check('checkIn');
    const f = this.byId(id);
    if (!f.checkedOut) return;
    f.published = f.draft ?? f.published;
    f.draft = undefined;
    f.checkedOut = false;
    f.eTag = this.tag();
  }
  async discardCheckOut(id: string) {
    this.check('discardCheckOut');
    const f = this.byId(id);
    f.draft = undefined;
    f.checkedOut = false;
    f.eTag = this.tag();
  }
  async getLease(recordId: string) {
    this.check('getLease');
    const item = this.leases.get(recordId);
    return item && structuredClone(item);
  }
  async listLeases() {
    return [...this.leases.values()].map((l) => structuredClone(l));
  }
  async createLease(fields: LeaseFields) {
    this.check('createLease');
    if (this.leases.has(fields.Title)) throw new GraphError(409, 'Unique value violation');
    const item = { id: `lease-${++this.seq}`, eTag: this.tag(), fields: { ...fields } };
    this.leases.set(fields.Title, item);
    return structuredClone(item);
  }
  async updateLease(itemId: string, fields: LeaseFields, ifMatch: string) {
    this.check('updateLease');
    const item = [...this.leases.values()].find((l) => l.id === itemId);
    if (!item) throw new GraphError(404, 'Not found');
    if (item.eTag !== ifMatch) throw new GraphError(412, 'Precondition failed');
    item.fields = { ...fields };
    item.eTag = this.tag();
    return structuredClone(item);
  }
  async deleteLease(itemId: string, ifMatch: string) {
    this.check('deleteLease');
    const item = [...this.leases.values()].find((l) => l.id === itemId);
    if (!item) return;
    if (item.eTag !== ifMatch) throw new GraphError(412, 'Precondition failed');
    this.leases.delete(item.fields.Title);
  }

  // What a person sees and does in SharePoint directly, under their own account.
  path(recordId: string) {
    return `records/${encodeURIComponent(recordId)}.json`;
  }
  personView(recordId: string) {
    const f = this.files.get(this.path(recordId))!;
    return JSON.parse(f.published);
  }
  personEdit(recordId: string, change: (record: any) => void) {
    const f = this.files.get(this.path(recordId))!;
    if (f.checkedOut) throw new GraphError(423, `${recordId} is checked out by MIGTOOL`);
    const record = JSON.parse(f.published);
    change(record);
    f.published = JSON.stringify(record);
    f.eTag = this.tag();
  }
  // An edit that reaches the file despite the check-out (e.g. an administrator override).
  tamper(recordId: string, change: (record: any) => void) {
    const f = this.files.get(this.path(recordId))!;
    const record = JSON.parse(f.draft ?? f.published);
    change(record);
    if (f.checkedOut) f.draft = JSON.stringify(record);
    else f.published = JSON.stringify(record);
    f.eTag = this.tag();
  }
  isCheckedOut(recordId: string) {
    return this.files.get(this.path(recordId))?.checkedOut ?? false;
  }
}

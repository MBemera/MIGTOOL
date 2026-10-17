import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { PlatformError } from '../core/model';

// Folders managed by a sync client delay locks and turn colliding saves into conflict copies
// (spec section 10.1). The database and staging areas are refused inside one; the extract
// landing folder and CBS load folder may be synced because they are only ever read, or only
// ever receive complete folders that are never changed afterwards.
const syncSegment =
  /^(onedrive|onedrive - .+|sharepoint|dropbox|google drive|icloud drive|box sync)$/i;
export function isSynced(path: string): boolean {
  const full = resolve(path);
  const roots = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer]
    .filter((root): root is string => Boolean(root))
    .map((root) => resolve(root));
  return (
    roots.some((root) => full === root || full.startsWith(root + sep)) ||
    full.split(/[\\/]/).some((segment) => syncSegment.test(segment))
  );
}
const inside = (path: string, root: string) =>
  resolve(path) === resolve(root) || resolve(path).startsWith(resolve(root) + sep);
export function assertNotSynced(path: string, purpose: string): void {
  if (path === ':memory:') return;
  if (isSynced(path))
    throw new PlatformError(
      'SYNCED_PATH_REJECTED',
      `${purpose} must not be inside a synced folder (${resolve(path)}). Use a local or server path.`,
      500,
    );
}

const STAGING = '.staging';
// Prepares an output folder and its staging area. For a synced output folder the staging area
// must be outside the synced tree, so the sync client never sees a file being written, and on
// the same volume, so the final rename is a single atomic step rather than a copy.
export function prepareOutputFolder(root: string, staging = join(root, STAGING)) {
  if (isSynced(root) && inside(staging, root))
    throw new PlatformError(
      'STAGING_INSIDE_SYNC',
      `${root} is synced, so its staging area must be outside it. Set CBS_STAGING to a local folder on the same drive.`,
      500,
    );
  assertNotSynced(staging, 'The staging area');
  mkdirSync(root, { recursive: true });
  mkdirSync(staging, { recursive: true });
  if (statSync(root).dev !== statSync(staging).dev)
    throw new PlatformError(
      'STAGING_VOLUME',
      `Staging (${resolve(staging)}) and ${resolve(root)} are on different drives, so files could not be moved into place in one step. Use a staging folder on the same drive.`,
      500,
    );
  sweepStaging(staging);
  return { root, staging };
}
// Builds a folder in the staging area and renames it into place, so readers and sync clients
// only ever see a complete folder. Nothing is overwritten: an existing folder with identical
// content is a no-op and different content is an error, so there are never conflict copies.
export function writeFolderAtomic(
  root: string,
  name: string,
  files: Record<string, Uint8Array>,
  stagingRoot = join(root, STAGING),
) {
  if (!/^[\w.-]+$/.test(name) || name.startsWith('.'))
    throw new PlatformError('OUTPUT_NAME', `Invalid output folder name ${name}`, 500);
  if (isSynced(root) && inside(stagingRoot, root))
    throw new PlatformError('STAGING_INSIDE_SYNC', `Staging must be outside synced ${root}`, 500);
  const target = join(root, name),
    staging = join(stagingRoot, randomUUID());
  if (existsSync(target)) {
    if (sameFolder(target, files)) return { path: target, created: false };
    throw new PlatformError('OUTPUT_EXISTS', `${name} already exists with different content`, 409);
  }
  mkdirSync(staging, { recursive: true });
  try {
    for (const [file, bytes] of Object.entries(files)) {
      if (!/^[\w.-]+$/.test(file))
        throw new PlatformError('OUTPUT_NAME', `Invalid output file ${file}`, 500);
      const fd = openSync(join(staging, file), 'wx');
      try {
        writeSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    renameSync(staging, target);
    return { path: target, created: true };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
function sameFolder(path: string, files: Record<string, Uint8Array>) {
  const existing = readdirSync(path).sort();
  return (
    existing.join('/') === Object.keys(files).sort().join('/') &&
    existing.every((file) => Buffer.from(files[file]).equals(readFileSync(join(path, file))))
  );
}
// Staging left by a crash is removed on start, so an interrupted write leaves nothing behind.
// Only entries older than the grace period are removed, so a write in progress in another
// process sharing the folder is never deleted.
export function sweepStaging(staging: string, graceMs = 3600000) {
  if (!existsSync(staging)) return;
  for (const entry of readdirSync(staging)) {
    const path = join(staging, entry);
    if (graceMs <= 0 || Date.now() - statSync(path).mtimeMs >= graceMs)
      rmSync(path, { recursive: true, force: true });
  }
}
// Names that indicate temp files or sync conflict copies; used by health checks and tests.
export const tempOrConflict =
  /(\.crswap$|\.tmp$|~$|^~\$|\.partial$|-conflict|conflicted copy| \(\d+\)\.[^.]+$|-(DESKTOP|LAPTOP)-[A-Z0-9]+\.)/i;
export function strayFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === STAGING) found.push(...readdirSync(path).map((f) => join(path, f)));
        else walk(path);
      } else if (tempOrConflict.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

// Reads one Bank 1 extract package from a (possibly synced) landing folder without changing it.
// Anything a sync client or an open spreadsheet could leave half-finished stops the import with
// a message saying what to do; checksums in control.csv catch anything else.
export function readExtractPackage(dir: string, settleMs = 30000, now = Date.now()) {
  const files: Record<string, string> = {},
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  if (!existsSync(dir)) throw new PlatformError('EXTRACT_MISSING', `${dir} does not exist`, 404);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (!entry.isFile() || /^(desktop\.ini|thumbs\.db|\.ds_store)$/i.test(name)) continue;
    if (name.startsWith('~$'))
      throw new PlatformError(
        'EXTRACT_LOCKED',
        `${name.slice(2)} is open in Excel or another program. Close it, let OneDrive finish syncing, then import again.`,
        409,
      );
    if (tempOrConflict.test(name))
      throw new PlatformError(
        'EXTRACT_CONFLICT',
        `${name} is a temporary file or sync conflict copy. Resolve it in OneDrive, then import again.`,
        409,
      );
    if (!name.toLowerCase().endsWith('.csv')) continue;
    const path = join(dir, name);
    let bytes: Buffer;
    try {
      if (now - statSync(path).mtimeMs < settleMs)
        throw new PlatformError(
          'EXTRACT_SYNCING',
          `${name} changed less than ${Math.round(settleMs / 1000)} seconds ago. Wait for OneDrive to finish syncing, then import again.`,
          409,
        );
      bytes = readFileSync(path);
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError(
        'EXTRACT_UNAVAILABLE',
        `${name} could not be read. If it is an online-only OneDrive file, choose "Always keep on this device" for the landing folder.`,
        409,
      );
    }
    try {
      files[name] = decoder.decode(bytes);
    } catch {
      throw new PlatformError('EXTRACT_ENCODING', `${name} is not valid UTF-8`);
    }
  }
  return files;
}
// Extract packages waiting in the landing folder: one subfolder each, holding a control file.
export function landingPackages(root: string, control: string) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(root, e.name, control)),
    )
    .map((e) => ({
      name: e.name,
      modifiedAt: new Date(statSync(join(root, e.name, control)).mtimeMs).toISOString(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

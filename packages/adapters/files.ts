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
// (spec section 10.1). Every path the platform writes to is refused if it sits inside one.
const syncSegment =
  /^(onedrive|onedrive - .+|sharepoint|dropbox|google drive|icloud drive|box sync)$/i;
export function assertNotSynced(path: string, purpose: string): void {
  if (path === ':memory:') return;
  const full = resolve(path);
  const roots = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer]
    .filter((root): root is string => Boolean(root))
    .map((root) => resolve(root));
  if (
    roots.some((root) => full === root || full.startsWith(root + sep)) ||
    full.split(/[\\/]/).some((segment) => syncSegment.test(segment))
  )
    throw new PlatformError(
      'SYNCED_PATH_REJECTED',
      `${purpose} must not be inside a synced folder (${full}). Use a local or server path.`,
      500,
    );
}

const STAGING = '.staging';
// Builds a folder in a hidden staging area and renames it into place, so readers only ever see
// a complete folder. Nothing is overwritten: an existing folder with identical content is a
// no-op and different content is an error, so there are never conflict copies.
export function writeFolderAtomic(root: string, name: string, files: Record<string, Uint8Array>) {
  if (!/^[\w.-]+$/.test(name) || name.startsWith('.'))
    throw new PlatformError('OUTPUT_NAME', `Invalid output folder name ${name}`, 500);
  const target = join(root, name),
    staging = join(root, STAGING, randomUUID());
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
export function sweepStaging(root: string, graceMs = 3600000) {
  const staging = join(root, STAGING);
  if (!existsSync(staging)) return;
  for (const entry of readdirSync(staging)) {
    const path = join(staging, entry);
    if (Date.now() - statSync(path).mtimeMs >= graceMs)
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

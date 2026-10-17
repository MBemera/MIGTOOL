import { type Envelope, type Pack, PlatformError } from '../packages/core/model';
type Upgrade = (data: Envelope['data']) => Envelope['data'];
const registry: Record<string, { to: string; upgrade: Upgrade }> = {
  'aaf-v73-demo': { to: 'aaf-v73.1-demo', upgrade: (data) => structuredClone(data) },
};
export function migrate(record: Envelope, pack: Pack): { record: Envelope; versions: string[] } {
  if (['exported', 'loaded', 'reconciled', 'amendment_pending', 'withdrawn'].includes(record.state))
    return { record, versions: [] };
  const result = structuredClone(record),
    versions: string[] = [];
  while (result.schemaVersion !== pack.schema.version) {
    const migration = registry[result.schemaVersion];
    if (!migration || versions.includes(migration.to))
      throw new PlatformError(
        'MIGRATION_MISSING',
        `No reviewed migration from ${result.schemaVersion} to ${pack.schema.version}`,
        409,
      );
    result.data = migration.upgrade(result.data);
    result.schemaVersion = migration.to;
    versions.push(migration.to);
  }
  return { record: result, versions };
}

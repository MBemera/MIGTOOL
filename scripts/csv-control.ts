import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, loadPack } from '../packages/adapters/config';
import { parseCsv } from '../packages/adapters/csv-extract';

// Writes the control file (row counts and SHA-256 per data file) for a Bank 1 CSV extract folder.
const dir = process.argv[2];
if (!dir) throw new Error('Usage: npm run csv:control -- <extract folder>');
const layout = loadPack().ingest.csv!;
const lines = ['FILE,ROWS,SHA256'];
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.csv') && f !== layout.control)
  .sort()) {
  const text = readFileSync(join(dir, file), 'utf8');
  lines.push(`${file},${parseCsv(text, file).rows.length},${hash(text)}`);
}
writeFileSync(join(dir, layout.control), lines.join('\r\n') + '\r\n');
console.log(`Wrote ${join(dir, layout.control)} for ${lines.length - 1} files`);

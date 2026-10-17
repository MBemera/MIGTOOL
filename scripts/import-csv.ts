import { importCsv } from '../packages/worker/commands';

// Imports a Bank 1 CSV extract folder (WF-01): npm run import:csv -- <folder> [--full-snapshot]
const dir = process.argv[2];
if (!dir) throw new Error('Usage: npm run import:csv -- <extract folder> [--full-snapshot]');
const batch = await importCsv(dir, process.argv.includes('--full-snapshot'));
console.log(JSON.stringify(batch, null, 2));

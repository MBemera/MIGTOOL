import { randomUUID } from 'node:crypto';
process.env.MIGTOOL_DEMO_DATABASE_PATH = `var/e2e-${randomUUID()}.sqlite`;
process.argv.push('--demo');
await import('./dev');

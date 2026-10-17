import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const demo = process.argv.includes('--demo'),
  children: ReturnType<typeof spawn>[] = [];
if (demo)
  console.log(
    'Synthetic demo accounts: admin / demo-admin-2026 | operator / demo-operator-2026 | reviewer / demo-reviewer-2026',
  );
const env = {
  ...process.env,
  ...(demo
    ? { DEMO_MODE: '1', DATABASE_PATH: process.env.MIGTOOL_DEMO_DATABASE_PATH ?? 'var/demo.sqlite' }
    : {}),
};
const launch = (module: string, args: string[]) => {
  const child = spawn(process.execPath, [resolve(module), ...args], { env, stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code) => {
    if (code && code !== 0) {
      children.forEach((c) => c.kill());
      process.exitCode = code;
    }
  });
};
const backend = spawn(process.execPath, ['--import', 'tsx', 'packages/server/index.ts'], {
  env,
  stdio: 'inherit',
});
children.push(backend);
backend.on('exit', (code) => {
  children.forEach((c) => {
    if (c !== backend) c.kill();
  });
  if (code) process.exitCode = code;
});
launch('node_modules/vite/bin/vite.js', []);
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => children.forEach((c) => c.kill(sig as NodeJS.Signals)));

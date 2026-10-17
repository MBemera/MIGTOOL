import { createApp } from './app';
const demo = process.env.DEMO_MODE === '1',
  host = process.env.HOST ?? '127.0.0.1',
  port = Number(process.env.PORT ?? 3001);
if (demo && !['127.0.0.1', 'localhost', '::1'].includes(host))
  throw new Error('Synthetic demo must bind to loopback');
const runtime = createApp({ demo });
const server = runtime.app.listen(port, host, () =>
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'server_started',
      host,
      port,
      demo,
      cbs: 'simulated',
      llm: 'disabled',
    }),
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close(() => {
      runtime.close();
      process.exit(0);
    });
  });

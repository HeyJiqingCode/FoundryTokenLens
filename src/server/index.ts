import { buildApp } from './app.js';
import { readConfig } from './config.js';

process.umask(0o077);

try {
  const config = readConfig();
  const app = await buildApp(config, true, { workerEnabled: true });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch((error: unknown) => {
        app.log.error(error, 'Failed to shut down cleanly');
        process.exitCode = 1;
      });
    });
  }
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Failed to start Foundry Token Lens');
  process.exitCode = 1;
}

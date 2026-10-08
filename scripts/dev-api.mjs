import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const apiPort = Number(process.env.FTL_DEV_API_PORT ?? '8081');
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535 || apiPort === 8080) {
  throw new Error('FTL_DEV_API_PORT must be a valid port other than the preview port 8080.');
}

const child = spawn(
  process.execPath,
  [require.resolve('tsx/cli'), 'watch', 'src/server/index.ts'],
  {
    cwd: root,
    env: {
      ...process.env,
      FTL_HOST: '127.0.0.1',
      FTL_PORT: String(apiPort),
      FTL_PUBLIC_URL: process.env.FTL_PUBLIC_URL || '',
      FTL_DEV_PUBLIC_URL: 'http://localhost:8080',
      // Vite serves the UI on 8080; point the API at a directory without one.
      FTL_WEB_DIR: join(tmpdir(), 'foundry-token-lens-no-ui'),
    },
    stdio: 'inherit',
  },
);

child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

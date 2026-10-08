import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 8080,
    strictPort: true,
    cors: false,
    proxy: { '^/api(?:/|$)': `http://127.0.0.1:${process.env.FTL_DEV_API_PORT ?? '8081'}` },
    fs: {
      strict: true,
      allow: [fromRoot('./src/web'), fromRoot('./src/shared'), fromRoot('./node_modules')],
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        '**/data/**',
        '**/.secret-key',
        '**/*.sqlite',
        '**/*.sqlite-*',
      ],
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});

import { resolve } from 'node:path';
import { normalizePublicUrl } from '../shared/public-url.js';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  webDir: string;
  publicUrl?: string;
  defaultPublicUrl?: string;
  secretKey?: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.FTL_PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('FTL_PORT must be an integer between 1 and 65535.');
  }
  return {
    host: env.FTL_HOST ?? '127.0.0.1',
    port,
    dataDir: resolve('data'),
    webDir: resolve(env.FTL_WEB_DIR ?? 'dist/web'),
    publicUrl: env.FTL_PUBLIC_URL ? normalizePublicUrl(env.FTL_PUBLIC_URL) : undefined,
    defaultPublicUrl: env.FTL_DEV_PUBLIC_URL
      ? normalizePublicUrl(env.FTL_DEV_PUBLIC_URL)
      : undefined,
    secretKey: env.FTL_SECRET_KEY || undefined,
  };
}

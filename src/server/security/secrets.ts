import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createSecretStore(
  dataDir: string,
  configuredKey?: string,
  requireExistingKey = false,
) {
  const path = join(dataDir, '.secret-key');
  if (!configuredKey && !existsSync(path)) {
    if (requireExistingKey)
      throw new Error(
        'Credential encryption key is missing. Restore .secret-key or provide FTL_SECRET_KEY.',
      );
    try {
      writeFileSync(path, randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const encoded = (configuredKey ?? readFileSync(path, 'utf8')).trim();
  const master = Buffer.from(encoded, 'base64');
  if (master.length !== 32 || master.toString('base64') !== encoded) {
    throw new Error('FTL_SECRET_KEY must be a base64 encoded 32-byte key.');
  }
  const key = createHmac('sha256', master).update('ftl:source-credentials:v1').digest();
  return {
    authSecret: createHmac('sha256', master).update('ftl:authentication:v1').digest('base64'),
    encrypt(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from('ftl:source:v1'));
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [
        'v1',
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        encrypted.toString('base64'),
      ].join('.');
    },
    decrypt(value: string) {
      const [version, iv, tag, encrypted, extra] = value.split('.');
      if (version !== 'v1' || !iv || !tag || !encrypted || extra)
        throw new Error('Invalid encrypted credential.');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from('ftl:source:v1'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

export type SecretStore = ReturnType<typeof createSecretStore>;

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSecretStore } from '../src/server/security/secrets.js';

test('credentials use authenticated encryption and the persisted key survives reopening', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-key-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createSecretStore(directory);
  const sealed = store.encrypt('synthetic-credential');
  assert.notEqual(sealed, store.encrypt('synthetic-credential'));
  assert.equal(createSecretStore(directory).decrypt(sealed), 'synthetic-credential');
  const parts = sealed.split('.');
  parts[2] = Buffer.alloc(16).toString('base64');
  assert.throws(() => store.decrypt(parts.join('.')));
  assert.throws(() =>
    createSecretStore(directory, Buffer.alloc(32, 1).toString('base64')).decrypt(sealed),
  );
});

test('missing protection key never silently creates a replacement for existing credentials', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-key-loss-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  createSecretStore(directory);
  unlinkSync(join(directory, '.secret-key'));
  assert.throws(() => createSecretStore(directory, undefined, true), /key is missing/);
  assert.equal(existsSync(join(directory, '.secret-key')), false);
});

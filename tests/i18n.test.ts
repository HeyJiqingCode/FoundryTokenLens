import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parsers } from 'prettier/plugins/typescript';
import { catalogs, enUS, zhCN, isMessageKey, type MessageKey } from '../src/shared/i18n/catalog.js';
import { message, formatSystemMessage, translate } from '../src/shared/i18n/translate.js';
import { t } from '../src/web/i18n/index.js';
import { getLocale, isLocale, setLocale, subscribeLocale } from '../src/web/i18n/locale.js';
import { usd } from '../src/web/features/analytics/format.js';
import { ENTRA_LOGIN_ERRORS, entraLoginError } from '../src/shared/entra-errors.js';
import { SETTINGS_SECTIONS } from '../src/shared/navigation.js';
import { APP_PAGES, REPORT_SECTIONS } from '../src/shared/navigation.js';

const parameters = (text: string) =>
  [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
const variants = (value: string | { one: string; other: string }) =>
  typeof value === 'string' ? [value] : [value.one, value.other];

test('stable keys select independently maintained languages and preserve interpolation data', () => {
  assert.equal(translate('navigation.overview', 'en-US'), 'Overview');
  assert.equal(translate('navigation.overview', 'zh-CN'), '概览');
  assert.equal(
    translate('auth.editNamedUser', 'en-US', { name: '林晓 <example>' }),
    'Edit 林晓 <example>',
  );
  assert.equal(translate('auth.editNamedUser', 'en-US', { name: '用户管理' }), 'Edit 用户管理');
  assert.equal(translate('auth.editNamedUser', 'en-US', { name: 'auth.admin' }), 'Edit auth.admin');
  assert.equal(translate('auth.newPassword', 'en-US'), 'Password');
  assert.equal(translate('auth.confirmNewPassword', 'en-US'), 'Confirm password');
  assert.equal(translate('auth.confirmNewPassword', 'zh-CN'), '确认新密码');
  assert.equal(isMessageKey('navigation.overview'), true);
  assert.equal(isMessageKey('概览'), false);
});

test('counted phrases use natural English plurals while preserving Chinese and number grouping', () => {
  assert.equal(translate('insights.callCount', 'en-US', { count: 1 }), '1 call');
  assert.equal(translate('insights.callCount', 'en-US', { count: 2 }), '2 calls');
  assert.equal(translate('insights.callCount', 'en-US', { count: 1000 }), '1,000 calls');
  assert.equal(translate('common.dayCount', 'en-US', { count: 1 }), '1 day');
  assert.equal(translate('common.dayCount', 'zh-CN', { count: 2 }), '2 天');
  assert.equal(
    translate('sources.connectionAvailable', 'en-US', { count: 1 }),
    'Connected. 1 log container is available.',
  );
  assert.equal(
    translate('sources.connectionAvailable', 'en-US', { count: 3 }),
    'Connected. 3 log containers are available.',
  );
});

test('notices retain locale-independent keys, including nested failure details', () => {
  const notice = message('auth.profilePartiallySaved', {
    error: message('errors.httpStatus', { status: 503 }),
  });
  assert.equal(
    formatSystemMessage(notice, 'zh-CN'),
    '邮箱已更新，显示名称保存失败：请求失败（503）。',
  );
  assert.equal(
    formatSystemMessage(notice, 'en-US'),
    'Email updated, but the display name could not be saved: Request failed (503).',
  );
  assert.deepEqual(notice, {
    key: 'auth.profilePartiallySaved',
    params: { error: { key: 'errors.httpStatus', params: { status: 503 } } },
  });
});

test('raw historical messages and user content are never reverse translated', () => {
  for (const text of [
    '完成',
    '该邮箱已被使用。',
    '日志缺少 cacheWriteTokens',
    'custom-model-name',
    '用户填写的备注 <keep>',
  ])
    assert.equal(formatSystemMessage(text, 'en-US'), text);
  assert.equal(
    formatSystemMessage('auth.emailIsAlreadyInUse', 'en-US'),
    'This email is already in use.',
  );
});

test('Entra callbacks use stable message keys and never echo untrusted descriptions', () => {
  for (const [code, key] of Object.entries(ENTRA_LOGIN_ERRORS)) {
    assert.equal(entraLoginError(new URLSearchParams({ auth_error: code })), key);
    assert.ok(isMessageKey(key), code);
    assert.equal(/\p{Script=Han}/u.test(formatSystemMessage(key, 'en-US')), false);
  }
  const error = (query: string) =>
    formatSystemMessage(entraLoginError(new URLSearchParams(query))!, 'zh-CN');
  assert.match(error('auth_error=entra&error=unable_to_get_user_info'), /无法获取或校验/);
  assert.match(error('auth_error=entra&error=invalid_code'), /授权码兑换失败/);
  assert.match(error('auth_error=entra&error=state_mismatch'), /会话已过期/);
  assert.equal(
    error('auth_error=unknown&error_description=private-data').includes('private-data'),
    false,
  );
  assert.equal(entraLoginError(new URLSearchParams()), null);
});

test('locale changes notify subscribers once, keep USD stable, and work without browser storage', () => {
  setLocale('zh-CN');
  const amount = usd('1234.5678');
  let changes = 0;
  const unsubscribe = subscribeLocale(() => {
    changes++;
  });
  setLocale('en-US');
  assert.equal(getLocale(), 'en-US');
  assert.equal(t('auth.signIn'), 'Sign in');
  assert.equal(usd('1234.5678'), amount);
  setLocale('en-US');
  assert.equal(changes, 1);
  setLocale('zh-CN');
  assert.equal(changes, 2);
  unsubscribe();
  assert.equal(isLocale('fr-FR'), false);
  assert.equal(isLocale(undefined), false);
});

test('both languages have matching stable keys, interpolation parameters and complete plural variants', () => {
  assert.deepEqual(Object.keys(enUS).sort(), Object.keys(zhCN).sort());
  const nativeLabels = new Set(['common.languageChinese', 'common.switchToChinese']);
  for (const key of Object.keys(zhCN) as MessageKey[]) {
    assert.match(key, /^[a-z]+\.[A-Za-z][A-Za-z0-9]*$/);
    const expected = parameters(zhCN[key]);
    for (const locale of ['zh-CN', 'en-US'] as const) {
      for (const value of variants(catalogs[locale][key])) {
        if (key !== 'common.empty') assert.ok(value.trim(), key);
        assert.deepEqual(parameters(value), expected, `${locale}: ${key}`);
        if (locale === 'en-US' && !nativeLabels.has(key))
          assert.equal(/\p{Script=Han}/u.test(value), false, key);
      }
    }
  }
});

test('interface translation calls use valid stable keys and named parameters', () => {
  const files = readdirSync('src/web', { recursive: true }).filter(
    (file) => /\.tsx?$/.test(String(file)) && !String(file).startsWith('i18n/'),
  );
  function walk(node: any, file: string) {
    if (
      node.type === 'CallExpression' &&
      ['t', 'message'].includes(node.callee?.name) &&
      node.arguments[0]?.type === 'Literal'
    ) {
      const key = node.arguments[0].value;
      assert.ok(typeof key === 'string' && isMessageKey(key), `${file}: ${key}`);
      const params = node.arguments[1];
      const names =
        params?.type === 'ObjectExpression'
          ? params.properties.map((p: any) => String(p.key?.name ?? p.key?.value)).sort()
          : [];
      assert.deepEqual(names, parameters(zhCN[key as MessageKey]), `${file}: ${key}`);
    }
    if (node.type === 'JSXText')
      assert.equal(/\p{Script=Han}/u.test(node.value), false, `${file}: untranslated JSX text`);
    for (const [name, value] of Object.entries(node)) {
      if (['loc', 'range', 'tokens', 'comments'].includes(name)) continue;
      for (const child of Array.isArray(value) ? value : [value])
        if (child && typeof child === 'object' && 'type' in child) walk(child, file);
    }
  }
  for (const file of files) {
    const path = join('src/web', String(file));
    walk(parsers.typescript.parse(readFileSync(path, 'utf8'), { filepath: path } as never), path);
  }
  for (const item of [...SETTINGS_SECTIONS, ...REPORT_SECTIONS, ...APP_PAGES])
    assert.ok(isMessageKey(item.label), item.label);
});

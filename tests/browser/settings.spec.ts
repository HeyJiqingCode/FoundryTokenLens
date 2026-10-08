import { test, expect } from '@playwright/test';
import { mockApi, openTask } from './fixtures';

test('setup submits the entered name and session loading is not a login failure', async ({
  page,
}) => {
  const state = await mockApi(page);
  let release!: () => void;
  state.sessionPending = new Promise((r) => (release = r));
  await page.goto('/settings/data');
  await expect(page.locator('.auth-loading')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toHaveCount(0);
  release();
  await expect(page.locator('.app-shell')).toBeVisible();
  state.sessionPending = undefined;
  state.setup = true;
  await page.goto('/login?language=en-US');
  await page.getByLabel('Display name', { exact: true }).fill('My Admin');
  await page.getByLabel('Email', { exact: true }).fill('test@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Testing8!');
  await page.getByLabel('Confirm password', { exact: true }).fill('Testing8!');
  await page.getByRole('button', { name: 'Create and sign in', exact: true }).click();
  await expect
    .poll(() => state.requests.find((r) => r.path === 'setup')?.body.name)
    .toBe('My Admin');
});

test('a failed sign-in keeps its error visible', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { user: null, setupRequired: false } }),
  );
  await page.route('**/api/auth/sign-in/email', (route) =>
    route.fulfill({ status: 401, json: { code: 'INVALID_EMAIL_OR_PASSWORD' } }),
  );
  await page.goto('/login?language=en-US');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.toast-message')).toHaveText('Incorrect email or password.');
});

test('default task name stays a key, edited names stay data and empty interval stays empty', async ({
  page,
}) => {
  const state = await mockApi(page);
  let d = await openTask(page);
  await expect(d.locator('input[name=taskName]')).toHaveValue('日常任务');
  await d.getByRole('button', { name: '保存定时任务', exact: true }).click();
  await expect(d).toBeHidden();
  expect(state.task.name).toBe('schedule.defaultTask');
  await page.goto('/settings/data?language=en-US');
  await page.getByRole('button', { name: 'Edit scheduled task', exact: true }).click();
  d = page.getByRole('dialog');
  await expect(d.locator('input[name=taskName]')).toHaveValue('Routine task');
  await d.locator('input[name=daytimeInterval]').fill('');
  await expect(d.locator('input[name=daytimeInterval]')).toHaveValue('');
  await d.locator('input[name=daytimeInterval]').fill('15');
  await d.locator('input[name=taskName]').fill('My task');
  await d.getByRole('button', { name: 'Save scheduled task', exact: true }).click();
  await expect(d).toBeHidden();
  expect(state.task.name).toBe('My task');
  expect(state.task.daytime.intervalMinutes).toBe(15);
});

test('opening a non-five-minute time does not change it; explicit wheel choice does', async ({
  page,
}) => {
  await mockApi(page);
  const d = await openTask(page),
    period = d.locator('.task-period').first(),
    input = period.locator('.date-input').first();
  await expect(input).toContainText('37');
  await period.getByRole('button', { name: /开始时间/ }).click();
  await page.waitForTimeout(450);
  await expect(input).toContainText('37');
  await page.locator('.time-wheel').nth(1).getByRole('button', { name: '40', exact: true }).click();
  await expect(input).toContainText('40');
  await page.keyboard.press('Escape');
  await expect(page.locator('.clock-options')).toBeHidden();
  await expect(d).toBeVisible();
});

test('busy deletion cannot be cancelled by buttons or repeated Escape; errors remain visible', async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto('/settings/data?language=zh-CN');
  await page.getByRole('button', { name: '删除数据源', exact: true }).click();
  const d = page.getByRole('dialog', { name: '删除数据源', exact: true });
  await d.locator('input').fill('fixtureblob');
  let release!: () => void;
  state.deletePending = new Promise((r) => (release = r));
  state.failDelete = true;
  await d.getByRole('button', { name: '删除数据源', exact: true }).click();
  await expect(d.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(d).toBeVisible();
  await expect(d).toHaveJSProperty('open', true);
  release();
  await expect(d.locator('.toast-message')).toBeVisible();
  await expect(d.getByRole('button', { name: '取消', exact: true })).toBeEnabled();
  await d.getByRole('button', { name: '取消', exact: true }).click();
  await expect(d).toBeHidden();
});

test('multiselect exposes current values and toast announcements are mounted before content', async ({
  page,
}) => {
  await mockApi(page);
  const d = await openTask(page);
  await expect(d.locator('.multi-select-trigger')).toHaveAccessibleDescription('fixtureblob');
  await expect(d.locator('[aria-live=polite]')).toBeEmpty();
  await expect(d.getByRole('alert')).toBeEmpty();
});

test('busy task save keeps the dialog open and announces a locale-independent error', async ({
  page,
}) => {
  const state = await mockApi(page);
  const d = await openTask(page);
  let release!: () => void;
  state.taskPending = new Promise((r) => (release = r));
  await d.getByRole('button', { name: '保存定时任务', exact: true }).click();
  await expect(d.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(d).toBeVisible();
  release();
  await expect(d).toBeHidden();
});

test('API error codes render in English and toast lasts three seconds', async ({ page }) => {
  const state = await mockApi(page);
  state.failDelete = true;
  await page.clock.install();
  await page.goto('/settings/data?language=en-US');
  await page.getByRole('button', { name: 'Delete data source', exact: true }).click();
  const d = page.getByRole('dialog');
  await d.locator('input').fill('fixtureblob');
  await d.getByRole('button', { name: 'Delete data source', exact: true }).click();
  const toast = d.locator('.toast-message');
  await expect(toast).toHaveText('Data source not found or already deleted.');
  await page.mouse.move(0, 0);
  await page.clock.fastForward(2000);
  await expect(toast).toBeVisible();
  await page.clock.fastForward(1001);
  await expect(toast).toHaveCount(0);
});

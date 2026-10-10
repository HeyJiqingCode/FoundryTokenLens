import { expect, type Page } from '@playwright/test';
import { accumulator } from '../../src/server/analytics/aggregate';
import { taskDefaults } from '../../src/shared/scheduled-tasks';
import type { AnalyticsResponse } from '../../src/shared/analytics';
import type { SourceSettings } from '../../src/shared/settings';
import type { RequestFact } from '../../src/shared/ingestion';
export const source: SourceSettings = {
  id: 'fixture-source',
  accountName: 'fixtureblob',
  endpoint: 'https://fixtureblob.blob.core.windows.net',
  enabled: true,
  containers: [],
  authMode: 'connection_string',
  managedIdentityClientId: '',
  hasConnectionString: true,
  availableContainers: [],
  verifiedAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};
export const user = {
  id: 'fixture-admin',
  name: 'Fixture Admin',
  email: 'admin@example.test',
  role: 'admin',
  enabled: true,
  isInitialAdmin: true,
};
export const fact: RequestFact = {
  resourceId: 'fixture-resource',
  correlationId: 'fixture-request',
  time: '2026-09-28T00:00:00Z',
  model: 'fixture-model',
  modelVersion: 'v1',
  deployment: 'fixture',
  region: 'eastus2',
  operation: 'responses',
  inputTokens: '100',
  outputTokens: '10',
  cachedTokens: '20',
  cacheWriteTokens: null,
  durationMs: 200,
  timeToFirstTokenMs: 100,
  statusCode: 200,
  callerIp: '192.0.2.1',
  hasUsage: true,
  hasRequest: true,
};
export function report(): AnalyticsResponse {
  const a = accumulator();
  a.add(fact);
  const summary = a.result();
  return {
    generatedAt: '2026-09-28T00:00:00Z',
    timezone: 'Asia/Shanghai',
    summary,
    timeline: [{ date: fact.time, ...summary }],
    models: [{ name: fact.model!, ...summary }],
    resources: [],
    ips: [],
    facets: { models: [fact.model!], resources: [fact.resourceId], ips: [] },
  };
}
export async function mockApi(page: Page) {
  const state = {
    setup: false,
    sessionPending: undefined as Promise<void> | undefined,
    failDelete: false,
    deletePending: undefined as Promise<void> | undefined,
    taskPending: undefined as Promise<void> | undefined,
    brokenReport: false,
    /** Replaces the one-call report, for views that need groups, bins and lists. */
    report: undefined as AnalyticsResponse | undefined,
    revision: '1',
    running: false,
    requests: [] as { path: string; method: string; body: any }[],
    task: {
      ...taskDefaults('daily'),
      id: 'fixture-task',
      name: 'schedule.defaultTask',
      enabled: false,
      sourceIds: [source.id],
      timezone: 'Asia/Shanghai',
      daytime: { startTime: '08:37', endTime: '20:37', intervalMinutes: 5 },
      nighttime: { intervalMinutes: 60 },
      updatedAt: '2026-09-01T00:00:00Z',
    },
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.slice(5);
    state.requests.push({ path, method: req.method(), body: req.postDataJSON() });
    let body: unknown = {},
      status = 200;
    if (path === 'session') {
      await state.sessionPending;
      body = {
        user: state.setup ? null : user,
        setupRequired: state.setup,
      };
    } else if (path === 'setup') {
      state.setup = false;
      body = { user };
    } else if (path === 'auth/sign-in/email') body = { user };
    else if (path === 'bootstrap') body = { version: '0.1.0', dataStatus: 'configured' };
    else if (path === 'ingestion')
      body = {
        dataRevision: state.revision,
        configured: true,
        running: state.running,
        runs: [],
        issues: [],
        requestCount: 1,
        resourceCount: 1,
      };
    else if (path === 'analytics')
      body = state.brokenReport ? { ...report(), models: null } : (state.report ?? report());
    else if (path === 'analytics/facets') body = report().facets;
    else if (path === 'requests') body = { requests: [fact], total: 60 };
    else if (path === 'requests/detail') body = { request: fact };
    else if (path === 'requests/evidence') body = { records: [] };
    else if (path === 'settings/tasks') body = { tasks: [state.task] };
    else if (path === 'settings/tasks/' + state.task.id) {
      await state.taskPending;
      state.task = { ...state.task, ...req.postDataJSON() };
      body = { task: state.task };
    } else if (path === 'settings/sources') body = { sources: [source] };
    else if (path.endsWith('/statistics')) body = { statistics: null };
    else if (path === 'settings/sources/' + source.id && req.method() === 'DELETE') {
      await state.deletePending;
      if (state.failDelete) {
        status = 409;
        body = { code: 'sources.sourceNotFound' };
      } else body = { deleted: true };
    } else throw Error('Unmocked API: ' + path);
    await route.fulfill({ status, json: body });
  });
  return state;
}
export async function openTask(page: Page) {
  await page.goto('/settings/data?language=zh-CN');
  await page.getByRole('button', { name: '编辑定时任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑定时任务', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

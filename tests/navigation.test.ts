import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginPath, requestPage, safeReturnPath } from '../src/shared/navigation.js';
import {
  emptyFilters,
  filterQuery,
  filterSearch,
  readFilters,
} from '../src/web/features/analytics/useAnalytics.js';

test('login return paths preserve local pages and filters without allowing external or reserved destinations', () => {
  const destination = '/analysis/tokens?from=2026-09-01&model=fixture%2Bchat#details';
  assert.equal(safeReturnPath(destination), destination);
  assert.equal(safeReturnPath('/unknown-page'), '/unknown-page');
  for (const unsafe of [
    null,
    undefined,
    '',
    'https://evil.example',
    '//evil.example/path',
    '/\\evil.example',
    '/%2F%2Fevil.example',
    '/%5Cevil.example',
    '/%0aevil',
    '/%ZZ',
    '/login?returnTo=/settings/users',
    '/login/',
    '/%6cogin',
    '/api/auth/sign-out',
    '/assets/app.js',
    '/data/foundry-token-lens.sqlite',
    '/' + 'x'.repeat(8192),
  ]) {
    assert.equal(safeReturnPath(unsafe), '/overview', String(unsafe));
  }
  const login = new URL(loginPath(destination, true), 'https://token-lens.example');
  assert.equal(login.pathname, '/login');
  assert.equal(login.searchParams.get('returnTo'), destination);
  assert.equal(login.searchParams.get('auth_error'), 'entra');
});

test('URL filters round-trip resource identifiers and dates without converting display dates to timestamps', () => {
  const filters = {
    from: '2026-09-01',
    to: '2026-09-21',
    model: 'fixture model + cache',
    resourceId:
      '/subscriptions/fixture/resourceGroups/example/providers/Microsoft.CognitiveServices/accounts/test',
    ip: '2001:db8::1',
    status: 'error',
  };
  const search = filterSearch(filters);
  const params = new URLSearchParams(search);
  assert.equal(params.get('from'), '2026-09-01');
  assert.equal(params.get('to'), '2026-09-21');
  assert.deepEqual(readFilters(params), filters);
  const api = new URLSearchParams(filterQuery(readFilters(params)));
  assert.equal(api.get('resourceId'), filters.resourceId);
  assert.equal(api.get('model'), filters.model);
  assert.equal(api.get('status'), 'error');
  assert.equal(api.get('from'), '2026-08-31T16:00:00.000Z');
  assert.equal(api.get('to'), '2026-09-21T16:00:00.000Z');
  assert.equal(filterSearch(emptyFilters), '');
});

test('malformed date and oversized filter parameters cannot crash a pasted link', () => {
  const invalid = new URLSearchParams({
    from: 'not-a-date',
    to: '2026-02-30',
    model: 'x'.repeat(161),
    resourceId: 'x'.repeat(2049),
    ip: 'x'.repeat(201),
    status: '429',
  });
  assert.deepEqual(readFilters(invalid), emptyFilters);
  assert.doesNotThrow(() => filterQuery(readFilters(invalid)));
  assert.equal(readFilters(new URLSearchParams('from=2024-02-29')).from, '2024-02-29');
  assert.equal(readFilters(new URLSearchParams('from=2025-02-29')).from, '');
});

test('request pagination from the URL respects the API offset limit', () => {
  assert.equal(requestPage('2'), 2);
  assert.equal(requestPage('400001'), 400001);
  for (const invalid of [null, '', '0', '-1', '1.5', 'Infinity', '2e2', '400002', '9'.repeat(100)])
    assert.equal(requestPage(invalid), 1);
});

test('relative ranges, absolute instants and granularities persist while unsafe filter values are ignored', () => {
  const relative = readFilters(
    new URLSearchParams(
      'range=30m&interval=1m&timezone=Asia%2FShanghai&link=response_only&status=429',
    ),
  );
  const query = new URLSearchParams(filterQuery(relative, Date.parse('2026-09-28T10:00:00Z')));
  assert.equal(query.get('from'), '2026-09-28T09:30:00.000Z');
  assert.equal(query.get('to'), '2026-09-28T10:00:00.000Z');
  assert.equal(query.get('interval'), '1m');
  assert.equal(query.has('link'), false);
  assert.equal(readFilters(new URLSearchParams(filterSearch(relative))).range, '30m');
  const invalid = readFilters(
    new URLSearchParams(
      'timezone=unknown&kind=unknown&status=inject&link=unknown&range=wrong&interval=wrong',
    ),
  );
  assert.deepEqual(invalid, emptyFilters);
});

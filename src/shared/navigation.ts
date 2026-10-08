export const SETTINGS_SECTIONS = [
  { id: 'data', label: 'navigation.dataManagement' },
  { id: 'prices', label: 'navigation.prices' },
  { id: 'users', label: 'navigation.authentication' },
  { id: 'platform', label: 'navigation.platform' },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];

export interface BootstrapResponse {
  version: string;
  dataStatus: 'not_connected' | 'configured';
}

export const REPORT_SECTIONS = [
  { id: 'cost', label: 'insights.costView' },
  { id: 'tokens', label: 'insights.tokenView' },
  { id: 'distribution', label: 'insights.distributionView' },
  { id: 'performance', label: 'insights.performanceView' },
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number]['id'];

export const APP_PAGES = [
  { path: '/overview', label: 'navigation.overview' },
  { path: '/requests', label: 'navigation.requests' },
  { path: '/account', label: 'navigation.account' },
  ...REPORT_SECTIONS.map((item) => ({ path: `/analysis/${item.id}`, label: item.label })),
  ...SETTINGS_SECTIONS.map((item) => ({ path: `/settings/${item.id}`, label: item.label })),
] as const;

export function safeReturnPath(value: unknown): string {
  const fallback = '/overview';
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/')) return fallback;
  if (value.startsWith('//') || /[\\\u0000-\u0020]/.test(value)) return fallback;
  try {
    const url = new URL(value, 'https://token-lens.invalid');
    const path = decodeURIComponent(url.pathname);
    if (
      url.origin !== 'https://token-lens.invalid' ||
      path.startsWith('//') ||
      /[\\\u0000-\u0020]/.test(path)
    )
      return fallback;
    if (/^\/(?:login|api|assets|data)(?:\/|$)/i.test(path)) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function loginPath(returnTo: string, authError = false): string {
  const query = new URLSearchParams({ returnTo: safeReturnPath(returnTo) });
  if (authError) query.set('auth_error', 'entra');
  return `/login?${query}`;
}

export function requestPage(value: string | null): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page <= 400001 ? page : 1;
}

import { LocalizedLabel } from './components/LocalizedLabel';
import { t, useLocale } from './i18n';
import { useCallback, useEffect, useState } from 'react';
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router';
import { Activity, Download, FileText, LayoutDashboard, Settings, UserRound } from 'lucide-react';
import {
  APP_PAGES,
  REPORT_SECTIONS,
  SETTINGS_SECTIONS,
  requestPage,
  type BootstrapResponse,
} from '../shared/navigation';
import { DEFAULT_TIME_ZONE } from '../shared/time-window';
import type { SessionUser } from '../shared/settings';
import type { Connection } from './types';
import { SERVICE_UNAVAILABLE, api, errorMessage } from './api';
import { onReconnect } from './connection';
import { ConnectionNotice } from './components/ConnectionNotice';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PageHeader } from './components/PageHeader';
import { SectionTabs } from './components/SectionTabs';
import { StatusMessage } from './components/StatusScreen';
import { BrandMark } from './components/BrandMark';
import { ScrollViewport } from './components/ScrollViewport';
import { FormNotice } from './components/Form';
import { ToastProvider } from './components/ToastProvider';
import { UserMenu } from './components/UserMenu';
import { AccountPage } from './features/account/AccountPage';
import {
  ClearFiltersButton,
  DataToolbar,
  RefreshButton,
  RequestIdSearch,
  intervalLabel,
  rangeText,
} from './features/analytics/DataToolbar';
import type { FilterField } from './features/analytics/series';
import {
  FILTER_KEYS,
  filterQuery,
  filterSearch,
  readFilters,
  useAnalytics,
  useFacets,
  useRequests,
  type ViewFilters,
} from './features/analytics/useAnalytics';
import { useVisibility } from './features/analytics/useVisibility';
import { AuthGate } from './features/auth/AuthGate';
import { useIngestion } from './features/ingestion/useIngestion';
import { OverviewPage } from './features/overview/OverviewPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { RequestsPage } from './features/requests/RequestsPage';
import { SettingsNavigation } from './features/settings/SettingsNavigation';
import { SettingsPanel } from './features/settings/SettingsPanel';

// `home` is the first real page of a section: linking to a redirect route would render an empty
// frame first and restart the report request.
const mainNavigation = [
  { path: '/overview', home: '/overview', label: 'navigation.overview', icon: LayoutDashboard },
  { path: '/analysis', home: '/analysis/cost', label: 'navigation.analysis', icon: Activity },
  { path: '/requests', home: '/requests', label: 'navigation.requests', icon: FileText },
] as const;
const inSection = (pathname: string, path: string) =>
  pathname === path || pathname.startsWith(`${path}/`);

export function App() {
  const locale = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <ToastProvider>
      <AuthGate>{(user, refresh) => <Workspace user={user} onUserChanged={refresh} />}</AuthGate>
    </ToastProvider>
  );
}

function Workspace({ user, onUserChanged }: { user: SessionUser; onUserChanged: () => void }) {
  const locale = useLocale();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const pathname = location.pathname.replace(/\/+$/, '') || '/';
  const page = APP_PAGES.find((item) => item.path === pathname);
  const reportSection = REPORT_SECTIONS.find((item) => pathname === `/analysis/${item.id}`);
  const isAnalysis = Boolean(reportSection);
  const settingsSection = SETTINGS_SECTIONS.find((item) => pathname === `/settings/${item.id}`);
  const isSettings = Boolean(settingsSection);
  const isRequests = pathname === '/requests';
  const isDataView = pathname === '/overview' || isRequests || isAnalysis;
  const isAccount = pathname === '/account';
  const filters = readFilters(searchParams);
  const visible = useVisibility();
  const listPage = requestPage(searchParams.get('page'));
  // The request list holds still while a detail is open or a later page is shown.
  const listPaused = isRequests && (searchParams.has('request') || listPage !== 1);
  const autoRefresh = isDataView && visible && !listPaused;
  const [queryAt, setQueryAt] = useState(Date.now);
  // Entering a data view from another page reloads it; switching analysis tabs does not.
  const dataSection = isAnalysis ? '/analysis' : isDataView ? pathname : null;
  const [enteredSection, setEnteredSection] = useState(dataSection);
  if (dataSection !== enteredSection) {
    setEnteredSection(dataSection);
    if (dataSection) setQueryAt(Date.now());
  }
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => setQueryAt(Date.now()), 60000);
    return () => clearInterval(timer);
  }, [autoRefresh]);
  const query = filterQuery(filters, queryAt);
  const dataSearch = filterSearch(filters);
  const [lastDataSearch, setLastDataSearch] = useState(dataSearch);
  if (isDataView && lastDataSearch !== dataSearch) setLastDataSearch(dataSearch);
  const navigationSearch = isDataView ? dataSearch : lastDataSearch;
  const dataPath = (path: string) => `${path}${navigationSearch ? `?${navigationSearch}` : ''}`;
  const ingestion = useIngestion();
  const dataRevision = ingestion.status?.dataRevision ?? '';
  const revision = `${queryAt}/${dataRevision}`;
  // New imports reach a paused request list only once it resumes, and only if data changed.
  const [listRevision, setListRevision] = useState(dataRevision);
  if (!listPaused && listRevision !== dataRevision) setListRevision(dataRevision);
  const analytics = useAnalytics(query, isDataView && !isRequests, revision);
  const facets = useFacets(isRequests, revision);
  const requests = useRequests(query, listPage, isRequests, `${queryAt}/${listRevision}`);
  const [connection, setConnection] = useState<Connection>({ state: 'loading' });
  const [retry, setRetry] = useState(0);
  const reconnect = useCallback(() => setRetry((value) => value + 1), []);
  const settingsHome = user.role === 'admin' ? '/settings/data' : '/settings/platform';
  const viewTitle = isSettings
    ? 'navigation.settings'
    : isAnalysis
      ? 'navigation.analysis'
      : (page?.label ?? 'navigation.notFound');

  useEffect(() => {
    document.title = `${t(page?.label ?? viewTitle)} · Foundry Token Lens`;
  }, [page?.label, viewTitle, locale]);
  useEffect(() => {
    const controller = new AbortController();
    setConnection((current) => (current.state === 'ready' ? current : { state: 'loading' }));
    api<BootstrapResponse>('/api/bootstrap', { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setConnection({ state: 'ready', data });
      })
      .catch((error) => {
        // An unreachable service is covered by the connection notice and retried on reconnect.
        if (!controller.signal.aborted && errorMessage(error) !== SERVICE_UNAVAILABLE)
          setConnection({ state: 'error' });
      });
    return () => controller.abort();
  }, [retry]);
  // When the service answers again after an outage, reload what the workspace shows.
  const refreshIngestion = ingestion.refresh;
  useEffect(
    () =>
      onReconnect(() => {
        setQueryAt(Date.now());
        refreshIngestion();
        reconnect();
      }),
    [refreshIngestion, reconnect],
  );

  function changeFilters(value: ViewFilters) {
    setQueryAt(Date.now());
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const key of FILTER_KEYS) next.delete(key);
        for (const [key, item] of new URLSearchParams(filterSearch(value))) next.set(key, item);
        next.delete('page');
        return next;
      },
      { replace: true },
    );
  }
  function filterBy(field: FilterField, value: string) {
    changeFilters({ ...filters, [field]: value });
  }
  // The header shows it on data views, the account page and settings (the fallback).
  const PageIcon = isAccount
    ? UserRound
    : (mainNavigation.find(({ path }) => inSection(pathname, path))?.icon ?? Settings);
  const reportZone = filters.timezone ?? DEFAULT_TIME_ZONE;
  const apiQuery = new URLSearchParams(query);
  const clock = new Intl.DateTimeFormat(locale, {
    timeZone: reportZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const dataMeta = [
    rangeText(apiQuery.get('from'), apiQuery.get('to'), reportZone, locale),
    reportZone,
    ...(!isRequests && analytics.data?.interval
      ? [t('insights.bucketedBy', { interval: intervalLabel(analytics.data.interval) })]
      : []),
    t('insights.updatedAt', {
      time: clock.format(
        new Date(!isRequests && analytics.data ? analytics.data.generatedAt : queryAt),
      ),
    }),
  ].join(' · ');

  return (
    <div className="app-shell">
      <ConnectionNotice />
      <aside className="sidebar">
        <Link
          className="brand"
          to={dataPath('/overview')}
          aria-label={t('common.foundryTokenLensOverview')}
        >
          <BrandMark />
          <span>
            <strong>Token Lens</strong>
            <small>Microsoft Foundry</small>
          </span>
        </Link>
        <nav aria-label={t('navigation.main')}>
          <ScrollViewport className="sidebar-navigation">
            {mainNavigation.map(({ path, home, label, icon: Icon }) => {
              const active = inSection(pathname, path);
              return (
                <Link
                  key={path}
                  aria-label={t(label)}
                  aria-current={active ? 'page' : undefined}
                  to={dataPath(home)}
                  className={`nav-item${active ? ' selected' : ''}`}
                >
                  <Icon size={20} strokeWidth={1.7} />
                  <span>
                    <LocalizedLabel message={label} />
                  </span>
                </Link>
              );
            })}
            <Link
              aria-label={t('navigation.settings')}
              to={settingsHome}
              aria-current={isSettings ? 'page' : undefined}
              className={`nav-item${isSettings ? ' selected' : ''}`}
            >
              <Settings size={20} strokeWidth={1.7} />
              <span>
                <LocalizedLabel message="navigation.settings" />
              </span>
            </Link>
          </ScrollViewport>
        </nav>
        <div className="sidebar-footer">
          <UserMenu
            user={user}
            version={connection.state === 'ready' ? connection.data.version : undefined}
            active={pathname === '/account' ? 'account' : null}
            onSignedOut={onUserChanged}
          />
        </div>
      </aside>
      <div className="workspace-main">
        <main aria-label={t(viewTitle)}>
          {!isDataView && !isSettings && !isAccount && <h1 className="sr-only">{t(viewTitle)}</h1>}
          <FormNotice
            error={
              connection.state === 'error'
                ? t('common.unableToConnectToTheApplicationService')
                : null
            }
            action={{ label: 'auth.reconnect', onClick: reconnect }}
          />
          <div className="workspace-card">
            {(isDataView || isSettings || isAccount) && (
              <div className="workspace-header">
                <PageHeader
                  icon={<PageIcon size={20} strokeWidth={1.7} aria-hidden="true" />}
                  title={t(viewTitle)}
                  tabs={
                    reportSection ? (
                      <SectionTabs
                        id="reports"
                        label={t('analytics.analysisType')}
                        value={reportSection.id}
                        hrefFor={(value) => `/analysis/${value}${location.search}`}
                        items={REPORT_SECTIONS}
                      />
                    ) : settingsSection && user.role === 'admin' ? (
                      <SettingsNavigation section={settingsSection.id} canManage />
                    ) : undefined
                  }
                  actions={
                    isDataView && (
                      <>
                        {isRequests && (
                          <a
                            className="button secondary toolbar-button"
                            href={`/api/requests/export.csv?${query}`}
                            title={t('analytics.exportTheCurrentSelectionUpTo100000')}
                          >
                            <Download size={14} aria-hidden="true" />
                            {t('analytics.exportCSV')}
                          </a>
                        )}
                        <RefreshButton
                          loading={isRequests ? requests.loading : analytics.loading}
                          onRefresh={() => setQueryAt(Date.now())}
                        />
                        <ClearFiltersButton value={filters} onChange={changeFilters} />
                      </>
                    )
                  }
                />
                {isDataView && (
                  <DataToolbar
                    value={filters}
                    onChange={changeFilters}
                    facets={isRequests ? (facets.data ?? undefined) : analytics.data?.facets}
                    resolvedInterval={analytics.data?.interval}
                    resolvedWindow={{ from: apiQuery.get('from'), to: apiQuery.get('to') }}
                    showInterval={!isRequests}
                    meta={dataMeta}
                  >
                    {isRequests && <RequestIdSearch value={filters} onChange={changeFilters} />}
                  </DataToolbar>
                )}
              </div>
            )}
            <ScrollViewport
              key={pathname}
              className={`page-viewport${isRequests ? ' page-fill' : ''}`}
              contentClassName="page-content"
              label={t(viewTitle)}
            >
              <ErrorBoundary key={pathname}>
                {/* Until a report first arrives its placeholder shows the error instead. */}
                <FormNotice
                  error={
                    isRequests
                      ? (requests.error ?? facets.error)
                      : isDataView && analytics.data
                        ? analytics.error
                        : null
                  }
                />
                <Routes>
                  <Route
                    path="/"
                    element={
                      <Navigate to={{ pathname: '/overview', search: location.search }} replace />
                    }
                  />
                  <Route
                    path="/overview"
                    element={
                      <OverviewPage
                        analytics={analytics.data}
                        error={analytics.error}
                        onFilter={filterBy}
                      />
                    }
                  />
                  <Route
                    path="/analysis"
                    element={
                      <Navigate
                        to={{ pathname: '/analysis/cost', search: location.search }}
                        replace
                      />
                    }
                  />
                  {REPORT_SECTIONS.map((section) => (
                    <Route
                      key={section.id}
                      path={`/analysis/${section.id}`}
                      element={
                        <ReportsPage
                          tab={section.id}
                          data={analytics.data}
                          error={analytics.error}
                          onFilter={filterBy}
                        />
                      }
                    />
                  ))}
                  <Route
                    path="/requests"
                    element={
                      <RequestsPage
                        list={requests.data}
                        loading={requests.loading}
                        page={listPage}
                        timeZone={reportZone}
                      />
                    }
                  />
                  <Route
                    path="/account"
                    element={<AccountPage user={user} onUserChanged={onUserChanged} />}
                  />
                  <Route path="/settings" element={<Navigate to={settingsHome} replace />} />
                  <Route
                    path="/settings/sources"
                    element={<Navigate to="/settings/data" replace />}
                  />
                  <Route
                    path="/settings/schedule"
                    element={<Navigate to="/settings/data" replace />}
                  />
                  {SETTINGS_SECTIONS.map((section) => (
                    <Route
                      key={section.id}
                      path={`/settings/${section.id}`}
                      element={
                        user.role !== 'admin' && section.id !== 'platform' ? (
                          <PageMessage
                            title={t('auth.accessDenied')}
                            text={t('auth.pageIsAvailableToAdministratorsOnly')}
                          />
                        ) : (
                          <div
                            id="settings-content"
                            role={user.role === 'admin' ? 'tabpanel' : undefined}
                            aria-labelledby={
                              user.role === 'admin' ? `settings-tab-${section.id}` : undefined
                            }
                            tabIndex={user.role === 'admin' ? 0 : undefined}
                            className={`card-grid settings-content settings-${section.id}`}
                          >
                            <SettingsPanel
                              section={section.id}
                              user={user}
                              onUserChanged={onUserChanged}
                              ingestion={ingestion.status}
                              onImportChanged={ingestion.refresh}
                            />
                          </div>
                        )
                      }
                    />
                  ))}
                  <Route
                    path="*"
                    element={
                      <PageMessage
                        title={t('navigation.notFound')}
                        text={t('common.checkTheURLOrReturnToTheOverview')}
                      />
                    }
                  />
                </Routes>
              </ErrorBoundary>
            </ScrollViewport>
          </div>
        </main>
      </div>
    </div>
  );
}

/** An error inside the workspace, such as an unknown address, in the shared status layout. */
function PageMessage({ title, text }: { title: string; text: string }) {
  useLocale();
  const navigate = useNavigate();
  return (
    <StatusMessage
      title={title}
      text={text}
      action={{ label: t('navigation.backToOverview'), onClick: () => navigate('/overview') }}
    />
  );
}

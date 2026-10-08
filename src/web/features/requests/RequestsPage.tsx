import { useSearchParams } from 'react-router';
import { t, useLocale } from '../../i18n';
import type { RequestFact } from '../../../shared/ingestion';
import { Pager } from '../../components/Pager';
import { ScrollViewport } from '../../components/ScrollViewport';
import { callTimeFormat, count, latency, money } from '../analytics/format';
import { resourceName } from '../analytics/series';
import { Muted, StatusCode, withRequest } from '../analytics/ui';
import { REQUESTS_PAGE_SIZE, type RequestList } from '../analytics/useAnalytics';
import { RequestDrawer } from './RequestDrawer';

const tokenCell = (value: string | null) => (value === null ? <Muted /> : count(Number(value)));
// A cache quantity absent from a Usage record means no such cache activity (billed as zero).
const cacheCell = (row: RequestFact, value: string | null | undefined) =>
  row.hasUsage ? count(Number(value ?? 0)) : <Muted />;

/** One page of the request list; the workspace loads it with the shared filters. */
export function RequestsPage({
  list,
  loading,
  page,
  timeZone,
}: {
  list: RequestList | null;
  loading: boolean;
  page: number;
  timeZone: string;
}) {
  const locale = useLocale();
  const [params, setParams] = useSearchParams();
  const rows = list?.requests ?? [];
  const total = list?.total ?? 0;
  const offset = (page - 1) * REQUESTS_PAGE_SIZE;
  const select = (row: RequestFact) => setParams((current) => withRequest(current, row));
  const close = () =>
    setParams((current) => {
      const q = new URLSearchParams(current);
      q.delete('request');
      q.delete('detailResource');
      return q;
    });
  const go = (n: number) =>
    setParams((current) => {
      const q = new URLSearchParams(current);
      q.set('page', String(n));
      return q;
    });
  const request = params.get('request'),
    detailResource = params.get('detailResource');
  const selected =
    rows.find((row) => row.correlationId === request && row.resourceId === detailResource) ??
    (request && detailResource ? { correlationId: request, resourceId: detailResource } : null);
  const time = callTimeFormat(locale, timeZone);
  const pages = Math.max(1, Math.ceil(total / REQUESTS_PAGE_SIZE));
  return (
    <div className={`card-grid request-page${selected ? ' drawer-open' : ''}`}>
      <section className="card request-card">
        <div className="request-table-region">
          <ScrollViewport
            className="request-table-viewport"
            label={t('analytics.requestUsageTable')}
          >
            <table className="request-table" aria-busy={loading}>
              <thead>
                <tr>
                  <th>{t('insights.time')}</th>
                  <th>{t('insights.filterModel')}</th>
                  <th>{t('insights.filterResource')}</th>
                  <th>{t('insights.status')}</th>
                  <th title={t('insights.inputIncludesCache')}>{t('insights.input')}</th>
                  <th>{t('insights.cacheRead')}</th>
                  <th>{t('insights.cacheWrites')}</th>
                  <th>{t('insights.output')}</th>
                  <th>{t('insights.latency')}</th>
                  <th>{t('insights.ttft')}</th>
                  <th>{t('insights.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const active = row.correlationId === request && row.resourceId === detailResource;
                  return (
                    <tr
                      key={`${row.resourceId}/${row.correlationId}`}
                      className={active ? 'selected' : undefined}
                      onClick={() => select(row)}
                    >
                      <td>
                        <button
                          type="button"
                          className="request-open"
                          aria-label={t('insights.openRequest', { id: row.correlationId })}
                          aria-current={active || undefined}
                          onClick={(event) => {
                            event.stopPropagation();
                            select(row);
                          }}
                        >
                          {time.format(new Date(row.time))}
                        </button>
                      </td>
                      <td>
                        <span className="request-model">{row.model ?? row.operation ?? '—'}</span>
                        {row.deployment && row.deployment !== row.model && (
                          <small>{row.deployment}</small>
                        )}
                      </td>
                      <td className="muted" title={row.resourceId}>
                        {resourceName(row.resourceId)}
                      </td>
                      <td>
                        <StatusCode code={row.statusConflict ? 'conflict' : row.statusCode} />
                      </td>
                      <td>{tokenCell(row.inputTokens)}</td>
                      <td>{cacheCell(row, row.cachedTokens)}</td>
                      <td>{cacheCell(row, row.cacheWriteTokens)}</td>
                      <td>{tokenCell(row.outputTokens)}</td>
                      <td>{row.durationMs === null ? <Muted /> : latency(row.durationMs)}</td>
                      <td>
                        {row.timeToFirstTokenMs === null ? (
                          <Muted />
                        ) : (
                          latency(row.timeToFirstTokenMs)
                        )}
                      </td>
                      <td className="request-cost">
                        {row.cost?.knownUsd == null ? <Muted /> : money(row.cost.knownUsd)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!rows.length && (
              <p className="card-empty request-empty">
                {t(loading ? 'analytics.loadingRequests' : 'analytics.noRequests')}
              </p>
            )}
          </ScrollViewport>
        </div>
        <Pager
          as="footer"
          className="request-pager"
          summary={
            total
              ? t('insights.pageRange', {
                  from: count(offset + 1),
                  to: count(Math.min(offset + rows.length, total)),
                  total: count(total),
                })
              : '0'
          }
          page={page}
          pages={pages}
          previousLabel={t('common.previous')}
          nextLabel={t('common.next')}
          disabled={loading}
          onPage={go}
        />
        {selected && (
          <RequestDrawer
            key={`${selected.resourceId}/${selected.correlationId}`}
            row={selected}
            timeZone={timeZone}
            onClose={close}
          />
        )}
      </section>
    </div>
  );
}

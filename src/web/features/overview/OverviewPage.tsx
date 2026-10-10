import { Boxes, ChartColumn, ChartLine, HeartPulse, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { t, useLocale, type DisplayMessage } from '../../i18n';
import type { AnalyticsResponse } from '../../../shared/analytics';
import { ChartLegend, TimeBarChart, TimeLineChart } from '../analytics/charts';
import { callCount, count, latency, money, ratio, tokens } from '../analytics/format';
import {
  byCost,
  displayName,
  errorRate,
  latencyLines,
  rowFilter,
  statusSeries,
  summaryTokens,
  metricFormat,
  metricLabel,
  overallTitle,
  timeAxis,
  stackSeries,
  totalSeries,
  type FilterField,
  type Metric,
} from '../analytics/series';
import {
  CardLink,
  ErrorRate,
  Comparison,
  EntityName,
  Muted,
  ReportPlaceholder,
  ShareBar,
  ViewAll,
  METRIC_TONE,
  callsValue,
} from '../analytics/ui';
import { Kpi, KpiStrip } from '../../components/Kpi';
import { Card } from '../../components/Card';
import { ScrollViewport } from '../../components/ScrollViewport';
import { Segmented } from '../../components/Segmented';
import { TopCostCard } from '../analytics/cards';

const METRICS = ['cost', 'requests', 'tokens'] as const;

export function OverviewPage({
  analytics,
  error,
  onFilter,
}: {
  analytics: AnalyticsResponse | null;
  error?: DisplayMessage | null;
  onFilter: (field: FilterField, value: string) => void;
}) {
  useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const [metric, setMetric] = useState<Metric>('cost');
  if (!analytics) return <ReportPlaceholder error={error} />;
  const s = analytics.summary,
    c = analytics.comparison;
  const cost = Number(s.costUsd ?? 0);
  // One total per bucket; the analysis views add the per-model or per-resource split.
  const totalTitle = overallTitle(metric);
  const total = totalSeries(analytics, metric);
  const format = metricFormat(metric);
  const errors = statusSeries(analytics);
  const durationLines = latencyLines(analytics);
  const go = (path: string) => navigate(`${path}${location.search}`);
  const models = [...analytics.models].sort(byCost);
  const common = timeAxis(analytics);
  return (
    <div className="card-grid">
      <div className="card-row overview-kpis">
        <KpiStrip label={t('insights.costAndUsage')} icon={Wallet} tone="amber">
          <Kpi
            label={t('insights.totalCost')}
            value={money(s.costUsd)}
            sub={
              c && (
                <Comparison
                  current={cost}
                  previous={c.costUsd}
                  format={money}
                  compact
                  kind="cost"
                />
              )
            }
          />
          <Kpi
            label={t('insights.calls')}
            value={callsValue(s.requests)}
            sub={
              c && <Comparison current={s.requests} previous={c.requests} format={count} compact />
            }
          />
          <Kpi
            label={t('insights.totalTokens')}
            value={tokens(summaryTokens(s))}
            sub={
              c && (
                <Comparison
                  current={summaryTokens(s)}
                  previous={summaryTokens(c)}
                  format={tokens}
                  compact
                />
              )
            }
          />
          <Kpi
            label={t('analytics.cacheHitRate')}
            value={ratio(s.cacheRatio)}
            sub={
              c && (
                <Comparison current={s.cacheRatio} previous={c.cacheRatio} format={ratio} compact />
              )
            }
          />
        </KpiStrip>
        <KpiStrip label={t('insights.health')} icon={HeartPulse} tone="success">
          <Kpi
            label={t('insights.errorRate')}
            value={ratio(errorRate(s), 2)}
            sub={t('insights.errorsWithThrottled', {
              errors: count(s.errors),
              throttled: count(s.throttled ?? 0),
            })}
          />
          <Kpi
            label={t('insights.p95Duration')}
            value={latency(s.p95DurationMs)}
            sub={
              c && (
                <Comparison
                  current={s.p95DurationMs}
                  previous={c.p95DurationMs}
                  format={latency}
                  compact
                  kind="risk"
                />
              )
            }
          />
          <Kpi
            label={t('insights.p95Ttft')}
            value={latency(s.p95FirstTokenMs)}
            sub={
              c && (
                <Comparison
                  current={s.p95FirstTokenMs}
                  previous={c.p95FirstTokenMs}
                  format={latency}
                  compact
                  kind="risk"
                />
              )
            }
          />
        </KpiStrip>
      </div>
      <div className="card-row overview-split">
        <Card
          title={totalTitle}
          icon={ChartColumn}
          tone={METRIC_TONE[metric]}
          actions={
            <Segmented
              label={t('insights.metric')}
              value={metric}
              options={METRICS.map((value) => ({ value, label: metricLabel(value) }))}
              onChange={setMetric}
            />
          }
        >
          <TimeBarChart
            {...common}
            series={total}
            details={stackSeries(analytics, 'resource', metric)}
            format={format}
            label={totalTitle}
            height="fill"
          />
        </Card>
        <Card
          title={t('insights.performanceView')}
          icon={ChartLine}
          tone="success"
          actions={
            <CardLink onClick={() => go('/analysis/performance')}>
              {t('insights.details')} →
            </CardLink>
          }
        >
          <h3 className="card-subhead">{t('insights.errors')}</h3>
          <ChartLegend items={errors} />
          <TimeBarChart
            {...common}
            series={errors}
            format={callCount}
            label={t('insights.errors')}
            height={120}
          />
          <h3 className="card-subhead">{t('insights.latency')}</h3>
          <ChartLegend items={durationLines} />
          <TimeLineChart
            {...common}
            height={120}
            label={t('insights.latency')}
            format={latency}
            lines={durationLines}
          />
        </Card>
      </div>
      <div className="card-row overview-split">
        <Card
          title={t('insights.models')}
          icon={Boxes}
          tone="violet"
          className="fixed-card tall"
          actions={
            <CardLink onClick={() => go('/analysis/cost')}>
              {t('insights.viewInAnalysis')} →
            </CardLink>
          }
        >
          <ScrollViewport
            className="table-viewport fill-viewport"
            label={t('insights.models')}
            showScrollbar={false}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('insights.filterModel')}</th>
                  <th>{t('insights.calls')}</th>
                  <th>{t('insights.cost')}</th>
                  <th>{t('insights.costShare')}</th>
                  <th>{t('insights.tokens')}</th>
                  <th>{t('insights.cacheHit')}</th>
                  <th>{t('insights.errorRate')}</th>
                </tr>
              </thead>
              <tbody>
                {models.map((row) => (
                  <tr key={row.name}>
                    <td>
                      <EntityName
                        name={displayName('model', row.name)}
                        onSelect={rowFilter('model', row.name, onFilter)}
                      />
                    </td>
                    <td>{count(row.requests)}</td>
                    <td>{row.costUsd === null ? <Muted /> : money(row.costUsd)}</td>
                    <td>
                      <ShareBar
                        value={row.costUsd === null ? null : Number(row.costUsd)}
                        total={cost}
                      />
                    </td>
                    <td>{tokens(summaryTokens(row))}</td>
                    <td>{ratio(row.cacheRatio)}</td>
                    <td>
                      <ErrorRate value={errorRate(row)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollViewport>
        </Card>
        <TopCostCard data={analytics} actions={<ViewAll onClick={() => go('/requests')} />} />
      </div>
    </div>
  );
}

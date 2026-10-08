import {
  Ban,
  Boxes,
  ChartLine,
  ChartNoAxesColumn,
  ChartScatter,
  Gauge,
  ListChecks,
  ShieldAlert,
  Snail,
  Timer,
  TriangleAlert,
} from 'lucide-react';
import { t } from '../../i18n';
import type { AnalyticsResponse } from '../../../shared/analytics';
import {
  ChartLegend,
  Histogram,
  ScatterPlot,
  TimeBarChart,
  TimeLineChart,
} from '../analytics/charts';
import { count, latency, ratio, tokens } from '../analytics/format';
import {
  displayName,
  entityColors,
  errorRate,
  latencyLines,
  rowFilter,
  seriesTotal,
  statusSeries,
  timeAxis,
  type FilterField,
} from '../analytics/series';
import { CallList, Comparison, EntityName, ErrorRate, Muted, StatusCode } from '../analytics/ui';
import { Kpi, KpiStrip } from '../../components/Kpi';
import { Card } from '../../components/Card';

export function PerformanceView({
  data,
  onFilter,
}: {
  data: AnalyticsResponse;
  onFilter: (field: FilterField, value: string) => void;
}) {
  const s = data.summary,
    c = data.comparison;
  const color = entityColors(data);
  const errors = statusSeries(data);
  const lines = [
    ...latencyLines(data),
    {
      key: 'ttft',
      name: t('insights.p95Ttft'),
      color: 'var(--teal)',
      values: data.timeline.map((b) => b.p95FirstTokenMs),
    },
  ];
  const statuses = [...(data.statuses ?? [])].sort((a, b) => b.count - a.count);
  const points = (data.scatter ?? []).map((p) => ({
    key: p.id,
    x: p.input,
    y: p.ttft,
    color: color('model', p.model),
    title: `${displayName('model', p.model)} · ${t('insights.input')} ${tokens(p.input)} · ${t('insights.ttft')} ${latency(p.ttft)}`,
  }));
  return (
    <>
      <KpiStrip>
        <Kpi
          label={t('insights.p50Duration')}
          icon={Timer}
          tone="blue"
          value={latency(s.p50DurationMs)}
          sub={
            c && (
              <Comparison
                current={s.p50DurationMs}
                previous={c.p50DurationMs}
                format={latency}
                kind="risk"
              />
            )
          }
        />
        <Kpi
          label={t('insights.p95Duration')}
          icon={Timer}
          tone="blue"
          value={latency(s.p95DurationMs)}
          sub={
            c && (
              <Comparison
                current={s.p95DurationMs}
                previous={c.p95DurationMs}
                format={latency}
                kind="risk"
              />
            )
          }
        />
        <Kpi
          label={t('insights.p99Duration')}
          icon={Timer}
          tone="blue"
          value={latency(s.p99DurationMs)}
          sub={
            c && (
              <Comparison
                current={s.p99DurationMs}
                previous={c.p99DurationMs}
                format={latency}
                kind="risk"
              />
            )
          }
        />
        <Kpi
          label={t('insights.p95Ttft')}
          icon={Gauge}
          tone="teal"
          value={latency(s.p95FirstTokenMs)}
          sub={
            c && (
              <Comparison
                current={s.p95FirstTokenMs}
                previous={c.p95FirstTokenMs}
                format={latency}
                kind="risk"
              />
            )
          }
        />
        <Kpi
          label={t('insights.errorRate')}
          icon={TriangleAlert}
          tone="error"
          value={ratio(errorRate(s), 2)}
          sub={
            c && (
              <Comparison
                current={errorRate(s)}
                previous={errorRate(c)}
                format={(value) => ratio(value, 2)}
                kind="risk"
              />
            )
          }
        />
        <Kpi
          label={t('insights.throttled')}
          icon={Ban}
          tone="amber"
          value={count(s.throttled ?? 0)}
          sub={
            c && (
              <Comparison
                current={s.throttled ?? 0}
                previous={c.throttled ?? 0}
                format={count}
                kind="risk"
              />
            )
          }
        />
      </KpiStrip>
      <div className="card-row halves">
        <Card title={t('insights.latencyTrend')} icon={ChartLine} tone="blue">
          <ChartLegend items={lines} />
          <TimeLineChart
            {...timeAxis(data)}
            lines={lines}
            format={latency}
            label={t('insights.latencyTrend')}
            height={220}
          />
        </Card>
        <Card title={t('insights.errorsAndThrottling')} icon={ShieldAlert} tone="error">
          <ChartLegend
            items={errors.map((item) => ({ ...item, value: count(seriesTotal(item)) }))}
          />
          <TimeBarChart
            {...timeAxis(data)}
            series={errors}
            format={count}
            label={t('insights.errorsAndThrottling')}
            height={220}
          />
        </Card>
      </div>
      <div className="card-row thirds">
        <Card title={t('insights.durationDistribution')} icon={ChartNoAxesColumn} tone="blue">
          <Histogram
            bins={data.distributions?.duration ?? []}
            color="var(--slate)"
            label={t('insights.durationDistribution')}
          />
        </Card>
        <Card title={t('insights.ttftDistribution')} icon={ChartNoAxesColumn} tone="teal">
          <Histogram
            bins={data.distributions?.ttft ?? []}
            color="var(--teal)"
            label={t('insights.ttftDistribution')}
          />
        </Card>
        <Card title={t('insights.responseStatus')} icon={ListChecks} tone="slate">
          <ul className="value-list">
            {statuses.map((status) => (
              <li key={status.name}>
                <StatusCode code={status.name} />
                <span>
                  {count(status.count)}
                  <Muted>{ratio(s.requests ? status.count / s.requests : null)}</Muted>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title={t('insights.byModelTitle')} icon={Boxes} tone="violet">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('insights.filterModel')}</th>
              <th>{t('insights.calls')}</th>
              <th>{t('insights.errorRate')}</th>
              <th>429</th>
              <th>{t('insights.p50Duration')}</th>
              <th>{t('insights.p95Duration')}</th>
              <th>{t('insights.p99Duration')}</th>
              <th>{t('insights.p95Ttft')}</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((row) => (
              <tr key={row.name}>
                <td>
                  <EntityName
                    name={displayName('model', row.name)}
                    onSelect={rowFilter('model', row.name, onFilter)}
                  />
                </td>
                <td>{count(row.requests)}</td>
                <td>
                  <ErrorRate value={errorRate(row)} />
                </td>
                <td>
                  {row.throttled ? (
                    <span className="status-code warn">{count(row.throttled)}</span>
                  ) : (
                    <Muted>0</Muted>
                  )}
                </td>
                <td>{latency(row.p50DurationMs)}</td>
                <td>{latency(row.p95DurationMs)}</td>
                <td>{latency(row.p99DurationMs)}</td>
                <td>{latency(row.p95FirstTokenMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div className="card-row wide-narrow">
        <Card title={t('insights.inputVsTtft')} icon={ChartScatter} tone="teal">
          <ChartLegend
            items={data.models.map((row) => ({
              key: row.name,
              name: displayName('model', row.name),
              color: color('model', row.name),
            }))}
          />
          <ScatterPlot
            points={points}
            xFormat={tokens}
            yFormat={latency}
            xLabel={t('insights.inputTokens')}
            label={t('insights.inputVsTtft')}
            height="fill"
          />
        </Card>
        <Card title={t('insights.slowestCalls')} icon={Snail} tone="amber">
          <CallList
            rows={data.slowest?.slice(0, 6) ?? []}
            timeZone={data.timezone}
            value={(row) => latency(row.durationMs)}
            detail={(row) =>
              `${t('insights.input')} ${tokens(row.inputTokens)} · ${t('insights.ttft')} ${latency(row.timeToFirstTokenMs)}`
            }
          />
        </Card>
      </div>
    </>
  );
}

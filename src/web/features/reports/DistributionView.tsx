import {
  CalendarClock,
  CalendarDays,
  ChartColumnStacked,
  Clock,
  Network,
  Server,
  TableProperties,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { t, useLocale } from '../../i18n';
import { TOP_SOURCE_IPS, type AnalyticsResponse } from '../../../shared/analytics';
import { ChartLegend, TimeBarChart, WeekHourHeatmap } from '../analytics/charts';
import {
  calendarDay,
  count,
  hourLabel,
  latency,
  money,
  ratio,
  tokens,
  weekdayName,
} from '../analytics/format';
import { ScrollViewport } from '../../components/ScrollViewport';
import {
  displayName,
  errorRate,
  groupLabel,
  groupOptions,
  groupRows,
  peakDay,
  rangeDays,
  rowFilter,
  seriesTotal,
  splitOptions,
  stackSeries,
  summaryTokens,
  timeAxis,
  totalSeries,
  overallTitle,
  type FilterField,
  type StackBy,
} from '../analytics/series';
import { Comparison, EntityName, ErrorRate, Muted, ShareBar } from '../analytics/ui';
import { Kpi, KpiStrip } from '../../components/Kpi';
import { Card } from '../../components/Card';
import { Segmented } from '../../components/Segmented';

export function DistributionView({
  data,
  onFilter,
}: {
  data: AnalyticsResponse;
  onFilter: (field: FilterField, value: string) => void;
}) {
  const locale = useLocale();
  const [split, setSplit] = useState<StackBy | 'none'>('resource');
  const [group, setGroup] = useState<StackBy>('model');
  const s = data.summary,
    c = data.comparison;
  const days = rangeDays(data);
  const series =
    split === 'none' ? totalSeries(data, 'requests') : stackSeries(data, split, 'requests');
  const peak = [...(data.heatmap ?? [])].sort((a, b) => b.requests - a.requests)[0];
  const peakCalls = peakDay(data, 'requests');
  const ips = data.ips;
  // Calls without a recorded IP ('—') are not a source.
  const topFiveIps = ips
    .filter((row) => row.name !== '—')
    .slice(0, 5)
    .reduce((sum, row) => sum + row.requests, 0);
  const rows = groupRows(data, group);
  return (
    <>
      <KpiStrip>
        <Kpi
          label={t('insights.callsCount')}
          icon={Zap}
          tone="blue"
          value={count(s.requests)}
          sub={c && <Comparison current={s.requests} previous={c.requests} format={count} />}
        />
        <Kpi
          label={t('insights.dailyCalls')}
          icon={CalendarDays}
          tone="blue"
          value={days ? count(s.requests / days) : '—'}
          sub={
            peakCalls && (
              <span title={calendarDay(peakCalls.date, locale)}>
                {t('insights.peakDayCalls', { count: peakCalls.value })}
              </span>
            )
          }
        />
        <Kpi
          label={t('insights.busiestHour')}
          icon={Clock}
          tone="blue"
          value={peak ? `${weekdayName(peak.day, locale)} ${hourLabel(peak.hour)}` : '—'}
          sub={peak && `${count(peak.requests)} · ${data.timezone}`}
        />
        <Kpi
          label={t('insights.resources')}
          icon={Server}
          tone="slate"
          value={count(data.resources.length)}
          sub={t('insights.deploymentCount', { count: data.deployments?.length ?? 0 })}
        />
        <Kpi
          label={t('insights.topIpShare')}
          icon={Network}
          tone="teal"
          value={s.requests ? ratio(topFiveIps / s.requests, 0) : '—'}
          sub={t('insights.ofAllCalls')}
        />
      </KpiStrip>
      <Card
        title={overallTitle('requests')}
        icon={ChartColumnStacked}
        tone="blue"
        actions={
          <Segmented
            label={t('insights.split')}
            value={split}
            options={splitOptions()}
            onChange={setSplit}
          />
        }
      >
        <ChartLegend items={series.map((item) => ({ ...item, value: count(seriesTotal(item)) }))} />
        <TimeBarChart
          {...timeAxis(data)}
          series={series}
          format={count}
          label={overallTitle('requests')}
        />
      </Card>
      <div className="card-row wide-narrow">
        <Card title={t('insights.weekdayHour')} icon={CalendarClock} tone="blue">
          <WeekHourHeatmap
            cells={data.heatmap ?? []}
            describe={(day, hour, requests) => `${day} ${hourLabel(hour)} · ${count(requests)}`}
          />
        </Card>
        <Card title={t('insights.sourceIps', { count: TOP_SOURCE_IPS })} icon={Network} tone="teal">
          <ScrollViewport
            className="table-viewport"
            label={t('insights.sourceIps', { count: TOP_SOURCE_IPS })}
            showScrollbar={false}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('insights.filterIp')}</th>
                  <th>{t('insights.calls')}</th>
                  <th>{t('insights.share')}</th>
                </tr>
              </thead>
              <tbody>
                {ips.map((row) => (
                  <tr key={row.name}>
                    <td className="mono">
                      {row.name === '—' ? (
                        <Muted>{t('analytics.missingIP')}</Muted>
                      ) : (
                        <EntityName name={row.name} onSelect={() => onFilter('ip', row.name)} />
                      )}
                    </td>
                    <td>{count(row.requests)}</td>
                    <td>
                      <ShareBar value={row.requests} total={s.requests} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollViewport>
        </Card>
      </div>
      <Card
        title={t('insights.callBreakdown')}
        icon={TableProperties}
        tone="blue"
        actions={
          <Segmented
            label={t('insights.split')}
            value={group}
            options={groupOptions()}
            onChange={setGroup}
          />
        }
      >
        <table className="data-table">
          <thead>
            <tr>
              <th>{groupLabel(group)}</th>
              <th>{t('insights.calls')}</th>
              <th>{t('insights.share')}</th>
              <th>{t('insights.cost')}</th>
              <th>{t('insights.tokens')}</th>
              <th>{t('insights.errorRate')}</th>
              <th>{t('insights.p95Duration')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <td>
                  <EntityName
                    name={displayName(group, row.name)}
                    onSelect={rowFilter(group, row.name, onFilter)}
                  />
                </td>
                <td>{count(row.requests)}</td>
                <td>
                  <ShareBar value={row.requests} total={s.requests} />
                </td>
                <td>{row.costUsd === null ? <Muted /> : money(row.costUsd)}</td>
                <td>{tokens(summaryTokens(row))}</td>
                <td>
                  <ErrorRate value={errorRate(row)} />
                </td>
                <td>{latency(row.p95DurationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

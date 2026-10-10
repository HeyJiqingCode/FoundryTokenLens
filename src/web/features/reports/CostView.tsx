import {
  CalendarDays,
  ChartArea,
  ChartColumnStacked,
  CircleDollarSign,
  Receipt,
  Sigma,
  TableProperties,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { t, useLocale } from '../../i18n';
import { COST_BIN_EDGES, type AnalyticsResponse } from '../../../shared/analytics';
import { ChartLegend, CumulativeChart, TimeBarChart } from '../analytics/charts';
import { calendarDay, count, money, tokens } from '../analytics/format';
import {
  billingItem,
  billingItems,
  billingLabel,
  byCost,
  costItemSeries,
  costTypeSeries,
  displayName,
  groupLabel,
  groupOptions,
  groupRows,
  peakDay,
  rangeDays,
  rowFilter,
  stackSeries,
  summaryTokens,
  overallTitle,
  timeAxis,
  typeOptions,
  type FilterField,
  type StackBy,
} from '../analytics/series';
import { Comparison, EntityName, Muted, ShareBar, METRIC_TONE, callsValue } from '../analytics/ui';
import { Kpi, KpiStrip } from '../../components/Kpi';
import { Card } from '../../components/Card';
import { Segmented } from '../../components/Segmented';
import { BandCard, DistributionCard, TopCostCard, edgeLabels } from '../analytics/cards';

/** The month so far in the cost color, the forecast in a light shade of it. */
const SPENT = 'var(--amber)';
const FORECAST = 'color-mix(in srgb, var(--amber) 28%, transparent)';

export function CostView({
  data,
  onFilter,
}: {
  data: AnalyticsResponse;
  onFilter: (field: FilterField, value: string) => void;
}) {
  const locale = useLocale();
  const [split, setSplit] = useState<'type' | StackBy>('model');
  const [group, setGroup] = useState<StackBy>('model');
  const s = data.summary,
    c = data.comparison;
  const cost = Number(s.costUsd ?? 0);
  const days = rangeDays(data);
  const rows = [...groupRows(data, group)].sort(byCost);
  const peak = peakDay(data, 'cost');
  const items = billingItems(data);
  const series = split === 'type' ? costTypeSeries(data, items) : stackSeries(data, split, 'cost');
  const month = data.monthForecast;
  // The month so far and the forecast as areas, last month's total as a dashed line; the legend
  // names them all.
  const forecastAreas = [
    {
      key: 'spent',
      name: t('insights.accumulatedCost'),
      color: SPENT,
      values: month?.actual ?? [],
    },
    {
      key: 'forecast',
      name: t('insights.forecast'),
      color: FORECAST,
      values: month?.forecast ?? [],
    },
  ];
  const lastMonth =
    month?.previous == null
      ? undefined
      : { name: t('insights.lastMonthTotal'), color: 'var(--slate)', value: month.previous };
  return (
    <>
      <KpiStrip>
        <Kpi
          label={t('insights.totalCost')}
          icon={CircleDollarSign}
          tone="amber"
          value={money(s.costUsd)}
          sub={c && <Comparison current={cost} previous={c.costUsd} format={money} kind="cost" />}
        />
        <Kpi
          label={t('insights.dailyCost')}
          icon={CalendarDays}
          tone="amber"
          value={days ? money(cost / days) : '—'}
          sub={
            peak && (
              <span title={calendarDay(peak.date, locale)}>
                {t('insights.peakDayCost', { value: money(peak.value) })}
              </span>
            )
          }
        />
        <Kpi
          label={t('insights.averageCost')}
          icon={Receipt}
          tone="amber"
          value={money(s.averageCostUsd)}
          sub={
            c && (
              <Comparison
                current={s.averageCostUsd}
                previous={c.averageCostUsd}
                format={money}
                kind="cost"
              />
            )
          }
        />
        <Kpi
          label={t('insights.p95Cost')}
          icon={Sigma}
          tone="amber"
          value={money(s.p95CostUsd)}
          sub={
            c && (
              <Comparison
                current={s.p95CostUsd}
                previous={c.p95CostUsd}
                format={money}
                kind="cost"
              />
            )
          }
        />
        <Kpi
          label={t('insights.calls')}
          icon={Zap}
          tone="blue"
          value={callsValue(s.requests)}
          sub={c && <Comparison current={s.requests} previous={c.requests} format={count} />}
        />
      </KpiStrip>
      <Card
        title={overallTitle('cost')}
        icon={ChartColumnStacked}
        tone={METRIC_TONE.cost}
        actions={
          <Segmented
            label={t('insights.split')}
            value={split}
            options={typeOptions()}
            onChange={setSplit}
          />
        }
      >
        <ChartLegend items={series} />
        <TimeBarChart
          {...timeAxis(data)}
          series={series}
          format={money}
          label={overallTitle('cost')}
        />
      </Card>
      <div className="card-row halves">
        <BandCard
          title={t('insights.costComposition')}
          tone="amber"
          format={money}
          tall
          split={(by) => ({
            // Cost of each billing item, split by the chosen group.
            series: costItemSeries(data, by, items),
            bands: items.map((name) => ({
              key: name,
              name: billingLabel(name),
              detail: `${tokens(billingItem(data, name).quantity)} · ${money(billingItem(data, name).costUsd ?? 0)}`,
            })),
          })}
        />
        <TopCostCard data={data} />
      </div>
      <div className="card-row halves">
        <DistributionCard
          data={data}
          title={t('insights.costPerCall')}
          tone="amber"
          measure="cost"
          edges={edgeLabels(COST_BIN_EDGES, (edge) => `$${edge}`)}
        />
        <Card
          title={t('insights.monthForecast')}
          icon={ChartArea}
          tone="amber"
          className="fixed-card"
        >
          <ChartLegend
            items={[
              ...forecastAreas,
              ...(lastMonth ? [{ key: 'previous', ...lastMonth, dashed: true }] : []),
            ]}
          />
          <CumulativeChart
            days={month?.days ?? []}
            areas={forecastAreas}
            reference={lastMonth}
            format={money}
            timeZone={data.timezone}
            label={t('insights.monthForecast')}
            height="fill"
          />
        </Card>
      </div>
      {/* Alone on the last row, the breakdown grows with its rows instead of scrolling. */}
      <Card
        title={t('insights.costBreakdown')}
        icon={TableProperties}
        tone="amber"
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
              <th>{t('insights.cost')}</th>
              <th>{t('insights.costShare')}</th>
              <th>{t('insights.cacheSavings')}</th>
              <th>{t('insights.averageCost')}</th>
              <th>{t('insights.tokens')}</th>
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
                <td>{row.costUsd === null ? <Muted /> : money(row.costUsd)}</td>
                <td>
                  <ShareBar
                    value={row.costUsd === null ? null : Number(row.costUsd)}
                    total={cost}
                  />
                </td>
                <td>{row.cacheSavingsUsd == null ? <Muted /> : money(row.cacheSavingsUsd)}</td>
                <td>{row.averageCostUsd == null ? <Muted /> : money(row.averageCostUsd)}</td>
                <td>{tokens(summaryTokens(row))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

import {
  CalendarDays,
  ChartColumnStacked,
  ChartNoAxesColumn,
  ChartPie,
  CircleDollarSign,
  Receipt,
  Sigma,
  TableProperties,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { t, useLocale } from '../../i18n';
import type { AnalyticsResponse } from '../../../shared/analytics';
import { ChartLegend, Histogram, TimeBarChart } from '../analytics/charts';
import { calendarDay, count, money, ratio, tokens } from '../analytics/format';
import {
  billingLabel,
  byCost,
  displayName,
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
  totalSeries,
  overallTitle,
  timeAxis,
  type FilterField,
  type StackBy,
} from '../analytics/series';
import { Comparison, EntityName, Muted, ShareBar, METRIC_TONE } from '../analytics/ui';
import { Kpi, KpiStrip } from '../../components/Kpi';
import { Card } from '../../components/Card';
import { Segmented } from '../../components/Segmented';

const ITEM_COLORS: Record<string, string> = {
  input: 'var(--blue)',
  output: 'var(--violet)',
  cache_read: 'var(--teal)',
  cache_write: 'var(--amber)',
};
const STANDARD_ITEMS: readonly string[] = ['input', 'output', 'cache_read', 'cache_write'];

export function CostView({
  data,
  onFilter,
}: {
  data: AnalyticsResponse;
  onFilter: (field: FilterField, value: string) => void;
}) {
  const locale = useLocale();
  const [split, setSplit] = useState<StackBy | 'none'>('model');
  const [group, setGroup] = useState<StackBy>('model');
  const s = data.summary,
    c = data.comparison;
  const cost = Number(s.costUsd ?? 0);
  const days = rangeDays(data);
  const series = split === 'none' ? totalSeries(data, 'cost') : stackSeries(data, split, 'cost');
  const rows = [...groupRows(data, group)].sort(byCost);
  const peak = peakDay(data, 'cost');
  // The four standard billing items always show, in billing order and as 0 when unused, so a
  // new kind of spend appears without code changes; any other item follows by cost.
  const costOf = (name: string) =>
    Number(data.costItems?.find((item) => item.name === name)?.costUsd ?? 0);
  const items = [
    ...STANDARD_ITEMS.map((name) => ({ name, costUsd: costOf(name) })),
    ...(data.costItems ?? [])
      .filter((item) => !STANDARD_ITEMS.includes(item.name) && Number(item.costUsd ?? 0) > 0)
      .map((item) => ({ name: item.name, costUsd: Number(item.costUsd) }))
      .sort((a, b) => b.costUsd - a.costUsd),
  ];
  const itemCost = items.reduce((sum, item) => sum + item.costUsd, 0);
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
          label={t('insights.callsCount')}
          icon={Zap}
          tone="blue"
          value={count(s.requests)}
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
            options={splitOptions()}
            onChange={setSplit}
          />
        }
      >
        <ChartLegend items={series.map((item) => ({ ...item, value: money(seriesTotal(item)) }))} />
        <TimeBarChart
          {...timeAxis(data)}
          series={series}
          format={money}
          label={overallTitle('cost')}
        />
      </Card>
      <div className="card-row wide-narrow">
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
                  <td>{row.averageCostUsd == null ? <Muted /> : money(row.averageCostUsd)}</td>
                  <td>{tokens(summaryTokens(row))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="card-stack">
          <Card title={t('insights.costComposition')} icon={ChartPie} tone="amber">
            {itemCost ? (
              <>
                <div className="composition-bar" aria-hidden="true">
                  {items.map((item) => (
                    <i
                      key={item.name}
                      style={{
                        width: `${(item.costUsd / itemCost) * 100}%`,
                        background: ITEM_COLORS[item.name] ?? 'var(--slate)',
                      }}
                    />
                  ))}
                </div>
                <ul className="value-list">
                  {items.map((item) => (
                    <li key={item.name}>
                      <EntityName
                        name={billingLabel(item.name)}
                        color={ITEM_COLORS[item.name] ?? 'var(--slate)'}
                      />
                      <span>
                        {money(item.costUsd)}
                        <Muted>{ratio(item.costUsd / itemCost)}</Muted>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="card-empty">{t('insights.noChartData')}</p>
            )}
          </Card>
          <Card title={t('insights.costPerCall')} icon={ChartNoAxesColumn} tone="amber">
            <Histogram
              bins={data.distributions?.cost ?? []}
              color="var(--blue)"
              label={t('insights.costPerCall')}
            />
          </Card>
        </div>
      </div>
    </>
  );
}

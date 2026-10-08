import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  ChartColumnStacked,
  ChartLine,
  ChartNoAxesColumn,
  DatabaseBackup,
  DatabaseZap,
  Percent,
} from 'lucide-react';
import { useState } from 'react';
import { t } from '../../i18n';
import type { AnalyticsResponse } from '../../../shared/analytics';
import { ChartLegend, Histogram, TimeBarChart, TimeLineChart } from '../analytics/charts';
import { contextLabel, count, money, ratio, share, tokens } from '../analytics/format';
import {
  displayName,
  rowFilter,
  seriesTotal,
  stackSeries,
  timeAxis,
  tokenTypeSeries,
  totalSeries,
  overallTitle,
  type FilterField,
} from '../analytics/series';
import { Comparison, EntityName, Muted, ShareBar } from '../analytics/ui';
import { Kpi, KpiStrip } from '../../components/Kpi';
import { Card } from '../../components/Card';
import { Segmented } from '../../components/Segmented';

export function TokenView({
  data,
  onFilter,
}: {
  data: AnalyticsResponse;
  onFilter: (field: FilterField, value: string) => void;
}) {
  const [split, setSplit] = useState<'type' | 'model' | 'none'>('type');
  const s = data.summary,
    c = data.comparison;
  const input = s.inputTokens === null ? null : Number(s.inputTokens);
  const series =
    split === 'type'
      ? tokenTypeSeries(data)
      : split === 'model'
        ? stackSeries(data, 'model', 'tokens')
        : totalSeries(data, 'tokens');
  return (
    <>
      <KpiStrip>
        <Kpi
          label={t('insights.inputTokensTotal')}
          icon={ArrowDownToLine}
          tone="blue"
          value={tokens(s.inputTokens)}
          sub={c && <Comparison current={input} previous={c.inputTokens} format={tokens} />}
        />
        <Kpi
          label={t('insights.cacheReadTokens')}
          icon={DatabaseZap}
          tone="teal"
          value={tokens(s.cachedTokens)}
          sub={
            c && <Comparison current={s.cachedTokens} previous={c.cachedTokens} format={tokens} />
          }
        />
        <Kpi
          label={t('insights.cacheWriteTokens')}
          icon={DatabaseBackup}
          tone="amber"
          value={tokens(s.cacheWriteTokens ?? '0')}
          sub={
            c && (
              <Comparison
                current={s.cacheWriteTokens ?? 0}
                previous={c.cacheWriteTokens ?? 0}
                format={tokens}
              />
            )
          }
        />
        <Kpi
          label={t('insights.outputTokens')}
          icon={ArrowUpFromLine}
          tone="violet"
          value={tokens(s.outputTokens)}
          sub={
            c && <Comparison current={s.outputTokens} previous={c.outputTokens} format={tokens} />
          }
        />
        <Kpi
          label={t('analytics.cacheHitRate')}
          icon={Percent}
          tone="teal"
          value={ratio(s.cacheRatio)}
          sub={c && <Comparison current={s.cacheRatio} previous={c.cacheRatio} format={ratio} />}
        />
      </KpiStrip>
      <Card
        title={overallTitle('tokens')}
        icon={ChartColumnStacked}
        tone="violet"
        actions={
          <Segmented
            label={t('insights.split')}
            value={split}
            options={[
              { value: 'none', label: t('insights.noSplit') },
              { value: 'model', label: t('insights.byModel') },
              { value: 'type', label: t('insights.byType') },
            ]}
            onChange={setSplit}
          />
        }
      >
        <ChartLegend
          items={series.map((item) => ({ ...item, value: tokens(seriesTotal(item)) }))}
        />
        <TimeBarChart
          {...timeAxis(data)}
          series={series}
          format={tokens}
          label={overallTitle('tokens')}
        />
      </Card>
      <div className="card-row halves">
        <Card title={t('insights.cacheHitTrend')} icon={ChartLine} tone="teal">
          <TimeLineChart
            {...timeAxis(data)}
            height="fill"
            fixedMax={1}
            format={(value) => ratio(value, 0)}
            label={t('insights.cacheHitTrend')}
            lines={[
              {
                key: 'cache',
                name: t('insights.cacheHitTrend'),
                color: 'var(--teal)',
                values: data.timeline.map((b) => b.cacheRatio),
              },
            ]}
          />
        </Card>
        <Card title={t('insights.sizeDistribution')} icon={ChartNoAxesColumn} tone="violet">
          <div className="histogram-pair">
            <div>
              <h3 className="card-subhead">{t('insights.inputTokens')}</h3>
              <Histogram
                bins={data.distributions?.input ?? []}
                color="var(--blue)"
                label={t('insights.inputTokens')}
              />
            </div>
            <div>
              <h3 className="card-subhead">{t('insights.outputTokens')}</h3>
              <Histogram
                bins={data.distributions?.output ?? []}
                color="var(--violet)"
                label={t('insights.outputTokens')}
              />
            </div>
          </div>
          <h3 className="card-subhead">{t('analytics.contextDistribution')}</h3>
          <ul className="value-list">
            {(data.distributions?.context ?? []).map((bin) => (
              <li key={bin.name}>
                <EntityName
                  name={t(contextLabel(bin.name))}
                  onSelect={() => onFilter('context', bin.name)}
                />
                <span>
                  {count(bin.count)}
                  {bin.costUsd === null ? (
                    <>
                      <Muted />
                      <Muted />
                    </>
                  ) : (
                    <>
                      <Muted>{money(bin.costUsd)}</Muted>
                      <span className="share">{share(bin.costUsd, data.summary.costUsd)}</span>
                    </>
                  )}
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
              <th>{t('insights.inputTokensTotal')}</th>
              <th>{t('insights.cachedTokens')}</th>
              <th>{t('insights.cacheWrites')}</th>
              <th>{t('insights.outputTokens')}</th>
              <th>{t('analytics.cacheHitRate')}</th>
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
                <td>{tokens(row.inputTokens)}</td>
                <td>{tokens(row.cachedTokens ?? '0')}</td>
                <td>{tokens(row.cacheWriteTokens ?? '0')}</td>
                <td>{tokens(row.outputTokens)}</td>
                <td>
                  <ShareBar value={row.cacheRatio} total={1} color="var(--teal)" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

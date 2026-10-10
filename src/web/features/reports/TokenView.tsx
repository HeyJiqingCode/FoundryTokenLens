import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  ChartColumnStacked,
  DatabaseBackup,
  DatabaseZap,
  Percent,
} from 'lucide-react';
import { useState } from 'react';
import { t } from '../../i18n';
import { COST_CONTEXTS } from '../../../shared/pricing';
import {
  CACHE_HIT_GROUPS,
  INPUT_BIN_EDGES,
  OUTPUT_BIN_EDGES,
  thousands,
  type AnalyticsResponse,
  type CacheHitGroup,
} from '../../../shared/analytics';
import { ChartLegend, TimeBarChart } from '../analytics/charts';
import { callCount, contextLabel, count, money, ratio, tokens } from '../analytics/format';
import {
  billingItem,
  binSeries,
  displayName,
  rowFilter,
  stackSeries,
  timeAxis,
  tokenTypeSeries,
  tokenTypeTotals,
  TOKEN_TYPES,
  overallTitle,
  typeOptions,
  type FilterField,
  type StackBy,
} from '../analytics/series';
import {
  BandCard,
  CallListCard,
  DistributionCard,
  GroupLineCard,
  edgeLabels,
} from '../analytics/cards';
import { Comparison, EntityName, METRIC_TONE, ShareBar } from '../analytics/ui';
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
  const [split, setSplit] = useState<'type' | StackBy>('model');
  const [cacheHit, setCacheHit] = useState<CacheHitGroup>('nonZero');
  const s = data.summary,
    c = data.comparison;
  const input = s.inputTokens === null ? null : Number(s.inputTokens);
  const series = split === 'type' ? tokenTypeSeries(data) : stackSeries(data, split, 'tokens');
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
        tone={METRIC_TONE.tokens}
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
          format={tokens}
          label={overallTitle('tokens')}
        />
      </Card>
      <div className="card-row halves">
        <GroupLineCard
          data={data}
          title={t('analytics.cacheHitRate')}
          tone="teal"
          field="cacheRatio"
          format={(value) => ratio(value, 0)}
          fixedMax={1}
          tall
        />
        <CallListCard
          title={t('insights.lowestCacheHitRate')}
          icon={Percent}
          tone="teal"
          view={cacheHit}
          actions={
            <Segmented
              label={t('insights.lowestCacheHitRate')}
              value={cacheHit}
              options={CACHE_HIT_GROUPS.map((value) => ({
                value,
                label: t(value === 'zero' ? 'insights.cacheHitZero' : 'insights.cacheHitNonZero'),
              }))}
              onChange={setCacheHit}
            />
          }
          rows={data.lowestCache?.[cacheHit] ?? []}
          timeZone={data.timezone}
          value={(row) => ratio(Number(row.cachedTokens) / Number(row.inputTokens))}
          detail={(row) =>
            [
              `${t('insights.input')} ${tokens(row.inputTokens)}`,
              `${t('insights.cacheRead')} ${tokens(row.cachedTokens)}`,
              `${t('insights.output')} ${tokens(row.outputTokens)}`,
            ].join(' · ')
          }
        />
      </div>
      <div className="card-row halves">
        <BandCard
          title={t('insights.contextDistribution')}
          tone="slate"
          format={callCount}
          onSelect={(context) => onFilter('context', context)}
          split={(by) => ({
            // Calls per price context, split by the chosen group.
            series: binSeries(data, by, 'context'),
            bands: COST_CONTEXTS.map((context, i) => {
              const bin = data.distributions?.context?.[i];
              return {
                key: context,
                name: t(contextLabel(context)),
                detail: `${callCount(bin?.count ?? 0)} · ${money(bin?.costUsd)}`,
              };
            }),
          })}
        />
        <BandCard
          title={t('insights.tokenDistribution')}
          tone="violet"
          format={tokens}
          split={(by) => {
            // Tokens of each type, not calls, split by the chosen group.
            const series = tokenTypeTotals(data, by);
            return {
              series,
              bands: TOKEN_TYPES.map((type, i) => ({
                key: type.key,
                name: t(type.label),
                detail: `${tokens(series.reduce((sum, item) => sum + (item.values[i] ?? 0), 0))} · ${money(billingItem(data, type.item).costUsd)}`,
              })),
            };
          }}
        />
      </div>
      <div className="card-row halves">
        <DistributionCard
          data={data}
          title={t('insights.inputDistribution')}
          tone="blue"
          measure="input"
          edges={edgeLabels(INPUT_BIN_EDGES, thousands)}
        />
        <DistributionCard
          data={data}
          title={t('insights.outputDistribution')}
          tone="violet"
          measure="output"
          edges={edgeLabels(OUTPUT_BIN_EDGES, thousands)}
        />
      </div>
      <Card title={t('insights.byModelTitle')} icon={Boxes} tone="violet">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('insights.filterModel')}</th>
              <th>{t('insights.calls')}</th>
              <th>{t('insights.inputTokensTotal')}</th>
              <th>{t('insights.cacheRead')}</th>
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

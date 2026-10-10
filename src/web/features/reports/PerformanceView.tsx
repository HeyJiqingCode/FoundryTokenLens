import {
  Ban,
  ChartScatter,
  FastForward,
  Gauge,
  Hourglass,
  ListChecks,
  ShieldAlert,
  Snail,
  TableProperties,
  Timer,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { t, type MessageKey } from '../../i18n';
import {
  FIRST_TOKEN_BIN_EDGES,
  PERFORMANCE_MEASURES,
  SPEED_BIN_EDGES,
  TIME_BIN_EDGES,
  tokensPerSecond,
  type AnalyticsResponse,
  type CallRow,
  type PerformanceMeasure,
} from '../../../shared/analytics';
import { ChartLegend, ScatterPlot, TimeBarChart } from '../analytics/charts';
import { callCount, count, latency, ratio, speed, speedNumber, tokens } from '../analytics/format';
import {
  displayName,
  entityColors,
  errorRate,
  groupLabel,
  groupOptions,
  groupRows,
  rowFilter,
  statusSeries,
  timeAxis,
  type FilterField,
  type StackBy,
} from '../analytics/series';
import {
  Comparison,
  EntityName,
  ErrorRate,
  Muted,
  StatusCode,
  callsValue,
  unitValue,
} from '../analytics/ui';
import { Kpi, KpiStrip } from '../../components/Kpi';
import { Card } from '../../components/Card';
import { ScrollViewport } from '../../components/ScrollViewport';
import { Segmented } from '../../components/Segmented';
import { CallListCard, DistributionCard, GroupLineCard, edgeLabels } from '../analytics/cards';

const SLOW_TITLES: Record<PerformanceMeasure, MessageKey> = {
  duration: 'insights.longestDuration',
  ttft: 'insights.slowestTtft',
  ttlt: 'insights.slowestTtlt',
  speed: 'insights.lowestSpeed',
};
const SLOW_OPTIONS: Record<PerformanceMeasure, MessageKey> = {
  duration: 'insights.latency',
  ttft: 'insights.ttft',
  ttlt: 'insights.ttlt',
  speed: 'insights.generationSpeed',
};
const SLOW_VALUES: Record<PerformanceMeasure, (row: CallRow) => string> = {
  duration: (row) => latency(row.durationMs),
  ttft: (row) => latency(row.timeToFirstTokenMs),
  ttlt: (row) => latency(row.timeToLastTokenMs),
  speed: (row) => speed(tokensPerSecond(row)),
};
/** A measure as an item of a call's detail line: named, except speed, whose unit names it. */
const slowItem = (measure: PerformanceMeasure, row: CallRow) =>
  measure === 'speed'
    ? SLOW_VALUES.speed(row)
    : `${t(SLOW_OPTIONS[measure])} ${SLOW_VALUES[measure](row)}`;
const seconds = (edge: number) => `${edge}s`;
const BIN_EDGES: Record<PerformanceMeasure, string[]> = {
  duration: edgeLabels(TIME_BIN_EDGES, seconds),
  ttft: edgeLabels(FIRST_TOKEN_BIN_EDGES, seconds),
  ttlt: edgeLabels(TIME_BIN_EDGES, seconds),
  speed: edgeLabels(SPEED_BIN_EDGES, String),
};

export function PerformanceView({
  data,
  onFilter,
}: {
  data: AnalyticsResponse;
  onFilter: (field: FilterField, value: string) => void;
}) {
  const [group, setGroup] = useState<StackBy>('model');
  const [slow, setSlow] = useState<PerformanceMeasure>('duration');
  const s = data.summary,
    c = data.comparison;
  const color = entityColors(data);
  const errors = statusSeries(data);
  const statuses = [...(data.statuses ?? [])].sort((a, b) => b.count - a.count);
  const rows = groupRows(data, group);
  const points = (data.scatter ?? []).map((p) => ({
    key: p.id,
    x: p.input,
    y: p.ttft,
    color: color('model', p.model),
    name: displayName('model', p.model),
  }));
  return (
    <>
      <KpiStrip>
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
          label={t('insights.p95Ttlt')}
          icon={Hourglass}
          tone="blue"
          value={latency(s.p95LastTokenMs)}
          sub={
            c && (
              <Comparison
                current={s.p95LastTokenMs}
                previous={c.p95LastTokenMs}
                format={latency}
                kind="risk"
              />
            )
          }
        />
        <Kpi
          label={t('insights.generationSpeed')}
          icon={FastForward}
          tone="violet"
          value={unitValue(speedNumber(s.p50TokensPerSecond), t('insights.tokensPerSecond'))}
          sub={
            c && (
              <Comparison
                current={s.p50TokensPerSecond}
                previous={c.p50TokensPerSecond}
                format={speedNumber}
                kind="gain"
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
          value={callsValue(s.throttled ?? 0)}
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
        <GroupLineCard
          data={data}
          title={t('insights.p95Duration')}
          tone="blue"
          field="p95DurationMs"
          format={latency}
        />
        <DistributionCard
          data={data}
          title={t('insights.durationDistribution')}
          tone="blue"
          measure="duration"
          edges={BIN_EDGES.duration}
        />
      </div>
      <div className="card-row halves">
        <GroupLineCard
          data={data}
          title={t('insights.p95Ttft')}
          tone="teal"
          field="p95FirstTokenMs"
          format={latency}
        />
        <GroupLineCard
          data={data}
          title={t('insights.p95Ttlt')}
          tone="blue"
          field="p95LastTokenMs"
          format={latency}
        />
      </div>
      <div className="card-row halves">
        <DistributionCard
          data={data}
          title={t('insights.ttftDistribution')}
          tone="teal"
          measure="ttft"
          edges={BIN_EDGES.ttft}
        />
        <DistributionCard
          data={data}
          title={t('insights.ttltDistribution')}
          tone="blue"
          measure="ttlt"
          edges={BIN_EDGES.ttlt}
        />
      </div>
      {/* Errors and statuses share the left half, so the speed chart lines up with the rows above. */}
      <div className="card-row halves">
        <div className="card-row halves">
          <Card title={t('insights.errors')} icon={ShieldAlert} tone="error" className="fixed-card">
            {/* The status list beside it gives the counts. */}
            <ChartLegend items={errors} />
            <TimeBarChart
              {...timeAxis(data)}
              series={errors}
              format={callCount}
              label={t('insights.errors')}
              height="fill"
            />
          </Card>
          <Card
            title={t('insights.responseStatus')}
            icon={ListChecks}
            tone="slate"
            className="fixed-card"
          >
            {/* Many status codes scroll inside the card instead of stretching the row. */}
            <ScrollViewport
              className="fill-viewport"
              label={t('insights.responseStatus')}
              showScrollbar={false}
            >
              <ul className="value-list">
                {statuses.map((status) => (
                  <li key={status.name}>
                    <StatusCode code={status.name} />
                    <span>
                      {callCount(status.count)}
                      <Muted>{ratio(s.requests ? status.count / s.requests : null)}</Muted>
                    </span>
                  </li>
                ))}
              </ul>
            </ScrollViewport>
          </Card>
        </div>
        <DistributionCard
          data={data}
          title={t('insights.speedDistribution')}
          tone="violet"
          measure="speed"
          edges={BIN_EDGES.speed}
          unit={t('insights.tokensPerSecond')}
        />
      </div>
      <div className="card-row halves">
        <Card
          title={t('insights.inputVsTtft')}
          icon={ChartScatter}
          tone="teal"
          className="fixed-card tall"
        >
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
            yLabel={t('insights.ttft')}
            label={t('insights.inputVsTtft')}
            height="fill"
          />
        </Card>
        <CallListCard
          title={t(SLOW_TITLES[slow])}
          icon={Snail}
          tone="amber"
          view={slow}
          actions={
            <Segmented
              label={t('insights.metric')}
              value={slow}
              options={PERFORMANCE_MEASURES.map((value) => ({
                value,
                label: t(SLOW_OPTIONS[value]),
              }))}
              onChange={setSlow}
            />
          }
          rows={data.slowest?.[slow] ?? []}
          timeZone={data.timezone}
          value={SLOW_VALUES[slow]}
          detail={(row) =>
            [
              `${t('insights.input')} ${tokens(row.inputTokens)}`,
              `${t('insights.output')} ${tokens(row.outputTokens)}`,
              ...PERFORMANCE_MEASURES.filter((measure) => measure !== slow).map((measure) =>
                slowItem(measure, row),
              ),
            ].join(' · ')
          }
        />
      </div>
      {/* Alone on the last row, the overview grows with its rows instead of scrolling. */}
      <Card
        title={t('insights.summaryTable')}
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
              <th>{t('insights.errorRate')}</th>
              <th>429</th>
              <th>{t('insights.p50Duration')}</th>
              <th>{t('insights.p95Duration')}</th>
              <th>{t('insights.p50Ttft')}</th>
              <th>{t('insights.p95Ttft')}</th>
              <th>{t('insights.p50Ttlt')}</th>
              <th>{t('insights.p95Ttlt')}</th>
              <th>{t('insights.p50Speed')}</th>
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
                <td>{latency(row.p50FirstTokenMs)}</td>
                <td>{latency(row.p95FirstTokenMs)}</td>
                <td>{latency(row.p50LastTokenMs)}</td>
                <td>{latency(row.p95LastTokenMs)}</td>
                <td>{speed(row.p50TokensPerSecond)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

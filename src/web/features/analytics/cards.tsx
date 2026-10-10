import {
  ChartBarStacked,
  ChartLine,
  ChartNoAxesColumn,
  ReceiptText,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { t } from '../../i18n';
import type { AnalyticsResponse, BinnedMeasure } from '../../../shared/analytics';
import { Card, type Tone } from '../../components/Card';
import { ScrollViewport } from '../../components/ScrollViewport';
import { Segmented } from '../../components/Segmented';
import { BandBars, ChartLegend, Histogram, TimeLineChart, type ChartSeries } from './charts';
import { binSeries, groupLines, groupOptions, timeAxis, type StackBy } from './series';
import { money } from './format';
import { CallList } from './ui';

/** Bin lower bounds as axis labels: 0, then each bound as `label` writes it. */
export const edgeLabels = (edges: number[], label: (edge: number) => string) =>
  edges.map((edge) => (edge ? label(edge) : '0'));

/**
 * A card whose chart is split by model or by resource, with the switch in its title row. Like
 * every card it shares a row with, its height is fixed (`.fixed-card`), so a legend that wraps
 * for long names shrinks the chart instead of moving the page.
 */
function SplitCard({
  title,
  icon,
  tone,
  tall,
  children,
}: {
  title: string;
  icon: LucideIcon;
  tone: Tone;
  /** In a row with a list of calls, the card takes that row's height. */
  tall?: boolean;
  children: (by: StackBy) => ReactNode;
}) {
  const [by, setBy] = useState<StackBy>('model');
  return (
    <Card
      title={title}
      icon={icon}
      tone={tone}
      className={tall ? 'fixed-card tall' : 'fixed-card'}
      actions={
        <Segmented
          label={t('insights.split')}
          value={by}
          options={groupOptions()}
          onChange={setBy}
        />
      }
    >
      {children(by)}
    </Card>
  );
}

/**
 * Calls per bin of a measure, stacked by model or resource. `unit` follows the last edge and each
 * bin's name in the hover title.
 */
export function DistributionCard({
  data,
  title,
  tone,
  measure,
  edges,
  unit,
}: {
  data: AnalyticsResponse;
  title: string;
  tone: Tone;
  measure: BinnedMeasure;
  edges: string[];
  unit?: string;
}) {
  const bins = (data.distributions?.[measure] ?? []).map((bin) =>
    unit ? { ...bin, name: `${bin.name} ${unit}` } : bin,
  );
  return (
    <SplitCard title={title} icon={ChartNoAxesColumn} tone={tone}>
      {(by) => {
        const series = binSeries(data, by, measure);
        return (
          <>
            <ChartLegend items={series} />
            <Histogram bins={bins} series={series} edges={edges} edgeUnit={unit} label={title} />
          </>
        );
      }}
    </SplitCard>
  );
}

/** One line per model or resource, of a ratio or a percentile. */
export function GroupLineCard({
  data,
  title,
  tone,
  field,
  format,
  fixedMax,
  tall,
}: {
  data: AnalyticsResponse;
  title: string;
  tone: Tone;
  field: Parameters<typeof groupLines>[2];
  format: (value: number) => string;
  fixedMax?: number;
  tall?: boolean;
}) {
  return (
    <SplitCard title={title} icon={ChartLine} tone={tone} tall={tall}>
      {(by) => {
        const lines = groupLines(data, by, field);
        return (
          <>
            <ChartLegend items={lines} />
            <TimeLineChart
              {...timeAxis(data)}
              lines={lines}
              format={format}
              fixedMax={fixedMax}
              label={title}
              height="fill"
            />
          </>
        );
      }}
    </SplitCard>
  );
}

/**
 * Bands as bars as long as their share, stacked by model or resource, under the groups' legend;
 * a long list scrolls inside the card. `split` gives the groups, whose `values` follow the
 * bands, and each band's name and figures.
 */
export function BandCard({
  title,
  tone,
  format,
  onSelect,
  split,
  tall,
}: {
  title: string;
  tone: Tone;
  format: (value: number) => string;
  onSelect?: (band: string) => void;
  tall?: boolean;
  split: (by: StackBy) => {
    series: ChartSeries[];
    bands: { key: string; name: string; detail: string }[];
  };
}) {
  return (
    <SplitCard title={title} icon={ChartBarStacked} tone={tone} tall={tall}>
      {(by) => {
        const { series, bands } = split(by);
        return (
          <>
            <ChartLegend items={series} />
            <ScrollViewport className="fill-viewport" label={title} showScrollbar={false}>
              <BandBars
                bands={bands.map((band, i) => ({
                  ...band,
                  slices: series.map((item) => ({
                    ...item,
                    value: item.values[i] ?? 0,
                    parts: item.parts?.map((part) => ({ ...part, value: part.values[i] ?? 0 })),
                  })),
                }))}
                label={title}
                format={format}
                onSelect={onSelect}
              />
            </ScrollViewport>
          </>
        );
      }}
    </SplitCard>
  );
}

/**
 * Calls in a card of the call-list row height, all of them in a window of five that scrolls.
 * `view` names what the list shows, such as the measure picked in `actions`; another one starts
 * again at the top.
 */
export function CallListCard({
  title,
  icon,
  tone,
  actions,
  view,
  ...list
}: {
  title: string;
  icon: LucideIcon;
  tone: Tone;
  actions?: ReactNode;
  view?: string;
} & ComponentProps<typeof CallList>) {
  return (
    <Card title={title} icon={icon} tone={tone} className="fixed-card tall" actions={actions}>
      <ScrollViewport key={view} className="fill-viewport" label={title} showScrollbar={false}>
        <CallList {...list} />
      </ScrollViewport>
    </Card>
  );
}

/** The 20 most expensive calls, on the overview and the cost view alike. */
export function TopCostCard({ data, actions }: { data: AnalyticsResponse; actions?: ReactNode }) {
  return (
    <CallListCard
      title={t('insights.topCostCalls')}
      icon={ReceiptText}
      tone="amber"
      actions={actions}
      rows={data.topCosts ?? []}
      timeZone={data.timezone}
      value={(row) => money(row.cost?.knownUsd)}
    />
  );
}

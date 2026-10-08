import { useLocale, type DisplayMessage } from '../../i18n';
import type { ReportSection } from '../../../shared/navigation';
import type { AnalyticsResponse } from '../../../shared/analytics';
import { CostView } from './CostView';
import { DistributionView } from './DistributionView';
import { PerformanceView } from './PerformanceView';
import { TokenView } from './TokenView';
import type { FilterField } from '../analytics/series';
import { ReportPlaceholder } from '../analytics/ui';

export function ReportsPage({
  tab,
  data,
  error,
  onFilter,
}: {
  tab: ReportSection;
  data: AnalyticsResponse | null;
  error?: DisplayMessage | null;
  onFilter: (field: FilterField, value: string) => void;
}) {
  useLocale();
  const View = {
    cost: CostView,
    tokens: TokenView,
    performance: PerformanceView,
    distribution: DistributionView,
  }[tab];
  return (
    <div
      className="card-grid"
      id="reports-content"
      role="tabpanel"
      aria-labelledby={`reports-tab-${tab}`}
    >
      {data ? <View data={data} onFilter={onFilter} /> : <ReportPlaceholder error={error} />}
    </div>
  );
}

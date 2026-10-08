import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { RequestFact } from '../../../shared/ingestion';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { Tone } from '../../components/Card';
import { systemMessage, t, useLocale, type DisplayMessage } from '../../i18n';
import { callTimeFormat, latency, ratio, tokens } from './format';

/** Subject colors shared by titles and charts: cost, calls and tokens. */
export const METRIC_TONE: Record<'cost' | 'requests' | 'tokens', Tone> = {
  cost: 'amber',
  requests: 'blue',
  tokens: 'violet',
};

/** Placeholder until a view's first report arrives, or the error that prevented it. */
export function ReportPlaceholder({ error }: { error?: DisplayMessage | null }) {
  useLocale();
  return (
    <section className="card card-loading">
      {error ? systemMessage(error) : t('analytics.loadingAnalysis')}
    </section>
  );
}

/** `cost` marks increases for attention, `risk` marks them as bad; `neutral` carries no judgement. */
type ChangeKind = 'neutral' | 'cost' | 'risk';

/** Relative change against the previous equal-length window; no change stays neutral. */
function Delta({
  current,
  previous,
  kind = 'neutral',
}: {
  current: number | null | undefined;
  previous: number | null | undefined;
  kind?: ChangeKind;
}) {
  if (current == null || !previous) return null;
  const change = (current - previous) / previous;
  const tone =
    kind === 'neutral' || change === 0
      ? 'neutral'
      : change < 0
        ? 'good'
        : kind === 'cost'
          ? 'attention'
          : 'bad';
  const Icon = change > 0 ? ArrowUp : change < 0 ? ArrowDown : null;
  return (
    <span className={`delta delta-${tone}`}>
      {Icon && <Icon size={12} strokeWidth={2.4} aria-hidden="true" />}
      {ratio(Math.abs(change))}
    </span>
  );
}

type Amount = string | number | null | undefined;
const amount = (value: Amount) => (value == null ? null : Number(value));

/**
 * Change badge followed by the previous value, as `format` shows it; each part wraps as a unit.
 * `compact` names the comparison instead and moves the previous value into the tooltip, for
 * narrow tiles.
 */
export function Comparison<T extends Amount>({
  current,
  previous,
  format,
  kind,
  compact = false,
}: {
  current: Amount;
  previous: T;
  format: (value: T) => string;
  kind?: ChangeKind;
  compact?: boolean;
}) {
  const previousLabel = t('insights.previous', { value: format(previous) });
  const changed = current != null && Boolean(amount(previous));
  return (
    <span className="comparison" title={compact && changed ? previousLabel : undefined}>
      <Delta current={amount(current)} previous={amount(previous)} kind={kind} />
      <span>{compact && changed ? t('insights.vsPrevious') : previousLabel}</span>
    </span>
  );
}

export function ShareBar({
  value,
  total,
  color = 'var(--blue)',
}: {
  value: number | null;
  total: number;
  color?: string;
}) {
  if (value === null || !total) return <span className="muted">—</span>;
  const share = value / total;
  return (
    <span className="share-bar">
      {share > 0 && share < 0.001 ? '<0.1%' : ratio(share)}
      <span aria-hidden="true">
        <i style={{ width: `${Math.min(1, share) * 100}%`, background: color }} />
      </span>
    </span>
  );
}

export function EntityName({
  name,
  color,
  onSelect,
}: {
  name: string;
  color?: string;
  onSelect?: () => void;
}) {
  const content = (
    <>
      {color && <i className="legend-swatch" style={{ background: color }} aria-hidden="true" />}
      <span className="link-name">{name}</span>
    </>
  );
  return onSelect ? (
    <button type="button" className="entity-name" onClick={onSelect} title={name}>
      {content}
    </button>
  ) : (
    <span className="entity-name" title={name}>
      {content}
    </span>
  );
}

export const Muted = ({ children = '—' }: { children?: ReactNode }) => (
  <span className="muted">{children}</span>
);

export function CardLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="text-button card-link" onClick={onClick}>
      {children}
    </button>
  );
}

export const ViewAll = ({ onClick }: { onClick: () => void }) => (
  <CardLink onClick={onClick}>{t('insights.viewAll')} →</CardLink>
);

export function ErrorRate({ value }: { value: number | null }) {
  if (value === null) return <Muted />;
  if (!value) return <Muted>0</Muted>;
  return <span className={value > 0.02 ? 'text-bad' : undefined}>{ratio(value, 2)}</span>;
}

/** The query string with the request drawer opened on `row`. */
export function withRequest(
  search: string | URLSearchParams,
  row: Pick<RequestFact, 'correlationId' | 'resourceId'>,
) {
  const query = new URLSearchParams(search);
  query.set('request', row.correlationId);
  query.set('detailResource', row.resourceId);
  return query;
}

/** Compact call list that opens the request drawer on the requests page. */
export function CallList({
  rows,
  timeZone,
  value,
  detail,
}: {
  rows: RequestFact[];
  timeZone: string;
  value: (row: RequestFact) => string;
  detail?: (row: RequestFact) => string;
}) {
  const locale = useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const time = callTimeFormat(locale, timeZone);
  if (!rows.length) return <p className="card-empty">{t('analytics.noRequests')}</p>;
  return (
    <ul className="call-list">
      {rows.map((row) => (
        <li key={`${row.resourceId}/${row.correlationId}`}>
          <button
            type="button"
            aria-label={t('insights.openRequest', { id: row.correlationId })}
            onClick={() => {
              const query = withRequest(location.search, row);
              query.delete('page');
              navigate(`/requests?${query}`);
            }}
          >
            <span>
              <strong className="link-name">{row.model ?? row.operation ?? '—'}</strong>
              <small>
                {time.format(new Date(row.time))} ·{' '}
                {detail
                  ? detail(row)
                  : `${t('insights.input')} ${tokens(row.inputTokens)} · ${latency(row.durationMs)}`}
              </small>
            </span>
            <b>{value(row)}</b>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function StatusCode({ code }: { code: string | number | null }) {
  if (code === null || code === 'unknown') return <Muted>{t('analytics.unknownStatus')}</Muted>;
  if (code === 'conflict')
    return <span className="status-code warn">{t('analytics.conflict')}</span>;
  const value = Number(code);
  if (value < 400) return <span className="status-code">{code}</span>;
  return <span className={`status-code ${value === 429 ? 'warn' : 'error'}`}>{code}</span>;
}
